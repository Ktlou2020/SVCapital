#!/usr/bin/env node
/* The handover between a pool that matures and a pool that is still raising.
 *
 * The sequence a succession depends on, in the words it was given in:
 *
 *   23:00 on the close date   the maturing pool pays out, and whatever
 *                             reinvests lands in the pool that is STILL OPEN
 *                             and closing at midnight
 *   00:01 the next day        that pool deploys, and a new one opens
 *
 * One date holds the two apart. The cycler fires on a pool's INVESTMENT START
 * DATE, which the console auto-fills as close + 1 — so at 23:00 on the close
 * date the pool has not reached it, survives the cycle pass that runs first in
 * that job, and is there to take the money.
 *
 * Both halves are driven here, against a real database, rather than asserted
 * about the code. Each phase builds its own dates so "today" plays the right
 * part on any day of the year: the lesson from check-pool-cycle-trigger, where
 * an assertion that inherited today's date only failed on a month end.
 *
 * The failure it guards is quiet. Set the investment start date to the close
 * date and the pool deploys in the SAME 23:00 run; the maturities then find
 * its successor, which is open and raising, so nothing errors and nothing is
 * lost — the money simply raises for another full cycle before being deployed.
 * Nothing on any screen says so afterwards, which is why the pre-flight says
 * it beforehand.
 *
 * Needs a database:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-maturity-pool-handover.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function isScratch(url) {
  const name = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(name) || /^svctest/.test(name);
}

const quiet = async fn => {
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

const wipe = async () => {
  await db.query(`DELETE FROM transactions     WHERE investor_id LIKE 'HO-%'`);
  await db.query(`DELETE FROM investments      WHERE id LIKE 'HO-%' OR investor_id LIKE 'HO-%'`);
  await db.query(`DELETE FROM investors        WHERE id LIKE 'HO-%'`);
  await db.query(`DELETE FROM investment_pools WHERE id LIKE 'HO-%'`);
  /* The seeded demo pools would be swept by the cycler and drown the fixture. */
  await db.query(`UPDATE investment_pools SET status='closed', cycled_at=NOW()
                   WHERE product_type IN ('cattle','short_term') AND id NOT LIKE 'HO-%'`);
};

(async () => {
  try {
    const { rows: [{ ready }] } = await db.query(
      `SELECT to_regclass('public.investment_pools') IS NOT NULL AS ready`);
    if (!ready) {
      if (!isScratch(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
        console.log('  SKIP  incomplete schema and this is not a scratch database.');
        process.exit(0);
      }
      await quiet(() => require(path.join(ROOT, 'server', 'db', 'setup.js'))());
    }

    const { cycleExpiredPools } = require(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'));
    const maturity = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));

    /* ── 23:00 on the close date ──────────────────────────────────── */
    console.log('\n23:00 on the day it matures — the money reaches the pool still raising');
    await wipe();
    /* Raising now, stops at midnight tonight, deploys tomorrow. */
    await db.query(`
      INSERT INTO investment_pools
        (id,name,product_type,status,annual_rate,actual_rate,term_months,
         start_date,end_date,investment_start_date,min_investment,target_amount,current_invested)
      VALUES ('HO-OPEN','Short Term - raising','short_term','open',0.12,0,5,
              ${'$'}1::date - 29, ${'$'}1::date, ${'$'}1::date + 1, 1000, 5000000, 0)`,
      [new Date().toISOString().slice(0, 10)]);
    await db.query(`
      INSERT INTO investment_pools
        (id,name,product_type,status,annual_rate,actual_rate,term_months,start_date,end_date,maturity_date,min_investment,target_amount)
      VALUES ('HO-MAT','Short Term - maturing','short_term','active',0.12,0.05,5,
              CURRENT_DATE-150, CURRENT_DATE-120, CURRENT_DATE, 1000, 5000000)`);
    /* Two decoys, so the target query's own guards are exercised rather than
       assumed. Without them the fixture has one candidate and the rollover
       lands in it whatever the predicates say.

       HO-STALE is the shape that actually went wrong once: status 'open' long
       after it stopped raising, and because the target is ordered by end_date
       ASC it sorts FIRST and wins — matured funds landing in a pool that
       closed years ago. HO-ACTIVE has already been deployed, so it is no
       longer taking subscriptions at all. */
    await db.query(`
      INSERT INTO investment_pools
        (id,name,product_type,status,annual_rate,term_months,start_date,end_date,investment_start_date,min_investment,target_amount)
      VALUES ('HO-STALE','Short Term - stale, never cycled','short_term','open',0.12,5,
              CURRENT_DATE-400, CURRENT_DATE-370, CURRENT_DATE-369, 1000, 5000000),
             ('HO-ACTIVE','Short Term - already deployed','short_term','active',0.12,5,
              CURRENT_DATE-29, CURRENT_DATE, CURRENT_DATE+1, 1000, 5000000)`);
    /* HO-ACTIVE closes on the SAME day as the real target and was created
       first, so the ordering — end_date ASC, then created_at ASC — hands it
       the win the moment the status predicate stops excluding it. A decoy
       that sorts second proves nothing. */
    await db.query(`UPDATE investment_pools SET created_at = NOW() - INTERVAL '2 days' WHERE id='HO-ACTIVE'`);
    await db.query(`INSERT INTO investors (id,first_name,last_name,email,wallet_balance,status)
                    VALUES ('HO-1','Hand','Over','ho@example.com',0,'active')`);
    await db.query(`
      INSERT INTO investments (id,investor_id,pool_id,pool_name,product_type,amount,status,
                               maturity_instruction,start_date,end_date,annual_rate,term_months)
      VALUES ('HO-INV','HO-1','HO-MAT','Short Term - maturing','short_term',10000,'active',
              NULL, CURRENT_DATE-150, CURRENT_DATE, 0.12, 5)`);

    /* The 23:00 job, in its own order: cycle first, then process maturities. */
    await quiet(() => cycleExpiredPools());
    const { rows: [afterCycle] } = await db.query(`SELECT status FROM investment_pools WHERE id='HO-OPEN'`);
    ok('the stale pool is not quietly deployed by the cycle pass either',
       (await db.query(`SELECT status FROM investment_pools WHERE id='HO-STALE'`)).rows[0].status === 'open',
       'it is outside the 60-day window, so it is reported rather than swept');
    ok('the pool closing tonight survives the cycle pass',
       afterCycle.status === 'open',
       `it is "${afterCycle.status}" — deployed before the maturities it was meant to take`);

    await quiet(() => maturity.runMaturityProcessing());
    const { rows: landed } = await db.query(
      `SELECT pool_id, amount, is_reinvestment FROM investments
        WHERE investor_id='HO-1' AND id <> 'HO-INV'`);
    const { rows: [w] } = await db.query(`SELECT wallet_balance FROM investors WHERE id='HO-1'`);
    ok('and the matured money lands in it, not in a wallet',
       landed.length === 1 && landed[0].pool_id === 'HO-OPEN',
       landed.length ? `it went to ${landed[0].pool_id}` : `nothing was reinvested; wallet R${w.wallet_balance}`);
    ok('recorded as a reinvestment', landed.length === 1 && landed[0].is_reinvestment === true);
    ok('not into a stale pool still marked open, which sorts first by end date',
       landed.length === 1 && landed[0].pool_id !== 'HO-STALE',
       'matured funds once landed in a pool that had closed years earlier');
    ok('and not into one that has already been deployed',
       landed.length === 1 && landed[0].pool_id !== 'HO-ACTIVE');

    /* ── 00:01 the next day ───────────────────────────────────────── */
    console.log('\n00:01 the next day — it deploys, and a new one opens');
    await db.query(`UPDATE investment_pools
                       SET end_date = CURRENT_DATE - 1, investment_start_date = CURRENT_DATE
                     WHERE id='HO-OPEN'`);
    await quiet(() => cycleExpiredPools());
    const { rows: [deployed] } = await db.query(`SELECT status FROM investment_pools WHERE id='HO-OPEN'`);
    ok('the pool that stopped raising is deployed', deployed.status === 'active', deployed.status);

    const { rows: succ } = await db.query(
      `SELECT id,name,status,product_type,start_date,end_date,investment_start_date,
              raised_amount,current_invested
         FROM investment_pools WHERE id LIKE 'HO-OPEN-CYC-%'`);
    ok('a successor opened', succ.length === 1 && succ[0].status === 'open',
       succ.length ? succ[0].status : 'none');
    ok('of the same product', succ.length === 1 && succ[0].product_type === 'short_term');
    ok('raising from today, into the future',
       succ.length === 1 && new Date(succ[0].end_date) > new Date(succ[0].start_date));
    ok('and it starts empty — a successor inherits terms, never money',
       succ.length === 1 && Number(succ[0].raised_amount) === 0 && Number(succ[0].current_invested) === 0);
    ok('the money that rolled over stayed in the pool it was deployed with',
       Number((await db.query(`SELECT current_invested FROM investment_pools WHERE id='HO-OPEN'`)).rows[0].current_invested) > 0);

    /* ── The one date that breaks it ──────────────────────────────── */
    console.log('\nand the date that would break the handover is reported first');
    await wipe();
    await db.query(`
      INSERT INTO investment_pools
        (id,name,product_type,status,annual_rate,term_months,start_date,end_date,investment_start_date,min_investment,target_amount)
      VALUES ('HO-BAD','deploys on its close date','short_term','open',0.12,5,
              CURRENT_DATE-29, CURRENT_DATE, CURRENT_DATE, 1000, 5000000),
             ('HO-OK','deploys the day after','short_term','open',0.12,5,
              CURRENT_DATE-29, CURRENT_DATE, CURRENT_DATE+1, 1000, 5000000)`);
    const { runMaturityPreflight } = require(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'));
    const pf = await quiet(() => runMaturityPreflight(db, {}));
    const flagged = (pf.handover || []).map(h => h.poolId);
    ok('a pool that deploys on or before its close date is flagged',
       flagged.includes('HO-BAD'), JSON.stringify(flagged));
    ok('and one dated the day after is not', !flagged.includes('HO-OK'), JSON.stringify(flagged));
    ok('the finding explains what to change',
       (pf.findings || []).some(f => f.section === 'handover' && /day after it closes/.test(f.message)));
    ok('it is reported even when nothing matures, which is when it can still be fixed',
       pf.nothingDue === true && (pf.summary.attentions || 0) > 0,
       JSON.stringify({ nothingDue: pf.nothingDue, summary: pf.summary }));

    /* The console short-circuits on nothingDue; it must not swallow this. */
    const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
    ok('and the console shows it rather than printing "nothing matures"',
       /if \(r\.nothingDue && !\(r\.findings \|\| \[\]\)\.length\)/.test(ADMIN),
       'the panel returned early on nothingDue and the finding was never drawn');

    await wipe();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
