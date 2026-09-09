#!/usr/bin/env node
/* The Rand Return on a statement must be the money.
 *
 * A client queried three matured holdings whose Rand Return did not match what
 * they were paid. Reconstructed from the reported figures, the statement said:
 *
 *     Cattle Investment - August 2025   R29 242 @ 12.23%   R4 173,98
 *     Bike Fleet Investment 20          R3 100  @ 13.28%     R614,70
 *     Short Term Investment - Jan 2025  R105 000 @ 4.04%   R2 091,95
 *
 * None of those is capital x rate, and none of them was the maturity value.
 * The column was computed as:
 *
 *     principal x Utils.effectiveRate(i) x (days / 365)
 *
 * TWO FAULTS, AND THEY COMPOUND.
 *
 * FIRST — IT PRORATED A RATE THAT WAS ALREADY A PERIOD RATE. effectiveRate
 * returns actual_return/amount once an investment has paid out, and
 * pool_actual_rate once a pool has posted one. Both already cover the whole
 * term. Multiplying either by days/365 rescales a settled figure by the length
 * of the holding: +16.7% on a 426-day cattle holding, +49.3% on the bike
 * fleet, and -50.7% on a 180-day short-term holding. Two overstated, one
 * understated, which is why it looked arbitrary rather than like a formula.
 *
 * js/api.js already carries the warning, on Utils.rateSuffix: "actual_rate is
 * the return achieved FOR THE POOL'S PERIOD — for every product, not per annum
 * and not prorated over term_months." That fix landed on the rate LABEL and
 * never reached this calculation.
 *
 * SECOND — A MATURED INVESTMENT DOES NOT NEED ITS RETURN DERIVED. actual_return
 * is the amount that was credited. The statement's own summary line has always
 * used it, so the header total and the rows underneath it were computing the
 * same quantity two different ways and printing both on one page.
 *
 * So the fixtures below are the reported rows, reconstructed so that the OLD
 * formula reproduces each published figure to the cent — which is what makes
 * this a diagnosis rather than a guess — and every assertion is that the NEW
 * one returns the maturity value instead.
 *
 * Run: node scripts/check-statement-rand-return.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const vm   = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = fs.readFileSync(path.join(ROOT, 'js', 'investor-documents.js'), 'utf8');
const API  = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

/* Comments blanked, newlines kept, so a negative assertion cannot be satisfied
   by the paragraph explaining the fix. */
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const CODE = strip(DOCS);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const cents = n => Math.round((n || 0) * 100);
const near  = (a, b) => cents(a) === cents(b);

/* ── The shipped code, lifted and run ───────────────────────────────────── */
function sliceFn(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* The real Utils from js/api.js, not a stand-in — rateBasis is half of what is
   under test and a hand-written copy of it would agree with itself. */
function liftUtils() {
  const at = API.indexOf('const Utils = {');
  if (at < 0) throw new Error('Utils not found in js/api.js');
  const end = API.indexOf('\n};\n', at);
  const ctx = vm.createContext({ console, Date, Math, Number, String, Array, JSON,
    parseFloat, parseInt, isNaN, window: {}, document: {},
    localStorage: { getItem: () => null, setItem: () => {} } });
  vm.runInContext(API.slice(at, end + 4) + '\nthis._U = Utils;', ctx);
  return ctx._U;
}

let Utils, randReturn;
try {
  Utils = liftUtils();
  const ctx = vm.createContext({ Utils, console, Date, Math, Number, parseFloat, isNaN });
  /* randReturn now closes over the document's start/maturity definitions, so
     they come with it. Lifting the function alone gave a ReferenceError on the
     first call, which reads as though the shipped code were broken. */
  const deps = [
    (DOCS.match(/const _dateOf = [^\n]*/) || [''])[0],
    sliceFn(DOCS, 'investmentStart'),
    sliceFn(DOCS, 'investmentMaturity'),
  ].join('\n');
  vm.runInContext(deps + '\n' + sliceFn(DOCS, 'randReturn') + '\nthis._f = randReturn;', ctx);
  randReturn = ctx._f;
} catch (e) {
  ok('the statement arithmetic could be extracted and run', false, e.message);
}
ok('the statement arithmetic could be extracted and run',
   typeof randReturn === 'function' && typeof Utils?.rateBasis === 'function',
   'without this every assertion below is skipped rather than failed');

/* The calculation as it shipped, kept here so the reported figures can be
   reproduced. If this ever stops reproducing them the diagnosis was wrong. */
const oldCalc = i => {
  const principal = parseFloat(i.amount) || 0;
  const rate = Utils.effectiveRate(i) || 0;
  const startMs = new Date(i.start_date || i.created_at).getTime();
  const endMs = new Date(i.maturity_date || i.pool_end_date).getTime();
  if (!principal || !rate || isNaN(startMs) || isNaN(endMs) || endMs <= startMs)
    return parseFloat(i.actual_return || i.expected_return || 0);
  return principal * rate * ((endMs - startMs) / 86400000 / 365);
};

/* ── The three reported rows ────────────────────────────────────────────── */
const REPORTED = [
  { label: 'Cattle Investment - August 2025', shown: 4173.98,
    inv: { status: 'matured', pool_name: 'Cattle Investment - August 2025', product_type: 'cattle',
           amount: 29242, actual_return: 3576.30, annual_rate: 0.1223,
           start_date: '2025-07-01', maturity_date: '2026-08-31',
           pool_start_date: '2025-07-01', pool_end_date: '2025-08-31' } },
  { label: 'Bike Fleet Investment 20 - August 2024', shown: 614.70,
    inv: { status: 'matured', pool_name: 'Bike Fleet Investment 20 - August 2024', product_type: 'delivery_bike',
           amount: 3100, actual_return: 411.68, annual_rate: 0.1328,
           start_date: '2024-09-16', maturity_date: '2026-03-15',
           pool_start_date: '2024-09-16', pool_end_date: '2024-09-16' } },
  { label: 'Short Term Investment - January 2025', shown: 2091.95,
    inv: { status: 'matured', pool_name: 'Short Term Investment - January 2025', product_type: 'short_term',
           amount: 105000, actual_return: 4242.00, annual_rate: 0.0404,
           start_date: '2025-01-01', maturity_date: '2025-06-30',
           /* End before start, exactly as the statement printed it. */
           pool_start_date: '2025-02-01', pool_end_date: '2025-01-31' } },
];

if (randReturn) {
  console.log('\nthe reported figures, reproduced');
  {
    const misses = REPORTED.filter(r => !near(oldCalc(r.inv), r.shown));
    ok('the old formula reproduces every published figure to the cent',
       misses.length === 0,
       misses.map(r => `${r.label}: ${oldCalc(r.inv).toFixed(2)} ≠ ${r.shown}`).join(' | ') ||
       'if this fails the diagnosis below is about the wrong defect');
    ok('and not one of them was the maturity value',
       REPORTED.every(r => !near(r.shown, r.inv.actual_return)),
       'which is what the client was comparing against');
  }

  console.log('\nand replaced by what was actually credited');
  {
    const wrong = REPORTED.filter(r => !near(randReturn(r.inv).value, r.inv.actual_return));
    ok('every row now shows the maturity value', wrong.length === 0,
       wrong.map(r => `${r.label}: ${randReturn(r.inv).value} ≠ ${r.inv.actual_return}`).join(' | '));
    ok('and says so, rather than leaving the basis to be guessed',
       REPORTED.every(r => randReturn(r.inv).basis === 'actual'),
       JSON.stringify(REPORTED.map(r => randReturn(r.inv).basis)));
    ok('the overstatement is gone in both directions',
       near(REPORTED.reduce((s, r) => s + randReturn(r.inv).value, 0), 8229.98) &&
       !near(REPORTED.reduce((s, r) => s + oldCalc(r.inv), 0), 8229.98),
       'two rows were overstated and one understated, which is why it looked arbitrary');
  }

  console.log('\na rate that already covers the period is never annualised');
  {
    /* The case js/api.js warns about on Utils.rateSuffix: a pool posts 2.13%
       for a five-month period. Prorating it reports a third of what was
       earned. */
    const posted = { status: 'matured', amount: 20000, pool_actual_rate: 0.0213, annual_rate: 0.05,
                     start_date: '2025-05-01', maturity_date: '2025-10-01' };
    const r = randReturn(posted);
    ok('a posted pool rate is applied to the capital and to nothing else',
       near(r.value, 426) && r.basis === 'posted',
       `${r.value} (${r.basis}) — prorating gives ${oldCalc(posted).toFixed(2)}`);
    ok('which is not what the old formula gave',
       !near(oldCalc(posted), 426), oldCalc(posted).toFixed(2));

    /* The same shape, with actual_return set: effectiveRate returns
       actual/amount, so prorating scaled the settled figure by the term. */
    const settled = { status: 'matured', amount: 10000, actual_return: 1200,
                      start_date: '2025-01-01', maturity_date: '2026-06-30' };
    ok('a settled return is not rescaled by the length of the holding',
       near(randReturn(settled).value, 1200),
       `old formula gave ${oldCalc(settled).toFixed(2)} for a return of 1200`);
    ok('and the old formula demonstrably did rescale it',
       !near(oldCalc(settled), 1200), oldCalc(settled).toFixed(2));
  }

  console.log('\nthe order the figures are trusted in');
  {
    const base = { status: 'matured', amount: 10000, start_date: '2025-01-01', maturity_date: '2026-01-01' };
    ok('a credited return beats everything',
       randReturn({ ...base, actual_return: 900, pool_actual_rate: 0.11, expected_return: 1000, annual_rate: 0.12 }).basis === 'actual');
    ok('a posted pool rate beats a target and a stored expectation',
       randReturn({ ...base, pool_actual_rate: 0.11, expected_return: 1000, annual_rate: 0.12 }).basis === 'posted');
    ok('the expected return recorded at investment beats a re-derivation',
       randReturn({ ...base, expected_return: 1000, annual_rate: 0.12 }).basis === 'expected',
       'it is what the client was shown and what the contract says');
    ok('and only then is the annual target prorated over the term',
       randReturn({ ...base, annual_rate: 0.12 }).basis === 'projected');
    ok('the projection is the annual rate over the actual days',
       near(randReturn({ ...base, annual_rate: 0.12 }).value, 10000 * 0.12 * (365 / 365)),
       String(randReturn({ ...base, annual_rate: 0.12 }).value));
    ok('a row with nothing at all reports nothing, not zero rand',
       randReturn({ status: 'matured', amount: 10000 }).basis === 'none');
  }

  console.log('\nand a nonsense date range cannot produce a nonsense figure');
  {
    /* One of the reported pools carries an end date BEFORE its start date. The
       old code fell back to actual/expected only in that case; the settled
       figure is now the first answer, so the dates never enter into it. */
    const backwards = { status: 'matured', amount: 105000, actual_return: 4242,
                        pool_start_date: '2025-02-01', pool_end_date: '2025-01-31' };
    ok('an end date before its start date does not change the answer',
       near(randReturn(backwards).value, 4242));
    ok('nor does a missing maturity date',
       near(randReturn({ status: 'matured', amount: 1000, actual_return: 120 }).value, 120));
  }
}

console.log('\none definition of the number, used by the total and the rows');
{
  ok('the matured total is summed with the same function the rows use',
     /a \+ randReturn\(i\)\.value/.test(CODE),
     'the header read actual ?? expected while the column beside it recomputed');
  ok('the row cell goes through it too', /randReturnCell\(i\)/.test(CODE));
  ok('and so does the CSV', /randReturn\(i\)\.value\.toFixed\(2\)/.test(CODE));
  ok('the old calculation is gone entirely',
     !/calcRandReturn/.test(CODE) && !/Utils\.effectiveRate\(i\) \|\| 0/.test(CODE),
     'leaving it callable is how a second caller finds it again');
  ok('nothing multiplies a rate by days/365 outside the projected branch',
     (CODE.match(/86400000 \/ 365/g) || []).length === 1,
     'the one remaining use is the last-resort projection from an annual target');
}

console.log('\nthe reader is told which kind of number each one is');
{
  ok('the rate column says whether it is achieved or a target',
     /b\.posted \? 'achieved' : 'p\.a\. target'/.test(CODE),
     '12.23% achieved over fourteen months and 12.23% a year looked identical');
  ok('it reads that from Utils.rateBasis rather than deciding for itself',
     /const b = Utils\.rateBasis\(i\)/.test(CODE));
  ok('an unsettled figure is marked on the row',
     /RETURN_MARK/.test(CODE) && /expected: '\*'/.test(CODE));
  ok('and the note explains both marks',
     /the expected return recorded when the investment was taken out/.test(DOCS) &&
     /projected from the annual target rate over the term/.test(DOCS));
  ok('the footer no longer gives the same mark a second meaning',
     !/Returns marked \* represent projected figures/.test(DOCS),
     "'*' meant one thing above the table and another below it");
  ok('the CSV carries the basis as its own column, not glued to the number',
     /'Return Basis'/.test(DOCS) && /'Rand Return Basis'/.test(DOCS) &&
     /RETURN_BASIS_LABEL/.test(CODE),
     'a percentage with markup in it is not a number a spreadsheet can sum');
  ok('randReturn is a declaration, so the total above it is not in the dead zone',
     /^\s*function randReturn\(i\) \{/m.test(CODE),
     'a const arrow here throws on every statement render');
}

/* ── Rendered ───────────────────────────────────────────────────────────── */
console.log('\nthe document, rendered');
if (!CHROME) {
  console.log('  SKIP  no headless Chromium');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'randret-'));
  fs.copyFileSync(path.join(ROOT, 'js', 'api.js'), path.join(tmp, 'api.js'));
  fs.copyFileSync(path.join(ROOT, 'js', 'investor-documents.js'), path.join(tmp, 'docs.js'));

  const DATA = {
    investor: { id: 'INV-000123', first_name: 'Test', last_name: 'Investor', email: 't@example.test' },
    period: { from: '2024-09-01', to: '2026-09-01' },
    opening_balance: 0, closing_balance: 0, transactions: [],
    investments: REPORTED.map((r, n) => ({ id: 'i' + n, ...r.inv, maturity_instruction: 'reinvest' }))
      .concat([
        { id: 'ix', status: 'matured', pool_name: 'Solar Investment - March 2025', product_type: 'solar',
          amount: 50000, expected_return: 6500, annual_rate: 0.13,
          start_date: '2025-03-01', maturity_date: '2026-03-01',
          pool_start_date: '2025-03-01', pool_end_date: '2025-03-31', maturity_instruction: 'withdraw' },
      ]),
  };
  /* 3576.30 + 411.68 + 4242.00 + 6500.00 */
  const EXPECT_TOTAL = 14729.98;

  const page = `<!DOCTYPE html><html><body><div id="doc"></div><div id="probe"></div>
<script>const ERRORS = []; window.onerror = m => ERRORS.push(String(m));<\/script>
<script src="./api.js"><\/script>
<script src="./docs.js"><\/script>
<script>
const out = { errors: ERRORS };
try {
  const html = SVCDocs.accountStatementHTML(${JSON.stringify(DATA).replace(/</g, '\\u003c')});
  document.getElementById('doc').innerHTML = html;
  out.rendered = 'ok';
} catch (e) { out.rendered = 'THREW: ' + e.message; }
const txt = document.getElementById('doc').textContent || '';
/* Located by HEADER NAME, not by column count or position. This filtered on
   "ten cells" and read fixed indexes, so changing a column on the matured
   table emptied it and reported a working Rand Return as missing. */
const mt = [...document.querySelectorAll('#doc table')].find(t => t.innerHTML.includes('Rand Return'));
const head = mt ? [...mt.querySelectorAll('th')].map(th => th.textContent.trim()) : [];
const iRand = head.indexOf('Rand Return');
const iRate = head.indexOf('Return');
const body = mt ? [...mt.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim())) : [];
out.headings = head;
out.randCol = iRand < 0 ? [] : body.map(c => c[iRand]);
out.rateCol = iRate < 0 ? [] : body.map(c => c[iRate]);
out.summary = (txt.match(/\\+ R [\\d\\s,.]+ return/) || [''])[0];
out.starMeaning = (txt.match(/represent projected figures/) || []).length;
out.hasNote = /Rand Return is the amount credited at maturity/.test(txt);
document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;
  fs.writeFileSync(path.join(tmp, 'p.html'), page);

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom',
      'file://' + path.join(tmp, 'p.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }

  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  let r = null;
  try {
    r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) { /* reported below */ }

  ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 300));
  if (r) {
    ok('the statement renders', r.rendered === 'ok', r.rendered);
    ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));

    const nums = (r.randCol || []).map(v => parseFloat(String(v).replace(/[^\d.]/g, '')) || 0);
    ok('every reported row now prints its maturity value',
       REPORTED.every(x => nums.some(n => near(n, x.inv.actual_return))),
       JSON.stringify(r.randCol));
    ok('and none of them prints the figure the client queried',
       REPORTED.every(x => !nums.some(n => near(n, x.shown))),
       JSON.stringify(r.randCol));
    ok('the header total is the sum of the rows on the page',
       near(parseFloat(String(r.summary).replace(/[^\d.]/g, '')), EXPECT_TOTAL),
       `${r.summary} — rows sum to ${nums.reduce((s, n) => s + n, 0).toFixed(2)}`);
    ok('the rate column states its basis on every row',
       (r.rateCol || []).every(v => /achieved|p\.a\. target/.test(v)),
       JSON.stringify(r.rateCol));
    ok('a row with only an expected return is marked',
       (r.randCol || []).some(v => v.includes('*')), JSON.stringify(r.randCol));
    ok('the note above the table is there', r.hasNote === true);
    ok("and '*' is defined once on the page", r.starMeaning === 0,
       'the footer used to give it a different meaning');
  }
  if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
