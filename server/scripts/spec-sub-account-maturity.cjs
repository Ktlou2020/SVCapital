#!/usr/bin/env node
/* Money that leaves a sub-account must come back to that sub-account.
 *
 * A sub-account has its own wallet, its own total_invested and its own
 * total_returns. Investing from one debits it: tables.js locks the
 * sub_accounts row and deducts capital plus fee from it.
 *
 * Maturity does not credit it back. creditWallet updates `investors` using
 * inv.investor_id and never reads inv.sub_account_id, so the capital and the
 * return land in the PARENT's wallet. The sub-account is left permanently
 * short by whatever it invested, and its total_returns stays at zero however
 * much it earned.
 *
 * The payout transaction row omits sub_account_id too, so the sub-account's
 * own statement never shows the money arriving — the flow is invisible from
 * the account it belongs to.
 *
 * And a rollover loses the association entirely: the new investment row is
 * inserted without sub_account_id, so a sub-account's capital silently
 * becomes a parent-level holding. Nothing about that is reversible by
 * looking at it later — the link is simply gone.
 *
 * These assertions describe what SHOULD happen. They run the real
 * runMaturityProcessing and they FAIL ON PURPOSE until it handles
 * sub-accounts, which is why this is named spec- rather than check-: the
 * check-* suite is meant to be green, and a deliberately red test inside it
 * would either be silenced or would teach everyone to ignore a red suite.
 *
 * Rename it to check- once the engine credits the account the money came from.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/spec-sub-account-maturity.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqN = (name, a, b, d) =>
  ok(name, Math.abs(Number(a) - Number(b)) < 0.005, d || `expected ${b}, got ${a}`);

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investors', 'investments', 'investment_pools', 'transactions', 'sub_accounts']]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  return true;
}

async function seed() {
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'SA-%'`);
  await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'SA-%'`);
  await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'SUB-%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'SA-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'SAP-%'`);
  /* Neutralise seeded pools so the rollover target is the one under test. */
  await pool.query(`UPDATE investment_pools SET status='active', cycled_at=NOW()
                     WHERE product_type IN ('cattle','short_term')`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment,cycled_at)
    VALUES ('SAP-MAT','Cattle - matured','cattle','active',0.16,0.10,12,
            CURRENT_DATE-360, CURRENT_DATE, CURRENT_DATE, 500, NOW()),
           ('SAP-NEXT','Cattle - next','cattle','open',0.16,0,12,
            CURRENT_DATE-10, CURRENT_DATE+20, CURRENT_DATE+380, 500, NOW())`);

  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, total_returns)
    VALUES ('SA-PARENT','Parent','Investor','parent@example.test','active', 0, 0)`);
  await pool.query(`
    INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
        total_invested, total_returns, status)
    VALUES ('SUB-1','SA-PARENT','trust','Family Trust', 0, 100000, 0, 'active'),
           ('SUB-2','SA-PARENT','trust','Rollover Trust', 0, 100000, 0, 'active')`);

  /* Two investments made FROM sub-accounts: the capital already left those
     wallets, which is why their balances are 0 and total_invested is 100000. */
  await pool.query(`
    INSERT INTO investments (id, investor_id, sub_account_id, pool_id, pool_name, amount, status,
        start_date, end_date, annual_rate, term_months, expected_return, actual_return,
        product_type, maturity_instruction)
    VALUES ('SA-IV-PAY','SA-PARENT','SUB-1','SAP-MAT','Cattle - matured',100000,'active',
            CURRENT_DATE-360, CURRENT_DATE, 0.16, 12, 0, 0, 'cattle', 'payout_all'),
           ('SA-IV-ROLL','SA-PARENT','SUB-2','SAP-MAT','Cattle - matured',100000,'active',
            CURRENT_DATE-360, CURRENT_DATE, 0.16, 12, 0, 0, 'cattle', 'reinvest')`);
}

const sub = async id => (await pool.query(
  `SELECT wallet_balance, total_returns FROM sub_accounts WHERE id=$1`, [id])).rows[0];
const parent = async () => (await pool.query(
  `SELECT wallet_balance, total_returns FROM investors WHERE id='SA-PARENT'`)).rows[0];

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    await seed();

    const { runMaturityProcessing } = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));
    const q = console.log; console.log = () => {};
    try { await runMaturityProcessing(); } finally { console.log = q; }

    /* 10% of R100,000 for the period = R10,000. */
    const POSTED = 10000, CAPITAL = 100000;

    console.log('\na payout returns to the sub-account it came from');
    const s1 = await sub('SUB-1');
    const p  = await parent();
    eqN('the sub-account wallet receives capital plus return', s1.wallet_balance, CAPITAL + POSTED,
        `sub-account holds R${s1.wallet_balance}; the parent holds R${p.wallet_balance}`);
    eqN('and its total_returns records what it earned', s1.total_returns, POSTED);
    eqN('the parent wallet is untouched — the money was never theirs', p.wallet_balance, 0,
        `parent holds R${p.wallet_balance}`);

    console.log('\nthe payout is visible from the sub-account it belongs to');
    {
      const { rows } = await pool.query(
        `SELECT sub_account_id, amount FROM transactions
          WHERE investment_id='SA-IV-PAY' AND type='payout'`);
      ok('a payout row exists', rows.length === 1, JSON.stringify(rows));
      ok('carrying the sub-account it paid into',
         rows[0] && rows[0].sub_account_id === 'SUB-1',
         `sub_account_id=${rows[0] && rows[0].sub_account_id} — without it the sub-account ` +
         'statement never shows the money arriving');
    }

    console.log('\na rollover stays with the sub-account');
    {
      const { rows: [ri] } = await pool.query(
        `SELECT id, sub_account_id, amount FROM investments
          WHERE investor_id='SA-PARENT' AND is_reinvestment = true`);
      ok('a new investment was created', !!ri, 'nothing rolled over');
      ok('and it still belongs to the sub-account',
         ri && ri.sub_account_id === 'SUB-2',
         `sub_account_id=${ri && ri.sub_account_id} — a rollover must not silently ` +
         'move a sub-account holding to the parent');
      if (ri) eqN('for capital plus the posted return', ri.amount, CAPITAL + POSTED);
      const s2 = await sub('SUB-2');
      eqN('the sub-account records the return it earned on the way through',
          s2.total_returns, POSTED,
          'the capital rolled on, but the return was still earned by this account');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'SA-%'`).catch(() => {});
    await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'SA-%'`).catch(() => {});
    await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'SUB-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors    WHERE id LIKE 'SA-%'`).catch(() => {});
    await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'SAP-%'`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
