#!/usr/bin/env node
/* The invest funnel summary, from the query to the rendered table.
 *
 * /invest-funnel/summary runs eight queries in one Promise.all and destructures
 * the results positionally:
 *
 *   const [funnelRows, …, trendRows, poolRows, investorRows] = await Promise.all([…])
 *
 * The last two were the other way round. poolRows held the per-INVESTOR rows
 * and investorRows held the per-POOL rows, so every field one query selects and
 * the other does not came back undefined — and parseInt(undefined) is NaN,
 * which JSON.stringify writes as null. The admin console then reached for
 * r.fee_shown.toLocaleString() on a null and took the whole panel down.
 *
 * It survived because the panel's catch drew "No funnel data yet" for any
 * failure, so a crash on every render with data looked exactly like a quiet
 * marketplace. The tables were also silently transposed whenever they did draw:
 * pool names in the investor column, investor ids in the pool column.
 *
 * Positional destructuring of a long Promise.all cannot be checked by reading
 * it — the names are in one place and the queries in another, and nothing
 * connects them. So this asserts on the values: a per-pool row must carry the
 * POOL'S NAME and a numeric fee_shown, a per-investor row must carry the
 * INVESTOR'S name and email, and the counts must be that group's counts. The
 * fixture gives the two groupings different numbers on purpose, so a swap
 * cannot pass by coincidence.
 *
 * The real response is then rendered in headless Chromium, because a shape
 * assertion that stops at the JSON would not have caught the crash.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-invest-funnel-summary.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_ifunnel_' + process.pid;
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) {
  const u = new URL(url); u.pathname = '/' + name; return u.toString();
}

/* max: 2 — single-threaded, and the pg default of 10 per pool put enough idle
   connections against max_connections to fail roughly one nested suite run in
   ten. See the same note in check-pool-raise-report.cjs. */
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

/* Two pools and three investors, arranged so that the per-pool counts and the
   per-investor counts are DIFFERENT numbers in DIFFERENT orders. If the two
   result sets are transposed, no assertion below can pass by luck.

     by pool      opened  fee_shown  confirmed  abandoned   (order: opened desc)
       IF-P1        3         2          1          2
       IF-P2        2         1          1          1

     by investor  opened  abandoned  confirmed  after_fee   (order: abandoned desc)
       IF-I2        2         2          0        true
       IF-I1        2         1          1        true
       IF-I3      excluded — the query keeps only investors who abandoned

   [investor, pool, event_type, fee_seen] */
const EVENTS = [
  ['IF-I1', 'IF-P1', 'modal_opened', null],
  ['IF-I1', 'IF-P1', 'fee_shown',    null],
  ['IF-I1', 'IF-P1', 'confirmed',    true],
  ['IF-I1', 'IF-P1', 'modal_opened', null],
  ['IF-I1', 'IF-P1', 'fee_shown',    null],
  ['IF-I1', 'IF-P1', 'abandoned',    true],   // abandoned after seeing the fee
  ['IF-I2', 'IF-P1', 'modal_opened', null],
  ['IF-I2', 'IF-P1', 'abandoned',    false],  // abandoned before it
  ['IF-I2', 'IF-P2', 'modal_opened', null],
  ['IF-I2', 'IF-P2', 'fee_shown',    null],
  ['IF-I2', 'IF-P2', 'abandoned',    true],
  ['IF-I3', 'IF-P2', 'modal_opened', null],
  ['IF-I3', 'IF-P2', 'confirmed',    true],
];

async function seed() {
  await pool.query(`DELETE FROM invest_funnel_events WHERE investor_id LIKE 'IF-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'IF-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'IF-%'`);

  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,term_months,
        start_date,end_date,maturity_date,min_investment)
    VALUES
      ('IF-P1','Short Term Investment - March 2026','short_term','open',0.13,12,
       CURRENT_DATE-10, CURRENT_DATE+20, CURRENT_DATE+380, 500),
      ('IF-P2','Cattle Investment - March 2026','cattle','open',0.16,12,
       CURRENT_DATE-10, CURRENT_DATE+20, CURRENT_DATE+380, 500)`);

  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,kyc_status,total_invested)
    VALUES ('IF-I1','Ann','Abandoner','ann@example.test','active','verified',12000),
           ('IF-I2','Bea','Bailer','bea@example.test','active','pending',0),
           ('IF-I3','Cal','Committer','cal@example.test','active','verified',5000)`);

  for (const [investor, poolId, type, feeSeen] of EVENTS) {
    await pool.query(
      `INSERT INTO invest_funnel_events (investor_id,event_type,pool_id,product_type,fee_seen,created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [investor, type, poolId, poolId === 'IF-P1' ? 'short_term' : 'cattle', feeSeen]);
  }
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _res, next) => { req.user = { id: 'IF-ADM', email: 'a@example.test', role: 'admin' }; next(); },
      requireRole: () => (_req, _res, next) => next(),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', require(path.join(ROOT, 'server', 'routes', 'friction')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 300) }; }
      resolve({ status: res.statusCode, body });
    });
  }).on('error', reject);
});

/* Pull one named function out of admin.js so it can be run for real. */
function sliceFn(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`));
  if (at < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('(', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  i = src.indexOf('{', i); depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* Render the REAL response, plus a doctored copy with a null count, and report
   what came out. */
function renderInBrowser(data) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ifunnel-'));
  const holed = JSON.parse(JSON.stringify(data));
  if (holed.by_pool && holed.by_pool[0]) holed.by_pool[0].fee_shown = null;

  fs.writeFileSync(path.join(tmp, 'stub.js'), `
${(ADMIN.match(/^const _esc = .*$/m) || [])[0]}
${sliceFn(ADMIN, 'renderInvestFunnel')}
const DATA  = ${JSON.stringify(data)};
const HOLED = ${JSON.stringify(holed)};
`);

  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="p1"></div><div id="p2"></div><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));<\/script>
<script src="./stub.js"><\/script>
<script>
const out = { errors: ERRORS };
try { renderInvestFunnel(DATA, document.getElementById('p1')); out.built = 'ok'; }
catch (e) { out.built = 'THREW: ' + e.message; }
try { renderInvestFunnel(HOLED, document.getElementById('p2')); out.holed = 'ok'; }
catch (e) { out.holed = 'THREW: ' + e.message; }

/* The heading div is a sibling of the table. It may hold a span of its own
   ("(top 25 by abandons)"), so it is identified by NOT containing a table
   rather than by having no children — which also excludes the wrapper. */
function tableAfter(root, heading) {
  const h = [...root.querySelectorAll('div')].find(d =>
    (d.textContent || '').trim().startsWith(heading) && !d.querySelector('table'));
  if (!h || !h.parentElement) return null;
  const n = h.parentElement.querySelector('table');
  if (!n) return null;
  return [...n.querySelectorAll('tbody tr')].map(tr =>
    [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()));
}
const p1 = document.getElementById('p1');
out.poolRows     = tableAfter(p1, 'Drop-off by pool');
out.investorRows = tableAfter(p1, 'Drop-off by investor');

const txt = (p1.textContent || '').replace(/\\s+/g, ' ');
out.undef = (txt.match(/undefined/g) || []).length;
out.nan   = (txt.match(/NaN/g) || []).length;
out.nul   = (txt.match(/\\bnull\\b/g) || []).length;
out.trueLiteral = (txt.match(/\\btrue\\b/g) || []).length;

out.holedRows = tableAfter(document.getElementById('p2'), 'Drop-off by pool');
document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;
  fs.writeFileSync(path.join(tmp, 'p.html'), page);

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.join(tmp, 'p.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }

  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  try {
    return JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) { return null; }
}

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    const { status, body: d } = await get(port, '/api/analytics/invest-funnel/summary?days=30');
    console.log('\nthe summary answers');
    ok('a 200', status === 200, `status ${status}: ${JSON.stringify(d).slice(0, 200)}`);
    if (status !== 200) throw new Error('cannot continue');

    console.log('\nthe totals count every event once');
    ok('opened is 5',    d.funnel && d.funnel.opened    === 5, JSON.stringify(d.funnel));
    ok('fee_shown is 3', d.funnel && d.funnel.fee_shown === 3, JSON.stringify(d.funnel));
    ok('confirmed is 2', d.funnel && d.funnel.confirmed === 2, JSON.stringify(d.funnel));
    ok('abandoned is 3', d.funnel && d.funnel.abandoned === 3, JSON.stringify(d.funnel));

    console.log('\nby_pool holds POOLS — this is what the transposition broke');
    {
      const rows = d.by_pool || [];
      const p1 = rows[0] || {};
      ok('two pools, busiest first',
         rows.length === 2 && p1.pool_id === 'IF-P1',
         JSON.stringify(rows.map(r => r.pool_id)));
      ok('a pool row is named from investment_pools, not from an investor',
         p1.pool_name === 'Short Term Investment - March 2026',
         `pool_name was ${JSON.stringify(p1.pool_name)} — a swapped result set has no pool name at all`);
      ok('fee_shown is a number, not null',
         Number.isFinite(p1.fee_shown),
         `fee_shown was ${JSON.stringify(p1.fee_shown)}; parseInt(undefined) is NaN, which serialises as null`);
      ok('and it is the POOL’s fee_shown count',
         p1.fee_shown === 2, String(p1.fee_shown));
      ok('the pool’s own opened/confirmed/abandoned counts',
         p1.opened === 3 && p1.confirmed === 1 && p1.abandoned === 2,
         JSON.stringify({ o: p1.opened, c: p1.confirmed, a: p1.abandoned }));
      ok('the second pool is separate and carries its product type',
         rows[1] && rows[1].pool_id === 'IF-P2' && rows[1].opened === 2 &&
         rows[1].product_type === 'cattle',
         JSON.stringify(rows[1]));
      ok('no by_pool field arrives null',
         rows.every(r => Object.values(r).every(v => v !== null)),
         JSON.stringify(rows));
    }

    console.log('\nby_investor holds INVESTORS');
    {
      const rows = d.by_investor || [];
      const i2 = rows[0] || {};
      ok('only investors who abandoned, most abandons first',
         rows.length === 2 && i2.investor_id === 'IF-I2',
         `${JSON.stringify(rows.map(r => r.investor_id))} — IF-I3 never abandoned`);
      ok('an investor row is named from investors, not from a pool',
         i2.investor_name === 'Bea Bailer' && i2.email === 'bea@example.test',
         `investor_name was ${JSON.stringify(i2.investor_name)}`);
      ok('and carries the KYC status the console colours by',
         i2.kyc_status === 'pending', JSON.stringify(i2.kyc_status));
      ok('the investor’s own counts, which differ from any pool’s',
         i2.opened === 2 && i2.abandoned === 2 && i2.confirmed === 0,
         JSON.stringify({ o: i2.opened, a: i2.abandoned, c: i2.confirmed }));
      ok('abandoned_after_fee is a flag, not a count',
         i2.abandoned_after_fee === true, JSON.stringify(i2.abandoned_after_fee));
      ok('an investor who left before the fee is told apart',
         (rows[1] || {}).investor_id === 'IF-I1' && rows[1].confirmed === 1,
         JSON.stringify(rows[1]));
    }

    console.log('\nand the fee-aversion split matches the flags');
    ok('two of the three abandons happened after the fee was shown',
       d.abandoned_breakdown && d.abandoned_breakdown.fee_seen === 2 &&
       d.abandoned_breakdown.no_fee_seen === 1,
       JSON.stringify(d.abandoned_breakdown));

    if (!CHROME) {
      console.log('\n  SKIP  no headless Chromium — the panel was not rendered');
    } else {
      console.log('\nthe console renders that response');
      const r = renderInBrowser(d);
      ok('the panel reported', !!r, 'the page produced no probe');
      if (r) {
        ok('it builds', r.built === 'ok', r.built);
        ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));
        ok('no undefined, NaN or null reached the screen',
           r.undef === 0 && r.nan === 0 && r.nul === 0,
           JSON.stringify({ undef: r.undef, nan: r.nan, nul: r.nul }));

        const pr = (r.poolRows || [])[0] || [];
        ok('the pool table names the pool',
           pr[0] === 'Short Term Investment - March 2026', JSON.stringify(pr));
        ok('and shows its fee-seen count',
           pr[2] === '2', JSON.stringify(pr));

        const ir = (r.investorRows || [])[0] || [];
        ok('the investor table names the investor',
           ir[0] === 'Bea Bailer', JSON.stringify(ir));
        ok('after-fee reads as a yes/no, not the word "true"',
           /Yes/.test(ir[6] || '') && r.trueLiteral === 0,
           `${JSON.stringify(ir[6])} — abandoned_after_fee is a BOOL_OR`);

        console.log('\nand one bad field costs one cell, not the panel');
        ok('a null count still renders',
           r.holed === 'ok', r.holed);
        ok('as a dash, so it is visibly wrong rather than invisibly fatal',
           ((r.holedRows || [])[0] || [])[2] === '—',
           JSON.stringify((r.holedRows || [])[0]));
      }
    }

    console.log('\nempty and broken read differently');
    {
      ok('the funnel panel names the failure and offers a retry',
         /Could not load the investment funnel/.test(ADMIN) &&
         /onclick="loadInvestFunnel\(\)"/.test(ADMIN));
      ok('the personas panel decides emptiness from the payload, not from a catch',
         /if \(!Number\(data\.total\)\)[\s\S]{0,220}No persona data yet/.test(ADMIN) &&
         /Could not load investor personas/.test(ADMIN),
         'a 500 used to draw "No persona data yet"');
      ok('and so does the signup friction panel',
         /if \(!Number\(data\.total_sessions\)\)[\s\S]{0,220}No friction data yet/.test(ADMIN) &&
         /Could not load the signup friction analysis/.test(ADMIN));
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
