#!/usr/bin/env node
/* The Fund Ops views must draw, against rows shaped like the database's.
 *
 * Every other check in this sweep reads the source or the schema. This one runs
 * the shipped renderers, because the fix moved the whole console onto a
 * different set of column names and a renderer that still reaches for an old
 * one does not fail — it silently prints a dash, or totals to zero, which is
 * exactly the state it was being rescued from.
 *
 * The fixture uses the REAL column names, and NUMERIC values as strings,
 * because that is what node-pg returns and it is what turned
 * `(x||0).toFixed(0)` into a TypeError in the returns chart.
 *
 * Run: node scripts/check-fund-console-renders.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'fund.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'fund', 'index.html'), 'utf8');
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

const body = HTML
  .replace(/[\s\S]*<body[^>]*>/, '')
  .replace(/<\/body>[\s\S]*/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');

/* One seeded run, exactly as server/db/seed.js writes it — the row that used to
   render R0 across the board. */
const FIXTURE = {
  runs: [
    { id: 'FR-001', run_name: 'Cattle Run Q1 2024', product_type: 'cattle', status: 'completed',
      principal_amount: '1980000.00', annual_rate: '0.148300', term_days: 183,
      start_date: '2024-01-01', end_date: '2024-07-03', gross_return: '147329.70',
      management_fee: '19800.00', performance_fee: '7366.50', total_fees: '27166.50',
      net_return: '120163.20', total_payout: '2100163.20', investor_count: 8,
      actual_rate: '0.152000', pool_name: "O'Brien Pool <b>", run_type: 'standard', notes: null },
    { id: 'FR-002', run_name: 'Solar 7yr Fund 2024', product_type: 'solar', status: 'in_progress',
      principal_amount: '3250000.00', annual_rate: '0.214000', term_days: 2555,
      start_date: '2024-03-01', end_date: null, gross_return: '696700.00',
      management_fee: '97500.00', performance_fee: '34835.00', total_fees: '132335.00',
      net_return: '564365.00', total_payout: '3814365.00', investor_count: 12,
      actual_rate: null, pool_name: null, run_type: 'standard', notes: 'Watch <script>x</script>' },
  ],
  pools: [{ id: 'POOL-1', name: 'Cattle Q1 Pool', product_type: 'cattle', status: 'open',
            annual_rate: '0.148300', investor_count: 8, target_amount: '2000000.00',
            raised_amount: '1980000.00', min_investment: '500.00' }],
  schedules: [{ id: 'RS-1', fund_run_id: 'FR-001', investor_id: 'INV-1',
                amount_invested: '250000.00', expected_return: '37075.00',
                gross_return: '37075.00', fees: '5000.00', net_return: '32075.00',
                expected_date: '2026-10-01', status: 'pending', paid_at: null }],
  investors: [{ id: 'INV-1', first_name: "S'busiso", last_name: 'Dlamini <b>', email: 's@x.test' }],
  fees: [{ id: 'FEE-1', fund_run_id: 'FR-001', fee_type: 'management', amount: '19800.00',
           rate: '0.020000', basis: '990000.00', description: 'Q1 management fee',
           accrued_at: '2026-07-03', status: 'received' }],
  allocations: [{ id: 'ALLOC-1', investor_id: 'INV-1', investor_name: "S'busiso Dlamini",
                  investor_email: 's@x.test', product_type: 'cattle', entity_name: 'SVC-Q1 Cattle',
                  capital_committed: '250000.00', capital_paid: '250000.00', allocation_pct: '12.5',
                  annual_rate: '0.148300', term_days: 183, start_date: '2026-03-01',
                  maturity_date: '2026-09-01', expected_payout: '268537.50', actual_payout: null,
                  status: 'active', notes: null }],
  audit: [
    /* One written by this console, one written by the platform with no metadata
       at all — the second must still render as itself. */
    { id: 'AUD-1', event_type: 'fund_run.create', entity_type: 'fund_run', entity_id: 'FR-001',
      user_email: 'kagiso@svcapital.co.za', actor_role: 'director',
      description: 'New fund run created: Cattle Run Q1 2024',
      metadata: { action: 'create', entity_name: 'Cattle Run Q1 2024', severity: 'info',
                  before_state: null, after_state: { status: 'draft' }, source: 'fund_console' },
      created_at: '2026-08-30T10:00:00Z' },
    { id: 'AUD-2', event_type: 'investors.updated', entity_type: 'investors', entity_id: 'INV-1',
      user_email: null, actor_role: null, description: 'Wallet balance changed',
      metadata: null, created_at: '2026-08-29T09:00:00Z' },
  ],
  /* Exactly the shape POST /api/fund/runs/:id/plan returns. Three thirds of an
     odd total — the case where naive rounding loses a cent. */
  plan: {
    ok: true, blockers: [], warnings: ['The pool holds 900000.00 but the run records 1000000.00 as capital deployed — a difference of 100000.00.'],
    run: { id: 'FR-001', name: 'Cattle Run Q1 2024', poolId: 'POOL-1',
           principal: 1000000, grossReturn: 148300, netReturn: 118640, dueDate: '2026-12-31' },
    schedules: [
      { investorId: 'INV-1', investorName: "S'busiso Dlamini <b>", amountInvested: 333333.33,
        expectedReturn: 26362.22, grossReturn: 49433.33, fees: 9886.67, netReturn: 39546.66 },
      { investorId: 'INV-2', investorName: 'Thandi Nkosi', amountInvested: 333333.33,
        expectedReturn: 26362.22, grossReturn: 49433.33, fees: 9886.67, netReturn: 39546.66 },
      { investorId: 'INV-3', investorName: 'Johan van der Merwe', amountInvested: 333333.34,
        expectedReturn: 26362.23, grossReturn: 49433.34, fees: 9886.66, netReturn: 39546.68 },
    ],
    feeLines: [
      { fee_type: 'management', amount: 20000, rate: 0.02, basis: 1000000, description: 'Management fee on capital deployed' },
      { fee_type: 'performance', amount: 9660, rate: 0.20, basis: 148300, description: 'Performance fee on gross return' },
    ],
    replacing: { schedules: 0, fees: 0 },
    totals: { investors: 3, invested: 1000000, gross: 148300, fees: 29660, net: 118640, feeLedger: 29660 },
  },
  notifs: [{ id: 'N-1', type: 'risk', title: 'Concentration above threshold',
             message: 'Cattle is 71% of AUM', entity_type: 'pool', entity_id: 'POOL-1',
             is_read: false, is_dismissed: false, priority: 'critical',
             created_at: '2026-08-30T08:00:00Z' }],
};

const stubbed = SRC
  .replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);\n/, '')
  .replace(/^async function apiFetch[\s\S]*?^\}$/m,
    'async function apiFetch(){ throw new Error("no network in this check"); }');

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${body}
<div id="probe"></div>
<script>
window.Chart = function(){ return { destroy(){} }; };
const ERRORS = [];
window.onerror = m => ERRORS.push(String(m));
</script>
<script src="./fund.stub.js"><\/script>
<script>
const F = ${JSON.stringify(FIXTURE).replace(/</g, '\\u003c')};
const out = { errors: ERRORS };
const run = (k, fn) => { try { fn(); out[k] = 'ok'; } catch (e) { out[k] = 'THREW: ' + e.message; } };

S.runs = F.runs; S.pools = F.pools; S.schedules = F.schedules;
S.investors = F.investors; S.allocations = F.allocations;
S.investments = []; S.cattle = []; S.solar = []; S.loans = [];
S.auditEvents = F.audit; S._notifCache = F.notifs; S._feeCache = F.fees;

run('dashboard', () => renderDashboard());
run('runs',      () => renderRunsView());
run('schedules', () => renderSchedulesTable());
run('audit',     () => { renderAuditStats(); renderAuditTable(); });
run('fees',      () => renderFeeLedgerView(F.fees));
run('allocs',    () => { renderAllocationsKPIs(); renderAllocationsView(); });
run('notifs',    () => renderNotifications(F.notifs, '', ''));
run('ticker',    () => renderEventTicker());
run('genPlan',   () => renderGeneratePlan(F.plan));

const grab = id => (document.getElementById(id) || {}).innerHTML || '';
out.runsHtml   = grab('runsList');
/* The Capital metric of the FIRST run card, isolated. Searching the whole
   panel for "1.98" passed even with the rename reverted, because another run's
   figures are on the same screen — a mutation test caught the assertion, not
   the code. */
{
  const card = document.querySelector('#runsList .run-card');
  const cells = card ? [...card.querySelectorAll('.run-metric')] : [];
  const byLabel = l => {
    const c = cells.find(x => (x.querySelector('.run-metric__label')||{}).textContent === l);
    return c ? (c.querySelector('.run-metric__value')||{}).textContent.trim() : '';
  };
  out.runCapital   = byLabel('Capital');
  out.runBenchmark = byLabel('Benchmark');
  out.runNet       = byLabel('Net Return');
  out.runInvestors = byLabel('Investors');
}
out.auditHtml  = grab('auditBody');
out.feesHtml   = grab('feeLedgerBody') || grab('feesBody');
out.schedHtml  = grab('schedsBody');
out.allocHtml  = grab('allocBody');
out.notifHtml  = grab('notifList') || grab('notificationsList') || grab('notifBody');
out.deployed   = (document.getElementById('kpi-deployed') || {}).textContent || '';
out.genHtml = grab('generateModalBody');
/* Asked of the DOM, not of the captured string: the probe's own JSON has to be
   entity-decoded to parse, which turns an escaped &lt;b&gt; back into <b> and
   makes a string test on it meaningless. Whether an ELEMENT was created is the
   only question that survives the round trip. */
out.genMadeElement = !!document.querySelector('#generateModalBody b, #generateModalBody script');
out.genShowsName = (document.getElementById('generateModalBody')||{}).textContent.includes("Dlamini <b>");
out.genBtnDisabled = !!(document.getElementById('generateConfirmBtn')||{}).disabled;
/* The same plan with a cent missing, to show the tie check is load-bearing
   rather than decorative. Rendered last so it does not overwrite the good one
   before it has been read. */
run('genBroken', () => renderGeneratePlan(Object.assign({}, F.plan, {
  totals: Object.assign({}, F.plan.totals, { net: 118639.99 }) })));
out.genBrokenHtml = grab('generateModalBody');

const all = out.runsHtml + out.auditHtml + out.feesHtml + out.schedHtml + out.allocHtml + out.notifHtml;
out.undef  = (all.match(/undefined/g) || []).length;
out.nan    = (all.match(/NaN/g) || []).length;
out.injected = /<script/i.test(all) || !!document.querySelector('#runsList script');
out.rawBold  = all.includes('Dlamini <b>') || all.includes("O'Brien Pool <b>");

document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundc-'));
const file = path.join(tmp, 'p.html');
/* Loaded as a file rather than inlined. The fixture deliberately carries a
   <script> tag — that is the XSS payload being tested — and JSON.stringify
   leaves it literal, so embedding it in an inline block closes the block early:
   everything after is parsed as HTML, nothing runs, and the probe comes back
   empty with no error to show for it. Every < in the embedded JSON is escaped
   as \u003c for the same reason. */
fs.writeFileSync(path.join(tmp, 'fund.stub.js'), stubbed);
fs.writeFileSync(file, page);
if (process.env.DUMP) console.log('page at', file);

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

console.log('\nthe console, rendered against database-shaped rows');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 400));
if (r && process.env.DUMP) console.log('    DEBUG runCapital=%j benchmark=%j net=%j investors=%j', r.runCapital, r.runBenchmark, r.runNet, r.runInvestors);

if (r) {
  ok('nothing threw while the script loaded', (r.errors || []).length === 0, JSON.stringify(r.errors));
  for (const v of ['dashboard', 'runs', 'schedules', 'audit', 'fees', 'allocs', 'notifs', 'ticker'])
    ok(`the ${v} view renders`, r[v] === 'ok', r[v]);

  console.log('\nthe seeded run shows its real numbers');
  ok("the run card's Capital is R1.98m, not R0",
     /1[\s,.\u00a0]?98/.test(r.runCapital),
     `Capital rendered as "${r.runCapital}" — the console read capital_deployed ` +
     'while the seed writes principal_amount');
  ok('its Benchmark is 14.83%', /14[.,]83/.test(r.runBenchmark), r.runBenchmark);
  ok('its Net Return is R120k', /120/.test(r.runNet), r.runNet);
  ok('and its Investors is 8, not 0', r.runInvestors === '8', r.runInvestors);

  console.log('\nnothing renders as undefined, NaN or markup');
  ok('no field renders as "undefined"', r.undef === 0, String(r.undef));
  ok('and none as NaN', r.nan === 0, String(r.nan));
  ok('a name with an apostrophe and a tag renders as text',
     r.injected === false && r.rawBold === false,
     `injected=${r.injected} rawBold=${r.rawBold}`);

  console.log('\nthe audit trail renders both kinds of event');
  ok("this console's own event shows its summary",
     r.auditHtml.includes('New fund run created'), r.auditHtml.slice(0, 200));
  ok('and its action, read out of metadata', /create/i.test(r.auditHtml));
  ok("the platform's own event renders too, with no metadata at all",
     r.auditHtml.includes('Wallet balance changed'),
     'these carry no metadata; a reader that assumes it would drop them');
  ok('and derives its action from the event_type', /updated/i.test(r.auditHtml));

  console.log('\nthe payout schedule preview');
  ok('the plan renders', r.genPlan === 'ok', r.genPlan);
  ok('every investor is listed with their share',
     /Dlamini/.test(r.genHtml) && /Nkosi/.test(r.genHtml) && /Merwe/.test(r.genHtml));
  ok('a name with markup in it renders as text, not as an element',
     r.genMadeElement === false && r.genShowsName === true,
     `element=${r.genMadeElement} textShowsTag=${r.genShowsName}`);
  ok('the totals row shows the run totals', /118[\s,.]?640/.test(r.genHtml), r.genHtml.slice(0, 200));
  ok('the fee lines are shown with what they were charged on',
     /management/i.test(r.genHtml) && /148[\s,.]?300/.test(r.genHtml));
  ok('the warning is surfaced, not hidden', /difference/.test(r.genHtml));
  ok('and the split is confirmed to tie', /ties to the run/.test(r.genHtml));
  ok('the Generate button is enabled for a plan that is ok', r.genBtnDisabled === false);

  ok('A SPLIT THAT DOES NOT TIE IS CALLED OUT',
     /does NOT tie/.test(r.genBrokenHtml) && /Do not generate/.test(r.genBrokenHtml),
     'one cent out must be visible on the screen, not only in the database');

  console.log('\nthe fee ledger and schedules resolve what they show');
  ok('a fee shows its amount', /19[\s,.]?800/.test(r.feesHtml), r.feesHtml.slice(0, 200));
  ok('and names its run through fund_run_id', /Cattle Run Q1/.test(r.feesHtml));
  ok('a schedule resolves the investor from investor_id',
     /Dlamini/.test(r.schedHtml), r.schedHtml.slice(0, 200));
}

if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
