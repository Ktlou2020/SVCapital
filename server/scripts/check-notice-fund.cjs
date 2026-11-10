#!/usr/bin/env node
/* The 30-day notice fund: always open to money in, 1% fee on top, a
 * projected monthly return declared before each month and earned day by
 * day, and money out only after the notice, only to the group's own wallet.
 *
 * Checked:
 *   · the unit price follows the declared rates exactly: day-by-day within
 *     a month, compounding month to month, and unpriceable (not guessed)
 *     when a month has no rate
 *   · a projection can be amended while its month is current or ahead; an
 *     ended month gets its ACTUAL instead, which is final, replaces the
 *     projection in every price, and pays a waiting withdrawal on the true
 *     figure; every change is logged
 *   · OFF means off until the setting says otherwise
 *   · money in clears the mandate once, for that fund; the approved amount
 *     reaches the fund and the wallet pays it plus 1%, charged as its own fee
 *     row and shared out of the pot at once; the minimum is tested against
 *     the fund amount, not the wallet spend
 *   · money out waits for the notice, is priced on the day it ends, lands in
 *     the group's wallet, and the realised return is shared out
 *   · one withdrawal waiting at a time; it can be cancelled
 *   · only staff who run funds can declare rates; a member cannot
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
const NF = require(path.join(ROOT, 'server', 'services', 'noticeFund.js'));

console.log('\nthe price follows the declared rates');
{
  const rates = [{ month: '2026-01-01', rate: 0.02 }, { month: '2026-02-01', rate: 0.01 }];
  ok('the fund starts at R1 on its first day', NF.priceFrom(rates, '2026-01-01').unit_price === 1);
  ok('and earns day by day: the 16th of a 31-day month at 2% is 1 + 0.02 x 15/31',
     NF.priceFrom(rates, '2026-01-16').unit_price === Math.round((1 + 0.02 * 15 / 31) * 1e6) / 1e6);
  ok('each month starts where the last ended: 1 February is 1.02', NF.priceFrom(rates, '2026-02-01').unit_price === 1.02);
  ok('so the return compounds: 15 February is 1.02 x (1 + 0.01 x 14/28)',
     NF.priceFrom(rates, '2026-02-15').unit_price === Math.round(1.02 * (1 + 0.01 * 14 / 28) * 1e6) / 1e6);
  ok('a month with no rate is not priced at a guess', (NF.priceFrom(rates, '2026-03-05') || {}).missing === '2026-03');
  ok('nor is a day before the fund began', NF.priceFrom(rates, '2025-12-31') === null);
  ok('the fee is 1% on top, as on the pools', NF.feeOn(4000) === 40 && NF.feeOn(1234.56) === 12.35);
  const SETUP = read('server/db/setup.js');
  ok('the notice period can never be below 30 days', /CHECK \(notice_days >= 30\)/.test(SETUP));
  ok('the fund is off until switched on', /'notice_fund_live', 'false'/.test(SETUP));
  ok('and it is kept out of the tables the maturity and pool jobs act on',
     !/notice_fund/.test(read('server/jobs/maturityCron.js') + read('server/jobs/poolCyclerCron.js')));
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
  const G = 'SA-NF-1', G2 = 'SA-NF-2', P = 'INV-NF-';
  const clean = async () => {
    for (const g of [G, G2]) {
      await db.query(`DELETE FROM notice_fund_orders WHERE sub_account_id = $1`, [g]);
      await db.query(`DELETE FROM notice_fund_holdings WHERE sub_account_id = $1`, [g]);
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id = $1)`, [g]);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id = $1`, [g]);
      await db.query(`DELETE FROM stokvel_allocations WHERE sub_account_id = $1`, [g]);
      await db.query(`DELETE FROM transactions WHERE sub_account_id = $1`, [g]);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [g]);
      await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [g]);
    }
    await db.query(`DELETE FROM notice_fund_rate_log WHERE fund_id IN (SELECT id FROM notice_funds WHERE name LIKE 'Check NF%')`);
    await db.query(`DELETE FROM notice_fund_rates WHERE fund_id IN (SELECT id FROM notice_funds WHERE name LIKE 'Check NF%')`);
    await db.query(`DELETE FROM notice_funds WHERE name LIKE 'Check NF%'`);
    await db.query(`DELETE FROM investors WHERE id LIKE 'INV-NF-%'`);
    await db.query(`UPDATE platform_settings SET value = 'false' WHERE key = 'notice_fund_live'`);
  };
  try {
    await clean();
    for (const who of ['CHAIR', 'SIG', 'PLAIN'])
      await db.query(`INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
                      VALUES ($1,$2,'Nf',$3,'active',0)`, [P + who, who.charAt(0) + who.slice(1).toLowerCase(), `${(P + who).toLowerCase()}@example.test`]);
    for (const g of [G, G2]) {
      await db.query(`INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, kyc_status, status, stokvel_quorum, wallet_balance)
                      VALUES ($1,$2,'stokvel',$3,'approved','active',2,10000)`, [g, P + 'CHAIR', g === G ? 'Alexandra Savings Club' : 'Diepsloot Club']);
      for (const [who, role, sig] of [['CHAIR', 'chairperson', true], ['SIG', 'member', true], ['PLAIN', 'member', false]])
        await db.query(`INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
                        VALUES ($1,$2,$3,$4,$5,'active',NOW())`, [`SM-${g}-${who}`, g, P + who, role, sig]);
    }

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
    const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));
    const today = NF.sastDate(Date.now());
    const M0 = today.slice(0, 7);
    const shift = (m, k) => { const [y, mm] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mm - 1 + k, 1)); return d.toISOString().slice(0, 7); };
    const Mprev = shift(M0, -1), Mnext = shift(M0, 1), Mprev2 = shift(M0, -2);
    const wallet = async g => Number((await db.query(`SELECT wallet_balance FROM sub_accounts WHERE id = $1`, [g])).rows[0].wallet_balance);
    const assets = async g => (await shares.netAssets(db, g)).total;
    const shareSum = async g => (await shares.sharesOf(db, g)).shares.reduce((n, s) => n + Number(s.share), 0);

    console.log('\nthe fund’s managers declare the projected rate');
    ok('a member cannot set a fund up', (await call('POST', '/api/admin/notice-funds', 'PLAIN', { name: 'Check NF' })).status === 403);
    const made = await call('POST', '/api/admin/notice-funds', 'FUNDMGR', { name: 'Check NF Group Notice Fund', notice_days: 30, min_deposit: 500 });
    const F = made.body.data.id;
    ok('a fund manager creates it, in draft', made.status === 201 && made.body.data.status === 'draft');
    ok('a notice under 30 days is refused',
       (await call('POST', '/api/admin/notice-funds', 'FUNDMGR', { name: 'Check NF short', notice_days: 7 })).status === 400);
    ok('it cannot open until this month has a projected rate',
       (await call('PATCH', `/api/admin/notice-funds/${F}`, 'FUNDMGR', { status: 'open' })).status === 400);
    const rate = (month, pct) => call('POST', `/api/admin/notice-funds/${F}/rates`, 'FUNDMGR', { month, monthly_rate_pct: pct });
    ok('a member cannot declare one', (await call('POST', `/api/admin/notice-funds/${F}/rates`, 'PLAIN', { month: M0, monthly_rate_pct: 1 })).status === 403);
    ok('last month and this month are declared (the fund’s first months)',
       (await rate(Mprev, 2)).status === 201 && (await rate(M0, 1)).status === 201);
    const amended = await rate(M0, 3);
    ok('this month\u2019s projection can be amended', amended.status === 201 && amended.body.data.declared.amended === true,
       JSON.stringify(amended.body));
    await rate(M0, 1);
    const ended = await rate(Mprev, 5);
    ok('an ended month\u2019s projection cannot: its actual is posted instead',
       ended.status === 400 && /Post its actual/.test(ended.body.error || ''), ended.body.error);
    const act = (month, pct) => call('POST', `/api/admin/notice-funds/${F}/actuals`, 'FUNDMGR', { month, actual_rate_pct: pct });
    ok('no actual for a month that has not ended', (await act(M0, 1)).status === 400);
    ok('nor a loss of half the fund or worse in a month', (await act(Mprev, -60)).status === 400);
    ok('a member cannot post one', (await call('POST', `/api/admin/notice-funds/${F}/actuals`, 'PLAIN', { month: Mprev, actual_rate_pct: 2 })).status === 403);
    ok('next month can be declared, and changed until it starts',
       (await rate(Mnext, 1.5)).status === 201 && (await rate(Mnext, 1.6)).status === 201);
    ok('nothing before the fund’s first month', (await rate(Mprev2, 1)).status === 400);
    ok('a rate of 20% a month or more is refused', (await rate(shift(M0, 2), 20)).status === 400);
    ok('and with a rate it opens', (await call('PATCH', `/api/admin/notice-funds/${F}`, 'FUNDMGR', { status: 'open' })).status === 200);

    console.log('\noff means off');
    const off = await call('GET', `/api/stokvels/${G}/notice`, 'CHAIR');
    ok('while the setting is off, a group is not offered it', off.body.data && off.body.data.available === false);
    ok('and cannot ask to put money in',
       (await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 4000 })).status === 403);
    await db.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'notice_fund_live'`);
    const on = await call('GET', `/api/stokvels/${G}/notice`, 'PLAIN');
    ok('switched on, members see this month’s projected rate and the fee',
       on.body.data.available === true && on.body.data.projected.this_rate === 0.01 && on.body.data.fund.fee_pct === 1,
       JSON.stringify(on.body.data && on.body.data.projected));

    console.log('\nmoney in: the amount reaches the fund, the wallet pays 1% on top');
    ok('under the fund’s minimum is refused',
       (await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 499 })).status === 400);
    const atMin = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 500 });
    ok('the minimum is the fund amount: R500 is allowed though R505 leaves the wallet', atMin.status === 201);
    const ask = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 4000 });
    ok('nothing moves before the signatories approve',
       (await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: ask.body.data.id })).status === 403
       && await wallet(G) === 10000);
    for (const s of ['CHAIR', 'SIG']) await call('POST', `/api/stokvels/${G}/withdrawal-requests/${ask.body.data.id}/vote`, s, { decision: 'approve' });
    const moved = await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: ask.body.data.id });
    ok('once approved, R4 000 goes in and R4 040 leaves the wallet',
       moved.status === 201 && moved.body.data.amount === 4000 && moved.body.data.fee === 40 && await wallet(G) === 5960,
       JSON.stringify(moved.body));
    const price = NF.priceFrom([{ month: `${Mprev}-01`, rate: 0.02 }, { month: `${M0}-01`, rate: 0.01 }], today).unit_price;
    ok('dealt at today’s price', moved.body.data.unit_price === price
       && Math.abs(moved.body.data.units - Math.round(4000 / price * 1e6) / 1e6) < 1e-6, `${moved.body.data.unit_price} vs ${price}`);
    const feeRow = (await db.query(`SELECT type, amount FROM transactions WHERE reference = $1`, [`FEE-${moved.body.data.id}`])).rows[0];
    ok('the fee is its own ledger row', feeRow && feeRow.type === 'fee' && Number(feeRow.amount) === 40, JSON.stringify(feeRow));
    ok('and has left the pot: R10 000 less the R40 fee, shared out across the members',
       await assets(G) === 9960 && Math.abs(await shareSum(G) - 9960) < 0.02, `${await assets(G)} / ${await shareSum(G)}`);
    ok('an approval moves money once',
       (await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: ask.body.data.id })).status === 403);
    const big = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN', { kind: 'notice_deposit', amount: 5950 });
    for (const s of ['CHAIR', 'SIG']) await call('POST', `/api/stokvels/${G}/withdrawal-requests/${big.body.data.id}/vote`, s, { decision: 'approve' });
    const short = await call('POST', `/api/stokvels/${G}/notice/subscribe`, 'PLAIN', { authority_id: big.body.data.id });
    ok('a wallet that holds the amount but not the fee on top is refused, and nothing moves',
       short.status === 400 && /1% fee/.test(short.body.error || '') && await wallet(G) === 5960, short.body.error);
    const unspent = (await db.query(`SELECT status FROM stokvel_withdrawal_requests WHERE id = $1`, [big.body.data.id])).rows[0].status;
    ok('and the approval is not used up by the failed attempt', unspent !== 'used', unspent);

    console.log('\nmoney out, after the notice, with the declared return');
    /* A second group, dealt on the fund's first day so the arithmetic is round:
       R4 000 at R1.00 is 4 000 units; on the 1st of this month the price is 1.02. */
    const c = await db.connect();
    await c.query('BEGIN');
    const fundRow = (await c.query(`SELECT * FROM notice_funds WHERE id = $1`, [F])).rows[0];
    const sub = await NF.subscribe(c, { group: { id: G2, name: 'Diepsloot Club' }, fund: fundRow, amount: 4000,
      now: new Date(`${Mprev}-01T10:00:00Z`).getTime() });
    await c.query('COMMIT'); c.release();
    ok('R4 000 on the first day buys 4 000 units', sub.order && sub.order.units === 4000 && await wallet(G2) === 5960,
       JSON.stringify(sub));
    ok('a member cannot give notice', (await call('POST', `/api/stokvels/${G2}/notice/redeem`, 'PLAIN', { amount: 2040 })).status === 403);
    const out = await call('POST', `/api/stokvels/${G2}/notice/redeem`, 'CHAIR', { amount: 2040 });
    const days = (new Date(out.body.data.payable_at) - Date.now()) / 86400e3;
    ok('the chairperson can, payable in 30 days', out.status === 201 && days > 29.9 && days < 30.1);
    ok('one withdrawal waits at a time',
       (await call('POST', `/api/stokvels/${G2}/notice/redeem`, 'SIG', { all: true })).status === 400);
    await NF.settle(db, F);
    ok('nothing is paid before the notice runs', await wallet(G2) === 5960);
    await db.query(`UPDATE notice_fund_orders SET payable_at = $2 WHERE id = $1`, [out.body.data.id, new Date(`${M0}-01T08:00:00Z`)]);
    await NF.settle(db, F);
    const paid = (await db.query(`SELECT * FROM notice_fund_orders WHERE id = $1`, [out.body.data.id])).rows[0];
    ok('once it has, it is dealt at the price on that day (1.02)', paid.status === 'completed' && Number(paid.unit_price) === 1.02,
       JSON.stringify({ status: paid.status, price: paid.unit_price }));
    ok('R2 040 for 2 000 units lands in the group’s own wallet', Number(paid.proceeds) === 2040 && await wallet(G2) === 8000,
       `${paid.proceeds} → ${await wallet(G2)}`);
    ok('the R40 return it earned is realised and shared: the pot is back to R10 000',
       await assets(G2) === 10000 && Math.abs(await shareSum(G2) - 10000) < 0.02, `${await assets(G2)} / ${await shareSum(G2)}`);
    const all = await call('POST', `/api/stokvels/${G2}/notice/redeem`, 'SIG', { all: true });
    ok('a signatory can give notice on everything, and cancel it',
       all.status === 201 && (await call('POST', `/api/stokvels/${G2}/notice/redeem/${all.body.data.id}/cancel`, 'SIG', {})).status === 200);

    console.log('\nthe actual return replaces the projection');
    /* Notice on the remaining 2 000 units, run out on the 1st of this month
       but not yet paid: last month's actual decides what it is worth. */
    const rest = await call('POST', `/api/stokvels/${G2}/notice/redeem`, 'CHAIR', { all: true });
    await db.query(`UPDATE notice_fund_orders SET payable_at = $2 WHERE id = $1`, [rest.body.data.id, new Date(`${M0}-01T08:00:00Z`)]);
    const posted = await act(Mprev, 2.5);
    ok('last month\u2019s actual return is posted', posted.status === 201
       && posted.body.data.posted.actual_rate_pct === 2.5 && posted.body.data.posted.projected_rate_pct === 2, JSON.stringify(posted.body));
    ok('and from then on prices use it: the 1st of this month is now 1.025, not 1.02',
       (await NF.priceOn(db, F, `${M0}-01`)).unit_price === 1.025);
    const restPaid = (await db.query(`SELECT * FROM notice_fund_orders WHERE id = $1`, [rest.body.data.id])).rows[0];
    ok('a withdrawal still waiting is paid on what the month really earned: 2 000 units at 1.025 is R2 050',
       restPaid.status === 'completed' && Number(restPaid.unit_price) === 1.025 && Number(restPaid.proceeds) === 2050
       && await wallet(G2) === 10050, JSON.stringify({ s: restPaid.status, p: restPaid.unit_price, r: restPaid.proceeds }));
    ok('the earlier withdrawal keeps the price it was dealt at',
       Number((await db.query(`SELECT unit_price FROM notice_fund_orders WHERE id = $1`, [out.body.data.id])).rows[0].unit_price) === 1.02);
    ok('a posted actual is final', (await act(Mprev, 3)).status === 400);
    const seen = await call('GET', `/api/stokvels/${G}/notice`, 'PLAIN');
    ok('members see last month\u2019s actual beside its projection',
       seen.body.data.projected.last_actual === 0.025 && seen.body.data.projected.last_projected === 0.02,
       JSON.stringify(seen.body.data.projected));
    const log = (await db.query(`SELECT field, to_char(month,'YYYY-MM') m, old_rate, new_rate FROM notice_fund_rate_log WHERE fund_id = $1 ORDER BY id`, [F])).rows;
    ok('every change is logged, with what it was before',
       log.filter(l => l.m === M0 && l.field === 'projected').length === 3
       && log.some(l => l.m === M0 && Number(l.old_rate) === 0.03 && Number(l.new_rate) === 0.01)
       && log.some(l => l.m === Mprev && l.field === 'actual' && Number(l.new_rate) === 0.025), JSON.stringify(log));
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
