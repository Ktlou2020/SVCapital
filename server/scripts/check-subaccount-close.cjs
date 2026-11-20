#!/usr/bin/env node
/* Closing a minor's account and giving the balance back.
 *
 * A minor account opened by a parent could not be closed at all, and if it
 * still held money the only way to deal with that was to edit a balance by
 * hand — which writes no transaction and leaves nothing to show a client
 * where their money went.
 *
 * Three things have to be true at once and each is its own money bug:
 *
 *  · MINORS ONLY. A stokvel is held by its members under a mandate; a trust
 *    and a business are separate legal persons. Sweeping any of them into
 *    the parent account holder's personal wallet is moving somebody else's
 *    money on one person's say-so. The server refuses, not just the button.
 *
 *  · THE SWEEP IS EXACT AND HAPPENS ONCE. A second click on a stale page
 *    must not pay the balance out twice. The row is locked FOR UPDATE and an
 *    already-closed account is refused — without the lock two requests both
 *    read 'active', both sweep, and the parent is credited twice for money
 *    that existed once.
 *
 *  · NOT WHILE INVESTMENTS ARE LIVE. The wallet balance is only the
 *    uninvested part, and an investment belonging to a closed account is a
 *    loose end nobody would go looking for.
 *
 * And the rows have to COUNT. transfer_in/transfer_out were in neither cash
 * list, so a sweep would have moved the wallet columns while every balance
 * derived from the ledger ignored it.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-subaccount-close.cjs
 */
'use strict';

const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The rule, read from the one place that defines it ───────────────── */
const ledger = require(path.join(ROOT, 'server', 'services', 'ledger.js'));

console.log('\na transfer moves cash, which is what makes the sweep visible at all');
{
  ok('TRANSFER IN IS A CASH CREDIT',
     ledger.cashMovement({ type: 'transfer_in', amount: 250 }) === 250,
     String(ledger.cashMovement({ type: 'transfer_in', amount: 250 }))
     + ' — unclassified it returns 0, and the statement shows the transfer '
     + 'and then a running balance that has not moved');
  ok('AND TRANSFER OUT IS A CASH DEBIT',
     ledger.cashMovement({ type: 'transfer_out', amount: 250 }) === -250,
     String(ledger.cashMovement({ type: 'transfer_out', amount: 250 })));
  ok('and the SQL agrees with the JavaScript',
     /'transfer_in'/.test(ledger.cashMovementSQL()) && /'transfer_out'/.test(ledger.cashMovementSQL()),
     'two definitions of what moves cash is how a balance ends up with two answers');
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.sub_accounts') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no sub_accounts table in this database'); return; }

    await db.query(`ALTER TABLE sub_accounts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
    await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-CL-%'`);
    await db.query(`DELETE FROM investments  WHERE sub_account_id LIKE 'SA-CL-%'`);
    await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-CL-%'`);
    await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-CL-%'`);

    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
       VALUES ('INV-CL-A','Thandi','Parent','inv-cl-a@example.test','0721000001','active',1000)`);

    const mkSa = (id, type, bal) => db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status)
       VALUES ($1,'INV-CL-A',$2,$3,$4,'approved','active')`,
      [id, type, `${type} account ${id}`, bal]);

    await mkSa('SA-CL-MINOR', 'minor',   450.25);
    await mkSa('SA-CL-GROUP', 'stokvel', 8000);
    await mkSa('SA-CL-TRUST', 'trust',   5000);
    await mkSa('SA-CL-EMPTY', 'minor',   0);
    await mkSa('SA-CL-BUSY',  'minor',   300);
    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate,
                                     term_months, min_investment, max_capacity, current_invested)
       VALUES ('POOL-CL-1','Closing check pool','cattle','open',0.12,12,100,10000000,0)`);
    await db.query(
      `INSERT INTO investments (id, investor_id, sub_account_id, pool_id, amount, status)
       VALUES ('INVST-CL-1','INV-CL-A','SA-CL-BUSY','POOL-CL-1',1000,'active')`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/sub-accounts', require(path.join(ROOT, 'server', 'routes', 'subAccounts.js')));
    srv = await new Promise(x => { const s = app.listen(0, () => x(s)); });

    const tok = role => jwt.sign({ id: 'u-staff', email: 'ops@example.test', role },
                                 process.env.JWT_SECRET, { expiresIn: '1h' });
    const close = (saId, role = 'admin') => new Promise(res => {
      const payload = Buffer.from(JSON.stringify({}));
      const q = http.request({ port: srv.address().port, path: `/api/sub-accounts/${saId}/close`,
        method: 'POST', headers: { Authorization: `Bearer ${tok(role)}`,
          'Content-Type': 'application/json', 'Content-Length': payload.length } },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      q.write(payload); q.end();
    });
    const wallet = async id => Number((await db.query(
      'SELECT wallet_balance FROM investors WHERE id=$1', [id])).rows[0].wallet_balance);
    const saWallet = async id => Number((await db.query(
      'SELECT wallet_balance FROM sub_accounts WHERE id=$1', [id])).rows[0].wallet_balance);
    const saStatus = async id => (await db.query(
      'SELECT status FROM sub_accounts WHERE id=$1', [id])).rows[0].status;

    /* ── A minor's account ───────────────────────────────────────────── */
    console.log('\na minor account closes and its balance goes back to the parent');
    {
      const before = await wallet('INV-CL-A');
      const res = await close('SA-CL-MINOR');
      ok('the close is accepted', res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
      ok('and it reports what it swept', Number(res.body.swept) === 450.25, String(res.body.swept));
      ok('THE PARENT IS CREDITED THE EXACT BALANCE',
         Math.abs((await wallet('INV-CL-A')) - (before + 450.25)) < 0.005,
         `${before} → ${await wallet('INV-CL-A')}, expected ${before + 450.25}`);
      ok('and the account is emptied', (await saWallet('SA-CL-MINOR')) === 0,
         String(await saWallet('SA-CL-MINOR')));
      ok('and closed', (await saStatus('SA-CL-MINOR')) === 'closed', await saStatus('SA-CL-MINOR'));
      ok('and stamped with when', !!(await db.query(
         'SELECT closed_at FROM sub_accounts WHERE id=$1', ['SA-CL-MINOR'])).rows[0].closed_at);

      const { rows: txns } = await db.query(
        `SELECT type, amount, sub_account_id, actor_kind FROM transactions
          WHERE investor_id='INV-CL-A' ORDER BY type`);
      ok('two rows are written, not one', txns.length === 2, JSON.stringify(txns));
      const out = txns.find(t => t.type === 'transfer_out');
      const inn = txns.find(t => t.type === 'transfer_in');
      ok('the money leaves the MINOR account',
         out && out.sub_account_id === 'SA-CL-MINOR' && Number(out.amount) === 450.25,
         JSON.stringify(out));
      ok('and arrives in the MAIN wallet, not back in the sub-account',
         inn && inn.sub_account_id === null && Number(inn.amount) === 450.25,
         JSON.stringify(inn) + ' — a sub_account_id here would file the credit '
         + 'back into the account being closed');
      ok('and both say a staff member did it',
         txns.every(t => t.actor_kind === 'staff'),
         JSON.stringify(txns.map(t => t.actor_kind)));
      ok('the two rows net to zero as cash, which is what a transfer is',
         Math.abs(txns.reduce((s, t) => s + ledger.cashMovement(t), 0)) < 0.005,
         JSON.stringify(txns.map(t => ledger.cashMovement(t))));
    }

    /* ── The money bug ───────────────────────────────────────────────── */
    console.log('\nand a second click cannot pay the same balance out twice');
    {
      const before = await wallet('INV-CL-A');
      const res = await close('SA-CL-MINOR');
      ok('a closed account is refused', res.status === 409, `${res.status} ${JSON.stringify(res.body)}`);
      ok('AND THE PARENT IS NOT CREDITED AGAIN',
         Math.abs((await wallet('INV-CL-A')) - before) < 0.005,
         `${before} → ${await wallet('INV-CL-A')}`);
      const { rows: [n] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM transactions WHERE investor_id='INV-CL-A'`);
      ok('and no further rows were written', n.n === 2, String(n.n));
    }

    /* ── Everything that is not a minor ──────────────────────────────── */
    console.log('\nand nothing else can be closed this way');
    for (const [id, what] of [['SA-CL-GROUP', 'a group'], ['SA-CL-TRUST', 'a trust']]) {
      const before = await wallet('INV-CL-A');
      const res = await close(id);
      ok(`${what} is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
      ok(`${what} keeps its money`, (await saWallet(id)) > 0, String(await saWallet(id)));
      ok(`and the parent gets none of it`,
         Math.abs((await wallet('INV-CL-A')) - before) < 0.005,
         'a stokvel is held by its members under a mandate — this is the '
         + 'chairperson being handed the group\'s pot');
      ok(`${what} stays open`, (await saStatus(id)) === 'active', await saStatus(id));
    }

    /* ── Live investments ────────────────────────────────────────────── */
    console.log('\nand not while the account still holds investments');
    {
      const before = await wallet('INV-CL-A');
      const res = await close('SA-CL-BUSY');
      ok('it is refused', res.status === 409, `${res.status} ${JSON.stringify(res.body)}`);
      ok('and says how many are in the way', /1 investment/.test(res.body.error || ''), res.body.error);
      ok('the account keeps its wallet', (await saWallet('SA-CL-BUSY')) === 300,
         String(await saWallet('SA-CL-BUSY')));
      ok('and stays open', (await saStatus('SA-CL-BUSY')) === 'active', await saStatus('SA-CL-BUSY'));
      ok('and nothing reached the parent',
         Math.abs((await wallet('INV-CL-A')) - before) < 0.005, String(await wallet('INV-CL-A')));
    }

    /* ── An empty one ────────────────────────────────────────────────── */
    console.log('\nand an empty account closes without inventing a transaction');
    {
      const res = await close('SA-CL-EMPTY');
      ok('it closes', res.status === 200 && (await saStatus('SA-CL-EMPTY')) === 'closed',
         `${res.status} ${await saStatus('SA-CL-EMPTY')}`);
      ok('and swept nothing', Number(res.body.swept) === 0, String(res.body.swept));
      const { rows: [n] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM transactions WHERE investor_id='INV-CL-A'`);
      ok('and wrote no rows for it', n.n === 2,
         String(n.n) + ' — a R0,00 transfer is noise on a statement');
    }

    /* ── Who may do it ───────────────────────────────────────────────── */
    console.log('\nand a client cannot close their own minor account from the API');
    {
      await mkSa('SA-CL-SELF', 'minor', 100);
      const res = await close('SA-CL-SELF', 'investor');
      ok('the role is refused', res.status === 403 || res.status === 401,
         `${res.status} ${JSON.stringify(res.body)}`);
      ok('and the account is untouched', (await saStatus('SA-CL-SELF')) === 'active',
         await saStatus('SA-CL-SELF'));
    }

    await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-CL-%'`);
    await db.query(`DELETE FROM investments  WHERE sub_account_id LIKE 'SA-CL-%'`);
    await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-CL-%'`);
    await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-CL-%'`);
    await db.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-CL-%'`);
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
