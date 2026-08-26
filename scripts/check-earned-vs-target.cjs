#!/usr/bin/env node
/* The rule: a benchmark belongs on the POOL, where a client sees it before
 * investing. Nothing shown against money already held may be a projection —
 * only what has actually been posted.
 *
 * What it was: one helper served both meanings, and its fallback chain reached
 * the contracted rate. So a client who invested yesterday at 12% was told he
 * had already EARNED a full year's return, and his portfolio value included
 * it. The same investment reported three different figures on three screens.
 *
 * Run: node scripts/check-earned-vs-target.cjs
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
const eqN = (name, actual, expected) =>
  ok(name, Math.abs(actual - expected) < 0.005, `expected ${expected}, got ${actual}`);

/* ── Utils out of the shared api.js ─────────────────────────────────── */
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
if (!Utils || typeof Utils.earnedReturns !== 'function') {
  console.error('Utils.earnedReturns is missing from js/api.js');
  process.exit(1);
}

/* Christian Eyssen, S-111321: R1,485.15 at 12%, invested 25 Aug, active,
   nothing posted. The portal told him he had earned R178.22. */
const FRESH   = { amount: '1485.15', annual_rate: '0.1200', expected_return_amount: 178.22, status: 'active' };
/* Jacenter S-1105: R24,744.77, no rate of its own, 2.13% posted on the pool. */
const POSTED  = { amount: '24744.77', annual_rate: '0.0000', pool_actual_rate: '0.0213', status: 'active' };
/* Closed out with a realised figure. */
const REALISED = { amount: '43240.02', annual_rate: '0.0348', actual_return: '1504.75', status: 'paid_out' };
const CANCELLED = { amount: '10000.00', annual_rate: '0.1300', status: 'cancelled' };

console.log('\nearned means declared');
eqN('nothing posted earns nothing, however good the benchmark',
    Utils.earnedReturns([FRESH]), 0);
eqN('a posted pool rate is earned', Utils.earnedReturns([POSTED]), 24744.77 * 0.0213);
eqN('a realised return is earned',  Utils.earnedReturns([REALISED]), 1504.75);
eqN('a cancelled investment earns nothing', Utils.earnedReturns([CANCELLED]), 0);
eqN('earned over a mixed portfolio',
    Utils.earnedReturns([FRESH, POSTED, REALISED, CANCELLED]), 24744.77 * 0.0213 + 1504.75);

console.log('\nno helper sums targets across holdings');
// Deliberately absent. Every caller of such a helper would be showing a
// projection against money already held, which is the thing being removed.
ok('Utils has no targetReturns', typeof Utils.targetReturns === 'undefined',
   'a helper with that name invites exactly the misuse this removed');

console.log('\nportfolio value moves only on posted returns');
{
  const wallet = 5000;
  // FRESH is active capital; its R178.22 benchmark must NOT appear.
  eqN('a benchmark does not inflate portfolio value',
      Utils.portfolioValue([FRESH], wallet), 1485.15 + 5000);
  eqN('a posted return does raise it',
      Utils.portfolioValue([POSTED], wallet), 24744.77 + 5000 + 24744.77 * 0.0213);
  // paid_out: capital AND return are already in the wallet. Counting either
  // here would add the same money twice.
  eqN('a paid-out investment is not counted again — the money is in the wallet',
      Utils.portfolioValue([REALISED], wallet), 5000);
  // matured but unpaid: still held, so it and its declared return do count.
  const MATURED = { amount: '10000.00', annual_rate: '0.0000', pool_actual_rate: '0.0500', status: 'matured' };
  eqN('a matured but unpaid investment still counts, with its declared return',
      Utils.portfolioValue([MATURED], wallet), 10000 + 500 + 5000);
  eqN('a cancelled investment contributes nothing',
      Utils.portfolioValue([CANCELLED], wallet), 5000);
  eqN('no wallet, no investments, no value', Utils.portfolioValue([], 0), 0);
  ok('a missing wallet balance does not produce NaN',
     Number.isFinite(Utils.portfolioValue([FRESH], undefined)));
}

console.log('\nthe bug this replaces');
ok('the old helper really did report a full year on day one',
   Math.abs(Utils.totalReturns([FRESH]) - 178.22) < 0.005,
   `totalReturns says ${Utils.totalReturns([FRESH])}`);
ok('and earnedReturns does not',
   Utils.earnedReturns([FRESH]) === 0);
eqN('the gap is exactly what portfolio value was inflated by',
    Utils.totalReturns([FRESH]) - Utils.earnedReturns([FRESH]), 178.22);

/* ── No screen still reports earnings from a projection ─────────────── */
console.log('\nno surface reports earnings from a projection');
const FILES = ['js/portal-core.js', 'portal/js/portal.js', 'mobile/src/js/portal.js'];
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const bad = [];
  lines.forEach((line, idx) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    // totalReturns feeding anything named earned, or any portfolio value.
    if (/Utils\.totalReturns\(/.test(line) && /earn/i.test(line)) bad.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 100)}`);
    if (/(totalValue|portfolioVal)\s*=/.test(line) && /totalReturns/.test(line)) bad.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 100)}`);
  });
  ok(`${rel} keeps projections out of earnings and value`, bad.length === 0, bad.join('\n      '));
}

// One definition of portfolio value — it was computed five ways, and two of
// them wrote #pov-total with different formulas.
{
  const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  const povWriters = (core.match(/pov-total/g) || []).length;
  const shared     = (core.match(/Utils\.portfolioValue\(/g) || []).length;
  ok('every portfolio-value computation in portal-core goes through the helper',
     shared >= 2, `found ${shared} call(s) for ${povWriters} references to #pov-total`);
}

/* ── The rule itself: benchmark on the pool, never on a holding ─────── */
console.log('\nno benchmark appears against money already held');
{
  const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');

  // The labels that used to quote a benchmark on an investment the client owns.
  for (const [label, gone] of [
    ['the "Expected return" card stat', /mc2__stat-lbl">Expected return</],
    ['the Target Return tile write',    /getElementById\('mi-expected'\)/],
    ['the certificate\'s Target Return row', />Target Return</],
    ['the statement\'s target row',      /Target Return \(illustrative\)/],
  ]) {
    ok(`${label} is gone`, !gone.test(core), 'still present in portal-core.js');
  }

  // No total may fall back to a benchmark when nothing was actually recorded.
  const bad = core.split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(([l]) => /(actual_return\w*)\s*\|\|\s*\w*\.?expected_return/.test(l))
    .map(([l, i]) => `js/portal-core.js:${i}: ${l.trim().slice(0, 90)}`);
  ok('no total falls back from an actual return to a benchmark', bad.length === 0, bad.join('\n      '));
}

console.log('\nbut the pool keeps its benchmark — that is where it belongs');
{
  const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  ok('the marketplace pool card still shows the benchmark rate',
     /Utils\.pct\(pool\.annual_rate\)\} benchmark/.test(core),
     'a client must be able to see what a pool aims at before investing');
  ok('the pool listing still shows its target rate',
     /target \$\{\(p\.benchmark_rate \* 100\)/.test(core));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
