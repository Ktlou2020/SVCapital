#!/usr/bin/env node
/* The 1% platform fee is INCLUSIVE, and the parts add back to the whole.
 *
 * Two separate faults lived here. The mobile shell added the fee on top of
 * what the client typed while the web portal and the server took it out of
 * the amount, so the same instruction meant two different sums of money. And
 * "use max" on mobile offered floor(balance / 1.01) in whole rands, so a
 * client who wanted to invest everything could not: there was always a
 * remainder, and no amount they could type would clear it.
 *
 * The rule this check defends: WHAT THE CLIENT TYPES IS WHAT LEAVES THE
 * WALLET. Type the balance, spend the balance, nothing left behind.
 *
 * Run: node server/scripts/check-platform-fee-inclusive.cjs
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

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE   = read('js/portal-core.js');
const WEB    = read('portal/js/portal.js');
const MOBILE = read('mobile/src/js/portal.js');
const TABLES = read('server/routes/tables.js');

/* The shipped helpers, lifted and run — not retyped. A copy of the formula
   here would keep agreeing with itself after the real one changed. */
function liftCoreFeeHelpers() {
  const names = ['svcFeeRate', 'svcPoolAmount', 'svcPlatformFee', 'svcMinWalletFor', 'svcMaxInvestable'];
  let src = '';
  for (const n of names) {
    const m = CORE.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}`, 'm'));
    if (!m) throw new Error(`could not lift ${n} from js/portal-core.js`);
    src += m[0] + '\n';
  }
  const ctx = { Math, parseFloat };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api = { ' + names.join(', ') + ' };', ctx);
  return ctx.api;
}

/* The server's split, lifted the same way, so "the screen agrees with the
   ledger" is a claim about the real code on both sides. */
function liftServerSplit() {
  const m = TABLES.match(/poolAmount\s*=\s*Math\.round\(\(rawAmount \/ 1\.01\) \* 100\) \/ 100;\s*\n\s*platformFee = (.+?);/);
  if (!m) throw new Error('could not lift the fee split from server/routes/tables.js');
  const feeExpr = m[1];
  return raw => {
    const rawAmount = raw;
    const poolAmount = Math.round((rawAmount / 1.01) * 100) / 100;
    const platformFee = vm.runInNewContext(feeExpr, { rawAmount, poolAmount, Math });
    return { poolAmount, platformFee, required: rawAmount };
  };
}

const F = liftCoreFeeHelpers();
const S = liftServerSplit();

/* Amounts chosen to sit on rounding boundaries, not round numbers: a split
   that only works on multiples of a hundred is not a split. */
const AMOUNTS = [
  500, 1000, 1000.01, 1234.56, 99.99, 100, 2500.55, 5000, 7777.77,
  10000, 12345.67, 0.05, 1.01, 1.02, 3.03, 49999.99, 250000, 1000000,
];
for (let i = 0; i < 400; i++) AMOUNTS.push(Math.round(Math.random() * 5000000) / 100);

console.log('\nthe parts add back to what left the wallet');
{
  const bad = AMOUNTS.filter(a => {
    const fee = F.svcPlatformFee(a), pool = F.svcPoolAmount(a);
    return Math.round((pool + fee) * 100) !== Math.round(a * 100);
  });
  ok('pool amount plus fee equals the wallet spend, exactly, every time',
     bad.length === 0,
     `first failures: ${JSON.stringify(bad.slice(0, 5))}`);

  const neg = AMOUNTS.filter(a => F.svcPlatformFee(a) < 0);
  ok('and the fee is never negative', neg.length === 0, JSON.stringify(neg.slice(0, 3)));

  const over = AMOUNTS.filter(a => F.svcPlatformFee(a) > a * 0.01 + 0.005);
  ok('nor more than 1% of the amount', over.length === 0, JSON.stringify(over.slice(0, 3)));
}

console.log('\nthe screen agrees with the ledger');
{
  const bad = AMOUNTS.filter(a => {
    const srv = S(a);
    return Math.round(srv.poolAmount * 100) !== Math.round(F.svcPoolAmount(a) * 100)
        || Math.round(srv.platformFee * 100) !== Math.round(F.svcPlatformFee(a) * 100);
  });
  ok('the client split and the server split are the same numbers',
     bad.length === 0,
     `first disagreements: ${JSON.stringify(bad.slice(0, 5).map(a => ({ a, srv: S(a), cli: { pool: F.svcPoolAmount(a), fee: F.svcPlatformFee(a) } })))}`);

  const wrongTotal = AMOUNTS.filter(a => Math.round(S(a).required * 100) !== Math.round(a * 100));
  ok('and the server takes exactly what was typed, no more',
     wrongTotal.length === 0, JSON.stringify(wrongTotal.slice(0, 3)));
}

console.log('\nthe whole balance can be invested, to the cent');
{
  const BALANCES = [1000, 1234.56, 0.05, 99.99, 7777.77, 250000.01, 3.33];
  const stranded = BALANCES.filter(b => {
    const spend = F.svcMaxInvestable(b);
    return Math.round((b - S(spend).required) * 100) !== 0;
  });
  ok('investing the maximum leaves nothing behind', stranded.length === 0,
     `left over: ${JSON.stringify(stranded.map(b => ({ b, left: b - S(F.svcMaxInvestable(b)).required })))}`);
  ok('the maximum is the balance itself, not a fraction of it',
     F.svcMaxInvestable(1000) === 1000,
     `offered ${F.svcMaxInvestable(1000)} of a 1000 balance`);
  ok('and it is not floored to whole rands',
     F.svcMaxInvestable(1234.56) === 1234.56, String(F.svcMaxInvestable(1234.56)));
}

console.log('\nthe minimum is a wallet amount, with nothing to add');
{
  ok('the wallet needed for the pool minimum is the minimum',
     F.svcMinWalletFor({ min_investment: 1000 }) === 1000,
     String(F.svcMinWalletFor({ min_investment: 1000 })));
  /* The server compares the pool minimum against the WALLET SPEND. A client
     that added the fee on top told people they needed more than the server
     would ever have asked for. */
  ok('which is what the server compares against',
     /if \(minInv && required < minInv - 0\.005\)/.test(TABLES),
     'the server compares the minimum against something other than the wallet spend');
}

console.log('\nneither shell charges the fee on top any more');
{
  const web = strip(WEB), mob = strip(MOBILE);
  for (const [label, src] of [['the web portal', web], ['the mobile shell', mob]]) {
    ok(`${label} derives the fee from the shared helper`,
       /function _platformFee\([^)]*\)\s*\{\s*return svcPlatformFee\(/.test(src),
       'it carries its own copy of the formula, which is how the two drifted apart');
    ok(`${label} needs no top-up above the pool minimum`,
       /function _minPlusFee\([^)]*\)\s*\{\s*return svcMinWalletFor\(/.test(src));
    ok(`${label} sends the wallet spend with the inclusive flag`,
       /fee_inclusive:\s*true/.test(src),
       'the server would re-derive the total and could land a cent away');
  }
  ok('the mobile shell no longer adds the fee to the total',
     !/const totalDeducted = amount \+ platformFee;/.test(mob),
     'typing the balance would still overdraw it');
  ok('and no longer floors the maximum to whole rands',
     !/Math\.floor\(walletBal \/ \(1 \+ PLATFORM_FEE_RATE\)\)/.test(mob),
     'the client cannot spend their balance');
  ok('both shells offer a whole-balance pick',
     /invest-qp-btn--all/.test(web) && /invest-qp-btn--all/.test(mob),
     'there is no control that means "invest everything"');
  ok('and the rate the shells quote matches the platform rule',
     /const PLATFORM_FEE_RATE = 0\.01;/.test(web) &&
     /const PLATFORM_FEE_RATE = 0\.01;/.test(mob) &&
     F.svcFeeRate() === 0.01);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
