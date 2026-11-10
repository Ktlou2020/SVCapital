#!/usr/bin/env node
/* The 30-day notice fund: always open to money in; money out only after
 * the notice, only to the group's own wallet, at the price on that day.
 *
 * Checked against a real database:
 *   · OFF means off: groups see nothing and cannot ask, until the setting
 *   · money in clears the mandate like any investment, once, for that fund
 *   · units are FORWARD-priced: a deposit is dealt at the first price on or
 *     after it arrived, never at a price already known
 *   · the group's shares carry the fund at cost the whole time, so moving
 *     money in is not read as the pot shrinking
 *   · money out waits for the notice, is priced on the day it ends, lands in
 *     the group wallet, and the gain is shared out when it is realised
 *   · one withdrawal waiting at a time; it can be cancelled
 *   · a posted price is never overwritten, and none is posted for the future
 *   · only staff who run funds can post prices; a member cannot
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-notice-fund.cjs
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

console.log('\nwithout a database');
{
  const SETUP = read('server/db/setup.js');
  ok('the notice period can never be set below 30 days', /notice_days\s+INT\s+NOT NULL DEFAULT 30 CHECK \(notice_days >= 30\)/.test(SETUP));
  ok('the fund is switched off until someone switches it on', /'notice_fund_live', 'false'/.test(SETUP));
  ok('it is kept out of the tables the maturity and pool jobs act on',
     !/notice_fund/.test(read('server/jobs/maturityCron.js') + read('server/jobs/poolCyclerCron.js')));
  ok('the group’s shares count it at cost', /notice_fund_holdings h[\s\S]{0,200}notice_fund_orders o/.test(read('server/services/stokvelShares.js')));
  ok('and money into it is a kind the mandate knows', /'mandate','notice_deposit'\)/.test(SETUP)
     && /approved for a different fund/.test(read('server/services/stokvelMandate.js')));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const http = require('http');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  let srv;
  const G = 'SA-NF-1', P = 'INV-NF-';
  const clean = async () => {
    await db.query(`DELETE FROM notice_fund_orders WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM notice_fund_holdings WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM notice_fund_prices WHERE fund_id IN (SELECT id FROM notice_funds WHERE name LIKE 'Check NF%')`);
    await db.query(`DELETE FROM notice_funds WHERE name LIKE 'Check NF%'`);
    await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id = $1)`, [G]);
    await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM stokvel_allocations WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM transactions WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [G]);
    await db.query(`DELETE FROM investors WHERE id LIKE 'INV-NF-%'`);
    await db.query(`UPDATE platform_settings SET value = 'false' WHERE key = 'notice_fund_live'`);
  };
  try {
    await clean();
    for (const who of ['CHAIR', 'SIG', 'PLAIN'])
      await db.query(`INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
                      VALUES ($1,$2,'Nf',$3,'active',0)`, [P + who, who.charAt(0) + who.slice(1).toLowerCase(), `${(P + who).toLowerCase()}@example.test`]);
    await db.query(`INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, kyc_status, status, stokvel_quorum, wallet_balance)
                    VALUES ($1,$2,'stokvel','Alexandra Savings Club','approved','active',2,10000)`, [G, P + 'CHAIR']);
    for (const [who, role, sig] of [['CHAIR', 'chairperson', true], ['SIG', 'member', true], ['PLAIN', 'member', false]])
      await db.query(`INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
                      VALUES ($1,$2,$3,$4,$5,'active',NOW())`, ['SM-NF-' + who, G, P + who, role, sig]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api/admin/notice-funds', require(path.join(ROOT, 'server', 'routes', 'noticeFundAdmin.js')));
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const call = (method, p, who, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const tok = who === 'FUNDMGR'
        ? jwt.sign({ id: 'u-fm', role: 'fund_manager', email: 'fund@example.test' }, process.env.JWT_SECRET)
        : jwt.sign({ id: 'u-' + who, role: 'investor', investorId: P + who }, process.env.JWT_SECRET);
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${tok}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s2 = ''; x.on('data', c => s2 += c); x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s2 || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });
    const NF = require(path.join(ROOT, 'server', 'services', 'noticeFund.js'));
    const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));
    const sast = d => new Date(Date.now() + 2 * 3600e3 - d * 86400e3).toISOString().slice(0, 10);
    const wallet = async () => Number((await db.query(`SELECT wallet_balance FROM sub_accounts WHERE id = $1`, [G])).rows[0].wallet_balance);
    const assets = async () => (await shares.netAssets(db, G)).total;

    console.log('\nthe fund’s managers set it up');
    const notStaff = await call('POST', '/api/admin/notice-funds', 'PLAIN', { name: 'Check NF' });
    ok('a member cannot', notStaff.status === 403, `${notStaff.status}`);
    const made = await call('POST', '/api/admin/notice-funds', 'FUNDMGR', { name: 'Check NF Group Notice Fund', notice_days: 30, min_deposit: 500 });
    ok('a fund manager creates it, in draft', made.status === 201 && made.body.data.status === 'draft', JSON.stringify(made.body));
    const F = made.body.data.id;
    const short = await call('POST', '/api/admin/notice-funds', 'FUNDMGR', { name: 'Check NF short', notice_days: 7 });
    ok('a notice period under 30 days is refused', short.status === 400);
    const openNoPrice = await call('PATCH', `/api/admin/notice-funds/${F}`, 'FUNDMGR', { status: 'open' });
    ok('it cannot open without a first price', openNoPrice.status === 400, openNoPrice.body.error);
    await call('POST', `/api/admin/notice-funds/${F}/prices`, 'FUNDMGR', { price_date: sast(20), unit_price: 1 });
    const opened = await call('PATCH', `/api/admin/notice-funds/${F}`, 'FUNDMGR', { status: 'open' });
    ok('and opens once it has one', opened.status === 200);

    console.log('\noff means off');
    const off = await call('GET', `/api/stokvels/${G}/notice`, 'CHAIR');
    ok('while the setting is off, a group is not offered it', off.status === 200 && off.body.data.available === false);
    const offAsk = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 4000 });
    ok('and cannot ask to put money in', offAsk.status === 403, `${offAsk.status}`);
    await db.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'notice_fund_live'`);

    console.log('\nmoney in, with the signatories');
    const tooSmall = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 100 });
    ok('under the fund’s minimum is refused', tooSmall.status === 400);
    const ask = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 4000 });
    ok('any member can ask', ask.status === 201, JSON.stringify(ask.body));
    const early = await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: ask.body.data.id });
    ok('nothing moves before the signatories approve', early.status === 403 && await wallet() === 10000, early.body.error);
    for (const s of ['CHAIR', 'SIG']) await call('POST', `/api/stokvels/${G}/withdrawal-requests/${ask.body.data.id}/vote`, s, { decision: 'approve' });
    const before = await assets();
    const moved = await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: ask.body.data.id });
    ok('once they have, any member moves it in', moved.status === 201 && await wallet() === 6000, JSON.stringify(moved.body));
    ok('and the group’s pot is unchanged: the fund is counted at cost', await assets() === before, `${before} → ${await assets()}`);
    const again = await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: ask.body.data.id });
    ok('an approval moves money once', again.status === 403 && await wallet() === 6000);

    console.log('\nforward pricing');
    await db.query(`UPDATE notice_fund_orders SET requested_at = NOW() - INTERVAL '10 days' WHERE sub_account_id = $1`, [G]);
    let pos = await NF.position(db, F, G);
    ok('the money waits for the next price; it does not buy at the last one', pos.units === 0 && pos.waiting_in === 4000, JSON.stringify(pos));
    const p1 = await call('POST', `/api/admin/notice-funds/${F}/prices`, 'FUNDMGR', { price_date: sast(9), unit_price: 1 });
    pos = await NF.position(db, F, G);
    ok('posting the next price deals it', p1.status === 201 && p1.body.data.settled.subscriptions === 1
       && pos.units === 4000 && pos.cost === 4000, JSON.stringify(pos));
    const dup = await call('POST', `/api/admin/notice-funds/${F}/prices`, 'FUNDMGR', { price_date: sast(9), unit_price: 2 });
    ok('a posted price is never overwritten', dup.status === 400, dup.body.error);
    const future = await call('POST', `/api/admin/notice-funds/${F}/prices`, 'FUNDMGR', { price_date: sast(-3), unit_price: 1 });
    ok('nor is one posted for a day that has not happened', future.status === 400);

    console.log('\nmoney out, after the notice');
    const plainOut = await call('POST', `/api/stokvels/${G}/notice/redeem`, 'PLAIN', { amount: 2000 });
    ok('an ordinary member cannot give notice', plainOut.status === 403);
    const out = await call('POST', `/api/stokvels/${G}/notice/redeem`, 'CHAIR', { amount: 2000 });
    const days = (new Date(out.body.data.payable_at) - Date.now()) / 86400e3;
    ok('the chairperson can, and it is payable in 30 days', out.status === 201 && days > 29.9 && days < 30.1, JSON.stringify(out.body));
    const second = await call('POST', `/api/stokvels/${G}/notice/redeem`, 'SIG', { all: true });
    ok('one withdrawal waits at a time', second.status === 400, second.body.error);
    await NF.settle(db, F);
    ok('nothing is paid before the notice runs', await wallet() === 6000);
    /* The notice runs out: move the clock by moving the date. */
    await db.query(`UPDATE notice_fund_orders SET payable_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [out.body.data.id]);
    await NF.settle(db, F);
    ok('and not until a price on or after its last day exists', await wallet() === 6000);
    await call('POST', `/api/admin/notice-funds/${F}/prices`, 'FUNDMGR', { price_date: sast(2), unit_price: 1.1 });
    const paidOrder = (await db.query(`SELECT * FROM notice_fund_orders WHERE id = $1`, [out.body.data.id])).rows[0];
    ok('then it is dealt at that price', paidOrder.status === 'completed' && Number(paidOrder.unit_price) === 1.1,
       JSON.stringify({ status: paidOrder.status, price: paidOrder.unit_price }));
    ok('and lands in the group’s own wallet', await wallet() === 8000, String(await wallet()));
    pos = await NF.position(db, F, G);
    ok('the units it used are gone, at a proportionate cost', Math.abs(pos.units - 2181.818182) < 1e-5 && pos.cost === 2181.82,
       JSON.stringify(pos));
    const total = await assets();
    const sumShares = (await shares.sharesOf(db, G)).shares.reduce((n, s) => n + Number(s.share), 0);
    ok('the realised gain is shared out across the members',
       Math.abs(total - 10181.82) < 0.01 && Math.abs(sumShares - total) < 0.02, `assets ${total}, shares ${sumShares}`);

    console.log('\ncancelling');
    const all = await call('POST', `/api/stokvels/${G}/notice/redeem`, 'SIG', { all: true });
    const cancel = await call('POST', `/api/stokvels/${G}/notice/redeem/${all.body.data.id}/cancel`, 'SIG', {});
    ok('a signatory can cancel a withdrawal waiting on its notice',
       all.status === 201 && cancel.status === 200, JSON.stringify([all.body, cancel.body]));

    const view = await call('GET', `/api/stokvels/${G}/notice`, 'PLAIN');
    ok('every member sees the holding and its history', view.body.data.available === true
       && view.body.data.position.units > 0 && view.body.data.orders.length >= 3 && view.body.data.may_redeem === false);
    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
