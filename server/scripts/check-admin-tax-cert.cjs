#!/usr/bin/env node
/* The investment income reference, over the real route.
 *
 * This endpoint returned a 500 on every single call. A `paid` summary written
 * for /account-statement had been duplicated into it, and that block referenced
 * `transactions`, `num` and `r2` — three identifiers declared inside the
 * account-statement handler and none of them in scope here. A ReferenceError is
 * a runtime event, so nothing about the file's shape gave it away: it parsed,
 * it loaded, it exported, and it threw the moment anyone pressed the button.
 * Nothing consumed the block's output either — the console reads returns,
 * deposits and their totals, which are computed further up.
 *
 * The lesson is about the harness rather than the bug. The endpoint check that
 * already existed in this repo mounts a hand-written stub of the route it is
 * testing, which is fine for a service behind two front ends and useless here:
 * the defect WAS the route body. So this mounts the real router out of
 * server/routes/manualCredit.js, with only the auth middleware replaced, and
 * asks it real questions over a real socket.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-admin-tax-cert.cjs
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
const DB_NAME = 'chk_taxcert_' + process.pid;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* Structural, not a regex: the regex form of this elsewhere silently does
   nothing when the URL carries no query string, which sends a check at the
   wrong database. */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
}

const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });
let pool;

/* Its own database. The suite's checks replace each other's schemas, and this
   one needs the full one. */
async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  /* Left pointing at the new database: the route module under test resolves
     db/pool at require time too, and it must reach the same place. */
  pool = new Pool({ connectionString: url, ssl: SSL });
  return original;
}

/* The 2025/26 SA tax year: 1 March 2025 – 28 February 2026. Every fixture is
   placed relative to that window so the boundaries are the thing under test. */
const TAX_YEAR = 2026;
const T = [
  // id,               type,        amount,  when,          status,      where
  ['TC-T-IN-RET',     'return',     1200,   '2025-06-15', 'completed', 'investor'],
  ['TC-T-IN-INT',     'interest',    450,   '2025-08-18', 'completed', 'investor'],
  /* A maturity payout: capital plus the return on it, in one amount. Counting
     this as income declares R8 500 of the client's own money as earnings. */
  ['TC-T-IN-PAY',     'payout',     8500,   '2025-11-01', 'completed', 'investor'],
  ['TC-T-IN-DEP',     'deposit',   40000,   '2025-04-02', 'completed', 'investor'],
  // Boundaries: the first and last day of the year must be inside it.
  ['TC-T-FIRST-DAY',  'deposit',     100,   '2025-03-01', 'completed', 'investor'],
  ['TC-T-LAST-DAY',   'deposit',     200,   '2026-02-28', 'completed', 'investor'],
  // Just outside, on both sides.
  ['TC-T-DAY-BEFORE', 'deposit',    9999,   '2025-02-28', 'completed', 'investor'],
  ['TC-T-DAY-AFTER',  'deposit',    8888,   '2026-03-01', 'completed', 'investor'],
  // Money that never moved: pending and rejected must not reach a tax document.
  ['TC-T-PENDING',    'deposit',    7777,   '2025-09-09', 'pending',   'investor'],
  ['TC-T-REJECTED',   'payout',     6666,   '2025-09-09', 'rejected',  'investor'],
  // Types the certificate is not about.
  ['TC-T-WITHDRAW',   'withdrawal', 5555,   '2025-09-09', 'completed', 'investor'],
  ['TC-T-FEE',        'fee',          55,   '2025-09-09', 'completed', 'investor'],
  // A minor's sub-account: its income is the parent's on the certificate.
  ['TC-T-SA-RET',     'return',      300,   '2025-07-07', 'completed', 'sub'],
  ['TC-T-SA-DEP',     'deposit',    2500,   '2025-07-07', 'completed', 'sub'],
];

async function seed() {
  await pool.query(`DELETE FROM transactions WHERE id LIKE 'TC-%'`);
  await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'TC-%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'TC-%'`);
  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,id_number,status,wallet_balance)
    VALUES ('TC-INV','Devin','Padayachy','devin@example.test','7202275224082','active',227.78)`);
  await pool.query(`
    INSERT INTO sub_accounts (id,parent_investor_id,name,account_type,wallet_balance)
    VALUES ('TC-SA','TC-INV','Minor account','minor',0)`);

  /* created_at is deliberately NOT the date the money moved. Every row is
     stamped as though the ledger were migrated in one batch on 21 August 2026,
     which is the shape real imported data has — and the shape that made this
     endpoint report R 0,00 to a client with a full ledger. A fixture where the
     two columns agree cannot tell the two apart, and the first version of this
     check made exactly that mistake and passed against the bug. */
  const MIGRATED_ON = '2026-08-21T00:00:00Z';
  for (const [id, type, amount, when, status, where] of T) {
    await pool.query(
      `INSERT INTO transactions (id,investor_id,sub_account_id,type,amount,status,reference,
                                 description,transaction_date,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$1,$7,$8::timestamptz,$9::timestamptz,NOW())`,
      [id, where === 'sub' ? null : 'TC-INV', where === 'sub' ? 'TC-SA' : null,
       type, amount, status, `fixture ${type}`, `${when}T09:00:00Z`, MIGRATED_ON]);
  }

  /* An investment that matured inside the tax year. Its return is on the
     investment, not in the ledger — creditWallet writes only the payout. */
  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,
        start_date,end_date,annual_rate,term_months,expected_return,actual_return,
        product_type,maturity_instruction)
    VALUES ('TC-I-MAT','TC-INV',NULL,'Cattle Investment - November 2025',
            8000,'matured','2024-11-01','2025-11-01',0.0625,12,500,500,'cattle','payout'),
           ('TC-I-OUT','TC-INV',NULL,'Cattle Investment - June 2026',
            9000,'matured','2025-06-01','2026-06-01',0.05,12,450,450,'cattle','payout')`);
}

/* The real router, with only its auth replaced. requireAuth/requireRole are
   swapped in the module cache BEFORE the route file is required, so the file
   under test is loaded exactly as it ships. That it IS guarded is asserted
   separately, from the source — this check is about the handler's body. */
function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 'TC-ADM', email: 'admin@example.test', role: 'admin' }; next(); },
      requireRole: () => (_req, _res, next) => next(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require(path.join(ROOT, 'server', 'routes', 'manualCredit')));
  return new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
}

const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body = null;
      try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 300) }; }
      resolve({ status: res.statusCode, body });
    });
  }).on('error', reject);
});

const idsOf = rows => (rows || []).map(r => r.id).sort();
const sum   = rows => Math.round((rows || []).reduce((a, r) => a + Math.abs(Number(r.amount) || 0), 0) * 100) / 100;

(async () => {
  let srv, original;
  try {
    original = await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    const cert = `/api/admin/tax-cert?investor_id=TC-INV&year=${TAX_YEAR}`;
    const { status, body } = await get(port, cert);

    console.log('\nthe endpoint answers at all');
    /* The assertion the whole file exists for. It failed with
       "r2 is not defined" for as long as the stray block was there. */
    ok('a 200, not a 500', status === 200,
       `status ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    ok('and no error in the body', !body.error, JSON.stringify(body.error));

    if (status === 200) {
      console.log('\nit returns exactly what the console reads');
      /* _openAdminTaxCertWindow destructures these. A response missing one
         renders a blank cell rather than failing, which is how a figure goes
         missing from a document a client files with SARS. */
      for (const k of ['investor', 'taxYear', 'from', 'to',
                       'returns', 'totalReturns', 'deposits', 'totalDeposits']) {
        ok(`${k} is present`, body[k] !== undefined, JSON.stringify(Object.keys(body)));
      }

      console.log('\nthe date the money moved, not the date the row was written');
      /* The bug that produced an income reference reading R 0,00 for a client
         with a full ledger: every row here was written on 21 August 2026, and
         filtering on created_at put all of it outside every tax year the
         client could ask for. */
      ok('a transaction migrated long afterwards is still in its own tax year',
         idsOf(body.returns).includes('TC-T-IN-RET'),
         `returns: ${JSON.stringify(idsOf(body.returns))} — all rows have created_at in Aug 2026`);
      ok('and the certificate is not empty',
         Number(body.totalReturns) > 0 && Number(body.totalDeposits) > 0,
         `returns ${body.totalReturns}, deposits ${body.totalDeposits}`);
      ok('each row carries the date the money moved',
         (body.returns || []).every(r => r.txn_date),
         'without it the document prints the migration date against every line');

      console.log('\nthe SA tax year, 1 March to the last day of February');
      ok('it starts on 1 March of the previous year',
         String(body.from).slice(0, 10) === '2025-03-01', String(body.from));
      ok('and ends on the last day of February',
         String(body.to).slice(0, 10) === '2026-02-28', String(body.to));
      /* Plain dates, not instants. Sent as 23:59:59Z the end of the year was
         printed as "1 March 2026" by a browser in SAST, disagreeing with the
         document's own header. */
      ok('and both are plain dates, so no reader\'s timezone can move them',
         /^\d{4}-\d{2}-\d{2}$/.test(String(body.from)) && /^\d{4}-\d{2}-\d{2}$/.test(String(body.to)),
         `${body.from} … ${body.to}`);
      ok('a transaction on the first day is inside it',
         idsOf(body.deposits).includes('TC-T-FIRST-DAY'), JSON.stringify(idsOf(body.deposits)));
      ok('and one on the last day too',
         idsOf(body.deposits).includes('TC-T-LAST-DAY'), JSON.stringify(idsOf(body.deposits)));
      ok('the day before is outside',
         !idsOf(body.deposits).includes('TC-T-DAY-BEFORE'));
      ok('and the day after',
         !idsOf(body.deposits).includes('TC-T-DAY-AFTER'));

      console.log('\nonly money that actually moved');
      ok('a pending deposit is not on the certificate',
         !idsOf(body.deposits).includes('TC-T-PENDING'),
         'money that never arrived must not be declared as income or contribution');
      ok('nor a rejected payout',
         !idsOf(body.returns).includes('TC-T-REJECTED'));
      ok('a withdrawal is not income', !idsOf(body.returns).includes('TC-T-WITHDRAW'));
      ok('and a fee is not a deposit', !idsOf(body.deposits).includes('TC-T-FEE'));

      console.log('\na sub-account\'s income belongs to the parent');
      ok('its returns are included',
         idsOf(body.returns).includes('TC-T-SA-RET'), JSON.stringify(idsOf(body.returns)));
      ok('and its deposits', idsOf(body.deposits).includes('TC-T-SA-DEP'),
         JSON.stringify(idsOf(body.deposits)));

      console.log('\nincome is what was earned, not what moved');
      /* A payout's amount is the client's capital coming back PLUS the return
         on it. Summing payouts as income declares returned capital as taxable
         earnings — R8 500 of it, on this fixture. */
      ok('a maturity payout is not counted as income',
         !idsOf(body.returns).includes('TC-T-IN-PAY'),
         `returns: ${JSON.stringify(idsOf(body.returns))}`);
      ok('an accrued return is', idsOf(body.returns).includes('TC-T-IN-RET'));
      ok('and so is credited interest', idsOf(body.returns).includes('TC-T-IN-INT'),
         'interest credited from the periodic distribution is income and was omitted entirely');
      ok('so the credited-income total is the returns and interest alone',
         Math.abs(Number(body.totalReturns) - (1200 + 450 + 300)) < 0.005,
         `${body.totalReturns} — expected 1950 (1200 return + 450 interest + 300 sub-account return)`);

      console.log('\nthe return realised at maturity is reported, and reported apart');
      ok('an investment that matured in the year is listed',
         (body.maturedInvestments || []).some(m => m.id === 'TC-I-MAT'),
         JSON.stringify((body.maturedInvestments || []).map(m => m.id)));
      ok('one that matured outside it is not',
         !(body.maturedInvestments || []).some(m => m.id === 'TC-I-OUT'),
         JSON.stringify((body.maturedInvestments || []).map(m => m.id)));
      ok('its realised return is totalled', Math.abs(Number(body.maturedReturns) - 500) < 0.005,
         String(body.maturedReturns));
      ok('and kept out of the credited-income figure',
         Math.abs(Number(body.totalReturns) - 1950) < 0.005,
         'a holding accrued monthly and then matured appears in both — adding them declares it twice');

      console.log('\nthe totals are the rows');
      /* Asserted against the rows the response itself returned, not against a
         number restated here: a total that disagrees with the list printed
         beneath it is the defect worth catching, and this stays true whatever
         is later decided about which types belong in it. */
      ok('totalReturns is the sum of the returns listed',
         Math.abs(Number(body.totalReturns) - sum(body.returns)) < 0.005,
         `${body.totalReturns} vs ${sum(body.returns)}`);
      ok('totalDeposits is the sum of the deposits listed',
         Math.abs(Number(body.totalDeposits) - sum(body.deposits)) < 0.005,
         `${body.totalDeposits} vs ${sum(body.deposits)}`);
      ok('every row carries a date and a reference to trace it by',
         [...body.returns, ...body.deposits].every(r => r.created_at && r.reference),
         'a client queried by SARS has to be able to point at the transaction');
      ok('and both lists are in date order',
         [body.returns, body.deposits].every(list =>
           list.every((r, i) => i === 0 || new Date(list[i - 1].created_at) <= new Date(r.created_at))));
    }

    console.log('\nand it refuses what it cannot answer');
    const missing = await get(port, `/api/admin/tax-cert?investor_id=TC-NOBODY&year=${TAX_YEAR}`);
    ok('an unknown investor is a 404', missing.status === 404, `status ${missing.status}`);
    const noYear = await get(port, '/api/admin/tax-cert?investor_id=TC-INV');
    ok('a missing year is a 400', noYear.status === 400, `status ${noYear.status}`);
    const badYear = await get(port, '/api/admin/tax-cert?investor_id=TC-INV&year=1066');
    ok('and an implausible year is a 400', badYear.status === 400, `status ${badYear.status}`);

    console.log('\nthe route is still behind the admin guard');
    const src = require('fs').readFileSync(
      path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
    ok('the router requires an admin or director for everything it serves',
       /router\.use\(requireAuth, requireRole\('admin', 'director'\)\)/.test(src),
       'this check replaces that middleware, so it has to be asserted separately');

    console.log('\nand the stray block has not come back');
    const certRoute = src.slice(src.indexOf("router.get('/tax-cert'"),
                                src.indexOf("router.get('/account-statement'") > src.indexOf("router.get('/tax-cert'")
                                  ? src.indexOf("router.get('/account-statement'")
                                  : src.length);
    ok('the tax-cert handler references no helper it does not own',
       !/\br2\(/.test(certRoute) && !/\bnum\(/.test(certRoute) && !/\btransactions\b\s*\./.test(certRoute),
       'r2, num and transactions are declared inside the account-statement handler');

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    if (original) process.env.DATABASE_URL = original;
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
