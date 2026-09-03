#!/usr/bin/env node
/* Placing money into a pool that has stopped raising.
 *
 * This is a real operation, not a loophole: an EFT clears after the cut-off, a
 * misallocation has to be moved. tables.js has always allowed it — the pool
 * guard is scoped to `req.user.role === 'investor'` and says so in as many
 * words — but the admin console's pool dropdown listed only open, filling and
 * active pools, so a CLOSED pool was simply not there. The correction then had
 * to be made by editing rows by hand, which is how money goes missing.
 *
 * The console was enforcing a rule the platform does not have. So this pins
 * both halves:
 *
 *   a client still cannot buy into a round that has shut — that guard is the
 *   reason the marketplace close date means anything, and it is the half that
 *   protects the pool;
 *
 *   staff can, deliberately, with the pool's state in front of them.
 *
 * And the line between them: a matured, paid-out or cancelled pool takes
 * nobody's money, because there is nothing left for the investment to mature
 * into.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-late-placement.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_late_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

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

function withDatabase(url, name) {
  const u = new URL(url); u.pathname = '/' + name; return u.toString();
}
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE), which terminates whatever
     is still connected to it. pg reports that as an 'error' event on the pool,
     and a pool with no listener for one takes the process down — so a check
     that passed every assertion exits non-zero, at random, with a stack that
     names pg and not the drop. The termination is expected. The crash is not. */
  pool.on('error', () => {});
}

/* One pool still raising, one that closed a month ago, one already matured.
   The client has enough in the wallet for exactly two of the placements. */
async function seed() {
  await pool.query(`DELETE FROM investments      WHERE id LIKE 'LP-%'`);
  await pool.query(`DELETE FROM transactions     WHERE investor_id LIKE 'LP-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'LP-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'LP-%'`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
        start_date,end_date,maturity_date,min_investment)
    VALUES
      ('LP-OPEN','Short Term - Open','short_term','open',0.13,12,
       CURRENT_DATE-5,  CURRENT_DATE+20, CURRENT_DATE+380, 500),
      ('LP-CLOSED','Short Term - Closed','short_term','active',0.13,12,
       CURRENT_DATE-60, CURRENT_DATE-30, CURRENT_DATE+300, 500),
      ('LP-MATURED','Short Term - Matured','short_term','matured',0.13,12,
       CURRENT_DATE-400,CURRENT_DATE-40, CURRENT_DATE-40,  500)`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,kyc_status,wallet_balance)
    VALUES ('LP-1','Ann','Late','ann@example.test','active','verified',10000)`);
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'tables.js'))];
  const app = express();
  app.use(express.json());
  app.use('/api/tables', require(path.join(ROOT, 'server', 'routes', 'tables')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const post = (port, url, payload) => new Promise((resolve, reject) => {
  const data = JSON.stringify(payload);
  const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 200) }; }
      resolve({ status: res.statusCode, body });
    });
  });
  req.on('error', reject); req.write(data); req.end();
});

const AS_ADMIN    = { id: 'ADM',  email: 'a@example.test', role: 'admin' };
const AS_INVESTOR = { id: 'INV',  email: 'ann@example.test', role: 'investor', investorId: 'LP-1' };

const placement = (id, poolId, amount) => ({
  id, investor_id: 'LP-1', pool_id: poolId, amount,
  status: 'active', product_type: 'short_term', term_months: 12,
  annual_rate: 0.13, pool_name: 'x', maturity_instruction: 'reinvest',
});

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    console.log('\na client cannot buy into a round that has shut');
    CURRENT_USER = AS_INVESTOR;
    {
      const r = await post(port, '/api/tables/investments', placement('LP-X1', 'LP-CLOSED', 1000));
      ok('refused', r.status === 400,
         `${r.status} ${JSON.stringify(r.body).slice(0, 140)} — this guard is what makes the ` +
         `marketplace close date mean anything`);
      ok('and told why, in words a client can act on',
         /closed|no longer open/i.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 140));
    }

    console.log('\nstaff can place a late investment into it');
    CURRENT_USER = AS_ADMIN;
    {
      const r = await post(port, '/api/tables/investments', placement('LP-A1', 'LP-CLOSED', 1000));
      ok('accepted', r.status >= 200 && r.status < 300,
         `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      const { rows } = await pool.query(`SELECT pool_id, amount FROM investments WHERE id = 'LP-A1'`);
      ok('and the investment is against the closed pool',
         rows.length === 1 && rows[0].pool_id === 'LP-CLOSED', JSON.stringify(rows));
      const { rows: w } = await pool.query(`SELECT wallet_balance FROM investors WHERE id = 'LP-1'`);
      /* R1 000 plus the 1% platform fee. A late placement is a purchase on the
         same terms as any other, fee included — it is not a free record. */
      ok('the wallet paid for it, platform fee and all',
         Math.abs(Number(w[0].wallet_balance) - 8990) < 0.005,
         `${w[0].wallet_balance} — expected 10 000 less 1 000 less the 1% fee`);
    }

    console.log('\nand the affordability guard still applies to staff');
    {
      const r = await post(port, '/api/tables/investments', placement('LP-A2', 'LP-CLOSED', 500000));
      ok('a placement the wallet cannot cover is refused',
         r.status === 400 && /insufficient/i.test(JSON.stringify(r.body)),
         `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const { rows } = await pool.query(`SELECT id FROM investments WHERE id = 'LP-A2'`);
      ok('and nothing is written', rows.length === 0);
    }

    console.log('\nthe console offers what the server allows, and no more');
    {
      const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      ok('the pool list is no longer filtered to open pools only',
         !/filter\(p=>\['open','active','filling'\]\.includes\(p\.status\)\)/.test(admin),
         'that filter was the console enforcing a rule the platform does not have');
      ok('a closed pool is offered under its own heading',
         /Closed to new money — late placement/.test(admin));
      ok('a matured, paid-out or cancelled pool is not offered at all',
         /_INVEST_CLOSED_STATES = \['active', 'closed'\]/.test(admin) &&
         !/_INVEST_CLOSED_STATES = \[[^\]]*matured/.test(admin),
         'there is nothing left for the investment to mature into');
      ok('choosing one warns before the money moves',
         /This pool has closed to new money/.test(admin) &&
         /_adminInvestPoolPicked/.test(admin));
      ok('and the confirmation says it too',
         /LATE PLACEMENT/.test(admin),
         'the dialog is the last thing read before money moves');
      ok('a pool past its close date but still flagged open counts as closed',
         /_INVEST_OPEN_STATES\.includes\(p\.status\) && _poolIsPastClose\(p\)/.test(admin),
         'the cycler may not have reached it yet; the close date is what decides');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
