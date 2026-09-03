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
const DB_NAME = 'chk_ifunnel_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
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

/* Two pools and three investors, arranged so that the per-pool counts and the
   per-investor counts are DIFFERENT numbers in DIFFERENT orders. If the two
   result sets are transposed, no assertion below can pass by luck.

     by pool      opened  fee_shown  confirmed  abandoned   (order: opened desc)
       IF-P1        5         2          1          3
       IF-P2        2         1          1          1

     by investor  opened  abandoned  confirmed  after_fee   (order: abandoned desc)
       IF-I2        2         2          0        true
       IF-I3        3         1          1        false   ← two of these arrive
       IF-I1        2         1          1        true      under a users uuid

   IF-I3's events are split across both id shapes on purpose. Until the
   investorId fix, POST /invest-funnel filed every event under req.user.id —
   the USERS row's uuid — because it read the claim as `investor_id` while
   signToken writes `investorId`. The summary therefore has to resolve through
   users, and fold an investor's events together across both shapes, or the
   console shows a column of uuids where the clients' names belong.

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

/* IF-I3's user account. Events written before the fix carry THIS id. */
const LEGACY_UUID = '11111111-2222-3333-4444-555555555555';
const LEGACY_EVENTS = [
  [LEGACY_UUID, 'IF-P1', 'modal_opened', null],
  [LEGACY_UUID, 'IF-P1', 'modal_opened', null],
  [LEGACY_UUID, 'IF-P1', 'abandoned',    false],
];

async function seed() {
  await pool.query(`DELETE FROM invest_funnel_events`);
  await pool.query(`DELETE FROM users            WHERE investor_id LIKE 'IF-%'`);
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

  /* Cal's login. users.investor_id is the bridge from the uuid the old events
     were filed under back to the account number. */
  await pool.query(
    `INSERT INTO users (id,email,password_hash,role,first_name,last_name,investor_id)
     VALUES ($1,'cal@example.test','x','investor','Cal','Committer','IF-I3')`,
    [LEGACY_UUID]);

  for (const [investor, poolId, type, feeSeen] of [...EVENTS, ...LEGACY_EVENTS]) {
    await pool.query(
      `INSERT INTO invest_funnel_events (investor_id,event_type,pool_id,product_type,fee_seen,created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [investor, type, poolId, poolId === 'IF-P1' ? 'short_term' : 'cattle', feeSeen]);
  }
}

/* Whoever the next request is from. signToken's payload shape matters here:
   it writes `investorId`, and the bug was reading `investor_id`. */
let CURRENT_USER = { id: 'IF-ADM', email: 'a@example.test', role: 'admin' };

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

const post = (port, url, payload) => new Promise((resolve, reject) => {
  const data = JSON.stringify(payload);
  const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => {
      let body; try { body = JSON.parse(b); } catch (_) { body = { _raw: b.slice(0, 300) }; }
      resolve({ status: res.statusCode, body });
    });
  });
  req.on('error', reject); req.write(data); req.end();
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
    ok('opened is 7',    d.funnel && d.funnel.opened    === 7, JSON.stringify(d.funnel));
    ok('fee_shown is 3', d.funnel && d.funnel.fee_shown === 3, JSON.stringify(d.funnel));
    ok('confirmed is 2', d.funnel && d.funnel.confirmed === 2, JSON.stringify(d.funnel));
    ok('abandoned is 4', d.funnel && d.funnel.abandoned === 4, JSON.stringify(d.funnel));

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
         p1.opened === 5 && p1.confirmed === 1 && p1.abandoned === 3,
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
         rows.length === 3 && i2.investor_id === 'IF-I2',
         JSON.stringify(rows.map(r => r.investor_id)));
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
         (rows[2] || {}).investor_id === 'IF-I1' && rows[2].confirmed === 1,
         JSON.stringify(rows[2]));

      /* The column the console was showing uuids in. */
      const cal = rows[1] || {};
      ok('an event filed under the users uuid still finds the investor',
         cal.investor_name === 'Cal Committer',
         `${JSON.stringify(cal.investor_id)} / ${JSON.stringify(cal.investor_name)} — resolved through users.investor_id`);
      ok('and reports the ACCOUNT NUMBER, not the login id',
         cal.investor_id === 'IF-I3',
         `investors.id is what the statement prints as "Account Number"; got ${JSON.stringify(cal.investor_id)}`);
      ok('events under both id shapes fold into one investor',
         cal.opened === 3 && cal.abandoned === 1 && cal.confirmed === 1,
         `${JSON.stringify({ o: cal.opened, a: cal.abandoned, c: cal.confirmed })} — 2 legacy opens + 1 direct`);
      ok('no row reports a raw uuid as an account number',
         rows.every(r => !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(r.investor_id))),
         JSON.stringify(rows.map(r => r.investor_id)));
    }

    console.log('\nand new events are filed under the account number');
    {
      /* The cause. signToken writes the claim as `investorId`; this route read
         `investor_id`, found nothing, and fell through to req.user.id. */
      CURRENT_USER = { id: LEGACY_UUID, email: 'cal@example.test', role: 'investor',
                       investorId: 'IF-I3' };
      const r = await post(port, '/api/analytics/invest-funnel',
                           { event_type: 'modal_opened', pool_id: 'IF-P2', product_type: 'cattle' });
      ok('the event is recorded', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
      const { rows: back } = await pool.query(
        `SELECT investor_id FROM invest_funnel_events
         WHERE pool_id = 'IF-P2' AND event_type = 'modal_opened'
         ORDER BY created_at DESC LIMIT 1`);
      ok('under the investor id from the token, not the users uuid',
         back[0] && back[0].investor_id === 'IF-I3',
         `stored ${JSON.stringify(back[0] && back[0].investor_id)} — reading req.user.investor_id finds nothing and falls through to req.user.id`);
      CURRENT_USER = { id: 'IF-ADM', email: 'a@example.test', role: 'admin' };
    }

    console.log('\nand the fee-aversion split matches the flags');
    ok('two of the four abandons happened after the fee was shown',
       d.abandoned_breakdown && d.abandoned_breakdown.fee_seen === 2 &&
       d.abandoned_breakdown.no_fee_seen === 2,
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
        ok('and shows the account number beside the name',
           ir[1] === 'IF-I2',
           `${JSON.stringify(ir[1])} — the column read a uuid before the id was resolved`);
        ok('after-fee reads as a yes/no, not the word "true"',
           /Yes/.test(ir[7] || '') && r.trueLiteral === 0,
           `${JSON.stringify(ir[7])} — abandoned_after_fee is a BOOL_OR`);
        ok('the legacy-uuid investor renders as a name, not an id',
           ((r.investorRows || [])[1] || [])[0] === 'Cal Committer',
           JSON.stringify((r.investorRows || [])[1]));

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
