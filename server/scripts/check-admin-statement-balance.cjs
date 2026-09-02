#!/usr/bin/env node
/* The admin console's client statement must agree with the client's wallet.
 *
 * A real statement, issued to a real client, opened with:
 *
 *     Opening Balance — 1 August 2026        R 24 010,73 Dr
 *     18 Aug 2026  INTEREST                  R 17,60
 *     Closing Balance — 1 September 2026     R 23 993,13 Dr
 *
 * "Dr" means the document was telling a client with money on deposit that they
 * owed the fund twenty-four thousand rand. Two separate defects put it there.
 *
 * TWO DEFINITIONS IN ONE DOCUMENT
 *
 * The opening balance was computed on the server from services/ledger.js. The
 * running balance beneath it was computed in the browser from a different list
 * — DEBIT_TYPES = {investment, reinvestment, withdrawal, fee}, everything else
 * a credit. They disagree about platform_fee, gift_sent, return, and every type
 * neither had heard of. So a PLATFORM FEE INCREASED the client's balance as the
 * page went down, and the ledger could not tie to its own opening figure by
 * construction.
 *
 * THE BALANCE WAS DERIVED, NOT ANCHORED
 *
 * opening_balance was SUM(cash effect) over all prior transactions, presented
 * as the client's balance. ledger.js says in its own header that the wallet
 * column is authoritative and that its definition is "for reporting and
 * reconciliation, not for repair" — because almost every write path moves the
 * wallet directly, and a reinvestment whose matching matured_funds credit was
 * never written leaves the derived figure short by the whole reinvested amount.
 * That gap is a known historical one; it has a backfill of its own.
 *
 * The closing balance is now the wallet with everything after the period
 * unwound, the opening is that less the period's movement, and when the derived
 * figure disagrees the statement says so and by how much — because that
 * disagreement is a data problem worth seeing, not something to paper over with
 * a plausible number.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-admin-statement-balance.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const express = require('express');
const pool    = require(path.join(__dirname, '..', 'db', 'pool'));
const { cashMovement, CASH_CREDIT_TYPES, CASH_DEBIT_TYPES } =
  require(path.join(__dirname, '..', 'services', 'ledger'));

const ROOT  = path.join(__dirname, '..', '..');
/* The statement builder moved out of admin.js into js/investor-documents.js,
   which the investor portal loads too — one implementation for both. */
const ADMIN = fs.readFileSync(path.join(ROOT, 'js', 'investor-documents.js'), 'utf8');
const CODE  = ADMIN
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.round((a || 0) * 100) === Math.round((b || 0) * 100);

console.log('\none rule for what moves cash');
{
  ok('a platform fee is a debit', cashMovement({ type: 'platform_fee', amount: 80 }) === -80,
     'the console counted it as a CREDIT, so a fee raised the client\'s balance');
  ok('and so is a gift sent', cashMovement({ type: 'gift_sent', amount: 50 }) === -50);
  ok('a return moves no cash — it is an accrual',
     cashMovement({ type: 'return', amount: 900 }) === 0,
     'the cash reaches the wallet later as a payout; counting both pays it twice');
  ok('interest is a credit', cashMovement({ type: 'interest', amount: 17.6 }) === 17.6);
  ok('a type nobody has classified moves nothing',
     cashMovement({ type: 'pledge_wallet_credit', amount: 1 }) === 0,
     'a balance is not the place to guess');
  ok('the sign of the stored amount cannot flip it',
     cashMovement({ type: 'deposit', amount: -100 }) === 100 &&
     cashMovement({ type: 'withdrawal', amount: -100 }) === -100,
     'the type carries the direction; some rows store the amount signed and some do not');
  ok('reinvestment and matured_funds are a matched pair',
     CASH_DEBIT_TYPES.includes('reinvestment') && CASH_CREDIT_TYPES.includes('matured_funds'),
     'including one without the other invents or destroys money');
}

console.log('\nthe console no longer computes balances of its own');
{
  ok('its private debit list is gone',
     !/DEBIT_TYPES = new Set\(\['investment', 'reinvestment', 'withdrawal', 'fee'\]\)/.test(CODE),
     'it disagreed with the server about four types and every unknown one');
  ok('each row carries the effect the server computed',
     /parseFloat\(t\.cash_effect\)/.test(CODE) && /parseFloat\(t\.running_balance\)/.test(CODE));
  ok('the closing balance comes from the server too',
     /const closingBal = r2\(closing_balance\)/.test(CODE),
     'it used to be whatever the browser\'s own running total ended on');
  ok('a row with no cash effect is labelled, not left blank',
     /no cash movement/.test(CODE));
  ok('and a mismatch against the wallet is printed on the statement',
     /reconciles === false/.test(CODE) && /Resolve it before sending/.test(CODE));
}

/* ── Against a real database ────────────────────────────────────────────── */
const authMod  = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
const realAuth = require(authMod);
require.cache[authMod].exports = {
  ...realAuth,
  requireAuth: (req, _r, next) => { req.user = { role: 'director', id: 'u-st', email: 'st@chk.test' }; next(); },
  requireRole: () => (_q, _r, next) => next(),
};

const app = express();
app.use(express.json());
app.use('/api/admin', require(path.join(__dirname, '..', 'routes', 'manualCredit')));

let server;
const get = p => new Promise(res => {
  const r = http.request({ port: server.address().port, path: p, method: 'GET' }, x => {
    let s = ''; x.on('data', c => s += c);
    x.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); });
  });
  r.on('error', () => res({ status: 0, body: {} }));
  r.end();
});

const INV = 'INV-STMT-CHK';
async function cleanup() {
  await pool.query(`DELETE FROM transactions WHERE investor_id = $1`, [INV]);
  await pool.query(`DELETE FROM investors WHERE id = $1`, [INV]);
}

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString();

async function seed(wallet, txns) {
  await cleanup();
  await pool.query(
    `INSERT INTO investors (id, first_name, last_name, email, wallet_balance, status)
     VALUES ($1,'Kagiso','Tloubatla','stmt@chk.test',$2,'active')`, [INV, wallet]);
  let n = 0;
  for (const t of txns) {
    await pool.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, created_at, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`TXN-STMT-${++n}`, INV, t.type, t.amount, t.status || 'completed', t.at, t.desc || null]);
  }
}

(async () => {
  try {
    server = app.listen(0);
    await new Promise(r => server.on('listening', r));

    console.log('\nthe statement is anchored to the wallet');
    {
      /* The shape from the real statement: an interest credit inside the
         period, a reinvestment before it whose matured_funds credit was never
         written, and a wallet that says the client is in funds. */
      await seed(5000, [
        { type: 'deposit',      amount: 10000, at: D(2025, 6, 1) },
        { type: 'reinvestment', amount: 4314.07, at: D(2024, 12, 31) },   // no matching matured_funds
        { type: 'interest',     amount: 17.60,  at: D(2026, 8, 18), desc: 'Interest — 2026-07_2' },
        { type: 'withdrawal',   amount: 500,    at: D(2026, 9, 15) },     // after the period
      ]);
      const r = await get(`/api/admin/account-statement?investor_id=${INV}&from=2026-08-01&to=2026-09-01`);
      ok('the endpoint answers', r.status === 200, JSON.stringify(r.body).slice(0, 200));

      /* Wallet 5 000, plus the 500 withdrawn after the period = 5 500 closing. */
      ok('THE CLOSING BALANCE IS THE WALLET, UNWOUND TO THE PERIOD END',
         near(r.body.closing_balance, 5500),
         `${r.body.closing_balance} — the client has R5 000 today and R500 left after the period`);
      ok('and it is positive, as the client\'s money is',
         r.body.closing_balance > 0,
         'the real statement said R23 993,13 Dr for an account in funds');
      ok('the opening balance is the closing less the period movement',
         near(r.body.opening_balance, 5500 - 17.60), String(r.body.opening_balance));

      ok('the derived figure is reported alongside, not instead',
         'derived_opening_balance' in r.body);
      ok('and the two are flagged as disagreeing',
         r.body.reconciles === false,
         'the unpaired reinvestment leaves the history short — that is the whole point');
      ok('with the size of the gap',
         Math.abs(r.body.ledger_gap) > 0, String(r.body.ledger_gap));
    }

    console.log('\nan investment that matured in the period is on the statement');
{
  /* The case the old filter dropped: started well before the period, matured
     inside it. This is the ordinary shape of anything whose term is longer than
     the statement, which is most of them. */
  await seed(1000, [{ type: 'deposit', amount: 1000, at: D(2026, 1, 5) }]);
  const pool1 = 'POOL-STMT-CHK';
  await pool.query(
    `INSERT INTO investment_pools (id, name, product_type, status, annual_rate)
     VALUES ($1,'Short Term Investment','short_term','matured',0.0323)
     ON CONFLICT (id) DO NOTHING`, [pool1]);

  const mk = (id, start, end, status) => pool.query(
    `INSERT INTO investments (id, investor_id, pool_id, amount, status, start_date, end_date, expected_return, actual_return)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, INV, pool1, 100000, status, start, end, 3000, status === 'matured' ? 3230 : null]);

  await mk('INVST-BEFORE', D(2024, 3, 1), D(2026, 4, 30), 'matured');   // matured IN the period
  await mk('INVST-INSIDE', D(2026, 2, 1), D(2026, 2, 28), 'matured');   // started and matured inside
  await mk('INVST-OLD',    D(2023, 1, 1), D(2025, 6, 30), 'matured');   // matured BEFORE the period
  await mk('INVST-LIVE',   D(2025, 9, 1), D(2027, 9, 1),  'active');    // running through it

  const r = await get(`/api/admin/account-statement?investor_id=${INV}&from=2026-01-01&to=2026-09-01`);
  const ids = (r.body.investments || []).map(i => i.id);

  ok('AN INVESTMENT THAT MATURED IN THE PERIOD IS INCLUDED',
     ids.includes('INVST-BEFORE'),
     'it started in 2024, so filtering on start date dropped it — the defect the client reported');
  ok('one that started and matured inside it still is', ids.includes('INVST-INSIDE'));
  ok('one running through the whole period is', ids.includes('INVST-LIVE'));
  ok('and one that matured BEFORE the period is not',
     !ids.includes('INVST-OLD'),
     'a statement is for its period; everything ever held is a different document');

  await pool.query(`DELETE FROM investments WHERE investor_id = $1`, [INV]);
  await pool.query(`DELETE FROM investment_pools WHERE id = $1`, [pool1]);
}

console.log('\nthe portfolio summary adds up');
{
  const src = ADMIN;
  ok('the summary shows active investment capital', /Active investment capital/.test(src));
  ok('and the wallet balance beside it', /Wallet balance<\/td>/.test(CODE) || /Wallet balance/.test(src));
  ok('and totals the two', /Total portfolio value/.test(src));
  ok('the wallet figure is the CLOSING balance, not today\'s',
     /const walletAtClose  = Math\.round\(\(parseFloat\(data\.closing_balance\)/.test(CODE),
     "today's wallet would be a figure the ledger below never reaches");
  ok('the summary is dated to the period end', /Portfolio Summary &mdash; as at ' \+ toLabel/.test(CODE));
  ok('pending capital counts as active, since it has left the wallet',
     /\['active','pending'\]\.includes\(i\.status\)/.test(CODE),
     'leaving it out would make the two figures fail to account for it');
  ok('the paid box shows returns paid to the client', /Returns paid to you/.test(src));
  ok('and keeps accrued returns visually apart',
     /Returns accrued, not yet paid/.test(src),
     'a client reading a single "returns" figure must not be shown cash plus accrual');
  /* Withdrawals are deliberately NOT summarised here. They are on the ledger
     below with their dates and references, and the box is about what the fund
     paid the client — not what the client then chose to move. The endpoint
     still returns the figure, so restoring the row is a one-line change. */
  ok('withdrawals are not summarised in the paid box',
     !/Withdrawn to your bank/.test(src));
  ok('an active investment past its maturity date is flagged',
     /still marked active although/.test(src),
     'the client will ask, so the person sending it should know first');
}

console.log('\nwhat was paid, in rands');
{
  await seed(2000, [
    { type: 'payout',       amount: 4893.02, at: D(2026, 3, 31) },
    { type: 'interest',     amount: 227.78,  at: D(2026, 8, 18) },
    { type: 'return',       amount: 900,     at: D(2026, 4, 1) },     // accrual, not cash
    { type: 'withdrawal',   amount: 4000,    at: D(2026, 4, 2) },
    { type: 'deposit',      amount: 40000,   at: D(2026, 6, 29) },
    { type: 'investment',   amount: 40000,   at: D(2026, 6, 29) },
    { type: 'platform_fee', amount: 400,     at: D(2026, 6, 29) },
    { type: 'payout',       amount: 99999,   at: D(2025, 1, 1) },     // before the period
  ]);
  const r = await get(`/api/admin/account-statement?investor_id=${INV}&from=2026-01-01&to=2026-09-01`);
  const paid = r.body.paid || {};

  ok('returns paid are the payouts and interest actually received',
     near(paid.returns, 4893.02 + 227.78), String(paid.returns));
  ok('an ACCRUED return is reported apart, never added in',
     near(paid.accrued, 900) && !near(paid.returns, 4893.02 + 227.78 + 900),
     'an accrual is money earned and not yet handed over; summing the two reports it twice');
  ok('withdrawals to the bank are their own figure', near(paid.withdrawn, 4000), String(paid.withdrawn));
  ok('deposits and placements are separated', near(paid.deposited, 40000) && near(paid.invested, 40000));
  ok('fees are shown', near(paid.fees, 400), String(paid.fees));
  ok('and nothing outside the period is counted',
     !near(paid.returns, 4893.02 + 227.78 + 99999),
     'the R99 999 payout was a year before the period');
}

console.log('\nthe ledger ties to its own opening and closing');
    {
      await seed(12000, [
        { type: 'deposit',      amount: 20000, at: D(2026, 1, 10) },
        { type: 'investment',   amount: 8000,  at: D(2026, 8, 5) },
        { type: 'platform_fee', amount: 80,    at: D(2026, 8, 5) },
        { type: 'payout',       amount: 100,   at: D(2026, 8, 20) },
        { type: 'return',       amount: 900,   at: D(2026, 8, 21) },      // accrual
        { type: 'deposit',      amount: 999,   at: D(2026, 8, 22), status: 'rejected' },
      ]);
      const r = await get(`/api/admin/account-statement?investor_id=${INV}&from=2026-08-01&to=2026-08-31`);
      const t = r.body.transactions;

      ok('a rejected transaction is not on the statement at all',
         !t.some(x => Math.abs(parseFloat(x.amount)) === 999),
         'the endpoint selects completed rows only');

      const move = t.reduce((s, x) => s + parseFloat(x.cash_effect), 0);
      ok('OPENING + THE PERIOD MOVEMENT = CLOSING',
         near(r.body.opening_balance + move, r.body.closing_balance),
         `${r.body.opening_balance} + ${move} ≠ ${r.body.closing_balance}`);

      const last = t[t.length - 1];
      ok('and the last row\'s running balance IS the closing balance',
         near(parseFloat(last.running_balance), r.body.closing_balance),
         `${last.running_balance} vs ${r.body.closing_balance}`);

      const fee = t.find(x => x.type === 'platform_fee');
      ok('a platform fee reduces the balance', parseFloat(fee.cash_effect) === -80,
         `${fee.cash_effect} — the console used to add it`);
      const ret = t.find(x => x.type === 'return');
      ok('a return leaves the balance alone', parseFloat(ret.cash_effect) === 0,
         `${ret.cash_effect} — it is an accrual, paid later as a payout`);
      ok('but is still listed, so the client sees it',
         !!ret, 'omitting it would hide a real event');
    }

    console.log('\na clean account reconciles');
    {
      await seed(11500, [
        { type: 'deposit',    amount: 12000, at: D(2026, 5, 1) },
        { type: 'withdrawal', amount: 500,   at: D(2026, 8, 9) },
      ]);
      const r = await get(`/api/admin/account-statement?investor_id=${INV}&from=2026-08-01&to=2026-08-31`);
      ok('the derived and anchored openings agree', r.body.reconciles === true,
         `derived ${r.body.derived_opening_balance} vs anchored ${r.body.opening_balance}`);
      ok('and no gap is reported', near(r.body.ledger_gap, 0), String(r.body.ledger_gap));
      ok('the closing balance equals the wallet when nothing follows the period',
         near(r.body.closing_balance, 11500), String(r.body.closing_balance));
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    try { server && server.close(); } catch (_) { /* already down */ }
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
