#!/usr/bin/env node
/* Clicking a column header must order the whole filter, correctly, by type.
 *
 * Not one table in this console sorted. The two ways anyone finds a row are
 * searching for a name they already know and ordering by the number they are
 * looking for, and only the first existed.
 *
 * The trap this exists for: node-pg returns NUMERIC as a STRING, so every
 * amount in STATE arrives as text. A comparator that does not parse puts
 * R9,000 above R10,000 — and on a screen full of money that looks plausible
 * enough to go unnoticed, which is the worst kind of wrong. So the comparator
 * is run in a browser against string amounts, not asserted from the source.
 *
 * The rest is what separates a usable sort from a demo: blanks last in BOTH
 * directions (a missing maturity date is absent, not earliest), stability so
 * equal rows do not shuffle on every render, and sorting the FILTER rather than
 * the visible page.
 *
 * Run: node scripts/check-sortable-columns.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The tables that sort, and the fact that every header has a renderer ── */
console.log('\nthe tables that matter sort');
{
  const tables = [...HTML.matchAll(/data-sort-table="([a-z]+)"/g)].map(m => m[1]);
  for (const t of ['investors', 'investments', 'transactions', 'kyc', 'maturity'])
    ok(`${t} is sortable`, tables.includes(t), `found: ${tables.join(', ')}`);

  const registered = [...SRC.matchAll(/_registerSortable\('([a-z]+)'/g)].map(m => m[1]);
  const orphan = tables.filter(t => !registered.includes(t));
  ok('every sortable table has a renderer registered', orphan.length === 0,
     `no renderer for: ${orphan.join(', ')} — its headers would do nothing`);

  const headers = [...HTML.matchAll(/data-sort="([^"]+)"/g)].length;
  ok('and there are headers to click', headers >= 20, `${headers} sortable headers`);

  /* A numeric column typed as text is the defect this whole check exists for,
     so the money columns are named explicitly rather than counted. */
  for (const col of ['_portfolio', '_absAmount', 'amount', '_payout'])
    ok(`  ${col} is typed numeric`,
       new RegExp(`data-sort="${col}"\\s+data-sort-type="num"`).test(HTML),
       'a money column sorted as text puts R9,000 above R10,000');
  for (const col of ['start_date', 'maturity_date', '_date', 'submitted_at', 'created_at'])
    ok(`  ${col} is typed as a date`,
       new RegExp(`data-sort="${col}"\\s+data-sort-type="date"`).test(HTML));
}

console.log('\nthe engine is wired, not just present');
{
  ok('sorting is delegated, not per-header onclick',
     /function _initSortableTables\(\)/.test(SRC) &&
     !/onclick="_toggleSort/.test(HTML),
     'sixty inline handlers is sixty chances to point one at the wrong field');
  ok('headers respond to the keyboard too',
     /e\.type === 'keydown' && e\.key !== 'Enter' && e\.key !== ' '/.test(SRC));
  ok('and announce their state', /setAttribute\('aria-sort'/.test(SRC));
  ok('a column click resets to page 1',
     /_registerSortable\('investors',\s*\(\) => \{ investorPage = 1;/.test(SRC),
     'sorting while on page 7 and staying there shows the middle of the new order');
  ok('the transactions table no longer sorts itself in place',
     !/filteredTxns\.sort\(\(a, b\) => new Date/.test(SRC),
     'it reordered the array the pager reads, on every render');
  ok('amount sorts on magnitude',
     /_absAmount: t => \{ const n = Math\.abs\(parseFloat\(t\.amount\)\)/.test(SRC),
     'the ledger shows every figure positive and takes direction from the type');
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the comparator was not exercised');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── The comparator itself, lifted out and run ────────────────────────── */
function slice(name) {
  const isFn = SRC.includes(`function ${name}(`);
  const at = SRC.indexOf(isFn ? `function ${name}(` : `const ${name} =`);
  if (at < 0) throw new Error(`${name} not found`);
  let i = SRC.indexOf('{', at), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(at, i + 1) + (isFn ? '' : ';');
}

let engine = '';
try {
  engine = ['_sortValue', '_sortRows', '_toggleSort'].map(slice).join('\n');
} catch (err) {
  ok('the sort engine could be extracted', false, err.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const page = `<!doctype html><meta charset="utf-8"><body>
<div id="out"></div>
<script>
const _sortState = {};
const _sortRenderers = {};
function _paintSortHeaders() {}
${engine}

/* Amounts as STRINGS — this is what node-pg hands back for NUMERIC, and the
   reason a comparator that does not parse is wrong on every money column.

   The values are chosen to DISCRIMINATE the two code paths. An earlier fixture
   used 9000 and 10000, and a mutation replacing the numeric compare with a raw
   string still passed: the text fallback collates with { numeric: true }, which
   orders those two correctly by accident. So the fixture now carries the cases
   where digit-run collation and real arithmetic disagree —

     -100 vs -9    collation reads the minus as a character and compares 9 < 100,
                   putting -9 below -100. Adjustments carry signed amounts.
     10.5 vs 10.25 collation compares the fractional run as 5 < 25, making 10.5
                   the smaller. Rates are not two decimal places.

   Without these, the check could not see the defect it exists for. */
const rows = [
  { id: 'a', amount: '9000',  name: 'Zanele',  due: '2026-03-01' },
  { id: 'b', amount: '10000', name: 'abel',    due: null },
  { id: 'c', amount: '10.5',  name: 'Mokoena', due: '2025-12-31' },
  { id: 'd', amount: null,    name: 'Ndlovu',  due: '2026-01-15' },
  { id: 'e', amount: '9000',  name: 'Botha',   due: '2026-03-01' },
  { id: 'f', amount: '-100',  name: 'Dlamini', due: '2026-02-01' },
  { id: 'g', amount: '10.25', name: 'Adams',   due: '2026-02-01' },
  { id: 'h', amount: '-9',    name: 'Zulu',    due: null },
];
const ids = list => list.map(r => r.id).join('');

const out = {};

_sortState.t = { key: 'amount', type: 'num', dir: 'desc' };
out.numDesc = ids(_sortRows('t', rows));
_sortState.t = { key: 'amount', type: 'num', dir: 'asc' };
out.numAsc = ids(_sortRows('t', rows));

_sortState.t = { key: 'name', type: 'text', dir: 'asc' };
out.textAsc = ids(_sortRows('t', rows));

_sortState.t = { key: 'due', type: 'date', dir: 'asc' };
out.dateAsc = ids(_sortRows('t', rows));
_sortState.t = { key: 'due', type: 'date', dir: 'desc' };
out.dateDesc = ids(_sortRows('t', rows));

/* Stability: 'a' and 'e' both hold 9000 and must keep their input order. */
_sortState.t = { key: 'amount', type: 'num', dir: 'desc' };
out.stable = ids(_sortRows('t', rows)) === ids(_sortRows('t', rows));

/* The source array must not be reordered underneath its caller. */
const before = ids(rows);
_sortRows('t', rows);
out.pure = ids(rows) === before;

/* Toggling: first click on a number goes descending, second flips. */
delete _sortState.t;
_toggleSort('t', 'amount', 'num'); out.firstNum = _sortState.t.dir;
_toggleSort('t', 'amount', 'num'); out.secondNum = _sortState.t.dir;
delete _sortState.t;
_toggleSort('t', 'name', 'text');  out.firstText = _sortState.t.dir;

/* An accessor wins over the field of the same name. */
_sortState.t = { key: 'amount', type: 'num', dir: 'asc' };
out.accessor = ids(_sortRows('t', rows, { amount: r => r.id === 'd' ? 0 : 999 }));

document.getElementById('out').textContent = JSON.stringify(out);
</script></body>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sortcols-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, page);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
} catch (err) { dom = (err.stdout || '').toString(); }
const m = dom.match(/id="out">([^<]*)</);
let r = null;
try { r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')); }
catch (_) { /* reported below */ }

console.log('\nthe comparator, in a browser');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 250));

if (r) {
  /* asc: -100, -9, 10.25, 10.5, 9000, 9000, 10000, null */
  ok('numbers sort as numbers, not as text', r.numAsc === 'fhgcaebd',
     `got ${r.numAsc} — collation would order -9 below -100 and 10.5 below 10.25`);
  ok('and descending is the reverse, blanks still last', r.numDesc === 'baecghfd',
     `got ${r.numDesc}`);
  ok('a negative amount sorts below every positive one',
     r.numAsc.indexOf('f') < r.numAsc.indexOf('g'),
     'adjustments carry signed amounts, and "-100" collates after "-9" as text');
  ok('and cents are compared as a quantity',
     r.numAsc.indexOf('g') < r.numAsc.indexOf('c'),
     '10.25 is less than 10.5; digit-run collation reads 25 > 5 and inverts them');
  ok('a blank amount sorts last in BOTH directions',
     r.numDesc.endsWith('d') && r.numAsc.endsWith('d'),
     `desc ${r.numDesc}, asc ${r.numAsc} — absent is not "smallest"`);

  ok('text is case-insensitive', r.textAsc === 'bgefcdah',
     `got ${r.textAsc} — "abel" must sort among the A's, not after "Zanele"`);

  ok('dates sort chronologically', r.dateAsc === 'cdfgaebh', `got ${r.dateAsc}`);
  ok('and a missing date is last in both directions',
     r.dateAsc.endsWith('bh') && r.dateDesc.endsWith('bh'),
     `asc ${r.dateAsc}, desc ${r.dateDesc} — a row with no maturity date is not the earliest`);

  ok('equal values keep their order', r.stable === true,
     'an unstable sort reshuffles matching rows on every render');
  ok('the caller\'s array is not reordered', r.pure === true,
     'sorting in place made the order depend on how many times the table rendered');

  ok('a number column opens descending', r.firstNum === 'desc',
     'the biggest balance and the newest transaction are what people want first');
  ok('a second click flips it', r.secondNum === 'asc', r.secondNum);
  ok('a text column opens ascending', r.firstText === 'asc', r.firstText);

  ok('an accessor overrides the plain field', r.accessor[0] === 'd', r.accessor);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
