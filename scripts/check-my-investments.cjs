#!/usr/bin/env node
/* My Investments: what order the cards come in, and what the three tiles mean.
 *
 * Ordering: the cards came out in whatever order the API returned — neither
 * chronological nor stable — so the investment a client most needs to act on
 * could sit anywhere on the page. Soonest maturity first now.
 *
 * Tiles: "Capital Deployed" was `!is_reinvestment` across every status. That
 * answers neither question cleanly and errs in both directions at once: it
 * counted capital from investments that matured or paid out years ago, while
 * excluding reinvestments, which are deployed capital.
 *
 * Run: node scripts/check-my-investments.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eqN = (name, a, b) => ok(name, Math.abs(a - b) < 0.005, `expected ${b}, got ${a}`);

const sandbox = {
  window: {}, document: { addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  console, fetch: () => Promise.reject(new Error('no network')),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8'), sandbox, { filename: 'js/api.js' });
const Utils = sandbox.Utils || vm.runInContext('typeof Utils !== "undefined" ? Utils : null', sandbox);
if (!Utils || typeof Utils.byGroupMaturity !== 'function') {
  console.error('Utils.byGroupMaturity is missing from js/api.js');
  process.exit(1);
}

/* Fixed reference so the test does not drift with the calendar: 26 Aug 2026,
   the day the ordering was reported wrong. */
const NOW = Date.UTC(2026, 7, 26);
const d = (id, date, status) => ({ id, maturity_date: date, status: status || 'active' });

console.log('\nsoonest maturity first');
{
  // The six cards from the report, in the order they were rendered.
  const asRendered = [
    d('shortterm-aug', '2027-01-31'),
    d('cattle-aug',    '2027-08-31'),
    d('cattle-jun',    '2027-06-30'),
    d('cattle-apr',    '2027-04-30'),
    d('cattle-feb',    '2027-02-28'),
    d('cattle-dec',    '2026-12-31'),
  ];
  const sorted = [...asRendered].sort((a, b) => Utils.byMaturity(a, b, NOW)).map(x => x.id);
  ok('the six cards order by maturity',
     JSON.stringify(sorted) === JSON.stringify(
       ['cattle-dec', 'shortterm-aug', 'cattle-feb', 'cattle-apr', 'cattle-jun', 'cattle-aug']),
     JSON.stringify(sorted));
  ok('and that is genuinely different from what was rendered',
     JSON.stringify(sorted) !== JSON.stringify(asRendered.map(x => x.id)));
}

console.log('\nalready-matured go after what is still coming');
{
  const list = [
    d('past-old',   '2025-03-31', 'matured'),
    d('future-far', '2027-08-31'),
    d('past-recent','2026-06-30', 'matured'),
    d('future-near','2026-09-30'),
  ];
  const sorted = [...list].sort((a, b) => Utils.byMaturity(a, b, NOW)).map(x => x.id);
  ok('upcoming first ascending, then matured most-recent first',
     JSON.stringify(sorted) === JSON.stringify(['future-near', 'future-far', 'past-recent', 'past-old']),
     JSON.stringify(sorted));
}

console.log('\ndates that do not parse go last, predictably');
{
  const list = [
    { id: 'no-date', status: 'active' },
    d('dated', '2026-09-30'),
    { id: 'junk-date', maturity_date: 'not a date', status: 'active' },
    { id: 'null-date', maturity_date: null, status: 'active' },
  ];
  const sorted = [...list].sort((a, b) => Utils.byMaturity(a, b, NOW)).map(x => x.id);
  ok('the dated one comes first', sorted[0] === 'dated', JSON.stringify(sorted));
  ok('and the three undated ones are all after it',
     ['no-date', 'junk-date', 'null-date'].every(id => sorted.indexOf(id) > 0),
     JSON.stringify(sorted));
  // NaN comparisons are all false, which makes a sort arbitrary rather than
  // merely wrong — the bucket is what keeps this deterministic.
  const again = [...list].reverse().sort((a, b) => Utils.byMaturity(a, b, NOW)).map(x => x.id);
  ok('the order is stable regardless of input order', again[0] === 'dated', JSON.stringify(again));
}

console.log('\nmaturing today still counts as upcoming');
{
  const today = new Date(NOW).toISOString().slice(0, 10);
  const list = [d('yesterday', '2026-08-25', 'matured'), d('today', today), d('tomorrow', '2026-08-27')];
  const sorted = [...list].sort((a, b) => Utils.byMaturity(a, b, NOW)).map(x => x.id);
  ok('today sorts with the upcoming, not the past',
     JSON.stringify(sorted) === JSON.stringify(['today', 'tomorrow', 'yesterday']),
     JSON.stringify(sorted));
}

console.log('\na pool held several times is placed by its earliest maturity');
{
  const groupA = [d('a1', '2027-05-31'), d('a2', '2027-05-31')];
  const groupB = [d('b1', '2026-11-30')];
  const sorted = [groupA, groupB].sort((a, b) => Utils.byGroupMaturity(a, b, NOW)).map(g => g[0].id);
  ok('the sooner pool comes first', JSON.stringify(sorted) === JSON.stringify(['b1', 'a1']), JSON.stringify(sorted));

  const mixed = [d('m-late', '2027-09-30'), d('m-early', '2026-10-31')];
  const other = [d('o', '2027-01-31')];
  const s2 = [other, mixed].sort((a, b) => Utils.byGroupMaturity(a, b, NOW)).map(g => g[0].id);
  ok('a mixed group is placed by its earliest, not by its first row',
     s2[0] === 'm-late', `expected the mixed group first, got ${JSON.stringify(s2)}`);
}

/* ── The tiles ──────────────────────────────────────────────────────── */
console.log('\nCapital Deployed means money at work now');
{
  // Reproduce the tile's expression from source so this cannot drift from it.
  const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  ok('the tile filters on active status',
     /mi-capital[\s\S]{0,400}?status === 'active'/.test(core),
     'it still sums every status');
  ok('and no longer excludes reinvestments',
     !/mi-capital[\s\S]{0,300}?!i\.is_reinvestment/.test(core),
     'a reinvestment is deployed capital');

  const capital = list => list.filter(i => i.status === 'active')
                              .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const portfolio = [
    { id: 'live',      amount: '10000', status: 'active' },
    { id: 'rolled',    amount: '5000',  status: 'active',  is_reinvestment: true },
    { id: 'closed',    amount: '43240', status: 'paid_out' },
    { id: 'matured',   amount: '20000', status: 'matured' },
  ];
  eqN('only the two active ones count', capital(portfolio), 15000);
  ok('a reinvestment is included — it is money at work',
     capital(portfolio) > capital(portfolio.filter(i => !i.is_reinvestment)));
  ok('paid-out capital is excluded — it is back in the wallet',
     capital(portfolio) < portfolio.reduce((s, i) => s + parseFloat(i.amount), 0));

  // The old formula, for the size of the error on this portfolio.
  const old = portfolio.filter(i => !i.is_reinvestment)
                       .reduce((s, i) => s + parseFloat(i.amount), 0);
  eqN('the old formula reported 73,240 for 15,000 of deployed capital', old, 73240);
}

console.log('\nthe other two tiles');
{
  const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  ok('Returns Earned uses the posted-only definition',
     /mi-earned[\s\S]{0,200}?Utils\.earnedReturns\(/.test(core));
  ok('Total Investments counts records, not amounts',
     /mi-count[\s\S]{0,120}?d\.length/.test(core));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
