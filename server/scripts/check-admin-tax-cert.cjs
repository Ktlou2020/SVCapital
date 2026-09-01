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

/* max: 2 — these checks are single-threaded and never need more. The pg
   default is 10 per pool, and this file opens two (plus the route module's
   own), which under check-run-checks' NESTED suite run put enough idle
   connections against max_connections to fail a run about one time in ten.
   The error surfaced inside the nested runner, where it read as an
   unrelated pg-protocol stack trace. */
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
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
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
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

  /* Investments that matured inside the tax year. The return realised at
     maturity is not in the ledger — creditWallet writes only the payout — and
     it is posted on the POOL as actual_rate, not on the investment.

     The three shapes below are the ones that matter, and the middle one is
     what a real account looks like: actual_return sits at 0 (its default, not
     NULL) while the pool carries the posted rate. A rule of
     COALESCE(actual_return, expected_return, 0) short-circuits on that zero
     and prints R 0,00 against every matured holding a client owns. */
  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,
        term_months,start_date,end_date,maturity_date,min_investment)
    VALUES ('TC-P-POSTED','Short Term Investment - October 2024','short_term','matured',
            0.16,0.0213,12,'2024-10-01','2024-10-31','2025-11-01',500),
           ('TC-P-OPEN','Cattle Investment - November 2024','cattle','matured',
            0.16,0,12,'2024-11-01','2024-11-30','2025-11-30',500)`);

  await pool.query(`
    INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,
        start_date,end_date,annual_rate,term_months,expected_return,actual_return,
        product_type,maturity_instruction)
    VALUES
      /* 1. A return written onto the investment itself. Used as-is. */
      ('TC-I-MAT','TC-INV',NULL,'Cattle Investment - November 2025',
       8000,'matured','2024-11-01','2025-11-01',0.0625,12,500,500,'cattle','payout'),
      /* 2. actual_return 0, pool rate posted: 100000 x 0.0213 = 2130. */
      ('TC-I-RATE','TC-INV','TC-P-POSTED','Short Term Investment - October 2024',
       100000,'matured','2024-10-01','2025-03-31',0.16,12,9999,0,'short_term','payout'),
      /* 3. Nothing posted anywhere. Not zero — unknown. expected_return is
         deliberately large, because using it would put a projection on a tax
         document. */
      ('TC-I-NONE','TC-INV','TC-P-OPEN','Cattle Investment - November 2024',
       50000,'matured','2024-11-01','2025-04-30',0.16,12,7777,0,'cattle','payout'),
      /* 4. Matured outside the tax year. */
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
      const mByIdRaw = Object.fromEntries((body.maturedInvestments || []).map(m => [m.id, m]));

      console.log('\n  the return comes from the pool, the way the payout engine reads it');
      /* The defect this replaced: 39 matured investments on a real certificate,
         every one of them printing R 0,00. actual_return defaults to 0 rather
         than NULL, so COALESCE(actual_return, expected_return, 0) never even
         looked at the pool. */
      ok('a posted pool rate is applied to the capital',
         mByIdRaw['TC-I-RATE'] && Math.abs(Number(mByIdRaw['TC-I-RATE'].realised_return) - 2130) < 0.005,
         `R100 000 x 2.13% = R2 130, got ${mByIdRaw['TC-I-RATE'] && mByIdRaw['TC-I-RATE'].realised_return}`);
      ok('even though actual_return on the investment is zero',
         mByIdRaw['TC-I-RATE'] && mByIdRaw['TC-I-RATE'].return_posted === true,
         'zero is the column default, not a statement that nothing was earned');
      ok('a return written on the investment is still used',
         mByIdRaw['TC-I-MAT'] && Math.abs(Number(mByIdRaw['TC-I-MAT'].realised_return) - 500) < 0.005,
         String(mByIdRaw['TC-I-MAT'] && mByIdRaw['TC-I-MAT'].realised_return));

      console.log('\n  and nothing posted is reported as unknown, not as zero');
      ok('an investment with no posted return anywhere is flagged',
         mByIdRaw['TC-I-NONE'] && mByIdRaw['TC-I-NONE'].return_posted === false,
         JSON.stringify(mByIdRaw['TC-I-NONE']));
      ok('its return is null rather than 0',
         mByIdRaw['TC-I-NONE'] && mByIdRaw['TC-I-NONE'].realised_return === null,
         'R 0,00 on a tax document says the client earned nothing, which is a different claim');
      ok("and expected_return is not substituted for it",
         mByIdRaw['TC-I-NONE'] && Number(mByIdRaw['TC-I-NONE'].realised_return) !== 7777,
         'expected_return is the projection made when the investment was written');
      ok('the count of unposted ones is reported', Number(body.maturedUnposted) === 1,
         `${body.maturedUnposted} — a total that silently omits them looks authoritative`);

      ok('the total is the posted returns only', Math.abs(Number(body.maturedReturns) - (500 + 2130)) < 0.005,
         `${body.maturedReturns} — expected 2630`);
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

    /* ── The document, drawn ─────────────────────────────────────────
       The route can be right and the page still wrong: a figure computed
       correctly and then printed in the wrong column, or an unknown return
       rendered as R 0,00, is a defect the endpoint cannot see. */
    console.log('\nthe document, drawn');
    {
      const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                      '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => require('fs').existsSync(p));
      if (!CHROME) {
        console.log('  SKIP  no headless Chromium — the certificate was not rendered');
      } else {
        const os = require('os'), { execFileSync } = require('child_process');
        const admin = require('fs').readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
        const at = admin.indexOf('function _openAdminTaxCertWindow(');
        let i = admin.indexOf('{', admin.indexOf(')', at)), d = 0, end = i;
        for (; i < admin.length; i++) {
          if (admin[i] === '{') d++;
          else if (admin[i] === '}') { d--; if (d === 0) { end = i; break; } }
        }
        const fnSrc = admin.slice(at, end + 1);
        const escSrc = (admin.match(/^const _esc = .*$/m) || [])[0];

        const DATA = {
          investor: { id: 'S-111628', first_name: 'Devin', last_name: 'Padayachy',
                      email: 'devin@example.test', id_number: '7202275224082' },
          taxYear: 2026, from: '2025-03-01', to: '2026-02-28',
          returns: [], totalReturns: 0,
          deposits: [{ id: 'd1', txn_date: '2025-06-26', type: 'deposit', description: 'CREDIT', amount: '20000.00' }],
          totalDeposits: 20000,
          maturedInvestments: [
            { id: 'A', pool_name: 'Short Term Investment - October 2024', amount: '80000.00',
              end_date: '2025-03-31', realised_return: 1704, return_posted: true },
            { id: 'B', pool_name: 'Cattle Investment - April 2024', amount: '179440.00',
              end_date: '2025-04-29', realised_return: null, return_posted: false },
          ],
          maturedReturns: 1704, maturedUnposted: 1,
        };

        const tmp = require('fs').mkdtempSync(path.join(os.tmpdir(), 'taxcert-'));
        require('fs').writeFileSync(path.join(tmp, 'p.html'), `<!doctype html>
<html><head><meta charset="utf-8"></head><body><div id="doc"></div><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));window.__html='';
window.location.origin||0;
window.open=function(){return {document:{write(h){window.__html+=h;},close(){}},focus(){},print(){}};};<\/script>
<script>${escSrc}
${fnSrc}
const out={errors:ERRORS};
try{_openAdminTaxCertWindow(${JSON.stringify(DATA).replace(/</g, '\\u003c')});out.built='ok';}
catch(e){out.built='THREW: '+e.message;}
document.getElementById('doc').innerHTML=window.__html||'';
const txt=(document.getElementById('doc').textContent||'').replace(/\\s+/g,' ');
out.len=txt.length;
/* Read the RETURN CELLS, not the page text.
   Two traps, both hit on the first attempt: "Not yet posted" also appears in
   the warning paragraph above the table, so searching the whole document
   found it even when the cell showed a zero; and headless Chromium renders
   en-ZA as "1,704.00" while a browser in South Africa renders "1 704,00", so
   a regex written for one locale silently matched nothing in the other. */
const mTable=[...document.querySelectorAll('table')].find(t=>/TOTAL RETURNS REALISED/.test(t.textContent));
const retCells=mTable?[...mTable.querySelectorAll('tbody tr:not(.total-row)')]
  .map(r=>(r.lastElementChild.textContent||'').trim()):[];
out.retCells=retCells;
out.notPosted=retCells.some(c=>/Not yet posted/.test(c));
out.postedAmount=retCells.some(c=>/1[  ,]704[.,]00/.test(c));
out.warns=/has no posted return/.test(txt);
out.headerRange=/1 March 2025 . 28 February 2026/.test(txt);
out.marchFirst=/1 March 2026/.test(txt);
/* A zero in the return column is the defect: it states the client earned
   nothing where the truth is that nobody has posted the figure. Matched in
   either locale's decimal separator. */
out.zeroReturn=retCells.some(c=>/^R.?0[.,]00$/.test(c));
/* Order, read off the rendered page. With interestCron disabled the credited
   figure is structurally zero for a client whose returns come from maturities,
   so leading with it buries the number that matters. */
const titles=[...document.querySelectorAll('.section-title')].map(t=>t.textContent.trim());
out.titles=titles;
out.maturedBeforeCredited=titles.indexOf('Investments Matured in this Tax Year')>-1 &&
  titles.indexOf('Investments Matured in this Tax Year')<titles.indexOf('Returns Credited');
const cards=[...document.querySelectorAll('.sum-lbl')].map(t=>t.textContent.trim());
out.cards=cards;
out.maturityCardLeads=cards[0]==='Returns Realised at Maturity';
/* The empty state must not read as "you earned nothing". */
out.emptyPointsAtMaturity=/investment income for this year is the return realised at maturity/.test(txt);
out.stamp=/www\\.svcapital\\.co\\.za/.test(txt);
out.undef=(txt.match(/undefined/g)||[]).length;
out.nan=(txt.match(/NaN/g)||[]).length;
document.getElementById('probe').textContent=JSON.stringify(out);
<\/script></body></html>`);

        let dom = '';
        try {
          dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
            '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.join(tmp, 'p.html')],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
        } catch (e) { dom = (e.stdout || '').toString(); }
        const mm = dom.match(/id="probe">([\s\S]*?)<\/div>/);
        let d2 = null;
        try {
          d2 = JSON.parse((mm ? mm[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
        } catch (_) {}

        ok('the certificate renders', !!d2 && d2.built === 'ok',
           d2 ? d2.built : (mm ? mm[1] : dom).slice(0, 300));
        if (d2 && d2.built === 'ok') {
          ok('nothing threw', (d2.errors || []).length === 0, JSON.stringify(d2.errors));
          ok('a posted return prints its amount', d2.postedAmount === true);
          ok('an unposted one prints "Not yet posted" IN ITS CELL', d2.notPosted === true,
             `printing R 0,00 tells a client they earned nothing, which is a different claim — cells: ${JSON.stringify(d2.retCells)}`);
          ok('and no return cell shows a zero', d2.zeroReturn === false,
             `the defect was 39 matured investments each showing R 0,00 — cells: ${JSON.stringify(d2.retCells)}`);
          ok('the reader is warned how many are unposted', d2.warns === true);
          ok('the tax year reads 1 March to 28 February', d2.headerRange === true);
          ok('and 1 March of the following year appears nowhere', d2.marchFirst === false,
             'the end of the year rendered as an instant used to roll into the next morning');
          console.log('\n  and the figure that matters leads');
          ok('the maturity return is the first summary card', d2.maturityCardLeads === true,
             JSON.stringify(d2.cards));
          ok('and its section comes before Returns Credited',
             d2.maturedBeforeCredited === true, JSON.stringify(d2.titles));
          ok('an empty Returns Credited section says where the income actually is',
             d2.emptyPointsAtMaturity === true,
             '"No returns were credited" alone reads as "you earned nothing"');

          ok('the shared footer stamp is on it', d2.stamp === true);
          ok('nothing renders as undefined', d2.undef === 0, String(d2.undef));
          ok('and none as NaN', d2.nan === 0, String(d2.nan));
        }
        if (!process.env.DUMP) require('fs').rmSync(tmp, { recursive: true, force: true });
      }
    }

    console.log('\nthe two documents a client receives share one masthead');
    /* The statement and the certificate go to the same person, often in the
       same email. Two different letterheads read as two different companies. */
    {
      const admin = require('fs').readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      const fn = name => {
        const at = admin.indexOf(`function ${name}(`);
        const end = admin.indexOf('\nfunction ', at + 10);
        return admin.slice(at, end > 0 ? end : admin.length);
      };
      const cert = fn('_openAdminTaxCertWindow');
      const stmt = fn('_openAccountStatementWindow');
      const LOGO = "/assets/sv-capital-logo-horizontal-white-text.png";
      ok('both use the same logo asset',
         cert.includes(LOGO) && stmt.includes(LOGO),
         'the certificate used a text heading while the statement used the logo');
      ok('both carry the purple rule above the page',
         /border-top:5px solid #eda5ff/.test(cert) && /border-top:5px solid #eda5ff/.test(stmt));
      ok('both use the same chrome colour, not two greys',
         /background:#1f2937/.test(cert) && /background:#1f2937/.test(stmt),
         'the certificate was #303030 and the statement #1f2937');
      ok('both close with the same stamp',
         /SV Capital \(Pty\) Ltd &mdash; www\.svcapital\.co\.za/.test(cert) &&
         /SV Capital \(Pty\) Ltd &mdash; www\.svcapital\.co\.za/.test(stmt));
      ok('and both name the client, the account and the period in the footer',
         /prepared for/.test(cert) && /prepared for/.test(stmt) &&
         /All amounts are in South African Rand \(ZAR\)/.test(cert));
      ok('the canonical purple is the only purple on the certificate',
         !/#[0-9a-fA-F]{6}/.test(cert.replace(/#eda5ff/gi, '')) ||
         !/(#8b5cf6|#a855f7|#9333ea|#7c3aed|#6d28d9)/i.test(cert),
         'the platform has one purple and it is #eda5ff');
    }

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
    /* The route module under test resolves db/pool at require time and opens
       its OWN pool against this database. Leaving it open makes the DROP below
       fail with "is being accessed by other users", which the .catch() then
       swallows — so the scratch database survives the run and check-run-checks
       reports it. Closing it here is what actually lets the drop succeed. */
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    if (original) process.env.DATABASE_URL = original;
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
