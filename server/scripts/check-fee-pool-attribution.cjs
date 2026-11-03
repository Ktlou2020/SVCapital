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
const { nbsp } = require('../../scripts/lib/rendered.cjs');

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

    /* ── Fees by pool ───────────────────────────────────────────────── */
    console.log('\nand the by-pool summary adds up to the figure beside it');
    {
      /* A second pool with its own fee, and a fee belonging to no pool, so
         the grouping has something to get wrong. */
      await pool.query(`
        INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months,
            start_date, end_date, min_investment)
        VALUES ('FPP-CATTLE','Cattle — November 2026','cattle','open',0.16,12,
                CURRENT_DATE - 5, CURRENT_DATE + 40, 100)`);
      await pool.query(`
        INSERT INTO investments (id, investor_id, pool_id, pool_name, amount, status,
            start_date, end_date, annual_rate, term_months, product_type)
        VALUES ('INVST-FP-CAT','FP-1','FPP-CATTLE','Cattle — November 2026', 4000,'active',
                CURRENT_DATE - 2, CURRENT_DATE + 360, 0.16, 12, 'cattle')`);
      await pool.query(`
        INSERT INTO transactions (id, investor_id, type, amount, status, reference, description,
            investment_id, pool_id)
        VALUES ('FEE-INVST-FP-CAT','FP-1','fee', 40,'completed','FEE-INVST-FP-CAT',
                '1% platform fee on investment','INVST-FP-CAT','FPP-CATTLE')`);

      const r = await call(port, 'GET', '/api/analytics/platform-fees?period=all');
      const byPool  = (r.body && r.body.by_pool) || [];
      const headline = r.body && r.body.summary && r.body.summary.total;
      const find = id => byPool.find(x => x.pool_id === id);

      ok('every pool that was charged a fee appears',
         !!find('FPP-SOLAR') && !!find('FPP-CATTLE'), JSON.stringify(byPool));
      ok('a pool groups ALL of its fees into one row',
         find('FPP-SOLAR') && find('FPP-SOLAR').count === 3,
         'three solar fees were written — ' + JSON.stringify(find('FPP-SOLAR')));
      /* R10 on the R1 000 placement, R20 on the legacy one, and R14,85 on
         the fee_inclusive R1 500 — inclusive means the 1% comes OUT of the
         1 500 rather than on top, so the pool takes R1 485,15 and the fee
         is 1% of that. Worth stating: the first draft of this assertion
         expected R15 and the product was right. */
      ok('and totals them',
         find('FPP-SOLAR') && Math.abs(find('FPP-SOLAR').total - 44.85) < 0.005,
         JSON.stringify(find('FPP-SOLAR')));
      ok('it carries the product, so the table can name it',
         find('FPP-CATTLE') && find('FPP-CATTLE').product_type === 'cattle',
         JSON.stringify(find('FPP-CATTLE')));

      const orphan = byPool.find(x => x.pool_id === null);
      ok('fees charged to no pool are a row, not a row dropped',
         !!orphan && orphan.count >= 1,
         'dropping them is how the column stops adding up — ' + JSON.stringify(byPool));
      ok('and that row carries no pool name to invent one from',
         orphan && orphan.pool_name === null, JSON.stringify(orphan));

      const summed = byPool.reduce((a, x) => a + x.total, 0);
      ok('the rows tie out to the headline total exactly',
         Math.abs(summed - headline) < 0.005,
         `grouped ${summed} vs headline ${headline} — a reconciliation view that ` +
         `does not tie is not one`);

      ok('the biggest pool comes first',
         byPool.length > 1 && byPool[0].total >= byPool[1].total, JSON.stringify(byPool));
    }

    /* ── The screen ─────────────────────────────────────────────────── */
    console.log('\nand the table reads as money leaving, with the blank explained');
    {
      const ADMIN = read('admin/js/admin.js');
      const box = {};
      const s = { console, Math, Number, String, JSON, Object, Array, Boolean, Date,
                  parseFloat, parseInt, isNaN, RegExp, Set, Map, Error,
                  localStorage: { getItem: () => null, setItem() {} },
                  navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
                  document: {
                    addEventListener() {},
                    getElementById: id => (box[id] = box[id] || { innerHTML: '', style: {},
                      textContent: '', classList: { add() {}, remove() {} } }),
                  },
                  _esc: v => String(v == null ? '' : v)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;') };
      s.globalThis = s; s.window = s; s.self = s;
      vm.createContext(s);
      /* js/api.js for the real Utils.rand and Utils.productInfo — the money
         format and the product label are both things this table prints. */
      vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
      /* The shipped functions, lifted and run — a copy of the rule here would
         keep agreeing with itself after the real one changed. */
      const from = ADMIN.indexOf('function _pfRenderByPool');
      const to   = ADMIN.indexOf('function _pfRenderTable');
      ok('both renderers were found to lift', from > 0 && to > from,
         'a slice that misses them would test nothing while passing');
      vm.runInContext(ADMIN.slice(from, to), s);

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

      /* The by-pool table, rendered. The figures are the server's; what is
         asserted here is that the table SAYS whether they tie out, because
         a reconciliation view that is quietly short is worse than one that
         admits it. */
      const ROWS = [
        { pool_id: 'P-A', pool_name: 'Solar — November 2026', product_type: 'solar', count: 3, total: 75 },
        /* The name deliberately does NOT contain the word the product label
           uses. The first version of the assertion below matched "Cattle"
           and passed against the pool NAME with the product column empty. */
        { pool_id: 'P-B', pool_name: 'Herd <b>2026</b>',      product_type: 'cattle', count: 1, total: 20 },
        { pool_id: null,  pool_name: null,                    product_type: null,     count: 2, total: 5 },
      ];
      s._pfRenderByPool(ROWS, 100);
      const poolHtml = nbsp(box.pfPoolBody.innerHTML);
      const poolFoot = nbsp(box.pfPoolFoot.innerHTML);

      ok('each pool is a row with its total',
         /Solar/.test(poolHtml) && /R 75,00/.test(poolHtml), poolHtml.slice(0, 300));
      ok('the product is named, not printed as its enum',
         /Cattle Investment/.test(poolHtml) && !/>cattle</.test(poolHtml),
         poolHtml.slice(0, 900));
      ok('the group with no pool says so rather than showing blank',
         /Not charged to a pool/.test(poolHtml));
      ok('a pool name is escaped before it reaches the page',
         !/<b>2026<\/b>/.test(poolHtml) && /&lt;b&gt;2026/.test(poolHtml),
         'a pool is named in the admin console by a person');
      ok('each row carries its share of the period',
         /75\.0%/.test(poolHtml) && /20\.0%/.test(poolHtml) && /5\.0%/.test(poolHtml),
         poolHtml.slice(0, 900));
      ok('the footer totals the column',
         /R 100,00/.test(poolFoot), poolFoot);
      ok('and says it ties to the headline figure',
         /ties to the total above/.test(poolFoot), poolFoot);

      /* The half that matters more. If the grouping ever drifts from the
         headline, the table has to SAY so — silently printing a short total
         beside a correct one is the failure this panel exists to prevent. */
      s._pfRenderByPool(ROWS, 140);
      const shortFoot = nbsp(box.pfPoolFoot.innerHTML);
      ok('a total that does not tie is called out, not printed quietly',
         /does not tie/.test(shortFoot) && /R 140,00/.test(shortFoot), shortFoot);

      s._pfRenderByPool([], 0);
      ok('and no fees at all is an empty state, not a broken table',
         /No fees in this period/.test(nbsp(box.pfPoolBody.innerHTML)),
         box.pfPoolBody.innerHTML.slice(0, 200));

      /* And that the report actually calls it. Lifting the renderer tests
         what it draws; nothing tested that anything draws it, and the
         mutation that deleted the call went unnoticed. */
      const stripC = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const render = stripC(ADMIN.slice(ADMIN.indexOf('function _pfRender(data'),
                                        ADMIN.indexOf('function _pfRenderByPool')));
      ok('the report renders the by-pool panel from the server’s own figures',
         /_pfRenderByPool\(data\.by_pool[^)]*,\s*s\.total/.test(render),
         'summing the transactions array instead would be capped at 500 rows — ' + render.slice(-300));

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
