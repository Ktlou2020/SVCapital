#!/usr/bin/env node
/* The analytics tab must not present a partial answer as a complete one.
 *
 * Every KPI and chart on that page is computed in the browser from three
 * lists — investors, investments, transactions — fetched one page deep at
 * ANALYTICS_PAGE_LIMIT rows. Past that the arithmetic runs on a subset. The
 * charts still draw, the totals still look plausible, and they are wrong.
 * There is no symptom: a dashboard that is merely slow announces itself, one
 * that is quietly incomplete does not.
 *
 * The API has always returned `total` alongside the rows. Nothing compared
 * the two.
 *
 * This is a guard, not a fix — aggregates belong in SQL, the way
 * server/routes/analytics-extra.js already does them for the seven panels it
 * serves. What it guarantees is that nobody reports a number the page could
 * not have known.
 *
 * The banner logic is extracted from admin.js and exercised in headless
 * Chromium, so this tests the shipped function rather than a copy of it.
 *
 * Run: node scripts/check-analytics-truncation.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const admin = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const html  = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');

console.log('\nthe page compares what it read against what exists');
{
  const i = admin.indexOf('async function loadAnalytics(');
  const body = admin.slice(i, admin.indexOf('\n}\n', i));
  ok('loadAnalytics was found', i > -1);
  ok('it records totals from the fetch it just made',
     /total: Number\(invRes\.total\)/.test(body) &&
     /total: Number\(invstRes\.total\)/.test(body) &&
     /total: Number\(txnRes\.total\)/.test(body));
  ok('and probes for them when serving from cache',
     /API\.investors\.list\(\{ limit: 1 \}\)/.test(body),
     'a cached STATE has unknown provenance — it may be smaller than one page');
  ok('the guard runs on both paths, not just the fetch',
     (body.match(/_analyticsTruncation\(counts\)/g) || []).length === 1 &&
     body.indexOf('_analyticsTruncation(counts)') > body.indexOf('} else {'),
     'placing it inside the fetch branch would skip every cached load');
  ok('the page limit is named rather than repeated as a literal',
     /const ANALYTICS_PAGE_LIMIT = \d+/.test(admin) &&
     /limit: ANALYTICS_PAGE_LIMIT/.test(body));
}

console.log('\nthe banner exists to be written into');
ok('the analytics view has a container for it',
   /id="an-truncation"/.test(html));
ok('which starts hidden', /id="an-truncation" style="display:none/.test(html));

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — banner behaviour not exercised');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* Run the real function against a real DOM. */
const i = admin.indexOf('function _analyticsTruncation(');
const fn = admin.slice(i, admin.indexOf('\n}\n', i) + 3);
ok('the banner function was found', i > -1);

const page = `<!doctype html><meta charset="utf-8"><body>
<div id="an-truncation" style="display:none"></div>
<script>
const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
${fn}
var el = document.getElementById('an-truncation');
function probe(counts) {
  _analyticsTruncation(counts);
  return { shown: el.style.display !== 'none', text: el.textContent.replace(/\\s+/g,' ').trim() };
}
var results = {
  complete: probe([{label:'Investors',loaded:1200,total:1200},
                   {label:'Investments',loaded:900,total:900},
                   {label:'Transactions',loaded:4000,total:4000}]),
  truncated: probe([{label:'Investors',loaded:1200,total:1200},
                    {label:'Investments',loaded:900,total:900},
                    {label:'Transactions',loaded:5000,total:81234}]),
  twoShort: probe([{label:'Investors',loaded:5000,total:5001},
                   {label:'Investments',loaded:900,total:900},
                   {label:'Transactions',loaded:5000,total:81234}]),
  unknown: probe([{label:'Investors',loaded:1200,total:NaN},
                  {label:'Transactions',loaded:5000,total:NaN}]),
  clears: probe([{label:'Investors',loaded:10,total:10}]),
};
document.title = 'RESULTS' + JSON.stringify(results);
<\/script></body>`;

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-trunc-'));
const file = path.join(dir, 'trunc.html');
fs.writeFileSync(file, page);

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=3000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  console.log(`  ✗ chromium did not run: ${e.message}`);
  process.exit(1);
}
const m = dom.match(/<title>RESULTS(.*?)<\/title>/s);
if (!m) { console.log('  ✗ the page did not report results'); process.exit(1); }
const decode = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                     .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const r = JSON.parse(decode(m[1]));

console.log('\nand it fires only when something is actually missing');
ok('a complete read shows nothing', r.complete.shown === false, JSON.stringify(r.complete));
ok('a short read is called out', r.truncated.shown === true);
ok('in terms nobody can misread',
   /do not report them/i.test(r.truncated.text), r.truncated.text.slice(0, 120));
ok('naming the table and both numbers',
   /Transactions: using 5,000 of 81,234/.test(r.truncated.text), r.truncated.text.slice(0, 200));
ok('and how many rows were left out',
   /76,234 excluded/.test(r.truncated.text), r.truncated.text.slice(0, 200));
ok('two short tables are both listed',
   /Investors: using 5,000 of 5,001/.test(r.twoShort.text) &&
   /Transactions: using 5,000 of 81,234/.test(r.twoShort.text), r.twoShort.text.slice(0, 220));
ok('one row short still counts as short',
   /5,000 of 5,001/.test(r.twoShort.text),
   'off-by-one truncation is the hardest kind to notice by eye');
ok('an unknown total raises no false alarm',
   r.unknown.shown === false, JSON.stringify(r.unknown));
ok('the banner clears once the read is complete again',
   r.clears.shown === false, JSON.stringify(r.clears));

console.log('\nit says what is NOT affected, so the whole page is not distrusted');
ok('the server-side panels are named as unaffected',
   /revenue, maturity, IFA, sub-accounts,\s*interest history, withdrawals/.test(admin),
   'those come from analytics-extra.js and are aggregated in SQL');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
