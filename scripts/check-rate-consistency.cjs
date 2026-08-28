#!/usr/bin/env node
/* Every place a rate or a return is shown must agree.

   The bug this guards: returns are posted by setting the *pool's* actual_rate,
   and are deliberately not written back onto the investment row. So an
   investment whose return has been posted still carries annual_rate 0 — and
   Postgres hands that back as the string "0.0000", which is truthy. Any site
   written as `rate ? pct(rate) : '—'` therefore renders a confident 0.00%.

   The admin investments list showed exactly that while the pool view beside it
   showed the real 2.13% for the same investment.

   Two halves to check:
     1. Utils.effectiveRate resolves the right figure (behavioural).
     2. No render site still reads annual_rate raw (structural) — a correct
        helper nobody calls fixes nothing.

   Run: node scripts/check-rate-consistency.cjs
*/
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ── Load Utils out of the shared api.js ───────────────────────────── */
const apiSrc = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const sandbox = {
  window: {}, document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  console, fetch: () => Promise.reject(new Error('no network')), setInterval: () => 0, clearInterval() {},
  setTimeout: () => 0, clearTimeout() {}, navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(apiSrc, sandbox, { filename: 'js/api.js' }); }
catch (e) { console.error('Could not evaluate js/api.js:', e.message); process.exit(1); }

// api.js declares `const Utils = {...}` at top level. In a classic script that
// is a lexical binding on the context, not a property of globalThis — so
// sandbox.Utils is undefined and it has to be read back by evaluation.
const Utils = sandbox.Utils || vm.runInContext('typeof Utils !== "undefined" ? Utils : null', sandbox);
if (!Utils || typeof Utils.effectiveRate !== 'function') {
  console.error('Utils.effectiveRate is missing from js/api.js');
  process.exit(1);
}

/* ── 0. Precedence: a posted return outranks the contracted target ─── */
console.log('\nrateBasis — which of the three figures wins');

// payoutInvestment writes actual_return and never touches annual_rate, so
// annual_rate is a target for the whole life of the investment. The pool card
// has always said "Achieved" once a rate is posted; the investments list
// showed the contracted 13.00% for the same investment.
const CONTRACTED_ONLY = { amount: '5000.00', annual_rate: '0.1300' };
const POOL_POSTED     = { amount: '5000.00', annual_rate: '0.1300', pool_actual_rate: '0.0213' };
const PAID_OUT        = { amount: '5000.00', annual_rate: '0.1300', pool_actual_rate: '0.0213', actual_return: '400.00' };

ok('a contracted rate with nothing posted is a TARGET',
   (() => { const b = Utils.rateBasis(CONTRACTED_ONLY); return b && b.rate === 0.13 && b.posted === false; })(),
   JSON.stringify(Utils.rateBasis(CONTRACTED_ONLY)));

ok('a posted pool return beats the contracted rate, and is marked posted',
   (() => { const b = Utils.rateBasis(POOL_POSTED); return b && b.rate === 0.0213 && b.posted === true; })(),
   `got ${JSON.stringify(Utils.rateBasis(POOL_POSTED))} — the list showed 13.00% while the pool said Achieved`);

ok('this investment\'s own realised return beats even the pool figure',
   (() => { const b = Utils.rateBasis(PAID_OUT); return b && Math.abs(b.rate - 0.08) < 1e-9 && b.posted === true; })(),
   JSON.stringify(Utils.rateBasis(PAID_OUT)));

eq('nothing anywhere is null', Utils.rateBasis({ amount: '1000', annual_rate: '0.0000' }), null);
eq('rateBasis(null) does not throw', Utils.rateBasis(null), null);

// The whole point of the change: pool and list must agree about one investment.
{
  const poolRow = { pool_actual_rate: '0.0213', annual_rate: '0.1300' };   // the pool card's input
  const invRow  = POOL_POSTED;                                             // the list's input
  const a = Utils.rateBasis(poolRow), b = Utils.rateBasis(invRow);
  ok('the pool card and the investments list report the same rate',
     a && b && a.rate === b.rate && a.posted === b.posted,
     `pool ${JSON.stringify(a)} vs list ${JSON.stringify(b)}`);
}

console.log('\nrateCell — how it renders');
ok('a posted return is tinted with the brand purple and says so',
   /#eda5ff/.test(Utils.rateCell(POOL_POSTED)) && /Return achieved/.test(Utils.rateCell(POOL_POSTED)),
   Utils.rateCell(POOL_POSTED));
ok('a target is green and labelled as a target',
   /#22c55e/.test(Utils.rateCell(CONTRACTED_ONLY)) && /Target return/.test(Utils.rateCell(CONTRACTED_ONLY)),
   Utils.rateCell(CONTRACTED_ONLY));
ok('nothing at all renders a dash', /—/.test(Utils.rateCell({ amount: '1', annual_rate: '0.0000' })));

/* ── A rate must be labelled as the kind of rate it is ────────────────
   investment_pools.actual_rate is the return achieved FOR THE POOL'S PERIOD,
   for every product — not per annum and not prorated over term_months. The
   contracted annual_rate is an annual figure. The investment detail appended
   "p.a." to both, so a confirmed 2.13% five-month return was presented as an
   annual one — understating it by more than half to anyone reading the modal. */
/* Guarded first. Without this the whole file dies on a TypeError when the
   helper is absent, printing a stack trace and no failures at all — which
   reads like a pass to anything counting ✗ lines. */
ok('Utils.rateLabel exists', typeof Utils.rateLabel === 'function',
   'the rate label helper is missing — nothing below can be checked');
ok('Utils.rateSuffix exists', typeof Utils.rateSuffix === 'function');
if (typeof Utils.rateLabel !== 'function') {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

ok('a posted period return is not labelled per annum',
   !/p\.a\./.test(Utils.rateLabel({ amount: 10000, pool_actual_rate: 0.0213, annual_rate: 0 })),
   Utils.rateLabel({ amount: 10000, pool_actual_rate: 0.0213, annual_rate: 0 }));
ok('it says what period it covers instead',
   /2\.13% for the period/.test(Utils.rateLabel({ amount: 10000, pool_actual_rate: 0.0213, annual_rate: 0 })),
   Utils.rateLabel({ amount: 10000, pool_actual_rate: 0.0213, annual_rate: 0 }));
ok('a contracted rate keeps its per annum qualifier',
   /14\.00% p\.a\./.test(Utils.rateLabel({ amount: 10000, annual_rate: 0.14 })),
   Utils.rateLabel({ amount: 10000, annual_rate: 0.14 }));
ok('an investment\'s own realised return is a period figure too',
   !/p\.a\./.test(Utils.rateLabel({ amount: 10000, actual_return: 213 })),
   Utils.rateLabel({ amount: 10000, actual_return: 213 }));
ok('no rate at all is a dash, not a bare qualifier',
   Utils.rateLabel({ amount: 1000 }) === '—', Utils.rateLabel({ amount: 1000 }));
ok('a posted rate is not annualised into a number nobody chose',
   Utils.rateLabel({ amount: 10000, pool_actual_rate: 0.0213 }).startsWith('2.13%'),
   'annualising needs a day count and a convention — a wrong precise figure is worse than an honest one');

{
  const adm = require('fs').readFileSync(require('path').join(__dirname, '..', 'admin', 'js', 'admin.js'), 'utf8');
  ok('the investment detail uses the shared label',
     /Return Rate<\/span><span class="info-row__value">\$\{Utils\.rateLabel\(inv\)\}/.test(adm));
  ok('and no longer appends p.a. to whatever it was given',
     !/Utils\.pct\(_invRate\) \+ ' p\.a\.'/.test(adm));
}
ok('the only purple used is the canonical #eda5ff',
   !/#(?!eda5ff)[0-9a-f]*(?:[89ab][0-9a-f]{2}ff|purple)/i.test(Utils.rateCell(POOL_POSTED)));

/* ── 1. effectiveRate ──────────────────────────────────────────────── */
console.log('\neffectiveRate — the figure to show');

// Jacenter S-1105: R24,744.77 in Short Term March 2026. The investment carries
// no rate of its own; the pool has 2.13% posted. The list showed 0.00%.
eq('posted pool rate wins when the investment carries "0.0000"',
   Utils.effectiveRate({ amount: '24744.77', annual_rate: '0.0000', pool_actual_rate: '0.0213' }), 0.0213);

// Deliberately the other way round. annual_rate is the CONTRACTED rate —
// payoutInvestment never writes it — so a posted pool return supersedes it.
// This assertion previously expected 0.0348 and encoded the bug: the pool card
// said "Achieved 2.13%" while the list beside it said 3.48%.
eq('a posted pool return outranks the contracted rate',
   Utils.effectiveRate({ annual_rate: '0.0348', pool_actual_rate: '0.0213' }), 0.0213);

eq('the contracted rate is used when the pool has posted nothing',
   Utils.effectiveRate({ annual_rate: '0.0348', pool_actual_rate: '0.0000' }), 0.0348);

eq('nothing anywhere returns null, so a dash means a dash',
   Utils.effectiveRate({ amount: '20000', annual_rate: '0.0000' }), null);

eq('a zero pool rate is not mistaken for a posted return',
   Utils.effectiveRate({ annual_rate: '0.0000', pool_actual_rate: '0.0000' }), null);

eq('expected_return_rate is honoured when annual_rate is absent',
   Utils.effectiveRate({ expected_return_rate: '0.12' }), 0.12);

eq('null input does not throw', Utils.effectiveRate(null), null);

// The precise failure: truthiness, not value.
ok('"0.0000" is truthy — the trap this helper exists to close',
   Boolean('0.0000') === true);

/* ── 2. No render site reads the rate raw ──────────────────────────── */
console.log('\nrender sites — every one goes through the helper');

// A raw read is `annual_rate` used as a condition or fed straight to pct(),
// without effectiveRate on the same line. Lines that are plainly about pools
// (p.annual_rate / pool.annual_rate) are the pool's own target rate and are
// legitimately raw — a pool has no "effective" rate to resolve.
const FILES = ['admin/js/admin.js', 'js/portal-core.js', 'portal/js/portal.js', 'mobile/src/js/portal.js'];

// `x.annual_rate ? …` or `pct(x.annual_rate…)` where x is an investment.
const RAW_COND = /\b(?:i|inv|invst|r|it)\.(?:annual_rate|expected_return_rate)\s*(?:\?|\|\|)/;
const RAW_PCT  = /Utils\.pct\(\s*(?:i|inv|invst|r|it)\.(?:annual_rate|expected_return_rate)/;

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const offenders = [];
  lines.forEach((line, idx) => {
    if (line.includes('effectiveRate')) return;          // already resolved here
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;         // comment
    // `x.annual_rate != null ? …` is the safe null-guard, not the truthiness
    // trap — the portal's field normaliser is written that way on purpose.
    if (/\.(?:annual_rate|expected_return_rate)\s*!=\s*null/.test(line)) return;
    if (!RAW_COND.test(line) && !RAW_PCT.test(line)) return;
    offenders.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 110)}`);
  });
  ok(`${rel} has no raw investment-rate render`, offenders.length === 0, offenders.join('\n      '));
}

/* ── 3. The server actually sends the pool figure ──────────────────── */
console.log('\nserver — pool_actual_rate reaches the client');

const tables = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');

// Each investment-returning query must join the pool's posted rate on, or
// effectiveRate has nothing to fall back to and every caller shows a dash.
const invQueries = [
  ['list  (GET /tables/investments)',              /FROM investments i\s+LEFT JOIN investment_pools ip[\s\S]{0,200}?\$\{invWhere\}/],
  ['pool all-investments',                          /FROM investments i\s+JOIN investors inv/],
  ['pool investors (drives the CSV export)',        /FROM investments inv\s+LEFT JOIN investors i/],
  ['single record (GET /tables/investments/:id)',   /WHERE i\.\$\{key\} = \$1 LIMIT 1/],
];
for (const [label, marker] of invQueries) {
  const m = tables.match(marker);
  ok(`${label} selects pool_actual_rate`,
     !!m && (() => {
       // Look backwards from the FROM clause to the start of the SELECT.
       const at = tables.indexOf(m[0]);
       const selectStart = tables.lastIndexOf('SELECT', at);
       return tables.slice(selectStart, at + m[0].length).includes('pool_actual_rate');
     })(),
     'the query returns investments without the pool\'s posted rate');
}

const manual = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');
ok('account-statement lets a stored 0 fall through to the pool rate',
   /COALESCE\(NULLIF\(i\.annual_rate,\s*0\)/.test(manual),
   'plain COALESCE only falls through on NULL — a stored 0.0000 beats the pool and the statement quotes 0.00%');
ok('account-statement prefers the posted return over the target',
   /NULLIF\(p\.actual_rate,\s*0\)[\s\S]{0,40}p\.annual_rate/.test(manual));

/* ── 3b. What the cells actually render ────────────────────────────── */
console.log('\nrendered output — the expression as it appears in the source');

// A helper that returns 0.0213 proves nothing if the cell around it drops the
// value. These pull the real `${…}` expression out of the source file and
// evaluate it against the Jacenter row, so the assertion is on the HTML.
const JACENTER = { amount: '24744.77', annual_rate: '0.0000', pool_actual_rate: '0.0213', status: 'active' };
const NO_RATE  = { amount: '20000.00', annual_rate: '0.0000', pool_actual_rate: null,     status: 'active' };

function renderCell(file, needle, row, varName) {
  const src  = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const line = src.split('\n').find(l => l.includes(needle));
  if (!line) return { error: `no line containing ${JSON.stringify(needle)}` };
  // Slice out the `(() => { … })()` by hand — a regex for balanced braces
  // inside a template literal is not worth writing.
  const OPEN = '(() => {';
  const start = line.indexOf(OPEN);
  const end   = line.indexOf('})()', start);
  if (start === -1 || end === -1) return { error: `no IIFE on: ${line.trim().slice(0, 90)}` };
  const expr = line.slice(start, end + 4);
  try {
    const fn = vm.runInContext(`(function (${varName}) { return ${expr}; })`, sandbox);
    return { value: fn(row) };
  } catch (e) { return { error: e.message }; }
}

const CELLS = [
  ['portal/js/portal.js', '<td>${(() => { const _r = Utils.effectiveRate(inv)', 'inv', 'web portal investments table'],
];
for (const [file, needle, varName, label] of CELLS) {
  const hit  = renderCell(file, needle, JACENTER, varName);
  const dash = renderCell(file, needle, NO_RATE,  varName);
  ok(`${label} renders 2.13%, not 0.00%`,
     !hit.error && String(hit.value).includes('2.13%'),
     hit.error || `got ${JSON.stringify(hit.value)}`);
  ok(`${label} renders a dash when nothing is posted`,
     !dash.error && String(dash.value).includes('—'),
     dash.error || `got ${JSON.stringify(dash.value)}`);
}

// The admin cells go through Utils.rateCell, so assert on its output directly.
ok('admin list + investor detail tab renders 2.13%, not 0.00%',
   Utils.rateCell(JACENTER).includes('2.13%'), Utils.rateCell(JACENTER));
ok('admin list + investor detail tab renders a dash when nothing is posted',
   Utils.rateCell(NO_RATE).includes('—'), Utils.rateCell(NO_RATE));
ok('and the admin cells actually call it',
   (() => {
     const src = fs.readFileSync(path.join(ROOT, 'admin/js/admin.js'), 'utf8');
     return (src.match(/Utils\.rateCell\(/g) || []).length >= 3;
   })(),
   'the dashboard, the investments list and the investor tab must all use it');

/* ── 4. The 100× bug in the move-investment picker ─────────────────── */
console.log('\nunit — the move picker printed a fraction as a percentage');

const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
ok('no Number(annual_rate).toFixed(2) + "%" anywhere',
   !/Number\(\s*i\.annual_rate\s*\)\.toFixed\(2\)\s*\}?\s*%/.test(admin),
   '0.0213 rendered as "0.02%" instead of 2.13% — the ×100 was missing');
eq('Utils.pct does the ×100', Utils.pct(0.0213), '2.13%');

/* ── summary ───────────────────────────────────────────────────────── */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
