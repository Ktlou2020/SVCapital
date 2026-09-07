#!/usr/bin/env node
/* Looking a transaction up by its reference.
 *
 * A client queries a line on their statement and quotes the reference —
 * FEE-INVST-1785559416599-8SKYA, say. Neither way of searching for it worked.
 *
 *   1. The server's search on /api/tables/transactions fell through to the
 *      catch-all branch, `id::text ILIKE $1`. Reference was never searched.
 *      For a fee raised at investment time that happened to work by accident,
 *      because tables.js writes the same string into id and reference. For a
 *      fee raised anywhere else it did not: manualCredit writes
 *      reference = 'FEE-<random>' onto a row whose id is something else
 *      entirely, so the reference on the client's statement matched no row.
 *      Nor did description, so "1% platform fee on investment" found nothing.
 *
 *   2. The admin console never asked the server at all. It loads the newest
 *      5 000 transactions once and the search box filtered that array. On a
 *      ledger longer than 5 000 rows, every older reference reads as "No
 *      matching transactions" — indistinguishable from a reference that does
 *      not exist. That is the worse half of the bug: it does not look like a
 *      missing feature, it looks like a missing payment.
 *
 * So the two halves are checked separately, and the fixture is built to make
 * the accident in (1) impossible to pass on: the fee row whose reference is
 * looked up has an id that does NOT contain the reference.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-transaction-reference-search.cjs
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
const DB_NAME = 'chk_txnref_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const HTML  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
/* Comments blanked, newlines kept — a negative assertion must not be satisfied
   by the paragraph explaining the fix. */
const CODE = ADMIN.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

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
  /* The teardown drops this database WITH (FORCE); pg reports the termination
     as a pool 'error', and a pool without a listener for one takes the process
     down after every assertion has already passed. */
  pool.on('error', () => {});
}

/* The reference the operator holds. Its row's id is deliberately unrelated —
   this is the manualCredit shape, and it is the one the old id-only search
   could not find. */
const REF        = 'FEE-INVST-1785559416599-8SKYA';
const REF_ROW_ID = 'TXN-unrelated-id-0001';

async function seed() {
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'TR-%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'TR-%'`);
  await pool.query(`
    INSERT INTO investors (id,first_name,last_name,email,status,kyc_status)
    VALUES ('TR-I1','Fee','Payer','fee@example.test','active','verified'),
           ('TR-I2','Other','Client','other@example.test','active','verified')`);

  await pool.query(
    `INSERT INTO transactions (id,investor_id,type,amount,status,reference,description,transaction_date,created_at)
     VALUES
       ($1,'TR-I1','fee',250.00,'completed',$2,'1% platform fee on investment', NOW() - INTERVAL '400 days', NOW() - INTERVAL '400 days'),
       ('TXN-noise-1','TR-I2','deposit',5000.00,'completed','DEP-2026-0001','EFT deposit', NOW(), NOW()),
       ('TXN-noise-2','TR-I2','fee',50.00,'completed','FEE-OTHER-9999','1% platform fee on investment', NOW(), NOW())`,
    [REF_ROW_ID, REF]);
}

let CURRENT_USER = { id: 'TR-ADM', email: 'a@example.test', role: 'admin' };

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
  app.use('/api/tables', require(path.join(ROOT, 'server', 'routes', 'tables')));
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

const enc = s => encodeURIComponent(s);

/* Lifts the console's three search functions into a sandbox and wires them to
   the live server above. The loaded page holds the two noise rows and NOT the
   fee whose reference is being looked for — which is the production shape:
   5 000 recent rows in the browser, the row you want older than all of them. */
async function liftTxnSearch(port) {
  const names = ['_txnSearchPool', 'applyTxnFilters', 'searchTxnLedger'];
  let src = '';
  for (const n of names) {
    /* Substring, not regex: escaping a literal '(' from a JS string into a
       RegExp is a step this file does not need. */
    /* async first — searching for 'function foo(' inside 'async function foo('
       matches at the wrong offset and lifts the body without its async, which
       then fails to parse on its own await. */
    let at = ADMIN.indexOf('async function ' + n + '(');
    if (at < 0) at = ADMIN.indexOf('function ' + n + '(');
    if (at < 0) return null;
    const end = ADMIN.indexOf('\n}\n', at);
    if (end < 0) return null;
    src += ADMIN.slice(at, end + 3) + '\n';
  }

  const calls = [];
  let inflight = [];
  let query = '';
  const loaded = [
    { id: 'TXN-noise-1', investor_id: 'TR-I2', type: 'deposit', amount: '5000.00', status: 'completed',
      reference: 'DEP-2026-0001', description: 'EFT deposit', created_at: new Date().toISOString() },
    { id: 'TXN-noise-2', investor_id: 'TR-I2', type: 'fee', amount: '50.00', status: 'completed',
      reference: 'FEE-OTHER-9999', description: '1% platform fee on investment', created_at: new Date().toISOString() },
  ];

  const inputs = {
    txnSearch:       { value: '' },
    txnTypeFilter:   { value: '' },
    txnStatusFilter: { value: '' },
    txnDateFrom:     { value: '' },
    txnDateTo:       { value: '' },
  };

  const ctx = vm.createContext({
    console,
    STATE: { transactions: loaded, investors: [] },
    selectedTxns: new Set(),
    filteredTxns: [],
    txnPage: 1,
    txnRemoteHits: [],
    _txnRemoteQ: '',
    _txnRemoteState: '',
    _txnInvName: t => t.investor_id || '—',
    renderTxnTable: () => {},
    Toast: { error: () => {} },
    document: { getElementById: id => inputs[id] || null },
    API: {
      _fetch: (method, url, body, params) => {
        calls.push({ method, url, search: params.search, limit: params.limit });
        const p = get(port, `/api/${url}?search=${enc(params.search)}&limit=${params.limit}`)
          .then(r => r.body);
        inflight.push(p.catch(() => {}));
        return p;
      },
    },
  });
  /* var, not let: the lifted functions assign to these names, and the check
     reads the results back off the context afterwards. */
  vm.runInContext('var filteredTxns = [], txnRemoteHits = [], _txnRemoteQ = "", _txnRemoteState = "", txnPage = 1;\n' + src, ctx);
  ctx.applyTxnFilters   = vm.runInContext('applyTxnFilters', ctx);
  ctx.searchTxnLedger   = vm.runInContext('searchTxnLedger', ctx);
  ctx._txnSearchPool    = vm.runInContext('_txnSearchPool', ctx);

  return {
    ctx, calls,
    setQuery(q) { query = q; inputs.txnSearch.value = q; },
    async settle() {
      /* Two drains: the fetch resolves, applyTxnFilters re-runs, and only then
         is filteredTxns the answer. */
      for (let i = 0; i < 4; i++) { await Promise.all(inflight); inflight = []; await new Promise(r => setImmediate(r)); }
      void query;
    },
  };
}

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    console.log('\nthe server finds a transaction by its reference');
    {
      const r = await get(port, `/api/tables/transactions?search=${enc(REF)}`);
      const rows = (r.body && r.body.data) || [];
      ok('the fee reference returns exactly its row',
         r.status === 200 && rows.length === 1 && rows[0].id === REF_ROW_ID,
         `status ${r.status}, ${rows.length} row(s): ${JSON.stringify(rows.map(x => x.id))}`);
      ok('and the row carries the reference that was searched for',
         rows[0] && rows[0].reference === REF, JSON.stringify(rows[0] && rows[0].reference));
      ok('even though its id does not contain that reference',
         !REF_ROW_ID.includes(REF),
         'the fixture must not let an id-only search pass by coincidence');
    }

    {
      /* Partial: the operator retypes the investment id without the FEE- prefix. */
      const r = await get(port, `/api/tables/transactions?search=${enc('INVST-1785559416599')}`);
      const rows = (r.body && r.body.data) || [];
      ok('a partial reference finds it too',
         rows.some(x => x.id === REF_ROW_ID), JSON.stringify(rows.map(x => x.reference)));
    }

    {
      const r = await get(port, `/api/tables/transactions?search=${enc('1% platform fee')}`);
      const rows = (r.body && r.body.data) || [];
      ok('description is searchable — two fees, both returned',
         rows.length === 2, JSON.stringify(rows.map(x => x.reference)));
    }

    {
      const r = await get(port, `/api/tables/transactions?search=${enc(REF_ROW_ID)}`);
      const rows = (r.body && r.body.data) || [];
      ok('the id still works, so nothing that used to be findable stopped being',
         rows.length === 1 && rows[0].id === REF_ROW_ID, JSON.stringify(rows.map(x => x.id)));
    }

    {
      const r = await get(port, `/api/tables/transactions?search=${enc('TR-I2')}`);
      const rows = (r.body && r.body.data) || [];
      ok('an investor id returns that investor\'s rows only',
         rows.length === 2 && rows.every(x => x.investor_id === 'TR-I2'),
         JSON.stringify(rows.map(x => [x.id, x.investor_id])));
    }

    {
      const r = await get(port, `/api/tables/transactions?search=${enc('NOTHING-LIKE-THIS')}`);
      const rows = (r.body && r.body.data) || [];
      ok('a reference that does not exist returns nothing, not everything',
         r.status === 200 && rows.length === 0, `${rows.length} row(s)`);
    }

    {
      /* The search must compose with the other filters rather than replace
         them — an operator narrows by type and then pastes a reference. */
      const r = await get(port, `/api/tables/transactions?search=${enc('1% platform fee')}&type=fee`);
      const d = await get(port, `/api/tables/transactions?search=${enc('1% platform fee')}&type=deposit`);
      ok('search ANDs with the type filter',
         ((r.body && r.body.data) || []).length === 2 &&
         ((d.body && d.body.data) || []).length === 0,
         `fee ${((r.body||{}).data||[]).length}, deposit ${((d.body||{}).data||[]).length}`);
    }

    console.log('\ninvestments are searchable by the same strings');
    {
      const r = await get(port, `/api/tables/investments?search=${enc('INVST-1785559416599')}`);
      ok('the investments table accepts a search without erroring',
         r.status === 200, `status ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }

    console.log('\nan investor cannot search their way into someone else\'s ledger');
    {
      CURRENT_USER = { id: 'TR-U2', email: 'other@example.test', role: 'investor', investorId: 'TR-I2' };
      const r = await get(port, `/api/tables/transactions?search=${enc(REF)}`);
      const rows = (r.body && r.body.data) || [];
      ok('the row-level scope still applies to a search hit',
         rows.length === 0, JSON.stringify(rows.map(x => [x.id, x.investor_id])));
      CURRENT_USER = { id: 'TR-ADM', email: 'a@example.test', role: 'admin' };
    }

    console.log('\nthe console asks the server when its loaded page has no answer');
    {
      ok('there is a ledger lookup at all',
         /function\s+searchTxnLedger\s*\(/.test(CODE),
         'the search box filtered STATE.transactions and nothing else');
      ok('it goes to the transactions table with the typed query',
         /searchTxnLedger[\s\S]{0,600}tables\/transactions[\s\S]{0,120}search:\s*q/.test(CODE));
      ok('the filter is a named function the lookup can re-run',
         /function\s+applyTxnFilters\s*\(/.test(CODE) &&
         /searchTxnLedger[\s\S]{0,900}applyTxnFilters\(\s*\{\s*noRemote:\s*true\s*\}\s*\)/.test(CODE),
         'otherwise the fetched rows land with nothing to render them');
      ok('the re-run does not fetch again — no request-per-render loop',
         /if\s*\(!opts\s*\|\|\s*!opts\.noRemote\)/.test(CODE));
      ok('it only fires when the loaded page came up empty',
         /!filteredTxns\.length\s*&&\s*_txnRemoteQ\s*!==\s*q/.test(CODE),
         'a round trip per keystroke for a row already on screen');
      ok('and only for a query long enough to mean something',
         /q\.length\s*>=\s*3\s*&&\s*!filteredTxns\.length/.test(CODE));
      ok('a stale response cannot overwrite a newer query',
         (CODE.match(/if\s*\(_txnRemoteQ\s*!==\s*q\)\s*return;/g) || []).length >= 2,
         'both the success and the failure path must check');
    }

    {
      ok('remote hits are searched, not counted',
         /function\s+_txnSearchPool\s*\(/.test(CODE) &&
         /_txnSearchPool\(\)\.filter/.test(CODE),
         'the pool the filter reads must include them');
      ok('STATE.transactions is left alone',
         !/STATE\.transactions\s*=\s*STATE\.transactions\.concat/.test(CODE) &&
         !/STATE\.transactions\.push\(\s*\.\.\.txnRemoteHits/.test(CODE),
         'folding old rows in would move the dashboard tiles and queue counts');
      ok('a hit is de-duplicated against the loaded page',
         /_txnSearchPool[\s\S]{0,400}new Set\(STATE\.transactions\.map/.test(CODE));
      ok('clearing the box clears the remote hits',
         /if\s*\(!q\)\s*\{\s*txnRemoteHits\s*=\s*\[\]/.test(CODE));
    }

    {
      ok('the id is searchable in the box, not only the reference',
         /\$\{t\.reference[^}]*\}[^`]*\$\{t\.description[^}]*\}[^`]*\$\{t\.id[^}]*\}/.test(CODE),
         'other fee paths put the reference and the id on different strings');
      ok('"nothing on this page" and "nothing on record" read differently',
         /No such transaction/.test(ADMIN) && /Searching the full ledger/.test(ADMIN) &&
         /No matching transactions/.test(ADMIN),
         'a missing feature must not look like a missing payment');
      ok('a row from beyond the loaded page says so in the footer',
         /found in the full ledger, beyond the loaded page/.test(ADMIN));
      ok('a failed lookup is reported, not swallowed',
         /Could not search the full ledger/.test(ADMIN));
    }

    {
      ok('the global palette offers the ledger lookup',
         /Search the full ledger for/.test(ADMIN),
         'the palette sees only loaded rows, so it must hand off to the box');
      ok('and the palette matches on id as well as reference',
         /\(t\.reference\|\|''\)\.toLowerCase\(\)\.includes\(q\)\s*\|\|\s*\(t\.id\|\|''\)\.toLowerCase\(\)\.includes\(q\)/.test(CODE));
      ok('the ledger row uses the one canonical purple',
         !/Search the full ledger[\s\S]{0,400}#(?!eda5ff)[0-9a-fA-F]{6}/.test(ADMIN) ||
         /color:\s*'#eda5ff'[\s\S]{0,200}Search the full ledger/.test(ADMIN));
    }

    /* Reading the source only proves the lines are there. The bug was
       behavioural — a search that returned nothing for a row that exists — so
       the console's own search functions are lifted out and run against the
       server that is already up, with the loaded page deliberately holding
       everything EXCEPT the row being looked for. */
    console.log('\nand run for real, the box finds a row it never loaded');
    {
      const S = await liftTxnSearch(port);
      if (!S) {
        ok('the search functions could be lifted and run', false, 'lift failed');
      } else {
        ok('the search functions are runnable', typeof S.ctx.applyTxnFilters === 'function');

        S.setQuery('DEP-2026-0001');
        S.ctx.applyTxnFilters();
        ok('a reference on the loaded page is found without a round trip',
           S.ctx.filteredTxns.length === 1 && S.ctx.filteredTxns[0].id === 'TXN-noise-1' &&
           S.calls.length === 0,
           `${S.ctx.filteredTxns.length} row(s), ${S.calls.length} request(s)`);

        S.setQuery(REF);
        S.ctx.applyTxnFilters();
        /* The box lowercases before sending; the server matches with ILIKE, so
           that is fine — but it is only fine because the server is
           case-insensitive, which the next assertion is what proves. */
        ok('a reference that is NOT on the loaded page sends one request',
           S.calls.length === 1 && String(S.calls[0].search).toLowerCase() === REF.toLowerCase(),
           JSON.stringify(S.calls));
        await S.settle();
        ok('and the row comes back and renders',
           S.ctx.filteredTxns.length === 1 && S.ctx.filteredTxns[0].id === REF_ROW_ID,
           JSON.stringify(S.ctx.filteredTxns.map(t => t.id)));
        ok('without being added to STATE.transactions',
           !S.ctx.STATE.transactions.some(t => t.id === REF_ROW_ID),
           'the dashboard tiles count that array');

        const before = S.calls.length;
        S.ctx.applyTxnFilters();
        ok('re-filtering the same query does not fetch again',
           S.calls.length === before, `${S.calls.length - before} extra request(s)`);

        S.setQuery('1% platform fee');
        S.ctx.applyTxnFilters();
        await S.settle();
        ok('a description search de-duplicates the row already loaded',
           S.ctx.filteredTxns.length === 2 &&
           new Set(S.ctx.filteredTxns.map(t => t.id)).size === 2,
           JSON.stringify(S.ctx.filteredTxns.map(t => t.id)));

        S.setQuery('NOTHING-LIKE-THIS');
        S.ctx.applyTxnFilters();
        await S.settle();
        ok('a reference that exists nowhere ends as "searched, not found"',
           S.ctx.filteredTxns.length === 0 && S.ctx._txnRemoteState === 'done',
           `${S.ctx.filteredTxns.length} row(s), state ${S.ctx._txnRemoteState}`);

        S.setQuery('');
        S.ctx.applyTxnFilters();
        ok('clearing the box drops the remote rows again',
           S.ctx.txnRemoteHits.length === 0 &&
           S.ctx.filteredTxns.length === S.ctx.STATE.transactions.length,
           `${S.ctx.txnRemoteHits.length} held, ${S.ctx.filteredTxns.length} shown`);
      }
    }

    {
      ok('the search box says what it searches',
         /id="txnSearch"/.test(HTML) && /full ledger/.test(HTML.split('id="txnSearch"')[0].slice(-260)),
         'the placeholder still promised only investor and reference');
      const m = HTML.match(/js\/admin\.js\?v=(\d+)/);
      ok('admin.js is cache-busted past 166', m && Number(m[1]) > 166,
         m ? `v=${m[1]}` : 'no version query string');
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
