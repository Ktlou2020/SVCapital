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
 * THE CONVENTION. actual_rate is the achieved return FOR THE POOL'S PERIOD,
 * already — for every product. It is not per annum and is not prorated over
 * term_months:
 *
 *     posted return = amount x actual_rate
 *
 * That is what Utils.postedReturn already does in the portal, so this brings
 * the money path onto the rule the investor is shown.
 *
 * (server/routes/products.js:236 disagrees — it treats actual_rate as per
 * annum for everything except short_term and prorates it. That endpoint reports
 * product performance and touches no money, but it is on the wrong convention
 * and will misstate non-short-term pools until it is brought across.)
 *
 * Both product types are covered below to pin that they are treated alike.
 *
 * This runs the real runMaturityProcessing — not a re-implementation of it —
 * against the real schema, which it builds itself if the database is empty.
 * It also covers the case where no rate has been posted: the investment must
 * be held back rather than paid at the projection, and must then settle on the
 * next run once the rate is entered, exactly once.
 *
 * Run:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-maturity-pays-posted-return.cjs
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

/* This exercises the real engine, so it needs the real schema rather than a
   hand-written subset — a subset drifts, and then the test passes for the
   wrong reason. autoSetup builds all of it in well under a second, so build it
   here rather than depending on some earlier script having left it behind. */
/* Only ever reset a database that is unmistakably a scratch one. Every other
   check in this suite drops and recreates its own tables, so they are all
   destructive — but this one rebuilds the WHOLE schema, and a DATABASE_URL
   pointed at production by accident must not be survivable. */
function isScratchDatabase(url) {
  const name = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(name) || /^svctest/.test(name);
}

async function ensureSchema() {
  /* Check every table this test touches, not just one: sibling checks drop
     investors and transactions to build their own fixtures, so a single
     sentinel table can be present while the rest are gone. */
  const needed = ['investors', 'investments', 'investment_pools', 'transactions'];
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready
       FROM unnest($1::text[]) AS t`, [needed]);
  if (rows[0].ready) return true;

  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  the schema is incomplete and this database is not a scratch one.');
    console.log('        Point DATABASE_URL at a test database, or set CHECK_ALLOW_RESET=1');
    console.log('        to let this check rebuild the schema from scratch.');
    return false;
  }

  /* A partial schema cannot simply be topped up. autoSetup creates all tables
     in ONE batch, so a single pre-existing table with an unexpected shape
     fails the entire step — leaving every table it would have created absent.
     Start from bare ground instead. */
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const quiet = console.log;
  console.log = () => {};                       // autoSetup narrates at length
  try { await require(path.join(__dirname, '..', 'db', 'setup.js'))(); }
  finally { console.log = quiet; }
  return true;
}

async function seed() {
  /* Stale pools left 'open' past their close date capture the reinvest target
     query, which orders by end_date ASC with no floor. The seeded demo pools
     are exactly that shape, so neutralise them or this test measures the
     wrong thing. */
  await pool.query(
    `UPDATE investment_pools SET status='active'
      WHERE status='open' AND end_date IS NOT NULL AND end_date < CURRENT_DATE`);
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-MAT%'`);
  await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'INV-MAT%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'INV-MAT%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-MAT%'`);

  /* Two maturing pools of different products, to pin that both are read the
     same way. Both ran six months against a contracted 12% p.a., so both
     projected R6 000 on R100 000.

     short_term posts 0.07 — "this pool returned 7% over its period"
       → real return R7 000 vs a R6 000 projection  (investor UNDERPAID)
     cattle posts 0.04 — likewise 4% over its period
       → real return R4 000 vs a R6 000 projection  (business OVERPAYS)

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
  await maturingPool('POOL-MAT-CT', 'Cattle - August 2026',     'cattle',     0.04);

  /* A pool whose rate has NOT been posted. Its investment must be held back,
     not paid at the projection. */
  await maturingPool('POOL-MAT-NR', 'Unposted - August 2026',   'short_term', 0);

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
  await investor('INV-MAT-NORATE',   'payout_all', 'POOL-MAT-NR', 'Unposted - August 2026',   'short_term');
}

const walletOf = async id =>
  Number((await pool.query(`SELECT wallet_balance FROM investors WHERE id=$1`, [id])).rows[0].wallet_balance);
const returnsOf = async id =>
  Number((await pool.query(`SELECT total_returns FROM investors WHERE id=$1`, [id])).rows[0].total_returns);

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    await seed();

    const { runMaturityProcessing } = require(path.join(__dirname, '..', 'jobs', 'maturityCron.js'));
    await runMaturityProcessing();

    const PROJECTED  = 6000;   // 12% p.a. contracted, computed at investment time
    const POSTED_ST  = 7000;   // short_term: 7% of R100 000 for the period
    const POSTED_CT  = 4000;   // cattle: 4% of R100 000 for the period

    console.log('\nboth pools ran six months against a contracted 12% p.a.');
    console.log(`  projection, both:                 ${rand(PROJECTED)}`);
    console.log(`  short_term posted 7% for period:  ${rand(POSTED_ST)}   (investor is short-changed)`);
    console.log(`  cattle posted 4% for period:      ${rand(POSTED_CT)}   (business over-pays)\n`);

    console.log('a payout_all instruction pays the posted return');
    const paidST = await walletOf('INV-MAT-PAYOUT');
    eqN('short_term: capital plus the period return reaches the wallet', paidST, 100000 + POSTED_ST,
        `wallet holds ${rand(paidST)}; posted is ${rand(100000 + POSTED_ST)}, ` +
        `the projection is ${rand(100000 + PROJECTED)}`);
    eqN('and total_returns records the posted figure', await returnsOf('INV-MAT-PAYOUT'), POSTED_ST);

    const paidCT = await walletOf('INV-MAT-CATTLE');
    eqN('cattle is read the same way — the rate is not prorated', paidCT, 100000 + POSTED_CT,
        `wallet holds ${rand(paidCT)}; posted is ${rand(100000 + POSTED_CT)}, ` +
        `the projection is ${rand(100000 + PROJECTED)}`);

    console.log('\nan unposted rate is held back, not paid at the projection');
    eqN('nothing reached the wallet', await walletOf('INV-MAT-NORATE'), 0,
        'paying the projection is exactly the defect this fixes');
    {
      const { rows: [held] } = await pool.query(
        `SELECT status, maturity_processed_at FROM investments WHERE id='INVST-INV-MAT-NORATE'`);
      ok('the investment is left active', held && held.status === 'active',
         `status is "${held && held.status}" — a held-back investment must not be marked matured`);
      ok('and unprocessed, so the next run picks it up once the rate is posted',
         held && held.maturity_processed_at === null,
         'setting maturity_processed_at would strand it unpaid forever');
    }

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

    console.log('\nposting the rate releases what was held back');
    {
      /* The whole point of holding back rather than paying a guess is that it
         is recoverable. Prove the recovery, rather than assuming it. */
      await pool.query(`UPDATE investment_pools SET actual_rate = 0.05 WHERE id = 'POOL-MAT-NR'`);
      await runMaturityProcessing();

      eqN('the next run pays the newly posted return', await walletOf('INV-MAT-NORATE'), 105000,
          'the held-back investment should settle with no further intervention');
      const { rows: [done] } = await pool.query(
        `SELECT status, maturity_processed_at FROM investments WHERE id='INVST-INV-MAT-NORATE'`);
      ok('and is marked processed this time', done && done.maturity_processed_at !== null);
      ok('with status matured', done && done.status === 'matured', `status is "${done && done.status}"`);

      /* Re-running must not pay twice — maturity_processed_at is the guard. */
      await runMaturityProcessing();
      eqN('a further run does not pay again', await walletOf('INV-MAT-NORATE'), 105000,
          'maturity_processed_at must keep the run idempotent');
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
