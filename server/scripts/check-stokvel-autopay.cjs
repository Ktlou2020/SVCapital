#!/usr/bin/env node
/* Collecting a contribution without asking every month.
 *
 * A stokvel is a group of people paying a fixed amount on a fixed day, and
 * every one of them had to remember to do it by hand. Most of what the
 * arrears screen shows is not somebody refusing to pay; it is friction.
 *
 * Four things here are easy to get wrong and expensive when you do, so each
 * is constructed on purpose rather than hoped for:
 *
 *   charging a card when the wallet already had the money — R9,64 of gateway
 *   fee for nothing, on every member, every month;
 *
 *   refusing to pay anything because the card declined, when the wallet held
 *   part of it and part payment has always been accepted;
 *
 *   retrying a dead card for ever, which is a failed-payment notification a
 *   day until somebody mutes us;
 *
 *   and a reference that changes between attempts, which turns off the one
 *   thing stopping a member being charged twice.
 *
 * Run: DATABASE_URL=… node server/scripts/check-stokvel-autopay.cjs
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
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const paystack = require(path.join(ROOT, 'server', 'services', 'paystack.js'));

console.log('the card is charged what it takes for the money to arrive');
{
  /* The member asked for R500 to reach the pot. R500 must reach the pot. */
  const g = paystack.grossUp(500);
  const feeTaken = Math.min(g.gross * paystack.FEE_RATE + paystack.FEE_FLAT, paystack.FEE_CAP);
  ok('what lands after the gateway takes its cut is what was asked for',
     Math.abs((g.gross - feeTaken) - 500) < 0.01,
     `charged ${g.gross}, fee ${feeTaken.toFixed(2)}, landed ${(g.gross - feeTaken).toFixed(2)}`);
  ok('and the fee is on top, never taken out of it', g.gross > 500);

  const big = paystack.grossUp(100000);
  ok('the cap applies at the top end', big.fee === paystack.FEE_CAP, String(big.fee));
  ok('nothing is charged for nothing', paystack.grossUp(0).gross === 0);

  ok('there is one definition of the fee, not one per caller',
     !/0\.985|\/ 0\.985/.test(read('server/jobs/recurringCron.js')),
     'auto top-up carried its own copy; two copies is two answers the day '
     + 'the rate changes');
}

console.log('\nand a reference is one obligation, for ever');
{
  const autopay = require(path.join(ROOT, 'server', 'services', 'stokvelAutopay.js'));
  const a = autopay.referenceFor({ id: 'SC-ABC123' });
  const b = autopay.referenceFor({ id: 'SC-ABC123' });
  ok('the same obligation gives the same reference', a === b, `${a} vs ${b}`);
  ok('a different one does not', a !== autopay.referenceFor({ id: 'SC-XYZ789' }));
  ok('and it carries no date',
     !/\d{8}/.test(a),
     'a reference that changes each day turns off Paystack’s duplicate '
     + 'refusal, which is the thing stopping a member being charged twice '
     + 'for the same month');
}

console.log('\nand nobody can arrange a debit against somebody else’s card');
{
  const routes = read('server/routes/stokvels.js');
  const route = routes.slice(routes.indexOf("router.put('/:id/autopay'"),
                              routes.indexOf("router.put('/:id/autopay'") + 2000);
  ok('the toggle acts on the caller and takes no member id',
     /investor_id = \$2/.test(route) && !/req\.body[\s\S]{0,40}investor_id/.test(route),
     'a treasurer who could switch this on for other members would be '
     + 'arranging debits against other people’s cards');
  ok('and it refuses when there is no card to charge',
     /There is no card on your account yet/.test(route));
}

(async () => {
  if (!process.env.DATABASE_URL) {
    fail++;
    console.log('\n  ✗ the collecting half needs a database');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const pool = require(path.join(ROOT, 'server', 'db', 'pool.js'));
  const autopay = require(path.join(ROOT, 'server', 'services', 'stokvelAutopay.js'));

  /* The gateway, stubbed. What is under test is what this platform does with
     an answer, not Paystack. */
  let charges = [];
  let answer = { ok: true };
  const realCharge = paystack.charge;
  paystack.charge = async (args) => {
    charges.push(args);
    const g = paystack.grossUp(args.net);
    return answer.ok
      ? { ok: true, ...g, reference: args.reference, declined: false, reason: null }
      : { ok: false, ...g, reference: args.reference, declined: true, reason: answer.reason || 'declined' };
  };

  async function fixture({ wallet, due, paid = 0 }) {
    await pool.query(`DELETE FROM stokvel_contributions WHERE id LIKE 'SC-AP%'`);
    await pool.query(`DELETE FROM stokvel_members WHERE sub_account_id = 'SA-AP'`);
    await pool.query(`DELETE FROM paystack_authorizations WHERE investor_id = 'INV-AP'`);
    await pool.query(`DELETE FROM sub_accounts WHERE id = 'SA-AP'`);
    await pool.query(`DELETE FROM investors WHERE id IN ('INV-AP','INV-APC')`);

    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email, wallet_balance, status)
       VALUES ('INV-APC','Chair','P','chair@example.test',0,'active'),
              ('INV-AP','Thandi','M','thandi@example.test',$1,'active')`, [wallet]);
    await pool.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, status, wallet_balance)
       VALUES ('SA-AP','INV-APC','Ubuntu Club','stokvel','active',0)`);
    await pool.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, status, autopay_enabled)
       VALUES ('SM-APC','SA-AP','INV-APC','chairperson','active',false),
              ('SM-AP','SA-AP','INV-AP','member','active',true)`);
    await pool.query(
      `INSERT INTO paystack_authorizations (investor_id, authorization_code, email, last4)
       VALUES ('INV-AP','AUTH_test','thandi@example.test','4242')`);
    await pool.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
       VALUES ('SC-AP1','SA-AP','INV-AP','2026-11',$1,$2,CURRENT_DATE,'due')`, [due, paid]);
    charges = [];
  }

  const one = async () => (await autopay.collectable(pool))[0];

  try {
    console.log('\nand the wallet is used before the card is');
    await fixture({ wallet: 600, due: 500 });
    let item = await one();
    ok('a member whose contribution is due is collectable', !!item, JSON.stringify(item));
    let out = await autopay.collectOne(item);
    ok('the contribution is paid', out.paid === 500 && out.settled === true, JSON.stringify(out));
    ok('and the card was never touched', charges.length === 0,
       `${charges.length} charge(s) — R9,64 of gateway fee, on every member, `
       + 'every month, for money that was already there');
    let { rows: [c] } = await pool.query(`SELECT * FROM stokvel_contributions WHERE id='SC-AP1'`);
    ok('the obligation is settled', c.status === 'paid', c.status);
    let { rows: [w] } = await pool.query(`SELECT wallet_balance FROM investors WHERE id='INV-AP'`);
    ok('and the wallet is down by exactly the contribution',
       Math.abs(Number(w.wallet_balance) - 100) < 0.01, String(w.wallet_balance));

    console.log('\nand only the shortfall reaches the card');
    await fixture({ wallet: 200, due: 500 });
    answer = { ok: true };
    out = await autopay.collectOne(await one());
    ok('one charge was made', charges.length === 1, String(charges.length));
    ok('for the part the wallet could not cover, not the whole contribution',
       charges[0] && charges[0].net === 300,
       charges[0] ? `charged for ${charges[0].net}, wallet held 200 of 500` : 'no charge');
    ok('and the contribution is settled in full', out.paid === 500 && out.settled, JSON.stringify(out));

    console.log('\nand a declined card still pays what the wallet holds');
    await fixture({ wallet: 300, due: 500 });
    answer = { ok: false, reason: 'Insufficient funds' };
    out = await autopay.collectOne(await one());
    ok('the card was tried', charges.length === 1);
    ok('the wallet’s share was still paid', out.paid === 300,
       JSON.stringify(out) + ' — refusing the whole thing leaves a member '
       + 'further behind than doing nothing');
    ok('and it is recorded as a part payment, still owing',
       out.part === true && Math.abs(Number(out.outstanding) - 200) < 0.01,
       JSON.stringify(out));
    ({ rows: [c] } = await pool.query(`SELECT * FROM stokvel_contributions WHERE id='SC-AP1'`));
    ok('the obligation stays open to be chased', c.status === 'due', c.status);
    ok('and says why the card failed',
       /Insufficient funds/.test(c.autopay_last_error || ''), c.autopay_last_error);

    console.log('\nand a dead card is not retried for ever');
    await fixture({ wallet: 0, due: 500 });
    answer = { ok: false, reason: 'Card declined' };
    for (let i = 0; i < autopay.MAX_ATTEMPTS; i++) {
      const it = await one();
      if (it) await autopay.collectOne(it);
    }
    ({ rows: [c] } = await pool.query(`SELECT * FROM stokvel_contributions WHERE id='SC-AP1'`));
    ok(`it stops after ${autopay.MAX_ATTEMPTS} attempts`,
       Number(c.autopay_attempts) === autopay.MAX_ATTEMPTS, String(c.autopay_attempts));
    ok('and is not offered again',
       (await autopay.collectable(pool)).length === 0,
       'a card that keeps declining is a failed-payment notification a day '
       + 'until somebody mutes us');

    console.log('\nand no database connection is left behind');
    /* Found the hard way: the client taken for a successful charge was never
       released, so the pool drained one collection at a time until the whole
       server could no longer reach the database. The only symptom was this
       check hanging instead of finishing. */
    for (let i = 0; i < 6; i++) {
      await fixture({ wallet: 100, due: 500 });
      answer = { ok: true };
      await autopay.collectOne(await one());
    }
    ok('every borrowed client is given back',
       pool.checkedOut === 0,
       `${pool.checkedOut} still checked out after six `
       + 'collections — a pool that drains takes the whole server with it');

    console.log('\nand only the people who asked for it are collected from');
    await fixture({ wallet: 600, due: 500 });
    await pool.query(`UPDATE stokvel_members SET autopay_enabled = false WHERE id='SM-AP'`);
    ok('autopay off means not collectable', (await autopay.collectable(pool)).length === 0);
    await pool.query(`UPDATE stokvel_members SET autopay_enabled = true, status='exited' WHERE id='SM-AP'`);
    ok('and a member who has left is not collected from either',
       (await autopay.collectable(pool)).length === 0,
       'their membership ended; their card did not');
    await pool.query(`UPDATE stokvel_members SET status='active' WHERE id='SM-AP'`);
    await pool.query(`DELETE FROM paystack_authorizations WHERE investor_id='INV-AP'`);
    ok('nor is somebody with no card on file',
       (await autopay.collectable(pool)).length === 0);
  } catch (e) {
    fail++;
    console.log(`  ✗ the collecting half threw\n      ${e.stack || e.message}`);
  } finally {
    paystack.charge = realCharge;
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
