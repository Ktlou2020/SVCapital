#!/usr/bin/env node
/* A quick-pick amount must be one the pool will actually accept.
 *
 * The ladder was [minimum, 5 000, 10 000, 25 000] filtered on whether the
 * wallet could afford each rung — and on nothing else. On a pool with a
 * R100 000 minimum that offered R5 000, R10 000 and R25 000 beside it, three
 * amounts the pool refuses. Tapping one filled the field with a figure that
 * could not be placed, blanked the fee breakdown to dashes, and left Confirm
 * live: the client's next move was a server error with no explanation on the
 * screen that caused it.
 *
 * The minimum is a rule about the POOL, so it is tested against what reaches
 * the pool and never against what leaves the wallet — the 1% platform fee is
 * charged on top of the amount, so the wallet spend is always the larger
 * figure and testing against it would refuse amounts the pool accepts.
 *
 * Run: node scripts/check-invest-quickpicks.cjs
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
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* The shipped functions, run rather than read. */
const s = {
  console, Math, Number, String, Object, Array, Map, Set, RegExp, JSON, Date,
  parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, Promise, Error,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  navigator: { userAgent: 'node' }, location: { href: '', origin: 'http://x' },
  fetch: () => Promise.reject(new Error('no network')),
  document: { addEventListener() {}, body: { style: {}, appendChild() {} },
              createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, append() {} }),
              querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
};
s.window = s; s.globalThis = s; s.self = s;
vm.createContext(s);
vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
vm.runInContext('var PORTAL = { pools: [], investments: [] }; var _mktProducts = [];' +
                'var _esc = x => String(x == null ? "" : x);', s);
vm.runInContext(read('js/portal-core.js'), s, { filename: 'js/portal-core.js' });

const picks  = s.svcInvestQuickPicks;
const spend  = s.svcWalletSpend;
const RICH   = 948900;   // the wallet in the report

console.log('\nnothing under the pool minimum is offered');
{
  /* The screen from the report: a R100 000 minimum showing R5 000, R10 000
     and R25 000 beside it. */
  const p = picks(100000, RICH);
  ok('a R100 000 pool offers only R100 000', JSON.stringify(p) === '[100000]', JSON.stringify(p));
  ok('and none of the rungs the report showed', !p.some(v => v < 100000), JSON.stringify(p));

  for (const min of [250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000]) {
    const got = picks(min, RICH);
    ok(`min ${min}: every rung clears it`, got.every(v => v >= min), JSON.stringify(got));
  }
}

console.log('\nthe rungs above it are kept, when the wallet covers them');
{
  ok('a R500 pool still offers the whole ladder',
     JSON.stringify(picks(500, RICH)) === '[500,5000,10000,25000]', JSON.stringify(picks(500, RICH)));
  ok('a R1 000 pool with R8 000 offers only what it can afford',
     JSON.stringify(picks(1000, 8000)) === '[1000,5000]', JSON.stringify(picks(1000, 8000)));
  ok('affordability is measured on the WALLET SPEND, fee included',
     spend(5000) > 5000 && picks(1000, spend(5000) - 0.01).indexOf(5000) === -1,
     `${spend(5000)} needed for a 5000 rung`);
}

console.log('\nthe minimum is always shown, even when it cannot be afforded');
{
  const broke = picks(100000, 50);
  ok('an empty wallet still sees what the pool costs',
     JSON.stringify(broke) === '[100000]', JSON.stringify(broke));
  ok('and it is never an empty row', picks(250000, 0).length >= 1, JSON.stringify(picks(250000, 0)));
}

console.log('\nthe ladder reads as a ladder');
{
  ok('a R5 000 minimum does not show R5 000 twice',
     JSON.stringify(picks(5000, RICH)) === '[5000,10000,25000]', JSON.stringify(picks(5000, RICH)));
  for (const min of [500, 5000, 12000, 100000]) {
    const got = picks(min, RICH);
    ok(`min ${min}: ascending`, got.every((v, i) => i === 0 || v > got[i - 1]), JSON.stringify(got));
  }
  ok('a zero or missing minimum does not produce a R0 chip',
     !picks(0, RICH).includes(0) && !picks(null, RICH).includes(0),
     JSON.stringify(picks(0, RICH)));
}

console.log('\nboth portals use the one ladder');
{
  for (const f of ['portal/js/portal.js', 'mobile/src/js/portal.js']) {
    const src = read(f);
    ok(`${f} calls it`, /svcInvestQuickPicks\(pool\.min_investment, walletBal\)/.test(src));
    ok(`${f} no longer keeps its own`,
       !/\[pool\.min_investment, 5000, 10000, 25000\]/.test(src),
       'two ladders drift, and only one of them gets fixed');
  }
}

console.log('\nan amount under the minimum is refused on the screen, not the server');
{
  for (const f of ['portal/js/portal.js', 'mobile/src/js/portal.js']) {
    const src = read(f);
    ok(`${f}: the state is recognised`, /const belowMin\s+= amt > 0 && amt < minInvest;/.test(src));
    ok(`${f}: Confirm is disabled for it`,
       /if \(belowMin\) \{[\s\S]{0,2200}confirmBtn\.disabled = true;/.test(src),
       'it used to fall through to the else branch, which ENABLES the button');
    ok(`${f}: and it says what the pool takes`,
       /Below this pool's minimum/.test(src) && /takes <strong[^>]*>\$\{Utils\.rand\(minInvest\)\}/.test(src));
    ok(`${f}: with a way to correct it`, /Use the minimum/.test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
