#!/usr/bin/env node
/* At maturity, an investor must be paid the return that was actually posted —
 * not the one that was projected when they invested.
 *
 * Returns are posted on the POOL, as investment_pools.actual_rate. That is what
 * the admin close-out does and what the portal reads: Utils.postedReturn falls
 * back to amount x pool_actual_rate when an investment has no actual_return of
 * its own, and the pool investor list says so in as many words — "Returns are
 * posted on the pool (actual_rate); they are not written back to each
 * investment's annual_rate."
 *
 * The maturity engine does not read that column. maturityCron.js:79 is:
 *
 *     const actualReturn = parseFloat(inv.actual_return)
 *                       || parseFloat(inv.expected_return) || 0;
 *
 * investments.actual_return is only ever written by interestCron, which is
 * disabled (server/index.js: "Interest is credited at maturity only"). So in
 * the normal flow it is 0, and the engine pays expected_return — the projected
 * figure computed from the contracted rate at the moment the investment was
 * created.
 *
 * The consequence is that the pool's real result never reaches anyone's wallet.
 * The investor is shown one number and credited another, and the direction of
 * the gap depends on whether the pool beat or missed its projection — so this
 * is not conservative in either direction.
 *
 * `||` also means a genuine zero return falls through: parseFloat("0.0000") is
 * 0, which is falsy, so a pool that returned nothing still pays the projection.
 *
 * TWO CONVENTIONS. server/routes/products.js:236 is explicit that actual_rate
 * means different things by product:
 *
 *   short_term  actual_rate is the TOTAL PERIOD return
 *               paid back = invested x (1 + actual)
 *   others      actual_rate is PER ANNUM
 *               paid back = invested x (1 + actual x term/12)
 *
 * Both are covered below, because a fix that reads actual_rate has to respect
 * the difference or it will overpay one product and underpay the other.
 *
 * This runs the real runMaturityProcessing against a real schema. It asserts
 * what SHOULD happen, so IT FAILS ON PURPOSE until the engine reads the posted
 * rate. That is why it is named spec- rather than check-: the check-* suite is
 * meant to be green, and a deliberately red test sitting inside it would either
 * be silenced or would train everyone to ignore a red suite.
 *
 * When the engine is fixed, this should pass, and can be renamed to check-.
 *
 * Needs a database with the full schema (boot the server against it once):
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/spec-maturity-pays-posted-return.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
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
const eqN = (name, a, b, detail) =>
  ok(name, Math.abs(Number(a) - Number(b)) < 0.005, detail || `expected ${b}, got ${a}`);

const rand = n => 'R' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });

async function seed() {
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-MAT%'`);
  await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'INV-MAT%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'INV-MAT%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-MAT%'`);

  /* Two maturing pools, one per convention. Both ran six months against a
     contracted 12% p.a., so both projected R6 000 on R100 000.

     short_term posts 0.07 meaning "this pool returned 7% over its period"
       → real return R7 000, projection R6 000  (investor is UNDERPAID)
     cattle posts 0.08 meaning "8% per annum"
       → real return R4 000 over six months, projection R6 000  (OVERPAID)

     The two directions are the point: paying the projection is not a
     conservative error, it is simply the wrong number. */
  const maturingPool = async (id, name, productType, actualRate) => pool.query(`
    INSERT INTO investment_pools
      (id, name, product_type, status, annual_rate, actual_rate, term_months,
       start_date, end_date, maturity_date, min_investment, current_invested, raised_amount)
    VALUES ($1,$2,$3,'active',0.12,$4,6,
            CURRENT_DATE - 190, CURRENT_DATE - 1, CURRENT_DATE, 1000, 100000, 100000)`,
    [id, name, productType, actualRate]);

  await maturingPool('POOL-MAT-ST', 'Short Term - August 2026', 'short_term', 0.07);
  await maturingPool('POOL-MAT-CT', 'Cattle - August 2026',     'cattle',     0.08);

  /* The pool a reinvestment should roll into — open, current, same product. */
  await pool.query(`
    INSERT INTO investment_pools
      (id, name, product_type, status, annual_rate, actual_rate, term_months,
       start_date, end_date, maturity_date, min_investment, current_invested, raised_amount)
    VALUES ('POOL-MAT-SEP','Short Term - September 2026','short_term','open',
            0.12, 0, 6, CURRENT_DATE, CURRENT_DATE + 30, CURRENT_DATE + 210, 1000, 0, 0)`);

  const investor = async (id, instruction, poolId, poolName, productType) => {
    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, total_returns)
       VALUES ($1,$2,'Maturing',$3,'active',0,0)`,
      [id, id.replace('INV-MAT-', ''), `${id.toLowerCase()}@example.test`]);
    await pool.query(
      `INSERT INTO investments
         (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
          annual_rate, term_months, expected_return, actual_return, product_type,
          maturity_instruction, maturity_processed_at)
       VALUES ($1,$2,$3,$4,100000,'active',
               CURRENT_DATE - 190, CURRENT_DATE - 1, 0.12, 6, 6000, 0, $5, $6, NULL)`,
      [`INVST-${id}`, id, poolId, poolName, productType, instruction]);
  };

  await investor('INV-MAT-PAYOUT',   'payout_all', 'POOL-MAT-ST', 'Short Term - August 2026', 'short_term');
  await investor('INV-MAT-REINVEST', 'reinvest',   'POOL-MAT-ST', 'Short Term - August 2026', 'short_term');
  await investor('INV-MAT-CATTLE',   'payout_all', 'POOL-MAT-CT', 'Cattle - August 2026',     'cattle');
}

const walletOf = async id =>
  Number((await pool.query(`SELECT wallet_balance FROM investors WHERE id=$1`, [id])).rows[0].wallet_balance);
const returnsOf = async id =>
  Number((await pool.query(`SELECT total_returns FROM investors WHERE id=$1`, [id])).rows[0].total_returns);

(async () => {
  try {
    await seed();

    const { runMaturityProcessing } = require(path.join(__dirname, '..', 'jobs', 'maturityCron.js'));
    await runMaturityProcessing();

    const PROJECTED  = 6000;   // 12% p.a. contracted, computed at investment time
    const POSTED_ST  = 7000;   // short_term: 7% of R100 000 for the period
    const POSTED_CT  = 4000;   // cattle: 8% p.a. over six months

    console.log('\nboth pools ran six months against a contracted 12% p.a.');
    console.log(`  projection, both:                 ${rand(PROJECTED)}`);
    console.log(`  short_term posted 7% for period:  ${rand(POSTED_ST)}   (investor is short-changed)`);
    console.log(`  cattle posted 8% p.a.:            ${rand(POSTED_CT)}   (business over-pays)\n`);

    console.log('a payout_all instruction pays the posted return');
    const paidST = await walletOf('INV-MAT-PAYOUT');
    eqN('short_term: capital plus the period return reaches the wallet', paidST, 100000 + POSTED_ST,
        `wallet holds ${rand(paidST)}; posted is ${rand(100000 + POSTED_ST)}, ` +
        `the projection is ${rand(100000 + PROJECTED)}`);
    eqN('and total_returns records the posted figure', await returnsOf('INV-MAT-PAYOUT'), POSTED_ST);

    const paidCT = await walletOf('INV-MAT-CATTLE');
    eqN('cattle: the annual rate is prorated over the term', paidCT, 100000 + POSTED_CT,
        `wallet holds ${rand(paidCT)}; posted is ${rand(100000 + POSTED_CT)}, ` +
        `the projection is ${rand(100000 + PROJECTED)}`);

    console.log('\na reinvest instruction rolls the posted amount forward');
    const { rows: [ri] } = await pool.query(
      `SELECT amount, pool_id FROM investments
        WHERE investor_id='INV-MAT-REINVEST' AND is_reinvestment = true`);
    ok('a new investment was created', !!ri, 'nothing rolled over');
    if (ri) {
      eqN('for capital plus the posted return', ri.amount, 100000 + POSTED_ST,
          `rolled ${rand(ri.amount)}; posted would be ${rand(100000 + POSTED_ST)}, ` +
          `projected ${rand(100000 + PROJECTED)}`);
      ok('into a pool that is still open for funds', ri.pool_id === 'POOL-MAT-SEP',
         `went to ${ri.pool_id} — the target query has no end_date filter and orders by ` +
         `end_date ASC, so the most stale open pool wins`);
    }

    console.log('\nwhat the investor is shown matches what they were paid');
    {
      /* Utils.postedReturn, the portal's rule, applied to the same row. */
      const { rows: [row] } = await pool.query(
        `SELECT i.amount, i.actual_return, p.actual_rate AS pool_actual_rate
           FROM investments i JOIN investment_pools p ON p.id = i.pool_id
          WHERE i.id = 'INVST-INV-MAT-PAYOUT'`);
      const shown = Number(row.actual_return) > 0
        ? Number(row.actual_return)
        : Number(row.amount) * Number(row.pool_actual_rate);
      const credited = paidST - 100000;
      eqN('the portal figure and the credited figure agree', credited, shown,
          `portal shows ${rand(shown)}, wallet received ${rand(credited)} — ` +
          `an investor reading their statement sees a different number from the one they got`);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    console.error(err.stack);
    fail++;
  } finally {
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
