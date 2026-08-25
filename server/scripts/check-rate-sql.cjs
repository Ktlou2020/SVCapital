#!/usr/bin/env node
/* The four investment queries must actually return the pool's posted rate.

   effectiveRate on the client falls back to pool_actual_rate. If a query never
   selects it, every caller downstream shows a dash — the helper is correct and
   the screen is still wrong. Greping the source proves the column is named;
   only running it proves the join resolves and the value arrives.

   Reproduces Jacenter S-1105: R24,744.77 in a pool with 2.13% posted and
   nothing on the investment row. Every query must hand back 0.0213.

   Needs a database:
     DATABASE_URL=postgres://… DATABASE_SSL=false node server/scripts/check-rate-sql.cjs

   Run: node server/scripts/check-rate-sql.cjs
*/
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-rate-sql.cjs header');
  process.exit(0);
}

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqNum = (name, actual, expected) =>
  ok(name, Math.abs(parseFloat(actual) - expected) < 1e-9,
     `expected ${expected}, got ${JSON.stringify(actual)}`);

const POOL_ID = 'CHK-POOL-RATE';
const INV_ID  = 'CHK-INVESTOR-RATE';
const INVST   = 'CHK-INVESTMENT-RATE';

async function seed() {
  await cleanup();
  await pool.query(
    `INSERT INTO investment_pools (id, name, product_type, status, annual_rate, actual_rate, start_date, end_date)
     VALUES ($1, 'Short Term Investment - March 2026', 'other', 'open', 0.0500, 0.0213, '2026-03-31', '2026-08-31')`,
    [POOL_ID]);
  await pool.query(
    `INSERT INTO investors (id, first_name, last_name, email)
     VALUES ($1, 'Jacenter', 'Tloubatla', 'check-rate@example.invalid')`,
    [INV_ID]);
  // The whole point: annual_rate is 0.0000 on the row, not NULL. Postgres
  // hands that back as the string "0.0000", which is truthy in JS.
  await pool.query(
    `INSERT INTO investments (id, investor_id, pool_id, amount, annual_rate, status, start_date, end_date, product_type)
     VALUES ($1, $2, $3, 24744.77, 0.0000, 'active', '2026-03-31', '2026-08-31', 'other')`,
    [INVST, INV_ID, POOL_ID]);
}

async function cleanup() {
  await pool.query('DELETE FROM investments WHERE id = $1', [INVST]);
  await pool.query('DELETE FROM investors   WHERE id = $1', [INV_ID]);
  await pool.query('DELETE FROM investment_pools WHERE id = $1', [POOL_ID]);
}

(async () => {
  try {
    await seed();
    console.log('\nseeded: R24,744.77 · investment rate 0.0000 · pool posted 2.13%\n');

    // 1. GET /api/tables/investments — the admin list and investor detail tab.
    {
      const { rows } = await pool.query(
        `SELECT i.*, COALESCE(ip.product_type, i.product_type) AS product_type,
                ip.actual_rate AS pool_actual_rate
         FROM investments i
         LEFT JOIN investment_pools ip ON ip.id = i.pool_id
         WHERE i.id = $1`, [INVST]);
      ok('list query returns a row', rows.length === 1);
      ok('the stored rate really is the truthy string "0.0000"',
         rows[0].annual_rate === '0.0000',
         `got ${JSON.stringify(rows[0].annual_rate)} (${typeof rows[0].annual_rate})`);
      eqNum('list query carries the pool rate', rows[0].pool_actual_rate, 0.0213);
    }

    // 2. GET /api/tables/investment_pools/:id/investors — drives the CSV export.
    {
      const { rows } = await pool.query(
        `SELECT inv.id AS investment_id, inv.amount, inv.annual_rate,
                i.first_name, sa.name AS sub_account_name,
                ip.actual_rate AS pool_actual_rate
         FROM investments inv
         LEFT JOIN investors i ON i.id = inv.investor_id
         LEFT JOIN sub_accounts sa ON sa.id = inv.sub_account_id
         LEFT JOIN investment_pools ip ON ip.id = inv.pool_id
         WHERE inv.pool_id = $1`, [POOL_ID]);
      ok('pool-investors query returns a row', rows.length === 1);
      eqNum('pool-investors query carries the pool rate', rows[0].pool_actual_rate, 0.0213);
      ok('the new join did not collide with an existing alias', !!rows[0].first_name);
    }

    // 3. GET /api/tables/investments/:id — the single-record fetch.
    {
      const { rows } = await pool.query(
        `SELECT i.*, COALESCE(ip.product_type, i.product_type) AS product_type,
                ip.actual_rate AS pool_actual_rate
         FROM investments i
         LEFT JOIN investment_pools ip ON ip.id = i.pool_id
         WHERE i.id = $1 LIMIT 1`, [INVST]);
      eqNum('single-record query carries the pool rate', rows[0].pool_actual_rate, 0.0213);
    }

    // 4. GET /api/admin/account-statement — the document a client receives.
    {
      const { rows } = await pool.query(
        `SELECT i.id, i.amount,
                COALESCE(NULLIF(i.annual_rate, 0), NULLIF(p.actual_rate, 0), p.annual_rate) AS annual_rate,
                p.actual_rate AS pool_actual_rate
         FROM investments i
         LEFT JOIN investment_pools p ON p.id = i.pool_id
         WHERE i.investor_id = $1`, [INV_ID]);
      eqNum('statement resolves to the posted 2.13%, not the stored 0', rows[0].annual_rate, 0.0213);

      // Plain COALESCE — what shipped — only falls through on NULL.
      const { rows: old } = await pool.query(
        `SELECT COALESCE(i.annual_rate, p.annual_rate) AS annual_rate
         FROM investments i LEFT JOIN investment_pools p ON p.id = i.pool_id
         WHERE i.id = $1`, [INVST]);
      eqNum('and the old COALESCE really did return 0 — this is the bug', old[0].annual_rate, 0);
    }

    // 5. An investment with its own rate must keep it.
    {
      await pool.query('UPDATE investments SET annual_rate = 0.0348 WHERE id = $1', [INVST]);
      const { rows } = await pool.query(
        `SELECT COALESCE(NULLIF(i.annual_rate, 0), NULLIF(p.actual_rate, 0), p.annual_rate) AS annual_rate
         FROM investments i LEFT JOIN investment_pools p ON p.id = i.pool_id
         WHERE i.id = $1`, [INVST]);
      eqNum('an investment\'s own rate still outranks the pool', rows[0].annual_rate, 0.0348);
    }

    // 6. Nothing posted anywhere falls back to the pool's target, not to 0.
    {
      await pool.query('UPDATE investments SET annual_rate = 0 WHERE id = $1', [INVST]);
      await pool.query('UPDATE investment_pools SET actual_rate = 0 WHERE id = $1', [POOL_ID]);
      const { rows } = await pool.query(
        `SELECT COALESCE(NULLIF(i.annual_rate, 0), NULLIF(p.actual_rate, 0), p.annual_rate) AS annual_rate
         FROM investments i LEFT JOIN investment_pools p ON p.id = i.pool_id
         WHERE i.id = $1`, [INVST]);
      eqNum('with nothing posted, the pool\'s target is the last resort', rows[0].annual_rate, 0.05);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    try { await cleanup(); } catch (_) {}
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
