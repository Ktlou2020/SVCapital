#!/usr/bin/env node
/* The Cattle console's views must actually draw.
 *
 * Everything else about this corner was proved by arithmetic or by hitting the
 * API. This is the other half: a renderer that throws leaves a spinner on the
 * screen forever and reports nothing, and a template literal that references a
 * field that no longer exists throws at render time, not at parse time. The
 * reconciliation view is new, the NAV dashboard and the animals table were both
 * rewired to read a different array, and a source scan cannot tell you whether
 * any of them survives contact with data.
 *
 * So: the shipped renderers, the shipped stylesheet, real-shaped rows, in a
 * real browser — and then read what ended up on the page.
 *
 * Run: node scripts/check-cattle-console-renders.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'cattle.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'fund', 'cattle.html'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'fund', 'css', 'cattle.css'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

if (!CHROME) {
  console.log('  SKIP  no headless Chromium — the console was not rendered');
  process.exit(0);
}

/* The page's own body, minus the scripts: the real view containers and the real
   sidebar, so a renderer writing to a missing element fails here rather than in
   production. */
const body = HTML
  .replace(/[\s\S]*<body>/, '')
  .replace(/<\/body>[\s\S]*/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');

/* Rows shaped like the database's: NUMERIC arrives as a string from node-pg and
   reaches these renderers unchanged, and a renderer that only ever saw numbers
   in a unit test is exactly how "R9,000 sorts above R10,000" happens. */
const FIXTURE = {
  cycles: [
    { id: 'C1', batch_name: 'Batch 685 - Agrifund', company: 'Agrifund', status: 'active',
      cycle_start_date: new Date(Date.now() - 100 * 86400000).toISOString(),
      no_purchased: 100, no_live: 98, no_sold: 0, mortalities: 2,
      purchase_value: '1000000.00', net_return_pct: null, inv_no: '66723', cycle_no: 'Cycle 5' },
    { id: 'C2', batch_name: "O'Brien & Sons <Batch 12>", company: 'SVC Farming', status: 'sold',
      cycle_start_date: new Date(Date.now() - 300 * 86400000).toISOString(),
      sale_date: new Date(Date.now() - 10 * 86400000).toISOString(), days_in_cycle: 120,
      no_purchased: 50, no_live: 0, no_sold: 49, mortalities: 1,
      purchase_value: '480000.00', total_selling_price: '552000.00', net_return_pct: '15.0000' },
  ],
  animals: [
    { id: 'A1', tag_number: 'ZA-001', batch_no: 'Batch 685', batch_name: 'Batch 685 - Agrifund',
      cycle_id: 'C1', entry_mass: '210.00', exit_mass: null, breed: 'Bonsmara', gender: 'Steer', status: 'active' },
    { id: 'A2', tag_number: 'ZA-002', batch_no: 'Batch 685', batch_name: 'Batch 685 - Agrifund',
      cycle_id: 'C1', entry_mass: '225.50', exit_mass: '318.00', breed: 'Angus', gender: 'Heifer',
      status: 'sold', sold: 'true', sale_batch: 'Lot 3', sale_date: '2026-07-14' },
    { id: 'A3', tag_number: 'ZA-003', batch_name: 'Batch 685 - Agrifund', cycle_id: null,
      entry_mass: '198.00', breed: null, gender: null, status: 'active' },
  ],
  costs: [
    { id: 'CC1', cycle_id: 'C1', category: 'feed', amount: '240000.00', description: 'Bulk feed',
      date: '2026-06-01', vendor: 'Feedlot Co', invoice_ref: 'INV-1', per_animal: '2400.00',
      animals_count: 100, status: 'paid' },
    { id: 'CC2', cycle_id: 'C1', category: 'vet', amount: '15000.00', description: null,
      date: '2026-06-20', vendor: null, invoice_ref: null, status: 'pending' },
  ],
  recon: {
    mismatched: [{ id: 'C1', batchName: 'Batch 685 - Agrifund', company: 'Agrifund', status: 'active',
      header: { purchased: 100, live: 98, sold: 0, mortalities: 2 },
      counted: { purchased: 3, live: 2, sold: 1, mortalities: 0 },
      purchaseValue: 1000000, liveDelta: -96, severity: 'high',
      checks: [{ key: 'purchased', label: 'Purchased', header: 100, counted: 3, delta: -97 },
               { key: 'live', label: 'Live', header: 98, counted: 2, delta: -96 }] }],
    headerOnly: [{ id: 'C2', batchName: "O'Brien & Sons <Batch 12>", company: 'SVC Farming',
      status: 'sold', header: { purchased: 50, live: 0, sold: 49, mortalities: 1 }, purchaseValue: 480000 }],
    imbalanced: [{ id: 'C1', batchName: 'Batch 685 - Agrifund',
      header: { purchased: 100, live: 98, sold: 0, mortalities: 2 },
      imbalance: { purchased: 100, accounted: 100, delta: 0 } }],
    orphans: [{ id: 'A3', tagNumber: 'ZA-003', batchName: 'Batch 685 - Agrifund', batchNo: null,
      status: 'active', matchedCycle: 'C1', matchedBatch: 'Batch 685 - Agrifund' },
      { id: 'A9', tagNumber: 'ZA-009', batchName: 'Gone', batchNo: null, status: 'active',
        matchedCycle: null, matchedBatch: null }],
    relinkable: [{ id: 'A3', tagNumber: 'ZA-003', matchedCycle: 'C1', matchedBatch: 'Batch 685 - Agrifund' }],
    totals: { cycles: 2, mismatched: 1, headerOnly: 1, imbalanced: 1, orphans: 2, relinkable: 1,
              liveOverstated: 96, liveUnderstated: 0 },
    verdict: 'found',
  },
};

/* The shipped script, with its network calls and its DOMContentLoaded bootstrap
   replaced. Everything else — every renderer, the NAV engine, the formatters —
   is the code that ships. */
const stubbed = SRC
  .replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);\n/, '')
  .replace(/^async function apiFetch[\s\S]*?^\}$/m,
    'async function apiFetch(){ throw new Error("no network in this check"); }');

const page = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
${body}
<div id="probe"></div>
<script>
window.Chart = function(){ return { destroy(){} }; };
const ERRORS = [];
window.onerror = (m) => { ERRORS.push(String(m)); };
</script>
<script>
${stubbed}
<\/script>
<script>
const F = ${JSON.stringify(FIXTURE)};
const out = { errors: ERRORS };
function run(label, fn) { try { fn(); out[label] = 'ok'; } catch (e) { out[label] = 'THREW: ' + e.message; } }

S.navSettings = { live_cattle_price_per_kg: 42.5, avg_daily_weight_gain_kg: 1.2,
                  feedlot_cost_per_day_per_head: 28, svc_standing_fee_per_day_per_head: 3.5 };
S.cycles = F.cycles; S.allAnimals = F.animals; S.costs = F.costs;
S.animals = F.animals; S.animalTotal = 3; S.animalPages = 1;
S.animalStats = { total: 3, sold: 1, mortalities: 0, avg_mass: '211.2', avg_gain: '92.5', weighed: 1 };
S.animalBatches = ['Batch 685']; S.animalBreeds = ['Bonsmara', 'Angus'];
S._costCache = F.costs; S._recon = F.recon;

run('cycles',   () => renderCyclesView());
run('animals',  () => renderAnimalsView());
run('costs',    () => renderCostsView(F.costs));
run('reconcile',() => renderReconciliation());

out.reconcileHtml = (document.getElementById('view-reconcile')||{}).innerHTML || '';
out.cyclesHtml    = (document.getElementById('view-cycles')||{}).innerHTML || '';
out.animalsHtml   = (document.getElementById('view-animals')||{}).innerHTML || '';
out.costsRows     = (document.getElementById('costLedgerBody')||{}).innerHTML || '';
out.costTotal     = (document.getElementById('cost-total')||{}).textContent || '';

/* Nothing may render the literal "undefined" or "NaN" — every one of those is a
   field the renderer expected and the row did not carry. */
const all = out.reconcileHtml + out.cyclesHtml + out.animalsHtml + out.costsRows;
out.undefinedCount = (all.match(/undefined/g) || []).length;
out.nanCount       = (all.match(/NaN/g) || []).length;
/* A script tag anywhere in rendered output means an unescaped value reached the
   DOM as markup. The fixture carries < > and an apostrophe for exactly this. */
out.injected = /<script/i.test(all);
out.escapedName = all.includes('O&#39;Brien') || all.includes("O'Brien");
out.rawAngle = all.includes('<Batch 12>');

document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cattle-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, page);
if (process.env.DUMP) console.log('page written to', file);

let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=6000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
} catch (err) { dom = (err.stdout || '').toString(); }

const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
let r = null;
try {
  r = JSON.parse((m ? m[1] : '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
} catch (_) { /* reported below */ }

console.log('\nthe console, rendered');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 400));

if (r) {
  ok('nothing threw while the script loaded', (r.errors || []).length === 0, JSON.stringify(r.errors));
  for (const view of ['cycles', 'animals', 'costs', 'reconcile'])
    ok(`the ${view} view renders`, r[view] === 'ok', r[view]);

  console.log('\nwhat ended up on the page');
  ok('no field renders as the word "undefined"', r.undefinedCount === 0,
     `${r.undefinedCount} — each one is a column the renderer expects and the row does not have`);
  ok('and none as NaN', r.nanCount === 0, String(r.nanCount));

  ok('the cost ledger shows the amounts it was given', /R\s?240[\s,]?000/.test(r.costsRows),
     r.costsRows.slice(0, 200));
  ok('and totals them', /240|255/.test(r.costTotal), r.costTotal);
  ok('a cost row names its cycle from the cycle, not from a stored copy',
     r.costsRows.includes('Batch 685 - Agrifund'), r.costsRows.slice(0, 300));

  ok('the animals table shows an exit mass where one exists',
     /318/.test(r.animalsHtml), 'exit mass had no column and could never be shown');
  ok('and the average gain the herd achieved', /92|93/.test(r.animalsHtml));

  console.log('\nthe reconciliation says what it found');
  ok('it names the cycle whose header disagrees',
     r.reconcileHtml.includes('Batch 685 - Agrifund'));
  ok('it shows the header count and the counted one side by side',
     />98</.test(r.reconcileHtml) && />2</.test(r.reconcileHtml), 'live: header 98, on file 2');
  ok('it totals the head NAV cannot point at', /96/.test(r.reconcileHtml));
  ok('it separates the orphan that can be relinked from the one that cannot',
     r.reconcileHtml.includes('needs a person') && r.reconcileHtml.includes('ZA-003'));
  ok('and offers to relink only the matched ones', /Relink 1 matched orphan/.test(r.reconcileHtml));

  console.log('\nvalues from the database are text, not markup');
  ok("an apostrophe in a batch name renders as text", r.escapedName === true);
  ok('angle brackets do not become an element', r.injected === false && r.rawAngle === false,
     `injected=${r.injected} rawAngle=${r.rawAngle}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
