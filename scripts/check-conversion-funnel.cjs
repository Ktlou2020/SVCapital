#!/usr/bin/env node
/* The analytics conversion funnel, computed from data shaped like the real book.
 *
 * Every figure on that panel was wrong in the same two ways, and both are
 * invisible on tidy fixtures:
 *
 *   A ROLLOVER IS NOT A DECISION. maturityCron writes a fresh investments row
 *   every time a holding matures and reinvests. Counting rows counted the
 *   engine's own writes as client behaviour: an investor who invested once and
 *   auto-reinvested four times showed as a repeat investor, so "retention" was
 *   largely the maturity engine looking at itself.
 *
 *   THE DATE A ROW WAS WRITTEN IS NOT THE DATE THE MONEY MOVED. A ledger
 *   imported in one batch has the same created_at on every row, so "avg days to
 *   invest" measured the gap between two copies of the import timestamp and
 *   read 0d.
 *
 * The fixture below is therefore migration-shaped on purpose: created_at is one
 * timestamp for everything, and start_date carries the truth. A fixture where
 * the two agree cannot tell the fix from the bug.
 *
 * Run: node scripts/check-conversion-funnel.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

if (!CHROME) {
  console.log('  SKIP  no headless Chromium — the panel was not rendered');
  process.exit(0);
}

function sliceFn(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`));
  if (at < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('(', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  i = src.indexOf('{', i); depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* Everything was written to the database on this day. Nothing happened on it. */
const IMPORTED = '2026-08-21T00:00:00Z';

/* Four investors, and what each is here to prove:

   A  signed up 1 Jan, invested 31 Jan (30 days), then auto-reinvested twice.
      One decision, three rows. Not a repeat investor.
   B  signed up 1 Jan, invested 21 Jan (20 days) and again 1 Mar. Two
      decisions — the only genuine repeat investor here.
   C  signed up 1 Jan, never invested.
   D  signed up 1 Feb, holds only a rollover from a migrated holding. No
      decision on record, so no first investment and no days-to-invest. */
const INVESTORS = [
  { id: 'A', date_joined: '2026-01-01T00:00:00Z', created_at: IMPORTED, status: 'active', fica_status: 'approved' },
  { id: 'B', date_joined: '2026-01-01T00:00:00Z', created_at: IMPORTED, status: 'active', fica_status: 'approved' },
  { id: 'C', date_joined: '2026-01-01T00:00:00Z', created_at: IMPORTED, status: 'active', fica_status: 'approved' },
  { id: 'D', date_joined: '2026-02-01T00:00:00Z', created_at: IMPORTED, status: 'active', fica_status: 'approved' },
];

const INVESTMENTS = [
  { id: 'A1', investor_id: 'A', amount: '10000', status: 'active',  product_type: 'cattle',
    start_date: '2026-01-31', created_at: IMPORTED, is_reinvestment: false },
  { id: 'A2', investor_id: 'A', amount: '10500', status: 'matured', product_type: 'cattle',
    start_date: '2026-04-30', created_at: IMPORTED, is_reinvestment: true },
  { id: 'A3', investor_id: 'A', amount: '11000', status: 'active',  product_type: 'cattle',
    start_date: '2026-07-31', created_at: IMPORTED, is_reinvestment: true },
  { id: 'B1', investor_id: 'B', amount: '50000', status: 'active',  product_type: 'short_term',
    start_date: '2026-01-21', created_at: IMPORTED, is_reinvestment: false },
  { id: 'B2', investor_id: 'B', amount: '20000', status: 'active',  product_type: 'short_term',
    start_date: '2026-03-01', created_at: IMPORTED, is_reinvestment: false },
  { id: 'D1', investor_id: 'D', amount: '90000', status: 'active',  product_type: 'short_term',
    start_date: '2026-03-15', created_at: IMPORTED, is_reinvestment: true },
  /* A cancelled holding, which is not money under management. */
  { id: 'B3', investor_id: 'B', amount: '999999', status: 'cancelled', product_type: 'cattle',
    start_date: '2026-02-01', created_at: IMPORTED, is_reinvestment: false },
];

const TRANSACTIONS = [
  { id: 'T1', investor_id: 'A', type: 'deposit', status: 'completed', amount: '10100' },
  { id: 'T2', investor_id: 'B', type: 'deposit', status: 'completed', amount: '70700' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-'));
fs.writeFileSync(path.join(tmp, 'stub.js'), `
${(ADMIN.match(/^const _esc = .*$/m) || [])[0]}
const STATE = {
  investors:    ${JSON.stringify(INVESTORS)},
  investments:  ${JSON.stringify(INVESTMENTS)},
  transactions: ${JSON.stringify(TRANSACTIONS)},
};
${sliceFn(ADMIN, 'renderConversionFunnel')}
`);

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="funnelPanel"></div><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));<\/script>
<script src="./stub.js"><\/script>
<script>
const out = { errors: ERRORS };
try { renderConversionFunnel(); out.built = 'ok'; } catch (e) { out.built = 'THREW: ' + e.message; }
const txt = (document.getElementById('funnelPanel').textContent || '').replace(/\\s+/g, ' ');
out.len = txt.length;

/* The stage rows, read as label -> count. */
const rows = [...document.querySelectorAll('#funnelPanel > div:first-child > div')];
out.stages = {};
rows.forEach(r => {
  const label = (r.querySelector('span:nth-of-type(2)') || {}).textContent;
  const spans = [...r.querySelectorAll('span')].map(s => s.textContent.trim());
  const nums  = spans.filter(s => /^[0-9,]+$/.test(s));
  if (label) out.stages[label.trim()] = Number((nums[0] || '0').replace(/,/g, ''));
});

/* The summary tiles, read as label -> value. */
out.tiles = {};
[...document.querySelectorAll('#funnelPanel div[style*="border-radius:8px"]')].forEach(t => {
  const kids = [...t.children].map(c => c.textContent.trim());
  if (kids.length >= 2) out.tiles[kids[0]] = kids[1];
});
out.tileSubs = {};
[...document.querySelectorAll('#funnelPanel div[style*="border-radius:8px"]')].forEach(t => {
  const kids = [...t.children].map(c => c.textContent.trim());
  if (kids.length >= 3) out.tileSubs[kids[0]] = kids[2];
});

out.undef = (txt.match(/undefined/g) || []).length;
out.nan   = (txt.match(/NaN/g) || []).length;
document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;
fs.writeFileSync(path.join(tmp, 'p.html'), page);

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.join(tmp, 'p.html')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
} catch (err) { dom = (err.stdout || '').toString(); }

const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
let r = null;
try {
  r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
} catch (_) {}

console.log('\nthe funnel renders');
ok('the panel reported', !!r, (m ? m[1] : dom).slice(0, 300));

if (r) {
  ok('it builds', r.built === 'ok', r.built);
  ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));

  console.log('\na rollover is the engine acting, not a client deciding');
  /* A invested once and auto-reinvested twice; B invested twice; D holds only a
     rollover. Counting rows gave three investors with 2+ "investments". */
  ok('an investor with one investment and two rollovers is not a repeat investor',
     r.stages['Repeat Investor'] === 1,
     `${r.stages['Repeat Investor']} — only B invested twice by choice`);
  ok('and retention is the share who chose to invest again',
     r.tiles['Retention'] === '50%',
     `${r.tiles['Retention']} — B out of A and B`);
  ok('the label says so, rather than "made 2+ investments"',
     /chose to invest 2\+ times/.test(r.tileSubs['Retention'] || ''),
     r.tileSubs['Retention']);
  ok('an investor holding only a rollover has made no first investment',
     r.stages['First Investment'] === 2,
     `${r.stages['First Investment']} — A and B; D only holds a rollover`);

  console.log('\ndays to invest is measured on the dates things happened');
  /* Every created_at is the import timestamp. Measured on those, this is 0d. */
  ok('it is not zero on a migrated book',
     r.tiles['Avg days to invest'] === '25d',
     `${r.tiles['Avg days to invest']} — A took 30 days, B took 20, mean 25`);
  ok('and the sample size is shown beside it',
     /2 investors/.test(r.tileSubs['Avg days to invest'] || ''),
     `${r.tileSubs['Avg days to invest']} — a mean over two people reads like a mean over two hundred`);

  console.log('\nthe first investment is the first one the client chose');
  ok('the average is over new money only',
     r.tiles['Avg 1st Invest'] === 'R30 000' || r.tiles['Avg 1st Invest'] === 'R30,000',
     `${r.tiles['Avg 1st Invest']} — A's R10 000 and B's R50 000`);
  ok('and the top pool is the product they chose first',
     /cattle|short term/i.test(r.tiles['Top pool'] || ''),
     r.tiles['Top pool']);

  console.log('\nAUM is the money under management');
  /* A1 10 000 + A3 11 000 + B1 50 000 + B2 20 000 + D1 90 000 = 181 000.
     A2 is matured and B3 cancelled, so neither counts. */
  ok('active investments only, rollovers included because they are still invested',
     (r.tiles['Total AUM'] || '').replace(/[^0-9]/g, '') === '181000',
     r.tiles['Total AUM']);

  console.log('\nnothing renders as undefined or NaN');
  ok('no field renders as "undefined"', r.undef === 0, String(r.undef));
  ok('and none as NaN', r.nan === 0, String(r.nan));
}

console.log('\nan empty funnel and a broken one are told apart');
{
  ok('a failure names the error and offers a retry',
     /Could not load the investment funnel/.test(ADMIN) && /onclick="loadInvestFunnel\(\)"/.test(ADMIN),
     'every failure used to draw "No funnel data yet", so a 500 read as a quiet marketplace');
  ok('and an empty window says it is empty, and over what window',
     /No marketplace activity in the last/.test(ADMIN));
  /* Comments stripped first: the phrase survives in the comment explaining why
     it was removed, and an assertion that trips over its own documentation is
     an assertion nobody keeps. */
  const CODE = ADMIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the old catch-all message is gone from the code',
     !/No funnel data yet/.test(CODE));
}

if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
