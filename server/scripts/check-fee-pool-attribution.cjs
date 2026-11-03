#!/usr/bin/env node
/* A platform fee says which pool it was charged against.
 *
 * transactions has had investment_id and pool_id for as long as the fee has
 * existed, and the fee written at investment time filled NEITHER. The only
 * trace of what a fee was for was its reference — FEE-<investment id> — so
 * the admin fee report's Pool column was a dash on every line, and totalling
 * a month's fees by pool meant parsing an id out of a string.
 *
 * Both halves are held here:
 *
 *   the write      both paths in tables.js (fee_inclusive and the one after
 *                  settlement) set investment_id and pool_id on the fee
 *   the backfill   setup step 29 recovers the link on rows already written,
 *                  from the FEE- prefix and nothing looser — a fee that was
 *                  never charged against a pool is left alone, because a
 *                  dash is the right answer for a gateway fee or a fee on a
 *                  manual credit
 *   the report     /api/analytics/platform-fees returns the pool's name
 *   the screen     a fee reads as money LEAVING, which CLAUDE.md requires of
 *                  every transaction list, and a blank pool says which kind
 *                  of blank it is rather than leaving the reader to guess
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-fee-pool-attribution.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_feepool_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

/* The route only reads req.user, so the middleware is replaced rather than a
   token minted — the same stand-in check-late-placement uses against this
   very route. */
let CURRENT_USER = { id: 'ADM', email: 'a@example.test', role: 'admin' };
{
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = CURRENT_USER; next(); },
      requireRole: (...roles) => (req, res, next) =>
        roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }),
    },
  };
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function withDatabase(url, name) {
  const u = new URL(url); u.pathname = '/' + name; return u.toString();
}
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl;

const runSetup = async () => {
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
};

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  await runSetup();
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE). pg reports the
     termination as an 'error' event, and a pool with no listener takes the
     process down — a check that passed everything then exits non-zero. */
  pool.on('error', () => {});
}

async function seed() {
  await pool.query(`DELETE FROM transactions     WHERE investor_id LIKE 'FP-%'`);
  await pool.query(`DELETE FROM investments      WHERE investor_id LIKE 'FP-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'FP-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'FPP-%'`);

  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months,
        start_date, end_date, maturity_date, min_investment)
    VALUES ('FPP-SOLAR','Solar — November 2026','solar','open',0.13,12,
            CURRENT_DATE - 10, CURRENT_DATE + 30, CURRENT_DATE + 395, 100)`);
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, kyc_status, wallet_balance)
    VALUES ('FP-1','Thandi','Nkosi','thandi@example.test','active','verified', 50000)`);
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  for (const m of ['routes/tables.js', 'routes/analytics-extra.js']) {
    delete require.cache[require.resolve(path.join(ROOT, 'server', m))];
  }
  const app = express();
  app.use(express.json());
  app.use('/api/tables',    require(path.join(ROOT, 'server', 'routes', 'tables')));
  app.use('/api/analytics', require(path.join(ROOT, 'server', 'routes', 'analytics-extra')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const call = (port, method, url, payload) => new Promise((resolve, reject) => {
  const data = payload ? JSON.stringify(payload) : null;
  const req = http.request({ host: '127.0.0.1', port, path: url, method,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
    res => {
      let b = ''; res.on('data', d => (b += d));
      res.on('end', () => {
        let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 200) }; }
        resolve({ status: res.statusCode, body });
      });
    });
  req.on('error', reject); if (data) req.write(data); req.end();
});

const feeRow = async id => (await pool.query(
  `SELECT id, reference, amount, investment_id, pool_id FROM transactions WHERE id = $1`, [id])).rows[0];

/* The placement route answers BEFORE the fee row is written — the
   confirmation e-mail goes out after the response too. Reading once right
   after the POST is a race this check lost the first time it ran, so it
   waits for the row instead of asserting against a gap in time. Bounded, so
   a fee that never arrives fails rather than hanging the suite. */
async function feeRowWithin(id, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const row = await feeRow(id);
    if (row || Date.now() > until) return row;
    await new Promise(r => setTimeout(r, 100));
  }
}

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;
    CURRENT_USER = { id: 'u-1', email: 'thandi@example.test', role: 'investor', investorId: 'FP-1' };

    /* ── The write ──────────────────────────────────────────────────── */
    console.log('\nthe fee written when an investment is placed names its pool');
    {
      const r = await call(port, 'POST', '/api/tables/investments', {
        id: 'INVST-FP-1', investor_id: 'FP-1', pool_id: 'FPP-SOLAR', amount: 1000,
        status: 'active', product_type: 'solar', term_months: 12, annual_rate: 0.13,
        pool_name: 'Solar — November 2026', maturity_instruction: 'reinvest',
      });
      ok('the investment is accepted', r.status >= 200 && r.status < 300,
         `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

      const fee = await feeRowWithin('FEE-INVST-FP-1');
      ok('a fee row was written', !!fee, 'nothing to attribute if the fee is missing');
      ok('it carries the investment it was charged on',
         fee && fee.investment_id === 'INVST-FP-1',
         JSON.stringify(fee));
      ok('and the pool that investment went into',
         fee && fee.pool_id === 'FPP-SOLAR',
         'this column is the one the fee report reads — ' + JSON.stringify(fee));
      ok('the amount is the 1% charged on top',
         fee && Math.abs(Math.abs(Number(fee.amount)) - 10) < 0.005,
         JSON.stringify(fee && fee.amount));
    }

    /* The other write path. fee_inclusive settles the fee inside the same
       transaction as the wallet deduction, so the columns are set in a
       different place in tables.js — and a fix applied to one path and not
       the other leaves half the fees unattributed. */
    console.log('\nand so does the fee settled inside the placement transaction');
    {
      const r = await call(port, 'POST', '/api/tables/investments', {
        id: 'INVST-FP-INC', investor_id: 'FP-1', pool_id: 'FPP-SOLAR', amount: 1500,
        status: 'active', product_type: 'solar', term_months: 12, annual_rate: 0.13,
        pool_name: 'Solar — November 2026', maturity_instruction: 'reinvest',
        fee_inclusive: true,
      });
      ok('the fee-inclusive placement is accepted', r.status >= 200 && r.status < 300,
         `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      const fee = await feeRowWithin('FEE-INVST-FP-INC');
      ok('its fee names the investment too', fee && fee.investment_id === 'INVST-FP-INC',
         JSON.stringify(fee));
      ok('and the pool', fee && fee.pool_id === 'FPP-SOLAR',
         'the two write paths must not disagree — ' + JSON.stringify(fee));
    }

    /* ── The backfill ───────────────────────────────────────────────── */
    console.log('\nand setup recovers the link on fees already written without it');
    {
      /* Three legacy rows, one of each kind the report will meet.

         The third is the trap: its reference HOLDS an investment id but has
         no FEE- prefix, so stripping five characters unconditionally would
         attach a wholly unrelated transaction to that investment. */
      await pool.query(`
        INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status,
            start_date, end_date, annual_rate, term_months, product_type)
        VALUES ('INVST-FP-OLD','FP-1','FPP-SOLAR','Solar — November 2026', 2000,'active',
                CURRENT_DATE - 5, CURRENT_DATE + 360, 0.13, 12, 'solar')`);
      await pool.query(`
        INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
        VALUES
          ('FEE-INVST-FP-OLD','FP-1','fee',        20,'completed','FEE-INVST-FP-OLD','1% platform fee on investment'),
          ('TXN-FP-MANUAL',   'FP-1','platform_fee', -7,'completed','FEE-9QX2LM4ZZ1', '1% platform fee on deposit'),
          ('TXN-FP-LOOSE',    'FP-1','fee',          3,'completed','INVST-FP-OLD',   'a reference with no FEE prefix')`);

      await runSetup();

      const old    = await feeRow('FEE-INVST-FP-OLD');
      const manual = await feeRow('TXN-FP-MANUAL');
      const loose  = await feeRow('TXN-FP-LOOSE');

      ok('a legacy investment fee is attached to its investment',
         old && old.investment_id === 'INVST-FP-OLD', JSON.stringify(old));
      ok('and to its pool', old && old.pool_id === 'FPP-SOLAR', JSON.stringify(old));
      ok('a fee that was never charged against a pool is left alone',
         manual && manual.investment_id === null && manual.pool_id === null,
         'a gateway fee or a fee on a manual credit has no pool, and a dash is ' +
         'the right answer for it — ' + JSON.stringify(manual));
      ok('and a reference without the FEE- prefix is not attached to anything',
         loose && loose.investment_id === null && loose.pool_id === null,
         'stripping five characters unconditionally would bind this to ' +
         'INVST-FP-OLD — ' + JSON.stringify(loose));
    }

    console.log('\nand running it again changes nothing');
    {
      const before = await feeRow('FEE-INVST-FP-OLD');
      await runSetup();
      const after = await feeRow('FEE-INVST-FP-OLD');
      ok('the step is idempotent',
         before.investment_id === after.investment_id && before.pool_id === after.pool_id,
         JSON.stringify({ before, after }));
    }

    /* ── The report ─────────────────────────────────────────────────── */
    console.log('\nso the fee report can say which pool each fee came from');
    {
      CURRENT_USER = { id: 'ADM', email: 'a@example.test', role: 'admin' };
      const r = await call(port, 'GET', '/api/analytics/platform-fees?period=all');
      ok('the report answers', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

      const txns = (r.body && r.body.transactions) || [];
      const byId = Object.fromEntries(txns.map(t => [t.id, t]));
      ok('the fee from the live placement names its pool',
         byId['FEE-INVST-FP-1'] && byId['FEE-INVST-FP-1'].pool_name === 'Solar — November 2026',
         JSON.stringify(byId['FEE-INVST-FP-1']));
      ok('and so does the backfilled one',
         byId['FEE-INVST-FP-OLD'] && byId['FEE-INVST-FP-OLD'].pool_name === 'Solar — November 2026',
         JSON.stringify(byId['FEE-INVST-FP-OLD']));
      ok('a fee with no pool still comes back, marked as having none',
         byId['TXN-FP-MANUAL'] && byId['TXN-FP-MANUAL'].pool_name === '—',
         'it belongs in the total even though it belongs to no pool — ' +
         JSON.stringify(byId['TXN-FP-MANUAL']));
    }

    /* ── The screen ─────────────────────────────────────────────────── */
    console.log('\nand the table reads as money leaving, with the blank explained');
    {
      const ADMIN = read('admin/js/admin.js');
      const s = { console, Math, Number, String, JSON, Object, Array,
                  _esc: v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
      s.globalThis = s; s.window = s;
      vm.createContext(s);
      /* The shipped function, lifted and run — a copy of the rule here would
         keep agreeing with itself after the real one changed. */
      const src = ADMIN.slice(ADMIN.indexOf('function _pfPoolCell'));
      vm.runInContext(src.slice(0, src.indexOf('\nfunction _pfRenderTable')), s);

      ok('a pool name renders as itself',
         s._pfPoolCell({ pool_name: 'Solar — November 2026' }).includes('Solar'),
         s._pfPoolCell({ pool_name: 'Solar — November 2026' }));
      ok('and a missing one says it was not charged to a pool',
         /Not charged to a pool/.test(s._pfPoolCell({ pool_name: '—' })),
         'a bare dash leaves a reader guessing whether the data is lost');
      ok('a null name reads the same way',
         /Not charged to a pool/.test(s._pfPoolCell({})), s._pfPoolCell({}));
      ok('and a pool name is escaped before it reaches the page',
         !s._pfPoolCell({ pool_name: '<img src=x>' }).includes('<img'),
         s._pfPoolCell({ pool_name: '<img src=x>' }));

      /* CLAUDE.md: a fee displays as NEGATIVE in every transaction list and
         statement. This table printed the absolute value in red, and red is
         not a sign — the CSV it exports had the same figure unsigned. */
      const row = ADMIN.slice(ADMIN.indexOf('function _pfRenderTable'),
                              ADMIN.indexOf('function exportPlatformFeesCSV'));
      ok('the amount column is signed negative',
         /td-red fw-700">-\$\{Utils\.rand\(Math\.abs\(r\.amount\)\)\}/.test(row),
         'red is a colour, not a minus sign');

      const csv = ADMIN.slice(ADMIN.indexOf('function exportPlatformFeesCSV'));
      ok('and the export agrees with the table it came from',
         /'Amount \(R\)':\s*-Math\.abs\(r\.amount\)/.test(csv.slice(0, 900)),
         'a CSV that disagrees with the screen is worse than either alone');
      ok('the export leaves the pool blank rather than exporting a dash',
         /Pool:\s+\(r\.pool_name && r\.pool_name !== '—'\) \? r\.pool_name : ''/.test(csv.slice(0, 900)),
         'filtering on an empty cell is the point of the column');

      const HTML = read('admin/index.html');
      ok('and the table does not describe the fee as deducted',
         /1% platform fee, charged on top of each investment/.test(HTML)
         && !/platform fee deducted on each investment/.test(HTML),
         'the amount a client enters is what reaches the pool; the fee is on top');
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
