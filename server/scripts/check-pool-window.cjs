#!/usr/bin/env node
/* A pool cannot close before it opens.
 *
 * One on a client statement did:
 *
 *     Short Term Investment - January 2025
 *     Pool Start 01 Feb 2025      Pool End 31 Jan 2025
 *
 * investment_pools.start_date and end_date are the FUNDRAISING WINDOW — when
 * the pool opens to money and when it shuts — not the term. poolCyclerCron
 * sets them that way: open is the previous pool's close plus a day, close is
 * the last day of the month the pool opens in for short_term, and the pool is
 * NAMED for the month it closes in. maturity_date is close + term_months, and
 * investment_start_date is close + 1 day.
 *
 * On that row the end date is right — it agrees with the pool's own name — and
 * the start date is holding what belongs in investment_start_date: the day
 * after the close. That is a mistake the console made easy, because neither
 * the create form nor the edit form checked the two dates against each other.
 *
 * It is not only a display fault. poolCyclerCron carries the same warning
 * where it guards against creating one: such a pool is "invisible to every
 * query that looks for one still raising".
 *
 * THE REPAIR HAS TO BE DERIVED, NOT GUESSED. An investment cannot be placed in
 * a pool before the pool opened, so the earliest investment in it is a real
 * transaction bounding the open date. Failing that, a close on a month end
 * means the window opened that month. A pool that fits neither is LEFT ALONE
 * and named in the log — moving it to a date nobody can justify would turn a
 * visible fault into an invisible one.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-pool-window.cjs
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
const DB_NAME = 'chk_poolwin_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const ADMIN  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const CYCLER = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'), 'utf8');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const ADMIN_CODE = strip(ADMIN);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  await runSetup();
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE); pg reports the termination
     as a pool 'error', and a pool with no listener takes the process down
     after every assertion has already passed. */
  pool.on('error', () => {});
}

/* The repair runs inside auto-setup, so the way to test it is to plant the
   broken rows and boot again. */
async function runSetup() {
  for (const f of ['pool.js', 'setup.js']) {
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', f))];
  }
  const q = console.log, w = console.warn;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = q; console.warn = w; }
  try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
  return lines.join('\n');
}

(async () => {
  try {
    await makeDatabase();

    console.log('\nthe window is guarded at the database');
    {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def, convalidated
           FROM pg_constraint WHERE conname = 'investment_pools_window_ck'`);
      ok('a constraint exists', rows.length === 1, 'nothing stopped the bad row being written');
      ok('and it says the close must be after the open',
         /end_date > start_date/.test((rows[0] || {}).def || ''), (rows[0] || {}).def);
      ok('it is validated on a database with no bad rows',
         rows[0] && rows[0].convalidated === true,
         'NOT VALID is the fallback for legacy data, not the resting state');

      let blocked = false;
      try {
        await pool.query(`INSERT INTO investment_pools (id,name,product_type,start_date,end_date)
                          VALUES ('P-CK','x','short_term','2026-03-01','2026-02-28')`);
      } catch (e) { blocked = /investment_pools_window_ck/.test(e.message); }
      ok('an insert that closes before it opens is refused', blocked);

      await pool.query(`INSERT INTO investment_pools (id,name,product_type,start_date,end_date)
                        VALUES ('P-CK','x','short_term','2026-02-01','2026-02-28')`);
      let updBlocked = false;
      try {
        await pool.query(`UPDATE investment_pools SET start_date = '2026-03-01' WHERE id = 'P-CK'`);
      } catch (e) { updBlocked = /investment_pools_window_ck/.test(e.message); }
      ok('and so is an update that would create one', updBlocked,
         'the bad row was almost certainly an edit, not an insert');
      await pool.query(`DELETE FROM investment_pools WHERE id = 'P-CK'`);
    }

    console.log('\nthe reported pool, repaired from the evidence');
    {
      /* The constraint has to come off to plant what the repair must find —
         which is the state a production database is in before it upgrades. */
      await pool.query(`ALTER TABLE investment_pools DROP CONSTRAINT investment_pools_window_ck`);
      await pool.query(`DELETE FROM investments WHERE pool_id LIKE 'PW-%'`);
      await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'PW-%'`);
      await pool.query(
        `INSERT INTO investors (id,first_name,last_name,email,status)
         VALUES ('PW-INV','Pool','Window','pw@example.test','active')
         ON CONFLICT (id) DO NOTHING`);

      await pool.query(`
        INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,start_date,end_date,min_investment)
        VALUES
          -- exactly as the statement printed it
          ('PW-REPORTED','Short Term Investment - January 2025','short_term','matured',0.0404,6,'2025-02-01','2025-01-31',1000),
          -- same shape, no investments: falls to the month-end rule
          ('PW-EMPTY','Short Term Investment - March 2025','short_term','closed',0.04,6,'2025-04-01','2025-03-31',1000),
          -- backwards, close is not a month end, no investments: not derivable
          ('PW-UNRESOLVED','Odd Pool','cattle','closed',0.14,6,'2025-05-20','2025-05-14',1000),
          -- a cattle raise across two months, backwards, with its first
          -- investment mid-window: the month rule alone would land a month
          -- late, so the investment date has to win
          ('PW-TWOMONTH','Cattle Investment - August 2025','cattle','closed',0.1483,12,'2025-09-01','2025-08-31',5000),
          -- a short_term pool whose first investment arrived mid-window: the
          -- investment date alone would land late, so the month rule wins
          ('PW-MIDMONTH','Short Term Investment - June 2025','short_term','closed',0.04,6,'2025-07-01','2025-06-30',1000),
          -- correct, and must not be touched
          ('PW-GOOD','Cattle Investment - August 2025','cattle','matured',0.1223,12,'2025-07-01','2025-08-31',5000)`);
      await pool.query(`UPDATE investment_pools SET investment_start_date = '2025-09-01' WHERE id = 'PW-GOOD'`);
      await pool.query(
        `INSERT INTO investments (id,investor_id,pool_id,amount,status,start_date,end_date,annual_rate,actual_return)
         VALUES ('PW-I1','PW-INV','PW-REPORTED',105000,'matured','2025-01-01','2025-06-30',0.0404,4242),
                ('PW-I2','PW-INV','PW-TWOMONTH',10000,'matured','2025-07-15','2026-08-31',0.1483,0),
                ('PW-I3','PW-INV','PW-MIDMONTH',10000,'matured','2025-06-18','2025-12-31',0.04,0)`);

      const log = await runSetup();
      const row = id => pool.query('SELECT * FROM investment_pools WHERE id = $1', [id]).then(r => r.rows[0]);

      const rep = await row('PW-REPORTED');
      ok('the open date moves to the day the money actually went in',
         iso(rep.start_date) === '2025-01-01',
         `${iso(rep.start_date)} — the earliest investment in the pool started 2025-01-01`);
      ok('the close date is left alone',
         iso(rep.end_date) === '2025-01-31',
         'it agrees with the pool\'s own name, so it is the field that is right');
      ok('and the pool is named for the month it closes in',
         /January 2025/.test(rep.name) && iso(rep.end_date).startsWith('2025-01'),
         'which is what makes the close date the trustworthy one');
      ok('the value that was in start_date is kept as the investment start date',
         iso(rep.investment_start_date) === '2025-02-01',
         `${iso(rep.investment_start_date)} — close + 1 day, which is what it always was`);
      ok('the repair says which pool it moved and why',
         /PW-REPORTED[\s\S]*earliest investment placed in it/.test(log),
         'a silent data edit on a client-facing record is not acceptable');

      const empty = await row('PW-EMPTY');
      ok('a pool with no investments falls back to the month-end rule',
         iso(empty.start_date) === '2025-03-01' && iso(empty.end_date) === '2025-03-31',
         `${iso(empty.start_date)} → ${iso(empty.end_date)}`);
      ok('and says that is the rule it used',
         /PW-EMPTY[\s\S]*close is a month end/.test(log));

      const unres = await row('PW-UNRESOLVED');
      ok('a window that cannot be derived is LEFT ALONE',
         iso(unres.start_date) === '2025-05-20' && iso(unres.end_date) === '2025-05-14',
         'moving it to a date nobody can justify turns a visible fault into an invisible one');
      ok('and is named, so a person can correct it',
         /could not be derived[\s\S]*PW-UNRESOLVED/.test(log), log.slice(-400));

      const two = await row('PW-TWOMONTH');
      ok('where the month rule would land a month late, the investment date wins',
         iso(two.start_date) === '2025-07-15',
         `${iso(two.start_date)} — the month rule alone would have said 2025-08-01`);
      const mid = await row('PW-MIDMONTH');
      ok('and where the investment arrived mid-window, the month rule wins',
         iso(mid.start_date) === '2025-06-01',
         `${iso(mid.start_date)} — the investment alone would have said 2025-06-18`);
      ok('the log names both bounds when they disagree',
         /the other bound gave/.test(log), 'so the choice can be checked, not just trusted');

      const good = await row('PW-GOOD');
      ok('a correct pool is not touched',
         iso(good.start_date) === '2025-07-01' && iso(good.end_date) === '2025-08-31' &&
         iso(good.investment_start_date) === '2025-09-01',
         `${iso(good.start_date)} → ${iso(good.end_date)}`);

      ok('the constraint is re-added but not validated while a bad row remains',
         /not validated/.test(log),
         'failing the boot over legacy data would take the platform down');
      const ck = await pool.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'investment_pools_window_ck'`);
      ok('and it is back in place regardless',
         ck.rows.length === 1 && ck.rows[0].convalidated === false);
    }

    console.log('\nand it settles');
    {
      const again = await runSetup();
      ok('a second boot repairs nothing further',
         !/Repaired \d+ pool window/.test(again),
         'the repair must not keep moving dates it has already moved');
      ok('but still reports the one nobody has fixed',
         /could not be derived/.test(again));

      await pool.query(`UPDATE investment_pools SET start_date = '2025-05-01' WHERE id = 'PW-UNRESOLVED'`);
      const clean = await runSetup();
      ok('once a person corrects it, the step goes quiet',
         !/could not be derived/.test(clean) && !/not validated/.test(clean),
         clean.split('\n').filter(l => /pool window|derived|validated/.test(l)).join(' | '));
      const ck = await pool.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'investment_pools_window_ck'`);
      ok('and the constraint validates itself', ck.rows[0].convalidated === true);
    }

    console.log('\nthe console will not let another one be saved');
    {
      ok('there is one window check, used by both forms',
         /function _poolWindowError\(/.test(ADMIN_CODE) &&
         (ADMIN_CODE.match(/_poolWindowError\(/g) || []).length === 3,
         'create and edit each calling it, plus the definition');
      ok('creating a pool is checked',
         /const newWindowErr = _poolWindowError\([\s\S]{0,160}newPoolCloseDate/.test(ADMIN_CODE));
      ok('and so is editing one',
         /const editWindowErr = _poolWindowError\(updates\.start_date, updates\.end_date\)/.test(ADMIN_CODE),
         'the bad row was almost certainly an edit');
      ok('both refuse before the save rather than after it',
         (ADMIN_CODE.match(/WindowErr\) \{ Toast\.error\(\w+WindowErr\); return; \}/g) || []).length === 2);
      ok('and the message names the field the operator probably wanted',
         /that is the investment start date/.test(ADMIN) && /that is the maturity date/.test(ADMIN),
         'start_date was holding the investment start date');
      ok('equal dates are refused too, not just inverted ones',
         /if \(endVal > startVal\) return null;/.test(ADMIN_CODE),
         'a window that opens and shuts on the same day takes no money');
      ok('a half-filled form is not blocked',
         /if \(!startVal \|\| !endVal\) return null;/.test(ADMIN_CODE));
      const v = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8')
        .match(/js\/admin\.js\?v=(\d+)/);
      ok('and admin.js is cache-busted past 166', v && Number(v[1]) > 166,
         v ? v[0] : 'no version query string');
    }

    console.log('\nand the meaning of the two dates is written down where it is set');
    {
      ok('the cycler still documents the window it creates',
         /close = last day of the month in which the new pool opens/.test(CYCLER) &&
         /Maturity date = closeDate \+ term_months/.test(CYCLER));
      ok('and still guards against creating a backwards one',
         /while \(closeDate <= openDate/.test(CYCLER),
         'the repair fixes history; this is what stops the cycler making more');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
