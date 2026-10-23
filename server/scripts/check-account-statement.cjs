#!/usr/bin/env node
/* An account statement builds for every client, not most of them.
 *
 * "Failed to generate statement: Cannot access '_dateOf' before
 * initialization." The statement header totals the matured returns through
 * randReturn — deliberately, so the header and the rows under it cannot
 * report different numbers — and that call sits ABOVE the line that defines
 * _dateOf. randReturn is a function declaration and hoists; _dateOf was a
 * const arrow, which is in the temporal dead zone until its own line runs.
 *
 * It only bit some clients. randReturn answers from the settled figure, then
 * the pool's posted rate, then the recorded expected return, and returns at
 * the first of those it finds. Only an investment with NONE of the three
 * reaches the branch that asks for dates — so a statement broke the moment a
 * client happened to hold one, and worked for everybody else. That is also
 * why no check caught it: every fixture anyone had written carried a return.
 *
 * So this runs the real builder against an investment of each kind, including
 * the one nobody had. It lifts the function out of the file and runs it with
 * the handful of browser globals it touches, which is enough to prove it
 * completes and cheap enough to run on every commit.
 *
 * Run: node server/scripts/check-account-statement.cjs
 */
'use strict';

const fs   = require('fs');
const vm   = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The whole module, not a slice of it. An earlier attempt lifted the one
   function out by matching its braces and then fell over on the helpers
   beside it — which is the test telling you it is not running the real
   thing. The file ends by exposing accountStatementHTML, "the same page as
   a string", which is the seam to drive. */
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'investor-documents.js'), 'utf8');

function build(investments, transactions = []) {
  const win = { location: { origin: 'https://platform.svcapital.co.za' } };
  const ctx = {
    window: win, global: win, self: win,
    console: { log() {}, warn() {}, error() {} },
    Utils: {
      /* The real rule the statement reads: a posted pool rate outranks a
         contracted target, and neither exists for the case that broke. */
      rateBasis: i => {
        const posted = parseFloat(i.pool_actual_rate);
        if (Number.isFinite(posted) && posted > 0) return { rate: posted, posted: true };
        const target = parseFloat(i.annual_rate);
        if (Number.isFinite(target) && target > 0) return { rate: target, posted: false };
        return null;
      },
      rand: n => 'R' + n, date: d => String(d), pct: n => n + '%', escapeHtml: s => String(s),
    },
    document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, click() {} }) },
    btoa: x => Buffer.from(String(x), 'binary').toString('base64'),
    atob: x => Buffer.from(String(x), 'base64').toString('binary'),
    Date, Math, Number, parseFloat, parseInt, isNaN, JSON, String, Object, Array,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  if (!win.SVCDocs || typeof win.SVCDocs.accountStatementHTML !== 'function') {
    throw new Error('the module did not expose accountStatementHTML');
  }
  return win.SVCDocs.accountStatementHTML({
    investor: { id: 'S-11113', first_name: 'Bandile', last_name: 'Nhlapo' },
    period: { from: '2019-12-31', to: '2026-10-23' },
    investments, transactions, opening_balance: 0, closing_balance: 0,
  });
}

ok('the module exposes the statement as a string', (() => {
  try { return typeof build([]) === 'string'; } catch (_) { return false; }
})(), 'accountStatementHTML is the seam this check drives');

const base = { id: 'INV-1', amount: 10000, status: 'matured',
               start_date: '2024-01-01', end_date: '2025-01-01', term_months: 12 };

/* The four ways randReturn can answer, in the order it tries them. The last
   is the one that reaches the dates, and the one nobody had a fixture for. */
const KINDS = [
  ['a settled return',            { ...base, actual_return: 1200 }],
  ['a rate the pool posted',      { ...base, pool_actual_rate: 0.12 }],
  ['a recorded expected return',  { ...base, expected_return: 1200 }],
  ['nothing settled or recorded', { ...base, annual_rate: 0.12 }],
];

console.log('\na statement builds whatever the investment carries');
for (const [label, inv] of KINDS) {
  let err = null, html = '';
  try { html = build([inv]); } catch (e) { err = e; }
  ok(`${label}: it builds`, !err,
     err && `${err.constructor.name}: ${err.message}`);
  if (!err) ok(`${label}: and the statement has content`, html.length > 500, `${html.length} chars`);
}

console.log('\nand the cases around it');
{
  let err = null;
  try { build([]); } catch (e) { err = e; }
  ok('a client with no investments at all', !err, err && err.message);
}
{
  /* A row is identified by its POOL, not by the investment id — the id is
     never printed. Each fixture gets a distinct pool name so "all four are
     on the page" is something the page can actually answer. */
  let err = null, html = '';
  try {
    html = build(KINDS.map(([, i], n) => ({ ...i, id: 'INV-' + n, pool_name: `Pool Number ${n}` })));
  } catch (e) { err = e; }
  ok('all four kinds in one statement', !err, err && err.message);
  const found = KINDS.filter((_, n) => html.includes(`Pool Number ${n}`)).length;
  ok('and every one of them is on it', !err && found === KINDS.length,
     `${found} of ${KINDS.length} rows found`);
}
{
  /* The shape that broke production: an investment still marked active, with
     no figure of any kind, whose dates have to be derived from the term. */
  let err = null;
  try {
    build([{ id: 'INV-X', amount: 50000, status: 'active',
             start_date: '2025-10-16', term_months: 60, annual_rate: 0.1 }]);
  } catch (e) { err = e; }
  ok('an active holding with only a start date and a term', !err, err && err.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
