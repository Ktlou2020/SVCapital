#!/usr/bin/env node
/* The 1% platform fee is charged ON TOP of the investment.
 *
 * The rule this check defends: WHAT THE CLIENT TYPES IS WHAT REACHES THE
 * POOL. Type R500 into a pool with a R500 minimum and R500 reaches the pool;
 * R5,00 is the fee and R505,00 leaves the wallet.
 *
 * That is the reason for the model. The pool minimum is a rule about the
 * pool, so it has to be tested against what reaches the pool. Taking the fee
 * out of the amount placed R495,05 against a R500 minimum while the screen
 * said R500 — short of the minimum it was supposed to satisfy.
 *
 * The cost is that the wallet no longer empties by typing the balance, so
 * "invest everything" becomes a search for the largest amount whose total the
 * balance covers. Most of this file is about that search not overdrawing.
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
const AGREE  = read('server/routes/agreements.js');

/* The shipped helpers, lifted and run — not retyped. A copy of the formula
   here would keep agreeing with itself after the real one changed. */
function liftCoreFeeHelpers() {
  const names = ['svcFeeRate', 'svcPoolAmount', 'svcPlatformFee', 'svcWalletSpend',
                 'svcMinWalletFor', 'svcMaxInvestable'];
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
/* The server's additive branch, lifted rather than retyped: this is the
   branch every client now takes. */
function liftServerSplit() {
  const m = TABLES.match(/poolAmount\s*=\s*rawAmount;\s*\n\s*platformFee = isReinvestment \? 0 : (.+?);\s*\n\s*required\s*=\s*(.+?);/);
  if (!m) throw new Error('could not lift the additive fee split from server/routes/tables.js');
  const feeExpr = m[1], reqExpr = m[2];
  return raw => {
    const rawAmount = raw;
    const poolAmount = rawAmount;
    const platformFee = vm.runInNewContext(feeExpr, { rawAmount, Math });
    const required = vm.runInNewContext(reqExpr, { rawAmount, platformFee, Math });
    return { poolAmount, platformFee, required };
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

console.log('\nthe fee is charged on top, and the sums hold');
{
  const bad = AMOUNTS.filter(a => {
    const fee = F.svcPlatformFee(a);
    return Math.round((a + fee) * 100) !== Math.round(F.svcWalletSpend(a) * 100);
  });
  ok('the wallet pays the amount plus its fee, exactly', bad.length === 0,
     `first failures: ${JSON.stringify(bad.slice(0, 5))}`);

  ok('what reaches the pool is what was entered',
     AMOUNTS.every(a => Math.round(F.svcPoolAmount(a) * 100) === Math.round(a * 100)),
     'the entered figure and the pool figure must be the same number');

  const neg = AMOUNTS.filter(a => F.svcPlatformFee(a) < 0);
  ok('the fee is never negative', neg.length === 0, JSON.stringify(neg.slice(0, 3)));

  ok('R500 into a R500 minimum places R500, and costs R505',
     F.svcPoolAmount(500) === 500 && F.svcPlatformFee(500) === 5 && F.svcWalletSpend(500) === 505,
     `pool ${F.svcPoolAmount(500)}, fee ${F.svcPlatformFee(500)}, total ${F.svcWalletSpend(500)}`);
}

console.log('\nthe screen agrees with the ledger');
{
  const bad = AMOUNTS.filter(a => {
    const srv = S(a);
    return Math.round(srv.poolAmount * 100) !== Math.round(F.svcPoolAmount(a) * 100)
        || Math.round(srv.platformFee * 100) !== Math.round(F.svcPlatformFee(a) * 100)
        || Math.round(srv.required * 100)    !== Math.round(F.svcWalletSpend(a) * 100);
  });
  ok('the client and the server compute the same three figures',
     bad.length === 0,
     `first disagreements: ${JSON.stringify(bad.slice(0, 4).map(a => ({ a, srv: S(a), cli: { pool: F.svcPoolAmount(a), fee: F.svcPlatformFee(a), total: F.svcWalletSpend(a) } })))}`);
}

console.log('\nthe pool minimum is tested against the pool, not the wallet');
{
  ok('the server compares the minimum to the pool amount',
     /if \(minInv && poolAmount < minInv - 0\.005\)/.test(TABLES),
     'the fee would count towards the minimum it is charged on');
  ok('the agreement route does the same',
     /amount` is what reaches the POOL[\s\S]{0,400}amountCents < minCents/.test(AGREE),
     'a contract could be signed for less than the pool accepts');
  ok('the wallet a client needs for the minimum includes the fee',
     F.svcMinWalletFor({ min_investment: 500 }) === 505,
     String(F.svcMinWalletFor({ min_investment: 500 })));
  ok('and a balance exactly equal to the minimum is not enough',
     F.svcMinWalletFor({ min_investment: 500 }) > 500);
}

console.log('\n"invest everything" never overdraws the wallet');
{
  /* The whole balance can no longer be typed, so the maximum is a search.
     Overdrawing would be refused by the server after the client had signed
     an agreement for it, which is the worst place to find out. */
  let over = 0, exact = 0, worst = 0;
  for (let c = 1; c <= 200000; c++) {
    const w = c / 100;
    const a = F.svcMaxInvestable(w);
    const total = F.svcWalletSpend(a);
    if (total > w + 1e-9) { over++; continue; }
    const left = Math.round((w - total) * 100);
    if (left === 0) exact++; else if (left > worst) worst = left;
  }
  ok('it never offers more than the balance covers, at any balance to R2 000',
     over === 0, `${over} balances overdrawn`);
  ok('and it lands on an exact drain wherever one exists',
     exact > 195000, `${exact} of 200000 drained exactly`);
  ok('leaving at most a cent when none does', worst <= 1, `${worst} cents stranded`);

  ok('a R505 balance invests the full R500',
     F.svcMaxInvestable(505) === 500, String(F.svcMaxInvestable(505)));
  ok('and a R500 balance cannot reach a R500 minimum',
     F.svcMaxInvestable(500) < 500, String(F.svcMaxInvestable(500)));
}

console.log('\nboth shells charge on top, and neither sends the old flag');
{
  const web = strip(WEB), mob = strip(MOBILE);
  for (const [label, src] of [['the web portal', web], ['the mobile shell', mob]]) {
    ok(`${label} derives the fee from the shared helper`,
       /function _platformFee\([^)]*\)\s*\{\s*return svcPlatformFee\(/.test(src),
       'it carries its own copy of the formula, which is how the two drifted apart');
    ok(`${label} asks for the minimum plus the fee`,
       /function _minPlusFee\([^)]*\)\s*\{\s*return svcMinWalletFor\(/.test(src));
    ok(`${label} no longer sends fee_inclusive`,
       !/fee_inclusive/.test(src),
       'the server would take the fee out of the amount instead of adding it');
    ok(`${label} caps the amount at what the balance can cover`,
       /max="\$\{svcMaxInvestable\(walletBal\)\}"/.test(src),
       'the field would accept an amount whose total overdraws');
    ok(`${label} spends the total, not the entered amount`,
       /svcWalletSpend\(/.test(src));
  }
  ok('and the rate the shells quote matches the platform rule',
     /const PLATFORM_FEE_RATE = 0\.01;/.test(web) &&
     /const PLATFORM_FEE_RATE = 0\.01;/.test(mob) &&
     F.svcFeeRate() === 0.01);
}

console.log('\nthe sub-account gate asks for the fee too');
{
  ok('it needs the cheapest minimum plus its fee',
     /const minNeeded = cheapest > 0 \? svcWalletSpend\(cheapest\) : 0;/.test(CORE),
     'a client is sent to the marketplace and refused at the last screen');
}

console.log('\nthe written rule says the same thing as the code');
{
  const md = read('CLAUDE.md');
  ok('CLAUDE.md describes a fee charged on top',
     /charged \*\*on top of it\*\*/.test(md),
     'the standing rule still says the fee is inclusive');
  ok('and a minimum tested against the pool amount',
     /tested against the pool amount, never against the wallet spend/.test(md));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
