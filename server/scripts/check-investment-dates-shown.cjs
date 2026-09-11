#!/usr/bin/env node
/* What an investment card and the investments table say the dates are.
 *
 * A pool carries two date pairs that mean different things:
 *
 *   start_date / end_date    the FUNDRAISING WINDOW — when it opens to money
 *                            and when it shuts
 *   investment_start_date    when money in it starts earning, the day after
 *                            it shuts
 *   maturity_date            when the term ends
 *
 * Both tables read pool.start_date and pool.end_date FIRST, falling back to
 * the investment's own only when the pool had none. So a client whose money
 * had been working for two months was shown the dates the pool was open for
 * subscription — earlier than their start, shorter than their term, and
 * different from their own statement and certificate.
 *
 * The card had a subtler version: it preferred the pool's investment start
 * and, failing that, derived one from the pool's CLOSE — so every investment
 * in a pool showed one date whenever it was actually made.
 *
 * Run: node server/scripts/check-investment-dates-shown.cjs
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
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CORE = read('js/portal-core.js');

/* The shipped helpers, lifted and run. */
function lift() {
  const names = ['_svcDate', 'svcInvestmentStart', 'svcInvestmentMaturity'];
  let src = '';
  for (const n of names) {
    const m = CORE.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}`, 'm'));
    if (!m) throw new Error(`could not lift ${n} from js/portal-core.js`);
    src += m[0] + '\n';
  }
  const ctx = { Date, isNaN, parseInt, Number, String };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api = { ' + names.join(', ') + ' };', ctx);
  return ctx.api;
}
const A = lift();

/* A pool whose raise window is deliberately nothing like its term, so a
   result that leaks the window is unmistakable. */
const POOL = {
  start_date: '2026-01-01',            // opened to money
  end_date: '2026-01-31',              // shut
  investment_start_date: '2026-02-01', // money starts working
  maturity_date: '2026-07-31',         // term ends
};
const iso = d => (d ? d.toISOString().slice(0, 10) : null);

console.log('\nit shows the investment’s own dates');
{
  const inv = { start_date: '2026-02-14', maturity_date: '2026-08-14',
                created_at: '2026-01-20', term_months: 6 };
  ok('the start is the investment’s, not the pool’s open date',
     iso(A.svcInvestmentStart(inv, POOL)) === '2026-02-14',
     iso(A.svcInvestmentStart(inv, POOL)));
  ok('the maturity is the investment’s, not the pool’s close',
     iso(A.svcInvestmentMaturity(inv, POOL)) === '2026-08-14',
     iso(A.svcInvestmentMaturity(inv, POOL)));

  /* Two investments in one pool, made a month apart, must not read the same. */
  const later = { ...inv, start_date: '2026-03-14', maturity_date: '2026-09-14' };
  ok('two investments in one pool keep their own dates',
     iso(A.svcInvestmentStart(inv, POOL)) !== iso(A.svcInvestmentStart(later, POOL)),
     'every investment in a pool showed one date');
}

console.log('\nit never reaches for the fundraising window');
{
  const bare = { created_at: '2026-01-20' };
  ok('not for the start, even with nothing else to go on',
     iso(A.svcInvestmentStart(bare, POOL)) !== '2026-01-01',
     iso(A.svcInvestmentStart(bare, POOL)));
  ok('and not for the maturity',
     iso(A.svcInvestmentMaturity(bare, POOL)) !== '2026-01-31',
     iso(A.svcInvestmentMaturity(bare, POOL)));

  /* A pool with ONLY a raise window — no investment start, no maturity. The
     old code derived a start from close + 1 day; this must not. */
  const windowOnly = { start_date: '2026-01-01', end_date: '2026-01-31' };
  ok('a pool with only a raise window contributes no start',
     iso(A.svcInvestmentStart({ created_at: '2026-03-02' }, windowOnly)) === '2026-03-02',
     iso(A.svcInvestmentStart({ created_at: '2026-03-02' }, windowOnly)));
  ok('nor any maturity',
     A.svcInvestmentMaturity({ created_at: '2026-03-02' }, windowOnly) === null,
     iso(A.svcInvestmentMaturity({ created_at: '2026-03-02' }, windowOnly)));
}

console.log('\nthe fallbacks are the right ones, in the right order');
{
  ok('the pool’s investment start stands in when the investment has none',
     iso(A.svcInvestmentStart({ created_at: '2026-01-20' }, POOL)) === '2026-02-01',
     'this is when the pool’s money began working, not when it opened');
  ok('but the investment’s own start wins over it',
     iso(A.svcInvestmentStart({ start_date: '2026-02-14' }, POOL)) === '2026-02-14');
  ok('the pool’s maturity stands in when the investment has none',
     iso(A.svcInvestmentMaturity({ start_date: '2026-02-01' }, POOL)) === '2026-07-31');
  ok('and the term derives one when there is no pool at all',
     iso(A.svcInvestmentMaturity({ start_date: '2026-02-01', term_months: 6 }, null)) === '2026-08-01',
     iso(A.svcInvestmentMaturity({ start_date: '2026-02-01', term_months: 6 }, null)));
  ok('with null rather than a guess when nothing is known',
     A.svcInvestmentMaturity({ start_date: '2026-02-01' }, null) === null);
  ok('and end_date on the INVESTMENT is still its maturity',
     iso(A.svcInvestmentMaturity({ end_date: '2026-08-14' }, POOL)) === '2026-08-14',
     'an investment’s end_date is its own, unlike a pool’s');
}

console.log('\nevery display site uses them');
{
  const src = strip(CORE);
  ok('no display reads the pool’s raise window for an investment',
     !/const startVal = pool\.start_date/.test(src) && !/const endVal   = pool\.end_date/.test(src),
     'the tables still prefer the window');
  ok('the investments table takes the investment’s dates',
     (src.match(/const start\s+= svcInvestmentStart\(i, pool\);/g) || []).length >= 1);
  ok('and so does the export beside it',
     (src.match(/svcInvestmentStart\(i, pool\)/g) || []).length === 2,
     'both tables render the same figures and must agree');
  ok('the card no longer derives a start from the pool’s close',
     !/_d\.setDate\(_d\.getDate\(\) \+ 1\)/.test(src),
     'close plus a day gave every investment in a pool the same date');
  ok('the card asks for the investment’s start',
     /const _invStartDate = svcInvestmentStart\(inv, _poolRec\);/.test(src));

  /* The statements already did this, via their own pair in
     investor-documents.js. The two must not disagree. */
  const DOCS = strip(read('js/investor-documents.js'));
  ok('statements still read the investment’s own dates too',
     /function investmentStart\(i\) \{\s*return _dateOf\(i\.start_date\)/.test(DOCS),
     'the card and the statement would show different dates for one investment');
  ok('and never the pool’s close there either',
     !/pool_end_date/.test(DOCS));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
