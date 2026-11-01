#!/usr/bin/env node
/* A missed tick is recovered on boot, and recovers nothing it should not.
 *
 * The maturity schedules are node-cron timers inside the server process. They
 * fire only while it runs, so a container restarting across 23:00 SAST does
 * not run late — it does not run at all. The nightly query is self-healing,
 * so the work lands the FOLLOWING night and a missed tick costs a day.
 *
 * It cost a day on 31 October 2026: a deploy restarted production near 23:00
 * and a cattle pool of 205 investors did not mature. Every rollover
 * instruction was a day late and the pool they were to roll into had closed.
 *
 * The catch-up runs that work at boot instead. It moves real money outside a
 * schedule, on a code path that executes on every single deploy, so what is
 * asserted here is mostly what it must REFUSE to do:
 *
 *  · It must not pull a maturity FORWARD. Only investments whose end_date is
 *    strictly before today, on the business day the schedule is pinned to.
 *    Without that, every restart would process the day's maturities hours
 *    early — before the pool's rate is posted and before anybody has closed
 *    it out — and a deploy at nine in the morning would quietly move the
 *    schedule for everyone.
 *  · It must not pay twice. It shares the engine's claim —
 *    FOR UPDATE SKIP LOCKED on maturity_processed_at IS NULL, inside the
 *    transaction that moves the money — so a second instance finds the row
 *    taken. The test for this is to run it twice and weigh the wallet.
 *  · It must do nothing at all on an ordinary boot, which is almost every
 *    boot, and it must be switchable off without a deploy.
 *
 * Needs a database. The runner gives it one.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-maturity-catchup.cjs
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
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'), 'utf8');

console.log('\nit is armed at boot, and it can be disarmed');
{
  ok('startMaturityCron arms it', /setTimeout\(\(\) => \{ runMaturityCatchUp\(\); \}/.test(SRC));
  ok('and does not await it', !/await runMaturityCatchUp/.test(SRC),
     'boot must not wait on a money job, nor be failed by one');
  ok('an env var turns it off without a deploy',
     /SVC_MATURITY_CATCHUP[\s\S]{0,120}'off'/.test(SRC));
  ok('it asks before it acts',
     /SELECT COUNT\(\*\)::int AS n[\s\S]{0,260}maturity_processed_at IS NULL/.test(SRC),
     'on almost every boot the answer is zero and nothing else runs');
  ok('and it cycles pools before rolling anything over',
     SRC.indexOf('await cycleExpiredPools();\n    await runMaturityProcessing({ overdueOnly: true })') > -1,
     'a rollover needs somewhere open to land, and that pool may be what the restart missed');
}

(async () => {
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.investments') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no investments table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-CU-%'`);
      await db.query(`DELETE FROM investments  WHERE investor_id LIKE 'INV-CU-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-CU-%'`);
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-CU-%'`);
    };
    await clean();

    /* A concluded pool with its rate posted — the engine refuses to pay an
       investment whose pool has none, which would mask everything below. */
    await db.query(`
      INSERT INTO investment_pools
        (id, name, product_type, status, annual_rate, actual_rate, term_months,
         start_date, end_date, maturity_date, min_investment, current_invested, raised_amount)
      VALUES ('POOL-CU-DONE','Cattle - catch-up source','cattle','active',0.12,0.1317,12,
              CURRENT_DATE - 370, CURRENT_DATE - 1, CURRENT_DATE - 1, 1000, 100000, 100000)`);

    const seed = async (id, endDateSql) => {
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, total_returns)
         VALUES ($1,'Catch','Up',$2,'active',0,0)`,
        [id, `${id.toLowerCase()}@example.test`]);
      await db.query(
        `INSERT INTO investments
           (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
            annual_rate, term_months, expected_return, product_type,
            maturity_instruction, maturity_processed_at)
         VALUES ($1,$2,'POOL-CU-DONE','Cattle - catch-up source',100000,'active',
                 CURRENT_DATE - 370, ${endDateSql}, 0.12, 12, 12000, 'cattle',
                 'payout_all', NULL)`,
        [`INVST-${id}`, id]);
    };
    /* Yesterday's maturity, never processed — the pool of 205, in miniature. */
    await seed('INV-CU-OVERDUE', 'CURRENT_DATE - 1');
    /* And one maturing today, which tonight's 23:00 run owns. */
    await seed('INV-CU-TODAY',   'CURRENT_DATE');

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const { runMaturityCatchUp } = require(path.join(ROOT, 'server', 'jobs', 'maturityCron.js'));

    const state = async id => (await db.query(
      `SELECT i.status, i.maturity_processed_at IS NOT NULL AS done,
              inv.wallet_balance::float AS wallet
         FROM investments i JOIN investors inv ON inv.id = i.investor_id
        WHERE i.investor_id = $1`, [id])).rows[0];

    console.log('\nthe run that was missed');
    const res = await runMaturityCatchUp();
    ok('it finds the overdue work', res && res.overdue >= 1, JSON.stringify(res));

    const overdue = await state('INV-CU-OVERDUE');
    ok('yesterday’s maturity is processed', overdue.done === true, JSON.stringify(overdue));
    ok('the investment is matured', overdue.status === 'matured', overdue.status);
    ok('and the money reached the wallet', overdue.wallet > 100000,
       `wallet ${overdue.wallet} — capital 100000 plus the posted 13.17%`);

    console.log('\nand the one it must not touch');
    const today = await state('INV-CU-TODAY');
    ok('today’s maturity is left alone', today.done === false, JSON.stringify(today));
    ok('still active, for tonight’s run', today.status === 'active', today.status);
    ok('and nothing was paid on it', today.wallet === 0, String(today.wallet),
       'a restart may make a late maturity less late; it may never make an on-time one early');

    console.log('\nrun it again, the way a crash loop would');
    const walletBefore = (await state('INV-CU-OVERDUE')).wallet;
    const again = await runMaturityCatchUp();
    const walletAfter = (await state('INV-CU-OVERDUE')).wallet;
    ok('the second run finds nothing left to do', again && again.overdue === 0,
       JSON.stringify(again));
    ok('and the wallet is untouched', walletAfter === walletBefore,
       `${walletBefore} -> ${walletAfter}`);

    console.log('\nthe switch');
    await db.query(
      `UPDATE investments SET status='active', maturity_processed_at=NULL
        WHERE investor_id = 'INV-CU-OVERDUE'`);
    process.env.SVC_MATURITY_CATCHUP = 'off';
    const off = await runMaturityCatchUp();
    ok('off means off', off && off.skipped === 'disabled', JSON.stringify(off));
    ok('and it processed nothing',
       (await state('INV-CU-OVERDUE')).done === false);
    delete process.env.SVC_MATURITY_CATCHUP;

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
