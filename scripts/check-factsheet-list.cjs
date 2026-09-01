#!/usr/bin/env node
/* The factsheet archive has to stay scannable as it grows.
 *
 * It grows by one sheet a month, forever, and it was rendered flat: every
 * sheet a product has ever had, in whatever order the API returned them, each
 * labelled with its UPLOAD date — which for a bulk import is the same day for
 * all of them. Three years of "April 2025 - Factsheet" rows with identical
 * timestamps, no order to read them in, sitting ABOVE the one open pool the
 * investor came to the page for.
 *
 * Every claim below is checked against a rendered document rather than the
 * source, because the failure mode here is visual: a sort that silently does
 * nothing, a row hidden that should not be, an index that no longer lines up
 * with what opens when it is tapped.
 *
 * Run: node scripts/check-factsheet-list.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
const WEB  = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
const MOB  = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'js', 'portal.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The page order, in both portals ──────────────────────────────────
   Asserted on the source, because it is a fact about the markup's shape
   rather than about what any one fixture renders: the pools grid comes
   before the factsheet container. */
console.log('\nthe open pools come before the archive');
for (const [label, src] of [['web portal', WEB], ['mobile portal', MOB]]) {
  const pools = src.indexOf('id="productPoolsGrid"');
  const sheets = src.indexOf('id="prodFactsheets"');
  ok(`${label}: the pools grid is rendered first`,
     pools > -1 && sheets > -1 && pools < sheets,
     `pools at ${pools}, factsheets at ${sheets}`);
  ok(`${label}: and the archive is outside the product card`,
     sheets > src.indexOf('id="productPoolsGrid"'),
     'inside the card it sat above the pools, which is the bug');
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the list was not rendered');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
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

/* _esc lives in each platform's portal.js, not in the shared core, so it is
   taken from the shipped web portal rather than restated here — a local copy
   that escapes differently would prove nothing about the real page. */
const ESC = (WEB.match(/^const _esc = .*$/m) || [])[0];
if (!ESC) { console.log('  ✗ _esc not found in portal/js/portal.js'); process.exit(1); }

/* Fourteen sheets: deliberately out of order, with a duplicate, upload dates
   that are all the same day (the bulk-import shape), and one named in a way
   the month parser cannot read. */
const SHEETS = [
  { pool_id: 'P1', file_url: 'u/apr2025.pdf', file_name: 'April 2025 - Factsheet',    created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'P2', file_url: 'u/oct2025.pdf', file_name: 'October 2025 - Factsheet',  created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'P3', file_url: 'u/oct2023.pdf', file_name: 'October 2023 - Factsheet',  created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'P4', file_url: 'u/jun2026.pdf', file_name: 'June 2026 - Factsheet',     created_at: '2026-07-30T00:00:00Z' },
  { pool_id: 'P5', file_url: 'u/aug2026.pdf', file_name: 'August 2026 - Factsheet',   created_at: '2026-08-24T00:00:00Z' },
  { pool_id: 'P6', file_url: 'u/apr2024.pdf', file_name: 'April 2024 - Factsheet',    created_at: '2026-08-21T00:00:00Z' },
  /* The same file, reached through a second pool. It rendered twice, with
     nothing on either row to tell them apart. */
  { pool_id: 'P7', file_url: 'u/apr2024.pdf', file_name: 'April 2024 - Factsheet',    created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'P8', file_url: 'u/feb2026.pdf', file_name: 'February 2026 - Factsheet', created_at: '2026-07-30T00:00:00Z' },
  { pool_id: 'P9', file_url: 'u/aug2023.pdf', file_name: 'August 2023 - Factsheet',   created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'PA', file_url: 'u/jan2026.pdf', file_name: 'January 2026 - Factsheet',  created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'PB', file_url: 'u/mar2025.pdf', file_name: 'March 2025 - Factsheet',    created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'PC', file_url: 'u/dec2024.pdf', file_name: 'December 2024 - Factsheet', created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'PD', file_url: 'u/sep2024.pdf', file_name: 'Sept 2024 - Factsheet',     created_at: '2026-08-21T00:00:00Z' },
  { pool_id: 'PE', file_url: 'u/notes.pdf',   file_name: 'Herd health notes',         created_at: '2026-08-21T00:00:00Z' },
];

const PRODUCT = {
  product_type: 'cattle', label: 'Cattle Investment',
  factsheet_url: 'u/product.pdf', factsheet_name: 'Cattle Investment factsheet',
  updated_at: '2026-08-25T00:00:00Z',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fslist-'));
fs.writeFileSync(path.join(tmp, 'stub.js'), `
${ESC}
let _fsDocCache = [];
${sliceFn(CORE, '_fsMonths')}
${sliceFn(CORE, '_fsCollapsedCount')}
${sliceFn(CORE, '_fsSearchAt')}
${sliceFn(CORE, '_fsPeriod')}
${sliceFn(CORE, '_fsUploaded')}
${sliceFn(CORE, '_fsCompare')}
${sliceFn(CORE, '_fsYear')}
${sliceFn(CORE, '_fsApplyVisibility')}
${sliceFn(CORE, '_toggleFsList')}
${sliceFn(CORE, '_filterFsRows')}
${sliceFn(CORE, '_renderProductFactsheets')}
const Utils = { date: d => new Date(d).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' }) };
const PORTAL = { pools: ${JSON.stringify(SHEETS.map(s => ({ id: s.pool_id, product_type: 'cattle' })))} };
const API = { _fetch: async () => ({ data: SHEETS }) };
window.__opened = null;
function _openFsDoc(i) { window.__opened = (_fsDocCache[i] || {}).file_name || null; }
`);

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="prodFactsheets"></div><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));<\/script>
<script>const SHEETS = ${JSON.stringify(SHEETS).replace(/</g, '\\u003c')};<\/script>
<script src="./stub.js"><\/script>
<script>
const PRODUCT = ${JSON.stringify(PRODUCT).replace(/</g, '\\u003c')};
const out = { errors: ERRORS };
const rows = () => [...document.querySelectorAll('[data-fs-kind="row"]')];
const visible = () => rows().filter(r => r.style.display !== 'none');
const nameOf = r => (r.querySelector('.fs-row__name').textContent || '').trim();

(async () => {
  try { await _renderProductFactsheets('cattle', PRODUCT); out.built = 'ok'; }
  catch (e) { out.built = 'THREW: ' + e.message; }

  const txt = (document.getElementById('prodFactsheets').textContent || '').replace(/\\s+/g, ' ');
  out.total       = rows().length;
  out.order       = rows().map(nameOf);
  out.years       = [...document.querySelectorAll('[data-fs-kind="year"]')].map(y => y.textContent.trim());
  out.visibleFirst= visible().map(nameOf);
  out.countShown  = /Factsheets & documents 14/.test(txt) || / 14 /.test(txt);
  out.uploadLabel = /Uploaded/.test(txt);
  out.hasSearch   = !!document.getElementById('fsFilter');
  out.toggleText  = (document.getElementById('fsToggle') || {}).textContent || '';

  // Expand
  _toggleFsList();
  out.expandedCount = visible().length;
  out.expandedToggle= (document.getElementById('fsToggle') || {}).textContent || '';
  _toggleFsList();
  out.recollapsed   = visible().length;

  // Search
  document.getElementById('fsFilter').value = '2024'; _filterFsRows();
  out.search2024    = visible().map(nameOf);
  out.toggleHidden  = (document.getElementById('fsToggle') || {}).style.display === 'none';
  document.getElementById('fsFilter').value = 'nothing at all'; _filterFsRows();
  out.emptyShown    = document.getElementById('fsEmpty').style.display !== 'none';
  out.emptyRows     = visible().length;
  document.getElementById('fsFilter').value = ''; _filterFsRows();
  out.afterClear    = visible().length;

  // The index still opens the row it is on
  const target = visible()[1];
  target.querySelector('.fs-row__icon').click ? null : null;
  target.click();
  out.openedName    = window.__opened;
  out.clickedName   = nameOf(target);

  out.undef = (txt.match(/undefined/g) || []).length;
  out.nan   = (txt.match(/NaN/g) || []).length;
})().catch(e => { out.probeError = String(e && e.message || e); })
  /* The probe is written whatever happens. Without this a throw anywhere in
     the block above left the div empty and the check reported only "the page
     reported: ✗", with the actual error nowhere on screen. */
  .then(() => { document.getElementById('probe').textContent = JSON.stringify(out); });
<\/script></body></html>`;
fs.writeFileSync(path.join(tmp, 'p.html'), page);

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=6000', '--dump-dom', 'file://' + path.join(tmp, 'p.html')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
} catch (err) { dom = (err.stdout || '').toString(); }

const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
let r = null;
try {
  r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
} catch (_) { /* reported below */ }

console.log('\nthe archive, rendered');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 400));

if (r) {
  ok('it builds', r.built === 'ok', r.built);
  ok('nothing threw', (r.errors || []).length === 0 && !r.probeError,
     JSON.stringify(r.errors) + (r.probeError ? ` / ${r.probeError}` : ''));

  console.log('\nthe same file is listed once');
  ok('fourteen sheets and one duplicate become fourteen rows',
     r.total === 14, `${r.total} rows — 13 unique sheets plus the product one`);
  ok('and "April 2024" appears exactly once',
     r.order.filter(n => /April 2024/.test(n)).length === 1,
     JSON.stringify(r.order.filter(n => /April 2024/.test(n))));

  console.log('\nnewest first, by the period the sheet is about');
  /* Not by upload date: nine of these were uploaded on the same day, and the
     one uploaded most recently (August 2026) is not the newest period. */
  ok('the current product sheet is pinned at the top',
     /Current/.test(r.order[0] || ''), r.order[0]);
  ok('then August 2026, the most recent period',
     /August 2026/.test(r.order[1] || ''), r.order[1]);
  ok('then June 2026', /June 2026/.test(r.order[2] || ''), r.order[2]);
  ok('then February 2026', /February 2026/.test(r.order[3] || ''), r.order[3]);
  ok('and the oldest period, August 2023, is last of the dated sheets',
     /August 2023/.test(r.order[r.order.length - 2] || '') &&
     /October 2023/.test(r.order[r.order.length - 3] || ''),
     JSON.stringify(r.order.slice(-3)));
  /* Its upload date is more recent than every dated sheet's period. Using the
     upload date as the fallback put it at the very top of the archive — two
     different meanings compared on one numeric scale. */
  ok('a sheet with no readable period sorts last rather than to the top',
     r.order.some(n => /Herd health notes/.test(n)) &&
     /Herd health notes/.test(r.order[r.order.length - 1] || ''),
     r.order[r.order.length - 1]);
  ok('an abbreviated month is still read — "Sept 2024" sits in 2024',
     r.order.indexOf(r.order.find(n => /Sept 2024/.test(n))) <
     r.order.indexOf(r.order.find(n => /October 2023/.test(n))),
     JSON.stringify(r.order));

  console.log('\ngrouped by year, so the list can be scanned');
  ok('year headings are present, descending, with the undated ones under "Other"',
     JSON.stringify(r.years) === JSON.stringify(['2026', '2025', '2024', '2023', 'Other']),
     JSON.stringify(r.years));

  console.log('\nthe long list is collapsed until asked for');
  ok(`only ${r.visibleFirst.length} rows show at rest`, r.visibleFirst.length === 4,
     JSON.stringify(r.visibleFirst));
  ok('and those are the newest ones', /Current/.test(r.visibleFirst[0] || '') &&
     /August 2026/.test(r.visibleFirst[1] || ''), JSON.stringify(r.visibleFirst));
  ok('the control says how many there are',
     /Show all 14 factsheets/.test(r.toggleText), r.toggleText);
  ok('expanding shows all of them', r.expandedCount === 14, String(r.expandedCount));
  ok('and the control then offers to collapse',
     /Show fewer/.test(r.expandedToggle), r.expandedToggle);
  ok('collapsing again returns to four', r.recollapsed === 4, String(r.recollapsed));

  console.log('\nsearch reaches the whole archive, not just what is on screen');
  ok('a search box appears once the list is long', r.hasSearch === true);
  ok('"2024" finds every 2024 sheet, including collapsed ones',
     r.search2024.length === 3 && r.search2024.every(n => /2024/.test(n)),
     JSON.stringify(r.search2024));
  ok('and the expand control is hidden while searching', r.toggleHidden === true,
     'it is not the collapse limiting the list then, and saying so would mislead');
  ok('a search with no matches says so', r.emptyShown === true && r.emptyRows === 0,
     `${r.emptyRows} rows visible`);
  ok('clearing the search restores the collapsed view', r.afterClear === 4,
     String(r.afterClear));

  console.log('\nthe row that is tapped is the row that opens');
  /* The rows are sorted and de-duplicated after the list arrives, so the index
     baked into each onclick has to be the index into the sorted cache. Off by
     one here opens the wrong document, silently. */
  ok('the second visible row opens its own document',
     !!r.openedName && r.openedName === r.clickedName,
     `clicked "${r.clickedName}", opened "${r.openedName}"`);

  console.log('\nand the rows read properly');
  ok('the upload date is labelled as an upload date', r.uploadLabel === true,
     'unlabelled it read as the period the sheet covers, which it is not');
  ok('nothing renders as "undefined"', r.undef === 0, String(r.undef));
  ok('and none as NaN', r.nan === 0, String(r.nan));
}

if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
