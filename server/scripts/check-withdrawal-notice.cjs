#!/usr/bin/env node
/* Money asked for today is not money payable today.
 *
 * Wallets on this platform bear interest — credited from the 3PIM import,
 * not computed here — and notice is what pays for it. A withdrawal becomes
 * payable 48 hours after it is asked for, or on a date the account has set,
 * whichever is LATER.
 *
 * Later, not whichever applies. An account that has committed its money
 * until the first of December and asks on the thirtieth of November does
 * not get it on the first: the date is a floor under the notice, not a
 * replacement for it. That is the rule most easily got backwards, and it is
 * the one a stokvel will test every December.
 *
 * The rest is about where the promise lives:
 *
 *  · IT IS STAMPED ON THE ROW, not recomputed at approval. Shortening the
 *    notice setting must change the terms for new requests and must not
 *    move a date a client has already been given.
 *  · APPROVAL CHECKS IT. Notice that is only applied when the request is
 *    made is a comment, not a control.
 *  · REJECTION DOES NOT. A client who changes their mind should not have to
 *    wait out a notice period to do it.
 *  · THE SETTING CAN BE ZEROED without a deploy, because the lever you want
 *    when the terms are wrong and a client is owed money is not a release.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-withdrawal-notice.cjs
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WD    = read('server/routes/withdrawals.js');
const EMAIL = read('server/services/email.js');

console.log('\nthe rule is in one place');
{
  const SVC = read('server/services/withdrawalAccess.js');
  ok('there is a service that decides it', /function availableAt/.test(SVC));
  ok('and the request and the approval both use it',
     (WD.match(/access\.availableAt\(/g) || []).length === 2
     && /access\.blockedUntil\(/.test(WD),
     'both wallet paths stamp it, and approval checks it');
  ok('the later of the two wins',
     /day > afterNotice \? day : afterNotice/.test(SVC),
     'a set date is a floor under the notice, not a replacement for it');
  ok('the notice is a setting, not a constant',
     /withdrawal_notice_hours/.test(SVC) && /withdrawal_notice_hours/.test(read('server/db/setup.js')));
  ok('and an unreadable setting falls back to 48, not to zero',
     /DEFAULT_NOTICE_HOURS = 48/.test(SVC) && /return DEFAULT_NOTICE_HOURS/.test(SVC),
     'zero is a real answer and somebody has to type it');
}

console.log('\nand the nudge no longer says something untrue');
{
  ok('wallet money is not described as idle',
     !/so it is not working/.test(EMAIL),
     'it earns interest now — the nudge is about the difference between two returns');
  ok('the email says what the wallet actually does',
     /earns interest where it is/.test(EMAIL) && /48 hours/.test(EMAIL));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const http = require('http');
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.transactions') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no transactions table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-WN-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-WN-%'`);
    };
    await clean();

    const investor = (id, date) => db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                              fica_status, kyc_status, withdrawal_date)
       VALUES ($1,$2,'Notice',$3,'active',10000,'approved','verified',$4)`,
      [id, id.replace('INV-WN-', ''), `${id.toLowerCase()}@example.test`, date]);
    await investor('INV-WN-PLAIN', null);
    /* Committed until a date well beyond the notice period. */
    await investor('INV-WN-DATED', '2099-12-01');

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/withdrawals', require(path.join(ROOT, 'server', 'routes', 'withdrawals.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = (id, role) => jwt.sign(
      { id: 'u-' + id, role: role || 'investor', investor_id: id },
      process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s2 = ''; x.on('data', c => s2 += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s2 || '{}') })); });
      if (payload) r.write(payload); r.end();
    });
    const txFor = async id => (await db.query(
      `SELECT id, available_at, status FROM transactions
        WHERE investor_id = $1 AND type = 'withdrawal' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];

    console.log('\nan ordinary wallet');
    const r1 = await call('POST', '/api/withdrawals/request', tok('INV-WN-PLAIN'),
                          { amount: 1000, bank_name: 'FNB', bank_account_number: '620123' });
    ok('the request is accepted', r1.status === 200 || r1.status === 201,
       `${r1.status} ${JSON.stringify(r1.body).slice(0, 140)}`);
    const t1 = await txFor('INV-WN-PLAIN');
    ok('and carries a payable-from stamp', !!t1 && !!t1.available_at, JSON.stringify(t1));
    const hours = (new Date(t1.available_at) - Date.now()) / 3600000;
    ok('roughly 48 hours out', hours > 47 && hours < 49, `${hours.toFixed(1)}h`);

    console.log('\napproving it early');
    const early = await call('POST', `/api/withdrawals/${t1.id}/approve`, tok('STAFF', 'admin'), {});
    ok('is refused', early.status === 409, `${early.status} ${JSON.stringify(early.body)}`);
    ok('and the client is told when', /payable from/i.test(early.body.error || ''), early.body.error);
    ok('the withdrawal is still pending', (await txFor('INV-WN-PLAIN')).status === 'pending');

    console.log('\nand once the notice has run');
    await db.query(`UPDATE transactions SET available_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [t1.id]);
    const late = await call('POST', `/api/withdrawals/${t1.id}/approve`, tok('STAFF', 'admin'), {});
    ok('it goes through', late.status === 200 || late.status === 201,
       `${late.status} ${JSON.stringify(late.body).slice(0, 140)}`);

    console.log('\na wallet committed to a date');
    const r2 = await call('POST', '/api/withdrawals/request', tok('INV-WN-DATED'),
                          { amount: 1000, bank_name: 'FNB', bank_account_number: '620123' });
    ok('the request is still accepted', r2.status === 200 || r2.status === 201, String(r2.status));
    const t2 = await txFor('INV-WN-DATED');
    ok('but payable only from that date, not in 48 hours',
       new Date(t2.available_at).getUTCFullYear() === 2099,
       String(t2.available_at));
    const blocked = await call('POST', `/api/withdrawals/${t2.id}/approve`, tok('STAFF', 'admin'), {});
    ok('and approval refuses until then', blocked.status === 409, String(blocked.status));

    console.log('\nbut changing your mind is never delayed');
    const rejected = await call('POST', `/api/withdrawals/${t2.id}/reject`, tok('STAFF', 'admin'),
                                { reason: 'client cancelled' });
    ok('a rejection is not held by the notice',
       rejected.status === 200 || rejected.status === 201,
       `${rejected.status} ${JSON.stringify(rejected.body).slice(0, 140)}`);

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
