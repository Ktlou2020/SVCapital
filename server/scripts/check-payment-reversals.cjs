#!/usr/bin/env node
/* When a card payment is taken back.
 *
 * The webhook was one line: `if (event !== 'charge.success') return;`. So a
 * dispute, a refund or a reversal was dropped on the floor while Paystack
 * took the money back from SV Capital, and the client's wallet went on
 * showing the credit. Every balance on the platform was overstated by
 * exactly the amount somebody had taken back.
 *
 * Automatic collection made it likely rather than rare: a card charged every
 * month without the client present is the exact pattern that produces "I do
 * not recognise this debit".
 *
 * The hard case is a stokvel. By the time a dispute arrives the contribution
 * has moved into the group's pot and been shared across every member's
 * ledger, so taking it back takes it from people who did nothing. That is a
 * conversation with a committee, not a database write, and the thing most
 * worth checking here is that this code REFUSES to do it.
 *
 * Run: DATABASE_URL=… node server/scripts/check-payment-reversals.cjs
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

console.log('the webhook no longer drops everything but one event');
{
  const pay = read('server/routes/payments.js');
  /* Matched on the STATEMENT, not on the text: the comment above it quotes
     the old line, and an indexOf found that instead — the assertion was
     comparing a position in prose with a position in code. */
  const successGuard = pay.search(/\n\s*if \(event !== 'charge\.success'\) return;/);
  const reverseGuard = pay.search(/\n\s*if \(reversals\.REVERSING_EVENTS\[event\]\)/);
  ok('a reversing event is routed before the success path',
     reverseGuard > -1 && successGuard > -1 && reverseGuard < successGuard,
     'returning early on anything that is not charge.success is what dropped '
     + 'every dispute on the floor');

  const { REVERSING_EVENTS } = require(path.join(ROOT, 'server', 'services', 'reversals.js'));
  for (const e of ['charge.dispute.create', 'charge.dispute.resolve',
                   'refund.processed', 'charge.reversed']) {
    ok(`${e} is handled`, !!REVERSING_EVENTS[e]);
  }
  ok('and the signature is still checked before any of it',
     pay.indexOf('x-paystack-signature') < reverseGuard,
     'anybody could otherwise post a dispute and drain a wallet');

  const { CASH_DEBIT_TYPES } = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
  ok('a reversal counts as money leaving',
     CASH_DEBIT_TYPES.includes('reversal'),
     'left out of the debit list, a reversed deposit stays counted as money '
     + 'the platform holds and every derived balance is overstated');
}

(async () => {
  if (!process.env.DATABASE_URL) {
    fail++;
    console.log('\n  ✗ the clawing-back half needs a database');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const pool      = require(path.join(ROOT, 'server', 'db', 'pool.js'));
  const reversals = require(path.join(ROOT, 'server', 'services', 'reversals.js'));

  async function fixture({ wallet, deposit, spentOn = null, groupName = null }) {
    await pool.query(`DELETE FROM payment_reversals WHERE reference LIKE 'RV-%'`);
    await pool.query(`DELETE FROM platform_incidents WHERE source LIKE 'paystack%'`);
    await pool.query(`DELETE FROM transactions WHERE investor_id = 'INV-RV'`);
    await pool.query(`DELETE FROM sub_accounts WHERE id = 'SA-RV'`);
    await pool.query(`DELETE FROM investors WHERE id IN ('INV-RV','INV-RVC')`);

    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email, wallet_balance, status)
       VALUES ('INV-RVC','Chair','P','chair-rv@example.test',0,'active'),
              ('INV-RV','Thandi','M','thandi-rv@example.test',$1,'active')`, [wallet]);
    await pool.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description,
                                 actor_kind, actor_role, created_at)
       VALUES ('TX-RV-DEP','INV-RV','deposit',$1,'completed','RV-REF-1','Card top-up',
               'client','investor', NOW() - INTERVAL '2 hours')`, [deposit]);
    await pool.query(`UPDATE transactions SET gateway = 'paystack' WHERE id = 'TX-RV-DEP'`);

    if (spentOn === 'stokvel_contribution') {
      await pool.query(
        `INSERT INTO sub_accounts (id, parent_investor_id, name, account_type, status, wallet_balance)
         VALUES ('SA-RV','INV-RVC',$1,'stokvel','active',0)`, [groupName || 'Ubuntu Club']);
      await pool.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description,
                                   sub_account_id, actor_kind, actor_role, created_at)
         VALUES ('TX-RV-SPEND','INV-RV','stokvel_contribution',$1,'completed','RV-SPEND','Contribution',
                 'SA-RV','client','investor', NOW() - INTERVAL '1 hour')`, [deposit]);
    } else if (spentOn) {
      await pool.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description,
                                   actor_kind, actor_role, created_at)
         VALUES ('TX-RV-SPEND','INV-RV',$2,$1,'completed','RV-SPEND','Spent',
                 'client','investor', NOW() - INTERVAL '1 hour')`, [deposit, spentOn]);
    }
  }

  const dispute = (amount, extra = {}) => ({
    event: 'charge.dispute.create',
    data: { id: `DSP-${Date.now()}-${Math.random()}`, amount: Math.round(amount * 100),
            transaction: { reference: 'RV-REF-1' }, status: 'awaiting-merchant-feedback', ...extra },
  });

  const wallet = async () => Number(
    (await pool.query(`SELECT wallet_balance FROM investors WHERE id='INV-RV'`)).rows[0].wallet_balance);
  const openIncidents = async () => (await pool.query(
    `SELECT severity, message FROM platform_incidents WHERE source LIKE 'paystack%'`)).rows;

  try {
    console.log('\nand what the wallet still holds is taken back');
    await fixture({ wallet: 500, deposit: 500 });
    let out = await reversals.record(dispute(500));
    ok('the whole amount is recovered', out && out.recovered === 500, JSON.stringify(out));
    ok('and the wallet is down by it', (await wallet()) === 0, String(await wallet()));
    ok('with a reversal row on the ledger',
       (await pool.query(`SELECT 1 FROM transactions WHERE investor_id='INV-RV' AND type='reversal'`)).rowCount === 1);
    ok('the original is marked reversed',
       !!(await pool.query(`SELECT reversed_at FROM transactions WHERE id='TX-RV-DEP'`)).rows[0].reversed_at,
       'a statement that still shows it as a plain deposit is telling the '
       + 'client they have money nobody has');
    /* Not "nobody is told" — a dispute has to be ANSWERED or Paystack
       awards it against us by default, and that costs the full amount
       whether or not the wallet covered it. The money is only safe once
       somebody has replied with the evidence. */
    let inc0 = await openIncidents();
    ok('but somebody is still told a dispute was opened',
       inc0.length === 1 && inc0[0].severity === 'warning',
       JSON.stringify(inc0));
    ok('and told that leaving it unanswered loses it',
       /lost by default/.test(inc0[0].message), inc0[0].message);
    ok('and it is not raised as critical, because the money was recovered',
       !inc0.some(i => i.severity === 'critical'), JSON.stringify(inc0));

    console.log('\nand the wallet is never driven negative');
    await fixture({ wallet: 200, deposit: 500 });
    out = await reversals.record(dispute(500));
    ok('only what was there is taken', out.recovered === 200, JSON.stringify(out));
    ok('the wallet rests at zero, not below it', (await wallet()) === 0, String(await wallet()));
    ok('and the rest is recorded as a shortfall', out.shortfall === 300, JSON.stringify(out));
    let inc = await openIncidents();
    const critical = inc.filter(i => i.severity === 'critical');
    ok('which somebody is told about', critical.length === 1, JSON.stringify(inc));
    ok('and the message says how much could not be taken back',
       /R300\.00/.test(critical[0].message), critical[0].message);

    console.log('\nand a stokvel is never clawed back from');
    await fixture({ wallet: 0, deposit: 500, spentOn: 'stokvel_contribution', groupName: 'Ubuntu Club' });
    out = await reversals.record(dispute(500));
    ok('nothing is taken from the member', out.recovered === 0, JSON.stringify(out));
    ok('and nothing from the group either',
       Number((await pool.query(`SELECT wallet_balance FROM sub_accounts WHERE id='SA-RV'`)).rows[0].wallet_balance) === 0,
       'taking R500 out of a pot because one member’s card was disputed '
       + 'takes it from everybody else in the group');
    inc = (await openIncidents()).filter(i => i.severity === 'critical');
    ok('a human is asked to deal with it', inc.length === 1, JSON.stringify(inc));
    ok('and the group is named, because that is what changes what they do',
       /Ubuntu Club/.test(inc[0].message) && /shared across its members/.test(inc[0].message),
       inc[0].message);

    console.log('\nand the same dispute twice is not charged twice');
    await fixture({ wallet: 500, deposit: 500 });
    const d = dispute(500);
    await reversals.record(d);
    /* Topped up AFTER the dispute, which is the case that matters: with an
       empty wallet a second debit takes nothing and a broken guard looks
       exactly like a working one. */
    await pool.query(`UPDATE investors SET wallet_balance = 500 WHERE id='INV-RV'`);
    await reversals.record({ ...d, event: 'charge.dispute.remind' });
    ok('a reminder takes nothing further, even from a wallet since topped up',
       (await wallet()) === 500, String(await wallet()));
    ok('and there is one reversal row, not two',
       (await pool.query(`SELECT 1 FROM transactions WHERE investor_id='INV-RV' AND type='reversal'`)).rowCount === 1);

    console.log('\nand a dispute we win takes nothing at all');
    await fixture({ wallet: 500, deposit: 500 });
    out = await reversals.record({
      event: 'charge.dispute.resolve',
      data: { id: 'DSP-WON', amount: 50000, transaction: { reference: 'RV-REF-1' },
              status: 'resolved-merchant-accepted' } });
    ok('the wallet is untouched', (await wallet()) === 500, String(await wallet()));
    ok('and it is recorded as resolved in our favour', out.status === 'reversed_back',
       JSON.stringify(out));

    console.log('\nand a dispute for a charge we never saw wakes somebody');
    await fixture({ wallet: 0, deposit: 500 });
    await pool.query(`DELETE FROM transactions WHERE id='TX-RV-DEP'`);
    out = await reversals.record(dispute(500));
    ok('nothing is invented', out === null, JSON.stringify(out));
    inc = (await openIncidents()).filter(i => i.severity === 'critical');
    ok('and it is raised as critical',
       inc.length === 1 && /not a payment we recorded/.test(inc[0].message),
       JSON.stringify(inc));

    console.log('\nand the two books are compared, not assumed to agree');
    const paystack  = require(path.join(ROOT, 'server', 'services', 'paystack.js'));
    const reconcile = require(path.join(ROOT, 'server', 'services', 'paystackReconcile.js'));
    const real = paystack.listTransactions;

    await fixture({ wallet: 500, deposit: 500 });
    paystack.listTransactions = async () => ({ ok: true, data: [
      { reference: 'RV-REF-1', amount: 50000 },
      { reference: 'RV-GHOST', amount: 25000 },
    ] });
    let cmp = await reconcile.compareDay(new Date());
    ok('a charge the gateway took and we never credited is found',
       cmp.onlyAtGateway.length === 1 && cmp.onlyAtGateway[0].reference === 'RV-GHOST',
       JSON.stringify(cmp.onlyAtGateway) + ' — the client is out of pocket and waiting');

    paystack.listTransactions = async () => ({ ok: true, data: [] });
    cmp = await reconcile.compareDay(new Date());
    ok('and a credit the gateway has no charge for is found too',
       cmp.onlyHere.some(r => r.reference === 'RV-REF-1'),
       JSON.stringify(cmp.onlyHere));

    await pool.query(`UPDATE transactions SET reversed_at = NOW() WHERE id='TX-RV-DEP'`);
    cmp = await reconcile.compareDay(new Date());
    ok('but one already reversed is not reported again',
       !cmp.onlyHere.some(r => r.reference === 'RV-REF-1'),
       'an alert that fires for every reversal this already handled is an '
       + 'alert somebody turns off');

    paystack.listTransactions = async () => ({ ok: false, reason: 'timeout', data: [], partial: true });
    cmp = await reconcile.compareDay(new Date());
    ok('and a read that only half worked reports nothing rather than everything',
       cmp.ok === false && cmp.onlyAtGateway.length === 0 && cmp.onlyHere.length === 0,
       'reporting the rows it never fetched as missing is a page of false '
       + 'alarms every morning');
    paystack.listTransactions = real;
  } catch (e) {
    fail++;
    console.log(`  ✗ the clawing-back half threw\n      ${e.stack || e.message}`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
