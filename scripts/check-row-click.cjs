#!/usr/bin/env node
/* Clicking an investment row opens its detail — and clicking a control inside
 * that row does not.
 *
 * Making a <tr> clickable puts every control inside it under the same handler.
 * A bulk-select checkbox that also opens a modal, or a "move to pool" button
 * that opens the detail behind the move dialog, are both one forgotten
 * stopPropagation away, and neither is obvious from reading the template.
 *
 * So this does not read the source and reason about it: it renders the real
 * row markup extracted from admin.js, loads it in headless Chromium, clicks
 * each element for real, and reports which handlers fired.
 *
 * Run: node scripts/check-row-click.cjs
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
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ''}`); }
};

if (!CHROME) {
  console.log('  SKIP  no headless Chromium found — see header');
  process.exit(0);
}

/* Pull the two row templates straight out of admin.js so this tests the
   shipped markup, not a copy that can drift from it. */
function extractRow(marker, endMarker) {
  const src = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const end = src.indexOf(endMarker, start);
  if (end < 0) return null;
  return src.slice(start, end + endMarker.length);
}

/* Anchored on the const each template builds its handler from, not on the <tr>
   attributes. Two of these rows now open with the same `<tr tabindex="0"
   style="cursor:pointer"` prefix, so a marker on that prefix silently captured
   whichever came first in the file and tested it twice — a check that passes
   while looking at the wrong row is worse than one that fails. The const names
   are unique per template.

   The captured text is a statement sequence (`const … ; return \`<tr …\``),
   so renderRow evaluates it as a function body rather than an expression. */
const LIST_ROW = extractRow('const _openRow = ', '</tr>`');
const TAB_ROW  = extractRow('const _open = ', '</tr>`');
const POOL_ROW = extractRow('`<tr style="cursor:pointer;${isCancelled', '</tr>`');

ok('the All Investments row template was found', !!LIST_ROW);
ok('the investor-tab row template was found', !!TAB_ROW);
ok('the pool-investors row template was found', !!POOL_ROW);
if (!LIST_ROW || !TAB_ROW || !POOL_ROW) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

/* Evaluate a template against a stub environment to get real HTML. */
function renderRow(tpl, extraVars) {
  const scope = {
    i: { id: 'INV-1', investor_id: 'S-1105', investor_name: 'Jacenter Tloubatla',
         pool_id: 'POOL-1', pool_name: 'Short Term Investment - March 2026',
         amount: '24744.77', annual_rate: '0.0000', pool_actual_rate: '0.0213',
         status: 'active', start_date: '2026-03-31', end_date: '2026-08-31',
         created_at: '2026-03-31', product_type: 'short_term' },
    pi: { label: 'Short Term Investment', badgeClass: 'badge--orange', icon: 'fa-bolt' },
    invName: 'Jacenter Tloubatla',
    investDate: '2026-03-31',
    Utils: {
      date: () => '31 Mar 2026', rand: v => 'R ' + v,
      pct: v => (Number(v) * 100).toFixed(2) + '%',
      statusBadge: () => '<span class="badge">ACTIVE</span>',
      productInfo: () => ({ label: 'Short Term Investment', badgeClass: 'badge--orange', icon: 'fa-bolt' }),
      rateCell: () => '<span>2.13%</span>',
    },
    _esc: s => String(s == null ? '' : s),
    ...extraVars,
  };
  const names = Object.keys(scope);
  /* A template that already contains `return` is a body; a bare `\`<tr …\``
     is an expression. Both appear here, so wrap only the second. */
  const body = /(^|\n)\s*return\s/.test(tpl) ? `${tpl};` : `return ${tpl};`;
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map(n => scope[n]));
}

const listHtml = renderRow(LIST_ROW);
const tabHtml  = renderRow(TAB_ROW, { id: 'S-1105' });
/* The pool-investors row is a different shape: its record is one investment
   joined to its investor, and the id that matters is investment_id. */
const poolHtml = renderRow(POOL_ROW, {
  isCancelled: false,
  _currentPoolId: 'POOL-1',
  r: { investment_id: 'INV-1', investor_id: 'S-1105', email: 'saki@example.test',
       amount: '147380.00', upfront_fee: 0, platform_fee: '1473.80', eva_contribution: 0,
       net_amount: '147380.00', investment_status: 'active', start_date: '2026-03-01',
       is_reinvestment: false, maturity_instruction: 'payout_all' },
  name: 'Saki Makume',
  acctCell: '<span>S-111105</span>',
  effRate: 0.1183,
  statusColor: { active: 'badge--green' },
});

const page = `<!doctype html><meta charset="utf-8"><body>
<table id="list"><tbody>${listHtml}</tbody></table>
<table id="tab"><tbody>${tabHtml}</tbody></table>
<table id="pool"><tbody>${poolHtml}</tbody></table>
<script>
window.__fired = [];
function viewInvestmentDetail(id, backTo, backKind){ window.__fired.push('detail:' + id + (backTo ? '|back=' + backTo : '') + (backKind ? '|kind=' + backKind : '')); }
function viewInvestor(id){ window.__fired.push('investor:' + id); }
function viewPoolInvestors(id){ window.__fired.push('pool:' + id); }
function openMoveInvestment(id, poolId){ window.__fired.push('move:' + id); }
function _invUpdateBulkBar(){ window.__fired.push('bulkbar'); }
var Modal = { close: function(id){ window.__fired.push('close:' + id); }, open: function(id){ window.__fired.push('open:' + id); } };

function clickAndReport(label, sel, within) {
  window.__fired = [];
  var scope = document.querySelector(within);
  var el = sel ? scope.querySelector(sel) : scope.querySelector('tr');
  if (!el) return { label: label, error: 'element not found: ' + sel };
  el.click();
  return { label: label, fired: window.__fired.slice() };
}

var results = [
  clickAndReport('list:row',       'td:nth-child(3)',      '#list'),
  clickAndReport('list:checkbox',  'input[type=checkbox]', '#list'),
  clickAndReport('list:investor',  '.td-strong[onclick]',  '#list'),
  clickAndReport('list:pool',      'td:nth-child(4) div[onclick]', '#list'),
  clickAndReport('list:eyebutton', 'button',               '#list'),
  clickAndReport('tab:row',        'td:nth-child(1)',      '#tab'),
  /* By title, not position. 'button' takes the first in the row, which used to
     be Move to pool and is now the eye — so the selector silently retargeted
     and the assertion below started describing a different control. */
  clickAndReport('tab:movebutton', 'button[title="Move to different pool"]', '#tab'),
  clickAndReport('tab:eyebutton',  'button[title="Open investment detail"]', '#tab'),
  clickAndReport('pool:row',       'td:nth-child(3)',      '#pool'),
  clickAndReport('pool:investorcell','td:nth-child(1)',     '#pool'),
];
document.title = 'RESULTS' + JSON.stringify(results);
<\/script></body>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-rowclick-'));
const file = path.join(dir, 'row.html');
fs.writeFileSync(file, page);

let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=3000',
    '--dump-dom', 'file://' + file,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  console.log(`  FAIL  chromium did not run: ${e.message}`);
  process.exit(1);
}

const m = dom.match(/<title>RESULTS(.*?)<\/title>/s);
if (!m) { console.log('  FAIL  the page did not report results'); process.exit(1); }
const decode = s => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const results = JSON.parse(decode(m[1]));
const byLabel = Object.fromEntries(results.map(r => [r.label, r]));
const fired = l => (byLabel[l] && byLabel[l].fired) || [];

console.log('\nAll Investments list');
ok('clicking the row opens the investment detail',
   fired('list:row').some(f => f.startsWith('detail:INV-1')), JSON.stringify(fired('list:row')));
ok('clicking the select checkbox does NOT open it',
   !fired('list:checkbox').some(f => f.startsWith('detail:')), JSON.stringify(fired('list:checkbox')));
ok('the checkbox still updates the bulk bar',
   fired('list:checkbox').includes('bulkbar'), JSON.stringify(fired('list:checkbox')));
ok('clicking the investor name opens the investor, not the investment',
   fired('list:investor').includes('investor:S-1105') && !fired('list:investor').some(f => f.startsWith('detail:')),
   JSON.stringify(fired('list:investor')));
ok('clicking the pool name opens the pool, not the investment',
   fired('list:pool').includes('pool:POOL-1') && !fired('list:pool').some(f => f.startsWith('detail:')),
   JSON.stringify(fired('list:pool')));
ok('the eye button opens the detail exactly once',
   fired('list:eyebutton').filter(f => f.startsWith('detail:')).length === 1,
   JSON.stringify(fired('list:eyebutton')));

console.log('\nInvestor detail — Investments tab');
ok('clicking the row opens the investment detail',
   fired('tab:row').some(f => f.startsWith('detail:INV-1')), JSON.stringify(fired('tab:row')));
ok('and passes the investor back-reference, so there is a way back',
   fired('tab:row').some(f => f.includes('|back=S-1105')), JSON.stringify(fired('tab:row')));
ok('clicking Move to pool does NOT also open the detail',
   fired('tab:movebutton').includes('move:INV-1') && !fired('tab:movebutton').some(f => f.startsWith('detail:')),
   JSON.stringify(fired('tab:movebutton')));
ok('the eye button opens the detail exactly once',
   fired('tab:eyebutton').filter(f => f.startsWith('detail:')).length === 1,
   JSON.stringify(fired('tab:eyebutton')));
ok('and it too carries the way back',
   fired('tab:eyebutton').some(f => f.includes('|back=S-1105')),
   JSON.stringify(fired('tab:eyebutton')));

console.log('\nPool investors list');
ok('clicking the row opens the INVESTMENT, not the investor',
   fired('pool:row').some(f => f.startsWith('detail:INV-1')) &&
   !fired('pool:row').some(f => f.startsWith('investor:')),
   JSON.stringify(fired('pool:row')));
ok('the way back is the pool it was opened from',
   fired('pool:row').some(f => f.includes('|back=POOL-1') && f.includes('|kind=pool')),
   JSON.stringify(fired('pool:row')));
ok('and the pool list closes behind it',
   fired('pool:row').includes('close:poolInvestorsModal'), JSON.stringify(fired('pool:row')));
ok('the investor cell behaves the same as the rest of the row',
   fired('pool:investorcell').some(f => f.startsWith('detail:INV-1')),
   JSON.stringify(fired('pool:investorcell')));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
