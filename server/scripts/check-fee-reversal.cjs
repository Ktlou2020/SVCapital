#!/usr/bin/env node
/* Giving a platform fee back.
 *
 * The 1% is charged when an investment is placed and there was never a way
 * to undo it. A fee charged in error, a goodwill gesture, a pool we said
 * would be fee-free and was not: all of it was a manual wallet credit with
 * a note — a figure typed by hand into a balance with nothing tying it to
 * the fee it was meant to cancel.
 *
 * Two destinations, and four things that are easy to get wrong and
 * expensive when you do, each constructed on purpose below:
 *
 *   writing the refund as a negative `fee`, which cashMovement signs by
 *   TYPE and reads through Math.abs — so the apology bills them twice;
 *
 *   returning a sub-account's fee to the member's own wallet, which moves
 *   money between two people's records;
 *
 *   raising an investment's principal without its expected return, which
 *   pays the wrong figure at maturity months later;
 *
 *   and paying it twice because somebody pressed the button twice.
 *
 * Run: DATABASE_URL=… node server/scripts/check-fee-reversal.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const { cashMovement, CASH_CREDIT_TYPES } = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
const { expectedReturnFor, PLATFORM_FEE_PCT } = require(path.join(ROOT, 'server', 'services', 'poolFees.js'));

console.log('a reversed fee reads as money coming back');
{
  ok('fee_reversal is a credit',
     CASH_CREDIT_TYPES.includes('fee_reversal'));
  ok('and it moves the balance up, not down',
     cashMovement({ type: 'fee_reversal', amount: 50 }) === 50,
     String(cashMovement({ type: 'fee_reversal', amount: 50 })));
  /* The trap this type exists to avoid. */
  ok('a refund written as a negative fee would have been a second charge',
     cashMovement({ type: 'fee', amount: -50 }) === -50,
     'cashMovement signs by TYPE and takes the amount through Math.abs, so '
     + 'the sign on the row cannot express a refund — hence a type of its own');
}

console.log('\nand the expected return has one definition');
{
  ok('it is simple interest over the term',
     expectedReturnFor({ amount: 10000, annualRate: 0.13, termMonths: 12 }) === 1300,
     String(expectedReturnFor({ amount: 10000, annualRate: 0.13, termMonths: 12 })));
  ok('prorated for a part year',
     expectedReturnFor({ amount: 10000, annualRate: 0.12, termMonths: 6 }) === 600,
     String(expectedReturnFor({ amount: 10000, annualRate: 0.12, termMonths: 6 })));
  ok('and the cron uses it rather than its own copy',
     !/Math\.round\(amount \* annualRate/.test(
       fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'recurringCron.js'), 'utf8')),
     'two formulas is two answers the day one is corrected');
}

(async () => {
  if (!process.env.DATABASE_URL) {
    fail++;
    console.log('\n  ✗ the money half needs a database');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const pool = require(path.join(ROOT, 'server', 'db', 'pool.js'));
  const fr   = require(path.join(ROOT, 'server', 'services', 'feeReversal.js'));
  const ACTOR = { kind: 'staff', id: 'u-fr', email: 'k@svcapital.co.za', role: 'admin', ip: '1.1.1.1' };

  const AMT = 10000, FEE = Math.round(AMT * PLATFORM_FEE_PCT * 100) / 100;

  async function fixture({ sub = null, status = 'active', fee = FEE, stokvel = false } = {}) {
    await pool.query(`DELETE FROM transactions WHERE investor_id = 'INV-FR'`);
    await pool.query(`DELETE FROM investments WHERE id = 'INVST-FR'`);
    await pool.query(`DELETE FROM stokvel_members WHERE sub_account_id = 'SA-FR'`);
    await pool.query(`DELETE FROM sub_accounts WHERE id = 'SA-FR'`);
    await pool.query(`DELETE FROM investment_pools WHERE id = 'POOL-FR'`);
    await pool.query(`DELETE FROM investors WHERE id IN ('INV-FR','INV-FR2')`);

    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email, wallet_balance, status)
       VALUES ('INV-FR','Thandi','M','fr@example.test',0,'active'),
              ('INV-FR2','Other','P','fr2@example.test',0,'active')`);
    await pool.query(
      `INSERT INTO investment_pools (id, name, product_type, annual_rate, term_months,
                                     current_invested, raised_amount, status)
       VALUES ('POOL-FR','Cattle November','cattle',0.13,12,$1,$1,'open')`, [AMT]);
    if (sub) {
      await pool.query(
        `INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, status, wallet_balance)
         VALUES ('SA-FR','INV-FR2','Ubuntu Club',$1,'active',0)`, [stokvel ? 'stokvel' : 'minor']);
      if (stokvel) {
        await pool.query(
          `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, status)
           VALUES ('SM-FR1','SA-FR','INV-FR2','chairperson','active'),
                  ('SM-FR2','SA-FR','INV-FR','member','active')`);
      }
    }
    await pool.query(
      `INSERT INTO investments (id, investor_id, sub_account_id, pool_id, pool_name, amount,
                                status, annual_rate, term_months, expected_return, product_type)
       VALUES ('INVST-FR','INV-FR',$1,'POOL-FR','Cattle November',$2,$3,0.13,12,$4,'cattle')`,
      [sub, AMT, status, expectedReturnFor({ amount: AMT, annualRate: 0.13, termMonths: 12 })]);
    if (fee) {
      await pool.query(
        `INSERT INTO transactions (id, investor_id, sub_account_id, investment_id, type, amount,
                                   status, reference, description, actor_kind, actor_role)
         VALUES ('FEE-INVST-FR','INV-FR',$1,'INVST-FR','fee',$2,'completed','FEE-INVST-FR',
                 '1% platform fee on investment','staff','admin')`, [sub, fee]);
    }
  }

  const wallet = async id => Number((await pool.query(
    `SELECT wallet_balance FROM investors WHERE id=$1`, [id])).rows[0].wallet_balance);
  const saWallet = async () => Number((await pool.query(
    `SELECT wallet_balance FROM sub_accounts WHERE id='SA-FR'`)).rows[0].wallet_balance);
  const investment = async () => (await pool.query(
    `SELECT amount, expected_return FROM investments WHERE id='INVST-FR'`)).rows[0];

  try {
    console.log('\nback to the wallet');
    await fixture();
    let a = await fr.assess(pool, 'INVST-FR');
    ok('the fee is found and both destinations offered',
       a.ok && a.amount === FEE && a.destinations.wallet && a.destinations.investment,
       JSON.stringify(a.reason || a.destinations));
    let out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet',
                                 reason: 'Charged in error', actor: ACTOR });
    ok('it is reversed', out.ok && out.amount === FEE, JSON.stringify(out));
    ok('and the wallet is up by exactly the fee', (await wallet('INV-FR')) === FEE,
       String(await wallet('INV-FR')));
    const inv1 = await investment();
    ok('the investment is untouched', Number(inv1.amount) === AMT, String(inv1.amount));
    ok('the fee row is stamped reversed',
       !!(await pool.query(`SELECT reversed_at FROM transactions WHERE id='FEE-INVST-FR'`))
         .rows[0].reversed_at);
    const { rows: [rev] } = await pool.query(
      `SELECT type, amount FROM transactions WHERE type='fee_reversal' AND investor_id='INV-FR'`);
    ok('and the credit is typed fee_reversal, not a negative fee',
       !!rev && Number(rev.amount) === FEE, JSON.stringify(rev));

    console.log('\nand it cannot be done twice');
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet',
                             reason: 'again', actor: ACTOR });
    ok('a second attempt is refused', out.ok === false, JSON.stringify(out));
    ok('and the wallet did not move again', (await wallet('INV-FR')) === FEE,
       String(await wallet('INV-FR')));

    /* The stamp and the reference are two independent gates, and a check
       that only ever exercises the first cannot tell whether the second
       works. The stamp is cleared here so the reference has to hold it on
       its own — which is the one that survives a stamp somebody undid. */
    await pool.query(
      `UPDATE transactions SET reversed_at = NULL, reversed_reference = NULL
        WHERE id='FEE-INVST-FR'`);
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet',
                             reason: 'third time', actor: ACTOR });
    ok('the reference alone stops a third attempt',
       out.ok === false && out.alreadyDone === true, JSON.stringify(out));
    ok('and still nothing moved', (await wallet('INV-FR')) === FEE,
       String(await wallet('INV-FR')));

    console.log('\ninto the investment');
    await fixture();
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'investment',
                             reason: 'Goodwill on a late pool', actor: ACTOR });
    ok('it is reversed', out.ok === true, JSON.stringify(out));
    const inv2 = await investment();
    ok('the principal is up by the fee', Number(inv2.amount) === AMT + FEE, String(inv2.amount));
    ok('and the expected return moved with it',
       Number(inv2.expected_return)
         === expectedReturnFor({ amount: AMT + FEE, annualRate: 0.13, termMonths: 12 }),
       `${inv2.expected_return} — a principal that rises without its expected `
       + 'return pays the wrong figure at maturity, months later');

    ok('the wallet nets to zero, because the money never stopped there',
       (await wallet('INV-FR')) === 0, String(await wallet('INV-FR')));
    const { rows: pair } = await pool.query(
      `SELECT type FROM transactions WHERE investment_id='INVST-FR'
         AND type IN ('fee_reversal','reinvestment') ORDER BY type`);
    ok('and both halves are on the ledger, so no deposit is invented',
       pair.length === 2 && pair[0].type === 'fee_reversal' && pair[1].type === 'reinvestment',
       JSON.stringify(pair));
    const { rows: [p] } = await pool.query(
      `SELECT current_invested, raised_amount FROM investment_pools WHERE id='POOL-FR'`);
    ok('the pool holds what its investments now say it holds',
       Number(p.current_invested) === AMT + FEE && Number(p.raised_amount) === AMT + FEE,
       JSON.stringify(p));

    /* SCALED, NOT RECOMPUTED. Found in live data: an investment of R30 000
       at 13,92% over five months carries a STORED expected return of
       R1 741,50 where the formula gives R1 740,00. The stored figure came
       from somewhere else, and recomputing it would move a client's
       expected return by R1,50 for a reason unrelated to the fee. */
    await fixture();
    await pool.query(
      `UPDATE investments SET expected_return = 1741.50, amount = 30000,
              annual_rate = 0.1392, term_months = 5 WHERE id='INVST-FR'`);
    await pool.query(`UPDATE transactions SET amount = 300 WHERE id='FEE-INVST-FR'`);
    const a2 = await fr.assess(pool, 'INVST-FR');
    ok('a stored figure is scaled by the change in principal',
       Math.abs(a2.wouldBecome.expectedReturn - 1758.92) < 0.005,
       `${a2.wouldBecome.expectedReturn} — scaling 1741.50 by 30300/30000 gives `
       + '1758.92; the formula would have given 1757.40 and quietly changed '
       + 'the basis of a figure somebody else set');
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'investment',
                             reason: 'Goodwill', actor: ACTOR });
    ok('and that is what is written', out.ok
       && Math.abs(Number((await investment()).expected_return) - 1758.92) < 0.005,
       String((await investment()).expected_return));
    ok('while an investment with no figure yet falls back to the formula',
       fr.grownExpectedReturn({ amount: 10000, expected_return: 0,
                                annual_rate: 0.13, term_months: 12 }, 10100) === 1313,
       String(fr.grownExpectedReturn({ amount: 10000, expected_return: 0,
                                       annual_rate: 0.13, term_months: 12 }, 10100)));

    console.log('\nand a finished investment has nowhere to put it');
    await fixture({ status: 'matured' });
    a = await fr.assess(pool, 'INVST-FR');
    ok('adding to it is not offered', a.destinations.investment === false);
    ok('but the wallet still is', a.destinations.wallet === true);
    ok('and the refusal says why, and what can be done instead',
       /matured/.test(a.investmentBlockedBecause || '')
       && /wallet/.test(a.investmentBlockedBecause || ''),
       a.investmentBlockedBecause);
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'investment',
                             reason: 'x', actor: ACTOR });
    ok('and trying anyway is refused', out.ok === false, JSON.stringify(out));
    ok('with nothing written', Number((await investment()).amount) === AMT);

    console.log('\nand a sub-account fee goes back where it came from');
    await fixture({ sub: 'SA-FR' });
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet',
                             reason: 'Charged in error', actor: ACTOR });
    ok('it is reversed', out.ok === true, JSON.stringify(out));
    ok('the sub-account wallet has it', (await saWallet()) === FEE, String(await saWallet()));
    ok('and the member’s own wallet does not',
       (await wallet('INV-FR')) === 0,
       'the fee left the sub-account; returning it to the member moves money '
       + 'between two people’s records');

    console.log('\nand a stokvel’s members are told their share of it');
    await fixture({ sub: 'SA-FR', stokvel: true });
    const allocated = async () => Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM stokvel_allocations
        WHERE sub_account_id='SA-FR'`)).rows[0].total);
    /* Shared out FIRST, so what is measured is the change this reversal
       caused. reconcile allocates all unallocated net assets, which on a
       fresh group is everything it holds — comparing the total against the
       fee tested the fixture, not the feature. */
    const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));
    {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await shares.reconcile(c, 'SA-FR', { reason: 'baseline' });
        await c.query('COMMIT');
      } finally { c.release(); }
    }
    const before = await allocated();
    out = await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet',
                             reason: 'Fee-free cycle', actor: ACTOR });
    ok('it is reversed into the group wallet',
       out.ok === true && (await saWallet()) === FEE, JSON.stringify(out));
    const after = await allocated();
    ok('and the share ledger has shared the fee out too',
       Math.abs((after - before) - FEE) < 0.01,
       `allocations moved ${(after - before).toFixed(2)}, the fee was ${FEE}`);
    const { rows: holders } = await pool.query(
      `SELECT COUNT(DISTINCT investor_id)::int AS n FROM stokvel_allocations
        WHERE sub_account_id='SA-FR'`);
    ok('between the members, not to one of them',
       holders[0].n === 2, `${holders[0].n} member(s) hold a share`);
    console.log('\nand the rules that keep it accountable');
    await fixture();
    let threw = null;
    try { await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet', reason: '  ', actor: ACTOR }); }
    catch (e) { threw = e.message; }
    ok('a reversal with no reason is refused', /reason is required/.test(threw || ''), threw);
    threw = null;
    try { await fr.reverse({ investmentId: 'INVST-FR', destination: 'pocket', reason: 'x', actor: ACTOR }); }
    catch (e) { threw = e.message; }
    ok('and so is an invented destination', /destination must be/.test(threw || ''), threw);
    threw = null;
    try { await fr.reverse({ investmentId: 'INVST-FR', destination: 'wallet', reason: 'x', actor: null }); }
    catch (e) { threw = e.message; }
    ok('and one with nobody behind it', /actor/.test(threw || ''), threw);
    ok('none of which moved any money', (await wallet('INV-FR')) === 0);

    await fixture({ fee: 0 });
    a = await fr.assess(pool, 'INVST-FR');
    ok('an investment with no fee says so rather than inventing one',
       a.ok === false && /No platform fee/.test(a.reason), JSON.stringify(a.reason));

    console.log('\nand staff can see and do it');
    const adm = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
    ok('the investment detail asks the server what is possible',
       /_loadFeeReversal\(inv\.id\)/.test(adm)
       && /admin\/investments\/\$\{encodeURIComponent\(investmentId\)\}\/fee-reversal/.test(adm),
       'a screen that works out for itself whether a fee can be reversed '
       + 'offers buttons that fail');
    ok('both destinations are offered',
       /reverseFee\('\$\{_esc\(inv\.id\)\}','wallet'\)/.test(adm)
       && /reverseFee\('\$\{_esc\(inv\.id\)\}','investment'\)/.test(adm));
    ok('the one that cannot be used is disabled, with the reason on it',
       /canInvest \? '' : 'disabled'/.test(adm)
       && /investmentBlockedBecause/.test(adm));
    ok('and it will not submit without a reason',
       /Please say why this fee is being given back/.test(adm),
       'the server refuses it anyway; saying so here saves a round trip and '
       + 'puts the message under the field the person has to fill in');
    /* The call itself, not the comment above it. */
    const callLine = adm.split('\n').find(l => /_loadFeeReversal\(inv\.id\)/.test(l)) || '';
    ok('the panel failing does not stop the investment opening',
       !/await/.test(callLine) && /typeof _loadFeeReversal === 'function'/.test(callLine),
       `${callLine.trim()} — an extra that can take the screen down with it, `
       + 'or that the detail waits on, is not an extra');

    console.log('\nand no client can reach any of it');
    const routes = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
    ok('the endpoints sit behind the admin guard',
       /router\.use\(requireAuth, requireRole\('admin', 'director'\)\)/.test(routes)
       && routes.indexOf("router.use(requireAuth") < routes.indexOf("'/investments/:id/fee-reversal'"),
       'giving money back is not something a client does for themselves');
  } catch (e) {
    fail++;
    console.log(`  ✗ the money half threw\n      ${e.stack || e.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
