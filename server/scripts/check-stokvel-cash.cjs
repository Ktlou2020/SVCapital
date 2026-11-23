#!/usr/bin/env node
/* Cash, which is how a stokvel actually collects.
 *
 * A stokvel meets and money changes hands in the room. A member could pay
 * only from their own SV Capital wallet, so a fifteen-year-old burial
 * society could not move onto the platform without converting every member
 * to a card on day one — which is never day one. Mama Dlamini put R500 on
 * the table and nothing could record it: her row stayed overdue, the
 * arrears list lied to the committee, the reminder chased a woman who had
 * paid, and her share was understated at the payout.
 *
 * THE SPLIT BETWEEN THE TWO STEPS IS THE WHOLE DESIGN, and it is what this
 * check exists to hold:
 *
 *   RECORDING MOVES NOTHING. The money is in the treasurer's hands, not in
 *   the group's account. A share ledger that counted it would claim SV
 *   Capital holds money it does not hold, which is the one way this ledger
 *   must never be wrong. So the wallet does not move, no share moves, and
 *   what changes is what the member's row SAYS.
 *
 *   SETTLING IS BOUNDED BY A DEPOSIT THAT REALLY ARRIVED. A group's wallet
 *   also grows from interest, from a maturing investment, from a refund —
 *   settling against whatever happens to be there would quietly hand one
 *   member money belonging to all of them. Each receipt is tied to a
 *   deposit reference, and one deposit can never settle more than it
 *   brought in however many times the button is pressed.
 *
 * AND THROUGHOUT, THE INVARIANT:
 *
 *     Σ active members' shares = wallet + invested − unpaid exit debts
 *
 * Settling says WHOSE an already-banked amount was. It must not change how
 * much there is. Every assertion about a share below is made with that
 * audit run beside it.
 *
 * Run: DATABASE_URL=… node server/scripts/check-stokvel-cash.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const sent = [];
function stub() {
  return new Proxy({}, { get(_t, k) {
    if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
    return (...a) => { sent.push({ fn: k, args: a }); return Promise.resolve({ ok: true }); };
  } });
}
for (const f of ['email.js', 'pushService.js', 'sms.js', 'stokvelNotify.js']) {
  const p = path.join(ROOT, 'server', 'services', f);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: stub() };
}

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_cash_receipts') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no cash receipt table here'); return; }

    const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));

    const clean = async () => {
      for (const t of ['stokvel_cash_receipts', 'stokvel_allocations', 'stokvel_exit_debts',
                       'stokvel_contributions', 'stokvel_members'])
        await db.query(`DELETE FROM ${t} WHERE sub_account_id LIKE 'SA-CA-%'`);
      await db.query(`DELETE FROM transactions WHERE sub_account_id LIKE 'SA-CA-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-CA-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-CA-%'`);
    };
    await clean();

    const MEMBERS = ['INV-CA-CHAIR', 'INV-CA-B', 'INV-CA-C'];
    for (const id of MEMBERS.concat(['INV-CA-OUT']))
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,$4,'active',0)`,
        [id, id.slice(-1), `${id.toLowerCase()}@example.test`, '079000000' + id.slice(-1)]);

    /* R3 000 already in the pot, split equally by what each has put in. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum, share_basis)
       VALUES ('SA-CA-1','INV-CA-CHAIR','stokvel','Masibambane',3000,'approved','active',2,'contribution')`);
    for (const [i, id] of MEMBERS.entries()) {
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
         VALUES ($1,'SA-CA-1',$2,$3,$4,'active', NOW() - INTERVAL '1 year')`,
        ['SM-CA-' + i, id, i === 0 ? 'chairperson' : 'member', i === 0]);
      await db.query(
        `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason)
         VALUES ($1,'SA-CA-1',$2,'contribution',1000,'Contribution')`, ['SAL-CA-' + i, id]);
    }
    /* What each of them owes for November. */
    for (const [i, id] of MEMBERS.entries())
      await db.query(
        `INSERT INTO stokvel_contributions
           (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
         VALUES ($1,'SA-CA-1',$2,'2026-11',500,0,CURRENT_DATE - 5,'due')`,
        ['SC-CA-' + i, id]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id,
                                 firstName: 'A', lastName: 'B' },
                               process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });

    const today = new Date().toISOString().slice(0, 10);
    const recordCash = (who, investor, amount, over) =>
      call('POST', '/api/stokvels/SA-CA-1/cash', tok(who), Object.assign(
        { investor_id: investor, amount, received_on: today, method: 'cash' }, over || {}));
    const settleCash = (who, reference) =>
      call('POST', '/api/stokvels/SA-CA-1/cash/settle', tok(who), { reference });
    const listCash = who => call('GET', '/api/stokvels/SA-CA-1/cash', tok(who));
    const shareOf = async id => {
      const a = await shares.sharesOf(db, 'SA-CA-1');
      return (a.shares.find(x => x.investor_id === id) || {}).share;
    };
    const invariant = async where => {
      /* Reconcile first, exactly as a read of /shares does. An amount that
         has landed and not yet been shared out is a gap by design — the
         invariant is a claim about the ledger once it has settled, not
         about the instant between a deposit and the next read. */
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await shares.reconcile(c, 'SA-CA-1', { reason: 'check: read' });
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); } finally { c.release(); }
      const a = await shares.audit(db, 'SA-CA-1');
      ok(`the books balance ${where}`, Math.abs(a.difference) < 0.005,
         `assets ${a.assets} vs shares ${a.shares}, out by ${a.difference}`);
    };
    const wallet = async () => (await db.query(
      `SELECT wallet_balance FROM sub_accounts WHERE id = 'SA-CA-1'`)).rows[0].wallet_balance;
    const deposit = async (reference, amount, type) => {
      await db.query(
        `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status,
                                   reference, description, created_at, transaction_date)
         VALUES ($1,'INV-CA-CHAIR','SA-CA-1',$4,$3,'completed',$2,'Banked takings',NOW(),NOW())`,
        ['TXN-CA-' + reference, reference, amount, type || 'deposit']);
      await db.query(
        `UPDATE sub_accounts SET wallet_balance = wallet_balance + $1 WHERE id = 'SA-CA-1'`, [amount]);
    };

    /* ══ Recording ═══════════════════════════════════════════════ */
    console.log('\nrecording what a member handed over moves no money at all');
    let receiptB;
    {
      const before = { wallet: await wallet(), share: await shareOf('INV-CA-B') };
      const r = await recordCash('INV-CA-CHAIR', 'INV-CA-B', 500, { note: 'November, at the meeting' });
      ok('the committee can record it', r.status === 201, JSON.stringify(r.body));
      receiptB = r.body.data && r.body.data.id;

      ok('THE GROUP WALLET DOES NOT MOVE',
         near(await wallet(), before.wallet),
         'the money is in the treasurer’s hands, not in the group’s account — '
         + 'a wallet that grew here would claim SV Capital holds cash it does not');
      ok('AND NOBODY’S SHARE MOVES',
         near(await shareOf('INV-CA-B'), before.share),
         'a share is a claim on money the platform holds');
      const { rows: [c] } = await db.query(
        `SELECT status, amount_paid FROM stokvel_contributions WHERE id = 'SC-CA-1'`);
      ok('and the contribution is still owing, because it is',
         c.status === 'due' && near(c.amount_paid, 0),
         'marking it paid before the money arrives is how the arrears list '
         + 'starts lying in the other direction: ' + JSON.stringify(c));
      await invariant('after recording');
    }

    console.log('\nand the whole group can see it, with who recorded it');
    {
      const r = await listCash('INV-CA-C');
      const row = (r.body.data || [])[0] || {};
      ok('a plain member reads the record', r.status === 200 && row.id === receiptB,
         JSON.stringify(r.body));
      ok('IT SAYS WHO RECORDED IT',
         !!row.recorded_by_name,
         'a receipt the group cannot attribute is a treasurer’s private note, '
         + 'which is the thing this replaces: ' + JSON.stringify(row));
      ok('and it is waiting, not settled', row.status === 'recorded', JSON.stringify(row));
      ok('and a plain member is not offered the recording',
         r.body.can_record === false, String(r.body.can_record));
      const outsider = await listCash('INV-CA-OUT');
      ok('and somebody outside the group sees nothing', outsider.status === 404,
         JSON.stringify(outsider.body));
    }

    console.log('\nand only the committee records one');
    {
      const r = await recordCash('INV-CA-C', 'INV-CA-C', 500);
      ok('A PLAIN MEMBER CANNOT RECORD THEIR OWN PAYMENT',
         r.status === 403,
         'otherwise anybody could mark themselves paid up: ' + JSON.stringify(r.body));
      const nonMember = await recordCash('INV-CA-CHAIR', 'INV-CA-OUT', 500);
      ok('and nobody can be recorded who is not in the group',
         nonMember.status === 400, JSON.stringify(nonMember.body));
      const future = await recordCash('INV-CA-CHAIR', 'INV-CA-C', 500,
        { received_on: '2099-01-01' });
      ok('and a date in the future is a typo, every time',
         future.status === 400 && /future/.test(future.body.error || ''),
         JSON.stringify(future.body));
      const nothing = await recordCash('INV-CA-CHAIR', 'INV-CA-C', 0);
      ok('and nothing is not an amount', nothing.status === 400, JSON.stringify(nothing.body));
    }

    /* ══ Settling ════════════════════════════════════════════════ */
    console.log('\nand it settles only against a deposit that really arrived');
    {
      /* WITH A REAL DEPOSIT ALREADY ON THE GROUP, which is the case that
         matters. Asking for a made-up reference while the group has no
         deposits at all passes for the wrong reason — there is nothing to
         match either way — and a lookup that ignored the reference
         entirely would sail through it. This group has banked R1 000
         before; the question is whether a reference nobody used can reach
         it. */
      await deposit('DEP-OLD', 1000);
      const made_up = await settleCash('INV-CA-CHAIR', 'NOT-A-REAL-REFERENCE');
      ok('A REFERENCE NOBODY BANKED SETTLES NOTHING, EVEN WHERE DEPOSITS EXIST',
         made_up.status === 400 && /No deposit with that reference/.test(made_up.body.error || ''),
         'this is the whole control: without it the committee could hand a '
         + 'member a share out of a deposit that was for something else: '
         + JSON.stringify(made_up.body));
      await db.query(`DELETE FROM transactions WHERE reference = 'DEP-OLD'`);
      await db.query(`UPDATE sub_accounts SET wallet_balance = wallet_balance - 1000 WHERE id = 'SA-CA-1'`);

      /* A member's own contribution arriving is NOT a deposit to settle from:
         it has already been attributed to them. */
      await deposit('CONTRIB-1', 500, 'stokvel_contribution_received');
      const wrongType = await settleCash('INV-CA-CHAIR', 'CONTRIB-1');
      ok('and a contribution already credited to somebody is not a deposit',
         wrongType.status === 400,
         'settling out of it would pay the same contribution twice: '
         + JSON.stringify(wrongType.body));
      await db.query(`DELETE FROM transactions WHERE reference = 'CONTRIB-1'`);
      await db.query(`UPDATE sub_accounts SET wallet_balance = wallet_balance - 500 WHERE id = 'SA-CA-1'`);
    }

    console.log('\nand when the takings are banked, it says whose they were');
    {
      /* Read BEFORE the money lands: that is the only moment at which
         "what the others had" means anything. */
      const sumBefore = (await shares.sharesOf(db, 'SA-CA-1'))
        .shares.reduce((n, s) => n + Number(s.share), 0);
      const bBefore = await shareOf('INV-CA-B');
      const cBefore = await shareOf('INV-CA-C');
      await deposit('DEP-1', 500);
      const walletNow = await wallet();

      const r = await settleCash('INV-CA-CHAIR', 'DEP-1');
      ok('the recorded payment is settled',
         r.status === 200 && r.body.data.settled.length === 1
         && r.body.data.settled[0].investor_id === 'INV-CA-B',
         JSON.stringify(r.body));

      ok('THE MEMBER WHO PAID IS R500 BETTER OFF',
         near(await shareOf('INV-CA-B'), bBefore + 500),
         `was ${bBefore}, now ${await shareOf('INV-CA-B')}`);
      ok('AND NONE OF IT STUCK TO ANYBODY ELSE',
         near(await shareOf('INV-CA-C'), cBefore),
         'attribute reconciles first, so whatever the deposit had been '
         + 'shared out as is taken back on the same proportions and the '
         + 'whole amount reaches the member who actually paid it: '
         + `C was ${cBefore}, is now ${await shareOf('INV-CA-C')}`);
      const sumAfter = (await shares.sharesOf(db, 'SA-CA-1'))
        .shares.reduce((n, s) => n + Number(s.share), 0);
      ok('AND THE SUM OF THE SHARES IS UNCHANGED BY WHOSE IT IS',
         near(sumAfter, sumBefore + 500),
         `the R500 deposit is the only thing that grew the pot: `
         + `${sumBefore} + 500 vs ${sumAfter}`);
      ok('and the wallet is untouched by the settling itself',
         near(await wallet(), walletNow),
         'settling says whose money it is; it does not move any');
      await invariant('after settling');

      const { rows: [c] } = await db.query(
        `SELECT status, amount_paid FROM stokvel_contributions WHERE id = 'SC-CA-1'`);
      ok('AND HER NOVEMBER IS PAID',
         c.status === 'paid' && near(c.amount_paid, 500),
         'which is the whole point — the arrears list stops chasing a woman '
         + 'who paid: ' + JSON.stringify(c));
      const row = ((await listCash('INV-CA-C')).body.data || []).find(x => x.id === receiptB);
      ok('and the record names the deposit it was settled out of',
         row && row.status === 'settled' && row.deposit_reference === 'DEP-1',
         JSON.stringify(row));
    }

    console.log('\nand one deposit cannot settle more than it brought in');
    {
      await recordCash('INV-CA-CHAIR', 'INV-CA-C', 500);
      const again = await settleCash('INV-CA-CHAIR', 'DEP-1');
      ok('THE SAME DEPOSIT CANNOT BE SPENT TWICE',
         again.status === 400 && /already been used up/.test(again.body.error || ''),
         'pressing the button again must not conjure a second R500: '
         + JSON.stringify(again.body));
      await invariant('after the second press');
    }

    console.log('\nand what a deposit cannot cover waits, whole');
    {
      await deposit('DEP-2', 300);              /* less than the R500 recorded */
      const r = await settleCash('INV-CA-CHAIR', 'DEP-2');
      ok('a receipt bigger than what is left is NOT half settled',
         r.status === 400 || (r.body.data && r.body.data.settled.length === 0),
         'half of Mama Dlamini’s R500 settled and half waiting is an object '
         + 'nobody can explain at a meeting: ' + JSON.stringify(r.body));
      const { rows: [c] } = await db.query(
        `SELECT status FROM stokvel_contributions WHERE id = 'SC-CA-2'`);
      ok('and the member still owes what she owes', c.status === 'due', JSON.stringify(c));
      await invariant('after a deposit that was too small');
    }

    console.log('\nand a record can be called back until it is settled');
    {
      const { rows: [openOne] } = await db.query(
        `SELECT id FROM stokvel_cash_receipts
          WHERE sub_account_id = 'SA-CA-1' AND status = 'recorded' LIMIT 1`);
      const byMember = await call('DELETE', `/api/stokvels/SA-CA-1/cash/${openOne.id}`, tok('INV-CA-C'));
      ok('a plain member cannot call one back', byMember.status === 403, JSON.stringify(byMember.body));
      const r = await call('DELETE', `/api/stokvels/SA-CA-1/cash/${openOne.id}`, tok('INV-CA-CHAIR'));
      ok('the committee can', r.status === 200, JSON.stringify(r.body));

      const settledOne = await call('DELETE', `/api/stokvels/SA-CA-1/cash/${receiptB}`, tok('INV-CA-CHAIR'));
      ok('BUT A SETTLED ONE CANNOT BE QUIETLY UNDONE',
         settledOne.status === 400 && /already been settled/.test(settledOne.body.error || ''),
         'it has moved a share; reversing that is a staff decision with a '
         + 'record, not a button: ' + JSON.stringify(settledOne.body));
      await invariant('after calling one back');
    }

    console.log('\nand a cancelled record settles nothing');
    {
      await deposit('DEP-3', 1000);
      const r = await settleCash('INV-CA-CHAIR', 'DEP-3');
      ok('THERE IS NOTHING LEFT WAITING',
         r.status === 400 && /nothing recorded/.test(r.body.error || ''),
         'the cancelled one must not come back to life: ' + JSON.stringify(r.body));
      await invariant('at the end');
    }

    console.log('\nand oldest first, so the longest wait is settled first');
    {
      await db.query(`DELETE FROM transactions WHERE sub_account_id = 'SA-CA-1'`);
      await recordCash('INV-CA-CHAIR', 'INV-CA-C', 200, { received_on: '2026-10-01' });
      await recordCash('INV-CA-CHAIR', 'INV-CA-B', 200, { received_on: '2026-09-01' });
      await deposit('DEP-4', 200);
      const r = await settleCash('INV-CA-CHAIR', 'DEP-4');
      ok('THE SEPTEMBER ONE GOES FIRST',
         r.body.data && r.body.data.settled.length === 1
         && r.body.data.settled[0].investor_id === 'INV-CA-B',
         'a queue that is not a queue is a queue somebody argues about: '
         + JSON.stringify(r.body.data));
      ok('and the one that is still waiting is named',
         r.body.data && r.body.data.not_settled
         && near(r.body.data.not_settled.short, 200),
         'a committee that settled one of two has to know which: '
         + JSON.stringify(r.body.data));
      await invariant('after settling oldest first');
    }

    console.log('\nand nothing was sent to anybody while doing it');
    ok('no email, no push, no sms', sent.length === 0, JSON.stringify(sent.slice(0, 3)));

    await clean();
  } catch (err) {
    fail += 1;
    console.log('  ✗ the check itself fell over\n      ' + (err && err.stack || err));
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
