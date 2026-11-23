#!/usr/bin/env node
/* Money the signatories have released is not money the group may spend again.
 *
 * THE DEFECT, found by driving the money flows. An authority that has been
 * approved and not yet carried out leaves the money sitting in the group
 * wallet — so every figure on every screen counted it as the group's to
 * spend. A group with R9 000 and R2 000 already approved for a funeral
 * raised its December payout for the full R9 000, and the signatories were
 * asked to approve paying out a rand that was already promised.
 *
 * THE RULE, as the shares endpoint now reports it:
 *
 *     committed   = approved, not yet spent, and it takes money OUT
 *     uncommitted = net assets − committed
 *
 * THREE JUDGEMENT CALLS, each of them checked below:
 *
 *   · ONLY 'approved'. A pending request is a question, not a commitment.
 *     Counting it would let an unanswered request shrink the pot, which is
 *     the opposite error and a worse one — anybody could raise a request
 *     for a million rand and make the group look broke.
 *   · THE FEE IS PART OF IT. An approved R10 000 investment takes R10 100
 *     out of the wallet. A commitment that understates itself is the one
 *     direction in which the wallet can go short.
 *   · PAYOUT AND EXIT ARE LEFT OUT. A payout's amount IS the whole pot, so
 *     counting it nets the pot against itself; an exit's figure is what the
 *     member's share stood at when it was raised and is settled at whatever
 *     it comes to on the day. Both are reported on their own screens.
 *
 * Run: DATABASE_URL=… node server/scripts/check-stokvel-committed.cjs
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

/* Nothing here should send anything. */
const sent = [];
function stub() {
  return new Proxy({}, { get(_t, k) {
    if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
    return (...args) => { sent.push({ fn: k, args }); return Promise.resolve({ ok: true }); };
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
      `SELECT to_regclass('public.stokvel_withdrawal_requests') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no stokvel tables here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-CM-%')`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-CM-%'`);
      await db.query(`DELETE FROM stokvel_allocations WHERE sub_account_id LIKE 'SA-CM-%'`);
      await db.query(`DELETE FROM stokvel_exit_debts  WHERE sub_account_id LIKE 'SA-CM-%'`);
      await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id LIKE 'SA-CM-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-CM-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-CM-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-CM-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-CM-%'`);
    };
    await clean();

    const MEMBERS = ['INV-CM-A', 'INV-CM-B', 'INV-CM-C'];
    for (const id of MEMBERS)
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,$4,'active',0)`,
        [id, id.slice(-1), `${id.toLowerCase()}@example.test`, '073000000' + id.slice(-1)]);

    /* R9 000 in the pot, three members, a mandate of two. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum, share_basis)
       VALUES ('SA-CM-1','INV-CM-A','stokvel','Masibambane',9000,'approved','active',2,'contribution')`);
    for (const [i, id] of MEMBERS.entries())
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
         VALUES ($1,'SA-CM-1',$2,$3,true,'active', NOW() - INTERVAL '1 year')`,
        ['SM-CM-' + id.slice(-1), id, i === 0 ? 'chairperson' : 'member']);
    for (const id of MEMBERS)
      await db.query(
        `INSERT INTO stokvel_allocations (id, sub_account_id, investor_id, kind, amount, reason)
         VALUES ($1,'SA-CM-1',$2,'contribution',3000,'Contribution')`,
        ['SAL-CM-' + id.slice(-1), id]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
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
    const sharesOf = async () =>
      (await call('GET', '/api/stokvels/SA-CM-1/shares', tok('INV-CM-A'))).body.data;

    /* A request, written straight in so each case is exact. */
    let n = 0;
    const request = async (kind, amount, status, over) => {
      n += 1;
      const id = `SWR-CM-${n}`;
      await db.query(
        `INSERT INTO stokvel_withdrawal_requests
           (id, sub_account_id, requested_by, kind, amount, status, quorum_required,
            expires_at, bank_name, bank_account_number, pool_id, payout_id, exit_investor_id)
         VALUES ($1,'SA-CM-1','INV-CM-A',$2,$3,$4,2, NOW() + INTERVAL '14 days',$5,$6,$7,$8,$9)`,
        [id, kind, amount, status,
         (over || {}).bank_name || null, (over || {}).bank_account_number || null,
         (over || {}).pool_id || null, (over || {}).payout_id || null,
         (over || {}).exit_investor_id || null]);
      return id;
    };
    const wipeRequests = () =>
      db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id = 'SA-CM-1'`);

    /* ── Nothing approved ──────────────────────────────────────────── */
    console.log('\na group with nothing approved has its whole pot to decide on');
    {
      const d = await sharesOf();
      ok('the pot is what it is', near(d.net_assets, 9000), JSON.stringify(d.net_assets));
      ok('nothing is committed', near(d.committed, 0), String(d.committed));
      ok('AND UNCOMMITTED IS THE WHOLE POT',
         near(d.uncommitted, 9000), String(d.uncommitted));
      ok('and it says how many approvals are waiting', d.committed_count === 0,
         String(d.committed_count));
    }

    /* ── An approved withdrawal ────────────────────────────────────── */
    console.log('\nan approved withdrawal is money the group has already promised');
    {
      await request('withdrawal', 2000, 'approved', { bank_name: 'FNB', bank_account_number: '62001234567' });
      const d = await sharesOf();
      ok('THE POT DOES NOT MOVE — the money is still in the wallet',
         near(d.net_assets, 9000),
         'it has not left yet, and pretending it has would make the books '
         + 'disagree with the wallet: ' + d.net_assets);
      ok('AND R2 000 IS COMMITTED', near(d.committed, 2000), String(d.committed));
      ok('so R7 000 is left to decide on', near(d.uncommitted, 7000), String(d.uncommitted));
      ok('and one approval is counted', d.committed_count === 1, String(d.committed_count));
    }

    /* ── A pending one is a question, not a commitment ─────────────── */
    console.log('\nbut a request nobody has answered commits nothing');
    {
      await wipeRequests();
      await request('withdrawal', 5000, 'pending', { bank_name: 'FNB', bank_account_number: '1' });
      const d = await sharesOf();
      ok('A PENDING REQUEST IS NOT COMMITTED',
         near(d.committed, 0),
         'otherwise anybody could raise a request for a million rand and '
         + 'make the group look broke: ' + d.committed);
      ok('and the whole pot is still to decide on',
         near(d.uncommitted, 9000), String(d.uncommitted));
    }

    /* ── Spent, rejected and expired are over ──────────────────────── */
    console.log('\nand one that is over commits nothing either');
    for (const status of ['used', 'rejected', 'expired']) {
      await wipeRequests();
      await request('withdrawal', 4000, status, { bank_name: 'FNB', bank_account_number: '1' });
      const d = await sharesOf();
      ok(`a ${status} authority commits nothing`, near(d.committed, 0),
         status === 'used'
           ? 'the money has already gone — counting it again would take it '
             + 'off the pot twice: ' + d.committed
           : String(d.committed));
    }

    /* ── The fee is part of what leaves ────────────────────────────── */
    console.log('\nand what leaves includes the fee charged on top of it');
    {
      await wipeRequests();
      await request('investment', 5000, 'approved', { pool_id: 'POOL-X' });
      const d = await sharesOf();
      ok('AN APPROVED INVESTMENT COMMITS THE AMOUNT PLUS THE 1% FEE',
         near(d.committed, 5050),
         'R5 000 into a pool takes R5 050 out of the wallet; a commitment '
         + 'that understates itself is how the wallet goes short: ' + d.committed);
      ok('so the rest is what is left', near(d.uncommitted, 3950), String(d.uncommitted));

      await wipeRequests();
      await request('notice_deposit', 5000, 'approved');
      const nd = await sharesOf();
      ok('and so does a move into the notice fund, which charges the same fee',
         near(nd.committed, 5050), String(nd.committed));
    }

    /* ── Payout and exit are reported, not netted ──────────────────── */
    console.log('\nand the two that would net the pot against itself are left out');
    {
      await wipeRequests();
      await request('payout', 9000, 'approved', { payout_id: 'SPO-X' });
      const d = await sharesOf();
      ok('AN APPROVED PAYOUT DOES NOT COMMIT THE POT AGAINST ITSELF',
         near(d.committed, 0),
         'a payout IS the whole pot — counting it would leave the group '
         + 'nothing and the figure on the payout panel would be zero: ' + d.committed);

      await wipeRequests();
      await request('exit', 3000, 'approved', { exit_investor_id: 'INV-CM-C' });
      const e = await sharesOf();
      ok('and nor does an exit, whose figure is settled on the day',
         near(e.committed, 0),
         'the amount on an exit request is what the share stood at when it '
         + 'was raised, not what will be paid: ' + e.committed);
    }

    /* ── Several at once ───────────────────────────────────────────── */
    console.log('\nand several approvals add up');
    {
      await wipeRequests();
      await request('withdrawal', 2000, 'approved', { bank_name: 'FNB', bank_account_number: '1' });
      await request('investment', 1000, 'approved', { pool_id: 'POOL-X' });
      await request('withdrawal', 500, 'pending', { bank_name: 'FNB', bank_account_number: '2' });
      const d = await sharesOf();
      ok('THE APPROVED ONES SUM, AND THE PENDING ONE DOES NOT',
         near(d.committed, 3010),
         'R2 000 + R1 000 + R10 of fee, and the R500 nobody has answered '
         + 'stays out of it: ' + d.committed);
      ok('and two are counted', d.committed_count === 2, String(d.committed_count));
      ok('so the group has R5 990 left to decide on',
         near(d.uncommitted, 5990), String(d.uncommitted));
    }

    /* ── Another group's approvals are not this group's ────────────── */
    console.log('\nand a different group’s approvals are not this group’s');
    {
      await wipeRequests();
      await db.query(
        `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                   wallet_balance, kyc_status, status, stokvel_quorum, share_basis)
         VALUES ('SA-CM-2','INV-CM-A','stokvel','Another',500,'approved','active',2,'contribution')`);
      await db.query(
        `INSERT INTO stokvel_withdrawal_requests
           (id, sub_account_id, requested_by, kind, amount, status, quorum_required,
            expires_at, bank_name, bank_account_number)
         VALUES ('SWR-CM-OTHER','SA-CM-2','INV-CM-A','withdrawal',400,'approved',2,
                 NOW() + INTERVAL '14 days','FNB','9')`);
      const d = await sharesOf();
      ok('IT IS SCOPED TO THE GROUP',
         near(d.committed, 0),
         'one group’s approvals shrinking another group’s pot would be the '
         + 'worst version of this: ' + d.committed);
    }

    ok('and nothing was sent while working any of this out', sent.length === 0,
       JSON.stringify(sent.slice(0, 3)));

    await clean();
    await db.query(`DELETE FROM sub_accounts WHERE id = 'SA-CM-2'`);
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
