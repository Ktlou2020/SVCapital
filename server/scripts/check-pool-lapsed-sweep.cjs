#!/usr/bin/env node
/* A pool that has stopped raising does not still say it is open.
 *
 * cycleExpiredPools only looks at cattle and short_term — the two product
 * types with a defined succession rule. Nothing else was ever cycled, so a
 * delivery_bike, solar or EIF pool sat at status 'open' for ever: past its
 * close date, past its investment start date, hidden from every client by
 * _poolPastClose, and still listed as open to every member of staff.
 *
 * That divergence is the bug — staff reading a marketplace that clients cannot
 * see. This file is mostly about the three ways the fix could have been worse
 * than the fault:
 *
 *   · writing status 'closed'. cycleExpiredPools excludes 'closed', so that
 *     would strand every pool it touched, and 'closed' already means the end of
 *     a pool's life after maturity.
 *   · going through PATCH /api/tables/investment_pools. That route emails every
 *     waitlisted investor when a pool turns 'active'. A batch of long-lapsed
 *     pools would have told people a round they were waiting for had opened,
 *     months after it shut.
 *   · sweeping cattle and short_term too. Deploying one of those outside the
 *     cycler's 60-day window settles the question of its successor by never
 *     opening one, which is a commercial decision. They are reported, not moved.
 *
 * Needs a database. It creates and drops its own.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-pool-lapsed-sweep.cjs
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

const SRC = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'), 'utf8');
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/* start_date is derived from the close date rather than fixed, because
   investment_pools_window_ck is CHECK (end_date > start_date): a pool that
   closed 200 days ago cannot also have opened 200 days ago, and a fixture that
   violates the constraint fails on the INSERT and proves nothing about the
   sweep. */
const seed = async (id, type, status, endDate, invStart) => {
  await db.query(`DELETE FROM investment_pools WHERE id = $1`, [id]);
  const start = new Date(endDate);
  start.setDate(start.getDate() - 60);
  await db.query(
    `INSERT INTO investment_pools
       (id, name, product_type, status, target_amount, raised_amount,
        min_investment, annual_rate, term_months, start_date, end_date, investment_start_date)
     VALUES ($1, $2, $3, $4, 100000, 0, 500, 0.13, 12, $5, $6, $7)`,
    [id, `Sweep ${id}`, type, status, start.toISOString().slice(0, 10), endDate, invStart]);
};
const statusOf = async id =>
  (await db.query(`SELECT status FROM investment_pools WHERE id = $1`, [id])).rows[0]?.status;

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    const { stopRaisingLapsedPools } = require(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'));
    ok('the sweep is exported', typeof stopRaisingLapsedPools === 'function',
       'without this the check can only read the source, which is how the gap survived');

    /* Deliberately covering the shapes that must NOT move as well as the one
       that must — a sweep with no WHERE clause would pass a check that only
       looked at the lapsed pool. */
    await seed('SWP-LAPSED',   'delivery_bike', 'open',   day(-30), day(-29));  // must deploy
    await seed('SWP-PLURAL',   'delivery_bikes','open',   day(-30), day(-29));  // must deploy
    await seed('SWP-SOLAR',    'solar',         'open',   day(-2),  day(-1));   // must deploy
    await seed('SWP-RAISING',  'delivery_bike', 'open',   day(30),  day(31));   // still raising
    /* Closed yesterday, deploys today — the inclusive edge of
       `INVESTMENT_START <= CURRENT_DATE`. An earlier version of this fixture
       closed in five days and deployed tomorrow, which is a pool that deploys
       before it shuts and tests nothing. */
    await seed('SWP-TODAY',    'solar',         'open',   day(-1),  day(0));
    await seed('SWP-CLOSED',   'solar',         'closed', day(-30), day(-29));  // already ended
    await seed('SWP-ACTIVE',   'solar',         'active', day(-30), day(-29));  // already deployed
    await seed('SWP-CATTLE',   'cattle',        'open',   day(-200),day(-199));  // reported, not moved
    await seed('SWP-SHORT',    'short_term',    'open',   day(-200),day(-199));  // reported, not moved
    await db.query(`DELETE FROM investment_pools WHERE id = 'SWP-NODATE'`);
    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, target_amount, min_investment, annual_rate, term_months)
       VALUES ('SWP-NODATE','Sweep no date','solar','open',100000,500,0.13,12)`);

    const warned = [];
    const w = console.warn, l = console.log;
    console.warn = (...a) => warned.push(a.join(' '));
    console.log  = (...a) => warned.push(a.join(' '));
    let res;
    try { res = await stopRaisingLapsedPools(); } finally { console.warn = w; console.log = l; }

    console.log('\na pool with no successor rule stops raising');
    ok('a lapsed delivery_bike pool is deployed', (await statusOf('SWP-LAPSED')) === 'active');
    ok('the plural spelling too',                 (await statusOf('SWP-PLURAL')) === 'active',
       'the same product is spelled both ways in this database');
    ok('and a lapsed solar pool',                 (await statusOf('SWP-SOLAR'))  === 'active');
    ok('one deploying today counts as lapsed',    (await statusOf('SWP-TODAY'))  === 'active',
       'the rule is investment start <= today, inclusive — the cycler uses the same boundary');

    console.log('\nand nothing else is touched');
    ok('a pool still raising stays open',   (await statusOf('SWP-RAISING')) === 'open',
       'its close date has not arrived — moving it would take a live round off the marketplace');
    ok('a closed pool stays closed',        (await statusOf('SWP-CLOSED')) === 'closed');
    ok('an active pool stays active',       (await statusOf('SWP-ACTIVE')) === 'active');
    ok('a pool with no end date is left alone', (await statusOf('SWP-NODATE')) === 'open',
       'it has not demonstrably ended, so deploying it would be a guess');

    console.log('\ncycling products are reported, not decided for');
    ok('a stranded cattle pool is left open',     (await statusOf('SWP-CATTLE')) === 'open');
    ok('a stranded short_term pool is left open', (await statusOf('SWP-SHORT')) === 'open',
       'deploying it here would settle its successor by never opening one');
    ok('both are counted as needing a decision',  res.stranded >= 2, JSON.stringify(res));
    ok('and named in the warning',
       warned.some(x => /SWP-CATTLE/.test(x)) && warned.some(x => /SWP-SHORT/.test(x)),
       warned.filter(x => /SWP-/.test(x)).join(' | ') || '(nothing said)');
    ok('the warning says why no successor is coming',
       warned.some(x => /no successor will be opened|no successor\s+will be opened/.test(x)),
       'a list of ids with no reason attached is not actionable');

    console.log('\nrunning it twice changes nothing the second time');
    {
      const before = res.moved;
      const l2 = console.log, w2 = console.warn;
      console.log = () => {}; console.warn = () => {};
      let res2;
      try { res2 = await stopRaisingLapsedPools(); } finally { console.log = l2; console.warn = w2; }
      ok('the second run moves nothing', res2.moved === 0, `${before} then ${res2.moved}`);
      ok('and still reports the same stranded pools', res2.stranded === res.stranded);
    }

    console.log('\nthe fix cannot strand what the cycler needs to find');
    {
      const code = decomment(SRC);
      ok("the sweep writes 'active', never 'closed'",
         /SET status = 'active'[\s\S]{0,400}product_type <> ALL/.test(code) &&
         !/SET status = 'closed'/.test(code),
         "cycleExpiredPools excludes status 'closed' — writing it here would orphan the pool");
      ok('the cycle pass runs before the sweep',
         code.indexOf('await cycleExpiredPools();') < code.indexOf('await stopRaisingLapsedPools();'),
         'a sweep that moved a cattle pool first would leave the cycler nothing to cycle');
      ok('the sweep excludes the cycling product types',
         /product_type <> ALL\(\$1::text\[\]\)/.test(code) && /CYCLED_TYPES = \['cattle', 'short_term'\]/.test(code));
      ok('it goes straight to SQL, not through the table API',
         !/api\/tables/.test(code) && /UPDATE investment_pools/.test(code),
         'PATCH on that route emails every waitlisted investor when a pool turns active');
    }

    for (const id of ['SWP-LAPSED','SWP-PLURAL','SWP-SOLAR','SWP-RAISING','SWP-TODAY',
                      'SWP-CLOSED','SWP-ACTIVE','SWP-CATTLE','SWP-SHORT','SWP-NODATE'])
      await db.query(`DELETE FROM investment_pools WHERE id = $1`, [id]).catch(() => {});

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
