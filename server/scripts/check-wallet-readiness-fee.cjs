#!/usr/bin/env node
/* What the dashboard says a client can afford is what they can actually afford.
 *
 * The platform fee is 1% of the investment, charged ON TOP of it: a R500
 * investment into a R500-minimum pool costs R505 out of the wallet. That rule
 * is written down in CLAUDE.md and enforced correctly in openSaInvest, whose
 * own comment says why —
 *
 *     "sending them to the marketplace only to be refused at the last screen
 *      is worse than saying so here"
 *
 * — and then both dashboard panels did exactly that. Wallet Readiness and the
 * marketplace conversion panel each asked
 *
 *     wallet >= parseFloat(p.min_investment)
 *
 * so a client holding exactly R500 was told "You can already invest in 1 open
 * pool", given an Invest now button, and refused by the invest modal when they
 * pressed it. The same arithmetic produced the shortfall figure: "Top up R200"
 * when R205 was needed, which is a top-up that leaves them short and sends
 * them round again.
 *
 * This is the money already sitting on the platform — the easiest money there
 * is to convert, since it is past every other barrier — and the two surfaces
 * that exist to convert it were misinforming people about it.
 *
 * The helper was already there: svcMinWalletFor(pool) = svcWalletSpend(min).
 * Both panels use it now, and the copy says the fee is in the figure.
 *
 * The arithmetic is RUN, not read. Every claim here is about a number.
 *
 * Run: node server/scripts/check-wallet-readiness-fee.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const decomment = s => s.replace(/(^|[\s;{(=])\/\*[\s\S]*?\*\//g, '$1 ').replace(/^\s*\/\/.*$/gm, ' ');

const CORE = read(path.join('js', 'portal-core.js'));
const FILES = [path.join('js', 'portal-core.js'),
               path.join('portal', 'js', 'portal.js'),
               path.join('mobile', 'src', 'js', 'portal.js'),
               path.join('mobile', 'www', 'js', 'portal.js')];

/* The shipped fee maths, lifted and run. */
const ctx = { Math, Number, parseFloat };
vm.createContext(ctx);
for (const fn of ['svcFeeRate', 'svcPlatformFee', 'svcWalletSpend', 'svcMinWalletFor']) {
  const at = CORE.indexOf(`function ${fn}(`);
  if (at < 0) continue;
  vm.runInContext(CORE.slice(at, CORE.indexOf('\n}\n', at) + 3), ctx);
}

console.log('\nthe fee maths is what the rest of the platform uses');
{
  ok('svcMinWalletFor is available', typeof ctx.svcMinWalletFor === 'function');
  const need = ctx.svcMinWalletFor({ min_investment: 500 });
  ok('a R500 minimum needs R505 in the wallet', Math.abs(need - 505) < 0.005, String(need));
  ok('a R3 100 minimum needs R3 131',
     Math.abs(ctx.svcMinWalletFor({ min_investment: 3100 }) - 3131) < 0.005,
     String(ctx.svcMinWalletFor({ min_investment: 3100 })));
  ok('and it is always MORE than the minimum, never less',
     [500, 1000, 3100, 5000, 10000].every(m => ctx.svcMinWalletFor({ min_investment: m }) > m),
     'the fee is charged on top — a test that allowed equality would pass the old bug');
}

console.log('\nno surface still compares a balance to the bare minimum');
for (const rel of FILES) {
  const src = decomment(read(rel));
  ok(`${rel} — no fee-less affordability filter`,
     !/wallet >= \(parseFloat\(p\.min_investment\) \|\| 0\)/.test(src),
     'this is the test that told somebody with R500 they could invest R500');
  ok(`${rel} — no fee-less shortfall figure`,
     !/\(parseFloat\(cheapest\.min_investment\) \|\| 0\) - wallet/.test(src),
     'a gap that excludes the fee is a top-up that leaves them short');
}

console.log('\nboth panels ask the helper instead');
{
  /* The function body, sliced — not a character budget after the name. The
     first version allowed 1600 characters and failed on correct code because
     these panels build long template literals between the filter and the gap.
     A window that has to be widened whenever the code grows is a window that
     will one day be too small again. */
  const body = (src, fn) => {
    const at = src.indexOf(`function ${fn}(`);
    if (at < 0) return '';
    const end = src.indexOf('\n}\n', at);
    return src.slice(at, end > 0 ? end : undefined);
  };
  const web  = body(decomment(read(path.join('portal', 'js', 'portal.js'))), 'renderWalletReadinessPanel');
  const core = body(decomment(read(path.join('js', 'portal-core.js'))), 'renderMarketConversionPanel');
  ok('both panel bodies were found', web.length > 400 && core.length > 400,
     `${web.length} / ${core.length} chars`);
  ok('Wallet Readiness filters on svcMinWalletFor',
     /filter\(p => wallet >= svcMinWalletFor\(p\)\)/.test(web));
  ok('and takes its shortfall from it',
     /svcMinWalletFor\(cheapest\) - wallet/.test(web));
  ok('the marketplace panel filters on it too',
     /filter\(p => wallet >= svcMinWalletFor\(p\)\)/.test(core));
  ok('and takes its shortfall from it',
     /svcMinWalletFor\(cheapest\) - wallet/.test(core));
}

console.log('\nthe copy admits the fee is in the figure');
for (const rel of [path.join('portal', 'js', 'portal.js'), path.join('js', 'portal-core.js')]) {
  const src = read(rel);
  ok(`${rel} — says so beside the number`,
     /includes the 1% platform fee, which is charged on top/.test(src),
     'a figure a client cannot reconstruct reads as a mistake on our side');
  ok(`${rel} — no longer claims it is the minimum itself`,
     !/to reach the lowest open minimum/.test(src) && !/to unlock your next eligible pool/.test(src),
     'the figure is the minimum PLUS the fee, so calling it the minimum is wrong');
}

console.log('\nthe boundary case the old code got wrong');
{
  /* Exactly the minimum — the case CLAUDE.md calls out by name. */
  const pool = { min_investment: 500, status: 'open' };
  const affordableNow = w => w >= ctx.svcMinWalletFor(pool);
  ok('R500 against a R500 pool is NOT affordable', affordableNow(500) === false,
     'this is the client who was told to invest and then refused');
  ok('R504.99 is still not', affordableNow(504.99) === false);
  ok('R505 is', affordableNow(505) === true);
  ok('and the shortfall quoted at R500 is R5',
     Math.abs((ctx.svcMinWalletFor(pool) - 500) - 5) < 0.005,
     String(ctx.svcMinWalletFor(pool) - 500));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
