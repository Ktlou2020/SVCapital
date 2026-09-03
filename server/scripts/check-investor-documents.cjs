#!/usr/bin/env node
/* The client and the console get the same document.
 *
 * The account statement and the Investment Income Reference used to exist
 * twice: once in the console, once rebuilt in the browser from whatever the
 * portal had cached. They had already drifted, and not cosmetically — the
 * portal's certificate counted `payout` as income, which is the client's own
 * capital coming back, and windowed the tax year on created_at, which on a
 * migrated ledger is one import timestamp across every row. A client could
 * hold two documents from the same platform disagreeing about what they
 * earned, and the console's was the right one.
 *
 * Now there is one computation per document (services/accountStatement,
 * services/incomeReference) and one renderer (js/investor-documents.js). Both
 * routes call the service; both surfaces call the renderer. This asserts that
 * the two routes really do return the same thing for the same client, because
 * "shared" is a claim about behaviour, not about file layout.
 *
 * AND THAT THE INVESTOR ROUTE IS THE CALLER'S OWN. It takes no investor id —
 * it derives one from the token — so the thing to prove is that it cannot be
 * pointed at somebody else. A query parameter that looks like it should work
 * is the failure worth catching.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investor-documents.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
/* A name no other process can pick.
 *
 * A check failed intermittently with FATAL 57P01, "terminating connection due
 * to administrator command" — which in this suite only comes from
 * DROP DATABASE ... WITH (FORCE), confirmed by the forced checkpoint the
 * server logs immediately after it. Something dropped a database out from
 * under a running check.
 *
 * process.pid alone is not unique enough to rule that out: one suite run
 * spawns two hundred short-lived processes and a container recycles pids, so
 * two checks can pick the same database name minutes apart. The random suffix
 * costs nothing and removes the only way two processes can name the same
 * database. */
const DB_NAME = 'chk_invdocs_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function withDatabase(url, name) {
  const u = new URL(url); u.pathname = '/' + name; return u.toString();
}

/* max: 2 — these checks are single-threaded and never need more; the pg
   default is 10 per pool and this file opens two.

   This was originally introduced as a fix for an intermittent failure, on the
   theory that idle connections were exhausting max_connections. That theory
   was WRONG: the server log carries not one "sorry, too many clients already"
   in the whole session. The real error was FATAL 57P01, a forced DROP
   DATABASE terminating a live connection. The cap is kept because it is
   correct on its own terms, not because it fixed anything. */
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
}

/* Two investors, so "the caller's own" has something to be wrong about.
   ID-1 has income of both kinds, a payout that is NOT income, a deposit, and a
   matured holding whose return is posted on the POOL. */
async function seed() {
  await pool.query(`DELETE FROM transactions     WHERE investor_id LIKE 'ID-%'`);
  await pool.query(`DELETE FROM investments      WHERE investor_id LIKE 'ID-%'`);
  await pool.query(`DELETE FROM users            WHERE investor_id LIKE 'ID-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'ID-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'ID-%'`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,kyc_status,wallet_balance)
    VALUES ('ID-1','Ada','Client','ada@example.test','active','verified',1000),
           ('ID-2','Bo','Other','bo@example.test','active','verified',50)`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,maturity_date,min_investment)
    VALUES ('ID-P1','Short Term Investment - June 2025','short_term','matured',0.13,0.05,12,
            '2024-06-01','2025-06-30','2025-06-30',500)`);

  /* Matured inside the 2026 tax year (1 Mar 2025 – 28 Feb 2026). actual_return
     is 0 — the default — so anything reading it directly reports nothing. */
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,start_date,end_date,
        annual_rate,term_months,expected_return,actual_return,product_type,maturity_instruction)
    VALUES ('ID-INV1','ID-1','ID-P1','Short Term Investment - June 2025',100000,'matured',
            '2024-06-01','2025-06-30',0.13,12,9999,0,'short_term','reinvest')`);

  const T = [
    ['ID-T1', 'ID-1', 'return',     500,  '2025-06-30', 'Accrued return'],
    ['ID-T2', 'ID-1', 'interest',   250,  '2025-08-15', 'Interest credited'],
    ['ID-T3', 'ID-1', 'payout',   105000, '2025-06-30', 'Maturity payout'],   // capital + return
    ['ID-T4', 'ID-1', 'deposit',   20000, '2025-05-02', 'Client deposit'],
    ['ID-T5', 'ID-2', 'interest',   999,  '2025-08-15', 'Not Ada’s'],
  ];
  for (const [id, who, type, amt, when, desc] of T) {
    await pool.query(
      `INSERT INTO transactions (id,investor_id,type,amount,status,reference,description,
          transaction_date,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'completed',$1,$5,$6::date,NOW(),NOW())`,
      [id, who, type, amt, desc, when]);
  }

  /* Ada's login. The token carries investorId; the users row is the fallback. */
  await pool.query(
    `INSERT INTO users (id,email,password_hash,role,first_name,last_name,investor_id)
     VALUES ('11111111-2222-3333-4444-555555555555','ada@example.test','x','investor','Ada','Client','ID-1')`);
}

let CURRENT_USER = { id: 'ADMIN-1', email: 'a@example.test', role: 'admin' };

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = CURRENT_USER; next(); },
      requireRole: () => (_req, _res, next) => next(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin',      require(path.join(ROOT, 'server', 'routes', 'manualCredit')));
  app.use('/api/statements', require(path.join(ROOT, 'server', 'routes', 'statements')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 200) }; }
      resolve({ status: res.statusCode, body });
    });
  }).on('error', reject);
});

const AS_ADMIN    = { id: 'ADMIN-1', email: 'a@example.test', role: 'admin' };
const AS_ADA      = { id: '11111111-2222-3333-4444-555555555555', email: 'ada@example.test',
                      role: 'investor', investorId: 'ID-1' };
/* A token shaped the way the invest funnel wrongly assumed: no investorId
   claim, only the users row id. The route must still resolve it. */
const AS_ADA_OLD  = { id: '11111111-2222-3333-4444-555555555555', email: 'ada@example.test',
                      role: 'investor' };

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    /* ── The income reference ──────────────────────────────────────── */
    console.log('\nthe income reference is one document');
    CURRENT_USER = AS_ADMIN;
    const admin = await get(port, '/api/admin/tax-cert?investor_id=ID-1&year=2026');
    ok('the console can produce it', admin.status === 200, JSON.stringify(admin.body).slice(0, 160));

    CURRENT_USER = AS_ADA;
    const mine = await get(port, '/api/statements/income-reference/2026');
    ok('and so can the client', mine.status === 200, JSON.stringify(mine.body).slice(0, 160));

    if (admin.status === 200 && mine.status === 200) {
      ok('and they are the same document, field for field',
         JSON.stringify(mine.body) === JSON.stringify(admin.body),
         'the same client asking two different parts of the platform must not ' +
         'be told two different things');

      const d = mine.body;
      ok('income is `return` and `interest` only',
         near(d.totalReturns, 750),
         `${d.totalReturns} — a payout is capital PLUS return; the 105 000 payout ` +
         `must not be counted as earnings`);
      ok('the deposit is reported separately',
         near(d.totalDeposits, 20000), String(d.totalDeposits));
      ok('the tax year runs 1 March to the end of February',
         d.from === '2025-03-01' && d.to === '2026-02-28', `${d.from} → ${d.to}`);
      ok('the realised return is read off the POOL, not the investment',
         d.maturedInvestments && d.maturedInvestments.length === 1 &&
         d.maturedInvestments[0].return_posted === true &&
         near(d.maturedInvestments[0].realised_return, 5000),
         `${JSON.stringify(d.maturedInvestments)} — actual_return is 0, the pool's ` +
         `actual_rate is 5% of 100 000`);
      ok('and another client’s income is not in it',
         !JSON.stringify(d.returns).includes('Not Ada'), JSON.stringify(d.returns));
    }

    /* ── The account statement ─────────────────────────────────────── */
    console.log('\nthe account statement is one document');
    CURRENT_USER = AS_ADMIN;
    const aStmt = await get(port, '/api/admin/account-statement?investor_id=ID-1&from=2025-03-01&to=2026-02-28');
    ok('the console can produce it', aStmt.status === 200, JSON.stringify(aStmt.body).slice(0, 160));

    CURRENT_USER = AS_ADA;
    const mStmt = await get(port, '/api/statements/account-statement?from=2025-03-01&to=2026-02-28');
    ok('and so can the client', mStmt.status === 200, JSON.stringify(mStmt.body).slice(0, 160));
    if (aStmt.status === 200 && mStmt.status === 200) {
      ok('and they are the same document, field for field',
         JSON.stringify(mStmt.body) === JSON.stringify(aStmt.body));
      ok('the closing balance is anchored to the wallet',
         near(mStmt.body.closing_balance, 1000), String(mStmt.body.closing_balance));
      ok('and every row carries the effect the server computed',
         (mStmt.body.transactions || []).every(t => t.cash_effect !== undefined &&
                                                    t.running_balance !== undefined),
         'the portal used to run its own totals with its own idea of a debit');
    }

    /* ── Whose document is it ──────────────────────────────────────── */
    console.log('\nthe investor route serves the caller and nobody else');
    CURRENT_USER = AS_ADA;
    {
      const spoof = await get(port, '/api/statements/income-reference/2026?investor_id=ID-2');
      ok('a query parameter cannot redirect it at another client',
         spoof.status === 200 && spoof.body.investor && spoof.body.investor.id === 'ID-1',
         `got ${spoof.body.investor && spoof.body.investor.id} — the id comes from the token`);

      const spoof2 = await get(port, '/api/statements/account-statement?investor_id=ID-2&from=2025-03-01&to=2026-02-28');
      ok('and neither can it on the statement',
         spoof2.status === 200 && spoof2.body.investor && spoof2.body.investor.id === 'ID-1',
         `got ${spoof2.body.investor && spoof2.body.investor.id}`);
    }
    {
      CURRENT_USER = AS_ADA_OLD;
      const viaUsers = await get(port, '/api/statements/income-reference/2026');
      ok('a token with no investorId claim still resolves through users',
         viaUsers.status === 200 && viaUsers.body.investor.id === 'ID-1',
         `${viaUsers.status} ${JSON.stringify(viaUsers.body).slice(0, 120)}`);
    }
    {
      CURRENT_USER = { id: 'NOBODY', email: 'x@example.test', role: 'investor' };
      const none = await get(port, '/api/statements/income-reference/2026');
      ok('and a caller with no investor account is refused, not given someone’s',
         none.status === 403, `${none.status} ${JSON.stringify(none.body).slice(0, 120)}`);
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
