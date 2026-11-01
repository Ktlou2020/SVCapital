#!/usr/bin/env node
/* A stokvel's money waits. Everybody else's does not.
 *
 * Every wallet bears interest — credited from the 3PIM import, not computed
 * here — but NOTICE IS NOT UNIVERSAL. The 48 hours applies to stokvel
 * wallets and to nothing else: a personal wallet, a trust and a child's
 * account all keep same-day access. A stokvel's money belongs to a group
 * and leaves on a mandate, so the pause is part of what the group is
 * buying; an individual's own money is their own.
 *
 * That narrowness is the thing to hold. The first version of this applied
 * the notice to every wallet on the platform, which would have made three
 * thousand clients wait two days for their own money.
 *
 * A withdrawal is payable after the notice, or on a date the account has
 * set, whichever is LATER.
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
  ok('notice is decided from the wallet, not from the caller',
     /function noticeApplies/.test(SVC)
     && /account_type === 'stokvel'/.test(SVC),
     'a new withdrawal path must not be able to forget to ask');
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
     /earns interest where it is/.test(EMAIL));
  /* This goes to an individual about their own wallet. A first draft told
     three thousand people their money needed two days' notice, which is
     true of stokvels and of nobody it was addressed to. */
  /* Both patterns against the stripped text. The first draft tested one of
     them against the raw file and failed on the comment that explains why
     the claim is absent — the same trap this session has now laid three
     times. */
  const emailCode = EMAIL.replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('and does not tell an individual their money needs notice',
     !/available on 48 hours/.test(emailCode) && !/48 hours.{0,20}notice/.test(emailCode),
     'same-day access is what a personal wallet has');
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
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id LIKE 'SWR-WN%'`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE id LIKE 'SWR-WN%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-WN-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-WN-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-WN-%'`);
    };
    await clean();

    const investor = (id, date) => db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                              fica_status, kyc_status, withdrawal_date)
       VALUES ($1,$2,'Notice',$3,'active',10000,'approved','verified',$4)`,
      [id, id.replace('INV-WN-', ''), `${id.toLowerCase()}@example.test`, date]);
    await investor('INV-WN-PLAIN', null);
    /* Committed until a date well beyond the notice period. A PERSONAL
       wallet, deliberately: an opt-in date binds whoever set it, stokvel or
       not, because they said so themselves. */
    await investor('INV-WN-DATED', '2099-12-01');

    /* The two sub-accounts that must behave differently. Same owner, same
       balance, same FICA — the only difference is the account type. */
    for (const [id, type] of [['SA-WN-STOK', 'stokvel'], ['SA-WN-TRUST', 'trust']])
      await db.query(
        `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                   wallet_balance, kyc_status, status)
         VALUES ($1,'INV-WN-PLAIN',$2,$3,10000,'approved','active')`,
        [id, type, type === 'stokvel' ? 'A Stokvel' : 'A Trust']);

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

    const txForSa = async id => (await db.query(
      `SELECT id, available_at, status FROM transactions
        WHERE sub_account_id = $1 AND type = 'withdrawal' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    const hoursOut = t => (new Date(t.available_at) - Date.now()) / 3600000;

    console.log('\na person withdrawing their own money');
    const r1 = await call('POST', '/api/withdrawals/request', tok('INV-WN-PLAIN'),
                          { amount: 1000, bank_name: 'FNB', bank_account_number: '620123' });
    ok('the request is accepted', r1.status === 200 || r1.status === 201,
       `${r1.status} ${JSON.stringify(r1.body).slice(0, 140)}`);
    const t1 = await txFor('INV-WN-PLAIN');
    ok('is not made to wait', hoursOut(t1) < 1, `${hoursOut(t1).toFixed(1)}h`,
       'the 48 hours is for stokvels; making three thousand clients wait two '
       + 'days for their own money is not what was asked for');
    const sameDay = await call('POST', `/api/withdrawals/${t1.id}/approve`, tok('STAFF', 'admin'), {});
    ok('and can be paid today', sameDay.status === 200 || sameDay.status === 201,
       `${sameDay.status} ${JSON.stringify(sameDay.body).slice(0, 120)}`);

    console.log('\na trust, which is also not a stokvel');
    const rT = await call('POST', '/api/withdrawals/request', tok('INV-WN-PLAIN'),
      { amount: 500, sub_account_id: 'SA-WN-TRUST', bank_name: 'FNB', bank_account_number: '620123' });
    ok('the request is accepted', rT.status === 200 || rT.status === 201, String(rT.status));
    ok('and is not delayed either', hoursOut(await txForSa('SA-WN-TRUST')) < 1);

    console.log('\na stokvel, which is');
    /* A stokvel withdrawal clears TWO gates, and this is where they meet.
       The mandate comes first — signatories approve an amount and a
       destination — and only then is the notice stamped. So the fixture has
       to satisfy the mandate, which is the honest path and also proves the
       two compose rather than one swallowing the other. */
    await db.query(`UPDATE sub_accounts SET stokvel_quorum = 2 WHERE id = 'SA-WN-STOK'`);
    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
       VALUES ('INV-WN-SIG','Sig','Two','inv-wn-sig@example.test','active',0)`);
    for (const [n, inv] of [[1, 'INV-WN-PLAIN'], [2, 'INV-WN-SIG']])
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
         VALUES ($1,'SA-WN-STOK',$2,'member',true,'active',NOW())`, [`SMW-${n}`, inv]);
    await db.query(
      `INSERT INTO stokvel_withdrawal_requests
         (id, sub_account_id, requested_by, amount, bank_name, bank_account_number,
          quorum_required, status, expires_at)
       VALUES ('SWR-WN','SA-WN-STOK','INV-WN-PLAIN',500,'FNB','620123',2,'approved', NOW() + INTERVAL '7 days')`);
    for (const [n, inv] of [[1, 'INV-WN-PLAIN'], [2, 'INV-WN-SIG']])
      await db.query(
        `INSERT INTO stokvel_request_approvals (id, request_id, investor_id, decision)
         VALUES ($1,'SWR-WN',$2,'approve')`, [`SRAW-${n}`, inv]);

    const rS = await call('POST', '/api/withdrawals/request', tok('INV-WN-PLAIN'),
      { amount: 500, sub_account_id: 'SA-WN-STOK', bank_name: 'FNB',
        bank_account_number: '620123', authority_id: 'SWR-WN' });
    ok('the request is accepted', rS.status === 200 || rS.status === 201,
       `${rS.status} ${JSON.stringify(rS.body).slice(0, 140)}`);
    const tS = await txForSa('SA-WN-STOK');
    ok('and carries the notice', hoursOut(tS) > 47 && hoursOut(tS) < 49,
       `${hoursOut(tS).toFixed(1)}h`);
    ok('so the mandate and the notice both bind, in that order',
       rS.status < 400 && hoursOut(tS) > 47,
       'signatories approve, then the money waits — neither replaces the other');

    console.log('\napproving the stokvel one early');
    const early = await call('POST', `/api/withdrawals/${tS.id}/approve`, tok('STAFF', 'admin'), {});
    ok('is refused', early.status === 409, `${early.status} ${JSON.stringify(early.body)}`);
    ok('and the client is told when', /payable from/i.test(early.body.error || ''), early.body.error);
    ok('the withdrawal is still pending', (await txForSa('SA-WN-STOK')).status === 'pending');

    console.log('\nand once the notice has run');
    await db.query(`UPDATE transactions SET available_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [tS.id]);
    const late = await call('POST', `/api/withdrawals/${tS.id}/approve`, tok('STAFF', 'admin'), {});
    ok('it goes through', late.status === 200 || late.status === 201,
       `${late.status} ${JSON.stringify(late.body).slice(0, 140)}`);

    console.log('\na personal wallet that committed itself to a date');
    const r2 = await call('POST', '/api/withdrawals/request', tok('INV-WN-DATED'),
                          { amount: 1000, bank_name: 'FNB', bank_account_number: '620123' });
    ok('the request is still accepted', r2.status === 200 || r2.status === 201, String(r2.status));
    const t2 = await txFor('INV-WN-DATED');
    ok('is held to it, because it opted in',
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
