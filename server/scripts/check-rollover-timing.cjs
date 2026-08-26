#!/usr/bin/env node
/* A rollover has to land in the pool while that pool is still open.
 *
 * The month-end timing is tighter than it looks, and two crons interact:
 *
 *   23:00 SAST  maturity engine — cycleExpiredPools() FIRST, then
 *               runMaturityProcessing(). 23:00 SAST is 21:00 UTC the SAME day,
 *               so the database's CURRENT_DATE has not rolled over.
 *   00:01 SAST  pool cycler on its own schedule. 00:01 SAST on the 1st is
 *               22:01 UTC on the 31st — still "the 31st" to a UTC database.
 *
 * The target pool for a month-end rollover typically closes on the very day
 * the investments mature (end_date = 31 Aug for both). Two questions follow,
 * and both are answered here by running the real functions in the real order:
 *
 *   1. Does a pool closing TODAY still accept the rollover at 23:00?
 *      The floor is `end_date >= CURRENT_DATE`, so it should — but that is
 *      exactly the kind of boundary worth executing rather than reasoning about.
 *
 *   2. Does cycleExpiredPools, which runs FIRST, take the target away?
 *      It used to. Cycling any pool also deployed every OTHER open pool of
 *      that product type — the current month-end one included — before a cent
 *      moved, so R3.9m of rollovers would have landed in a successor minted
 *      moments earlier, on a different close date and term. The sweep now
 *      only deploys pools that have passed their own close date, so a pool
 *      still inside its fundraising window survives it.
 *
 *      Both halves are held here: the current pool keeps its rollovers, and
 *      the sweep still deploys pools that really have closed — narrowing it
 *      must not turn it off.
 *
 * Needs a database: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-rollover-timing.cjs
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

function isScratchDatabase(url) {
  const name = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(name) || /^svctest/.test(name);
}

async function ensureSchema() {
  const needed = ['investors', 'investments', 'investment_pools', 'transactions'];
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [needed]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const quiet = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = quiet; }
  return true;
}

/* Today stands in for 31 August: the investments mature today and the
   successor pool closes today. Relative dates keep this true whenever it runs. */
async function seed({ withCyclablePool }) {
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'RT-%'`);
  await pool.query(`DELETE FROM investments  WHERE investor_id LIKE 'RT-%' OR pool_id LIKE 'RT-%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'RT-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'RT-%'`);
  /* Neutralise the seeded demo pools: several sit 'open' years past their
     close date and would otherwise be cycled, which is the very effect under
     test here. Each case re-creates whatever it needs. */
  await pool.query(
    `UPDATE investment_pools SET status='active', cycled_at = NOW()
      WHERE product_type IN ('cattle','short_term') AND id NOT LIKE 'RT-%'`);

  // The maturing pool: rate posted, matures today.
  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment,cycled_at)
    VALUES ('RT-MATURING','Cattle Investment - August 2025','cattle','active',0.16,0.1223,12,
            CURRENT_DATE-360, CURRENT_DATE, CURRENT_DATE, 500, NOW())`);

  // The successor the rollovers are meant for — open, and closing TODAY.
  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
        start_date,end_date,maturity_date,min_investment,cycled_at)
    VALUES ('RT-TARGET','Cattle Investment - August 2026','cattle','open',0.16,12,
            CURRENT_DATE-30, CURRENT_DATE, CURRENT_DATE+365, 500, NOW())`);

  if (withCyclablePool) {
    /* A cattle pool that closed inside the cycler's 60-day window and has
       never been cycled. cycleExpiredPools will pick this up at 23:00 —
       before any money moves. */
    await pool.query(`
      INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
          start_date,end_date,maturity_date,min_investment,cycled_at)
      VALUES ('RT-STALE','Cattle Investment - July 2026','cattle','active',0.16,12,
              CURRENT_DATE-90, CURRENT_DATE-10, CURRENT_DATE+270, 500, NULL)`);
  }

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,wallet_balance)
    VALUES ('RT-I','Roll','Over','rt@example.test','active',0)`);
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction)
    VALUES ('RT-1','RT-I','RT-MATURING','Cattle Investment - August 2025',100000,'active',
            CURRENT_DATE-360, CURRENT_DATE, 0.16, 12, 0, 0, 'cattle', 'reinvest')`);
}

const landed = async () => (await pool.query(
  `SELECT pool_id, pool_name, amount FROM investments
    WHERE investor_id='RT-I' AND is_reinvestment = true`)).rows[0] || null;
const wallet = async () => Number((await pool.query(
  `SELECT wallet_balance FROM investors WHERE id='RT-I'`)).rows[0].wallet_balance);
const statusOf = async id => (await pool.query(
  `SELECT status FROM investment_pools WHERE id=$1`, [id])).rows[0]?.status;

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }

    const { cycleExpiredPools }     = require(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'));
    const { runMaturityProcessing } = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));
    const quiet = () => {};

    console.log('\nthe 23:00 job, in the order the cron runs it');
    console.log('  (investments mature today; the target pool also closes today)');

    /* ── Case 1: nothing else to cycle ─────────────────────────────── */
    await seed({ withCyclablePool: false });
    {
      const log = console.log; console.log = quiet;
      await cycleExpiredPools();
      await runMaturityProcessing();
      console.log = log;
    }
    const a = await landed();
    ok('a pool closing TODAY still receives the rollover',
       a && a.pool_id === 'RT-TARGET',
       a ? `landed in ${a.pool_id}` : `nothing rolled over; wallet holds ${await wallet()}`);
    ok('and nothing fell back to the wallet', await wallet() === 0,
       `wallet holds ${await wallet()}`);
    ok('the target pool was still open when the money moved',
       await statusOf('RT-TARGET') === 'open', `status is ${await statusOf('RT-TARGET')}`);

    /* ── Case 2: another pool of the same product is due to cycle ──── */
    await seed({ withCyclablePool: true });

    /* Ask the pre-flight what it thinks will happen BEFORE running the job,
       then run the job. A report that predicts the wrong destination is worse
       than no report — someone reads "rolls into X", sees the money land in Y,
       and stops trusting the tool. */
    const { runMaturityPreflight } = require(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'));
    const predicted = await runMaturityPreflight(pool, { horizonDays: 14 });
    const predictedEntry = predicted.pools.find(p => p.poolId === 'RT-MATURING');
    const predictedSwept  = !!(predictedEntry && predictedEntry.rollsInto[0]
                               && predictedEntry.rollsInto[0].willBeSwept);
    const predictedTarget = predictedEntry && predictedEntry.rollsInto[0]
                              && predictedEntry.rollsInto[0].poolId;

    {
      const log = console.log; console.log = quiet;
      await cycleExpiredPools();          // runs FIRST, exactly as the cron does
      await runMaturityProcessing();
      console.log = log;
    }
    const b = await landed();
    const targetStatus = await statusOf('RT-TARGET');
    const successor = (await pool.query(
      `SELECT id, name, end_date FROM investment_pools
        WHERE id LIKE 'RT-STALE-CYC-%' AND status='open'`)).rows[0];

    console.log('\nwhen the cycler has something to cycle first');
    ok('the cycler still opens a successor for the stale pool', !!successor,
       'nothing was cycled — the fixture is not exercising the path');
    ok('but it leaves the current pool open',
       targetStatus === 'open',
       `RT-TARGET is "${targetStatus}" — the sweep must only deploy pools past their close date`);
    ok('so the rollover reaches the pool it was meant for',
       b && b.pool_id === 'RT-TARGET',
       b ? `landed in ${b.pool_id}${successor ? `, successor was ${successor.id}` : ''}` : 'nothing rolled over');
    ok('and not the successor minted moments earlier',
       !!successor && b && b.pool_id !== successor.id,
       `successor ${successor && successor.id}, landed ${b && b.pool_id}`);
    ok('money moved', (await wallet()) === 0 && !!b, `wallet holds ${await wallet()}`);

    console.log('\nand the pre-flight said so beforehand');
    ok('it named the intended pool, without a sweep warning',
       predictedTarget === 'RT-TARGET' && predictedSwept !== true,
       `predicted target=${predictedTarget}, swept flag=${predictedSwept}`);
    ok('the prediction matches where the money actually went',
       predictedTarget === (b && b.pool_id),
       `predicted ${predictedTarget}, actually ${b && b.pool_id}`);

    console.log('\nthe sweep still does the job it was there for');
    {
      /* Narrowing it must not turn it off. The invariant is still "only the
         newest successor stays open for this product" — a pool that has
         genuinely passed its close date is deployed, exactly as before. */
      await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'RT-SWEEP%'`);
      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
            start_date,end_date,maturity_date,min_investment,cycled_at)
        VALUES
         ('RT-SWEEP-PAST','Cattle - stale but open','cattle','open',0.16,12,
          CURRENT_DATE-120, CURRENT_DATE-5, CURRENT_DATE+240, 500, NOW()),
         ('RT-SWEEP-NOW','Cattle - current and open','cattle','open',0.16,12,
          CURRENT_DATE-5, CURRENT_DATE+25, CURRENT_DATE+360, 500, NOW()),
         ('RT-SWEEP-TRIGGER','Cattle - due a cycle','cattle','active',0.16,12,
          CURRENT_DATE-100, CURRENT_DATE-9, CURRENT_DATE+260, 500, NULL)`);
      const log2 = console.log; console.log = quiet;
      await cycleExpiredPools();
      console.log = log2;

      ok('an open pool past its close date is deployed',
         await statusOf('RT-SWEEP-PAST') === 'active',
         `RT-SWEEP-PAST is "${await statusOf('RT-SWEEP-PAST')}" — the sweep must still close these`);
      ok('an open pool still inside its window is left alone',
         await statusOf('RT-SWEEP-NOW') === 'open',
         `RT-SWEEP-NOW is "${await statusOf('RT-SWEEP-NOW')}"`);
    }

    console.log('\nthe timing itself');
    {
      const src = require('fs').readFileSync(
        path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');
      ok('the payout runs at 23:00 SAST — 21:00 UTC the same day',
         /cron\.schedule\('0 23 \* \* \*'/.test(src) && /timezone: 'Africa\/Johannesburg'/.test(src));
      ok('and the cycler runs inside that same job, before it',
         /cycleExpiredPools\(\);[\s\S]{0,80}runMaturityProcessing\(\)/.test(src),
         'the ordering is what makes the sweep able to move the target');
      const cyc = require('fs').readFileSync(
        path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'), 'utf8');
      ok('the cycler never touches a pool closing today',
         /end_date < CURRENT_DATE/.test(cyc),
         'strict less-than is what keeps today\'s pool open through the 23:00 run');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query(`DELETE FROM investments WHERE investor_id LIKE 'RT-%' OR pool_id LIKE 'RT-%'`).catch(() => {});
    await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'RT-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors WHERE id LIKE 'RT-%'`).catch(() => {});
    await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'RT-%' OR id LIKE 'RT-SWEEP%'`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
