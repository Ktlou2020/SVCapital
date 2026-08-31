#!/usr/bin/env node
/* A statement has to be true.
 *
 * It is the document a client keeps, shows their accountant, and files with
 * SARS. Everything else in the portal can be approximately right and be
 * forgiven; this cannot.
 *
 * WHAT WAS WRONG
 *
 *   MONEY THAT NEVER ARRIVED WAS COUNTED. Every total included transactions of
 *   any status except 'cancelled' — so a REJECTED R50 000 deposit was reported
 *   to the client as "Total Deposits R50 000", on a document with their name at
 *   the top. Pending deposits counted too.
 *
 *   MONEY THAT DID ARRIVE WAS DROPPED. The credit/debit split was two
 *   allow-lists and nothing else, so a type in neither — 'adjustment', and
 *   'reinvestment' on the web — rendered a dash in both columns and counted
 *   toward no total. A wallet adjustment is real money and it was invisible on
 *   the statement of that wallet.
 *
 *   THE TWO SURFACES DISAGREED. The web and mobile builders each carried their
 *   own copy of that classification, and they had drifted apart: mobile knew
 *   about 'reinvestment', the web did not. The same client's statement said
 *   different things depending on where they opened it.
 *
 *   NOTHING RECONCILED. There was no opening or closing balance — just a list
 *   and some totals, with no way for a reader to check any of it, and nothing
 *   that would have caught the two defects above.
 *
 *   ONLY 200 TRANSACTIONS WERE EVER LOADED, and the statement was built from
 *   whatever that page happened to contain.
 *
 *   THE STATEMENT NUMBER WAS FIVE RANDOM DIGITS, so the same statement had a
 *   different reference every time and two different ones could collide.
 *
 *   THE TAX YEAR ENDED ON THE 28th, hardcoded — dropping 29 February in a leap
 *   year, in the years nobody thinks to check.
 *
 * The arithmetic is lifted out of the shipped file and RUN, because none of
 * this is visible by reading: every one of those defects is a line that looks
 * perfectly reasonable on its own.
 *
 * Run: node scripts/check-statement-accuracy.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT   = path.join(__dirname, '..');
const CORE   = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
const MOBILE = fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'js', 'portal-core.js'), 'utf8');
const WEB_P  = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
/* The mobile SOURCE, not its build output. mobile/www is a copy of mobile/src,
   and reading only the copy is how a change lands in what ships today and is
   silently reverted by the next build — which is exactly what happened while
   this was being written. Both are read, and asserted identical. */
const MOB_SRC = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'js', 'portal.js'), 'utf8');
const MOB_P   = fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'js', 'portal.js'), 'utf8');
const STMTS  = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'statements.js'), 'utf8');

const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.round((a || 0) * 100) === Math.round((b || 0) * 100);

/* Lift the shipped functions out and run them. */
function sliceFn(src, name) {
  const at = src.indexOf(`function ${name}(`);
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

const ctx = { console };
vm.createContext(ctx);
for (const fn of ['_stmtDirection', '_stmtLabel', '_stmtCounts', '_stmtNet', '_stmtDate',
                  '_stmtRound', 'computeStatementFigures', 'statementNumber',
                  '_statementTaxYearRange']) {
  vm.runInContext(sliceFn(CORE, fn) + `\nthis.${fn} = ${fn};`, ctx);
}
ok('the statement arithmetic could be extracted and run',
   typeof ctx.computeStatementFigures === 'function',
   'without this every assertion below is skipped rather than failed');

const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString();
const FROM = new Date(Date.UTC(2026, 0, 1));
const TO   = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));

/* A period with one of everything that used to go wrong. */
const TXNS = [
  { id: 'T1', type: 'deposit',      amount: '10000.00', status: 'completed', created_at: D(2026, 1, 5) },
  { id: 'T2', type: 'deposit',      amount: '50000.00', status: 'rejected',  created_at: D(2026, 1, 9) },
  { id: 'T3', type: 'deposit',      amount: '7000.00',  status: 'pending',   created_at: D(2026, 1, 12) },
  { id: 'T4', type: 'investment',   amount: '8000.00',  status: 'completed', created_at: D(2026, 1, 20) },
  { id: 'T5', type: 'platform_fee', amount: '80.00',    status: 'completed', created_at: D(2026, 1, 20) },
  { id: 'T6', type: 'return',       amount: '1200.00',  status: 'completed', created_at: D(2026, 2, 15) },
  { id: 'T7', type: 'adjustment',   amount: '-250.00',  status: 'completed', created_at: D(2026, 3, 2) },
  { id: 'T8', type: 'reinvestment', amount: '500.00',   status: 'completed', created_at: D(2026, 3, 10) },
  /* Outside the period, and after it — the closing balance is derived by
     unwinding these from today's wallet. */
  { id: 'T0', type: 'deposit',      amount: '3000.00',  status: 'completed', created_at: D(2025, 12, 1) },
  { id: 'T9', type: 'withdrawal',   amount: '1000.00',  status: 'completed', created_at: D(2026, 5, 1) },
];
const INVESTMENTS = [
  { id: 'I1', amount: '8000.00', status: 'active',  start_date: D(2026, 1, 20), end_date: D(2026, 7, 20) },
  { id: 'I2', amount: '5000.00', status: 'matured', start_date: D(2025, 6, 1),  end_date: D(2026, 2, 1) },
  { id: 'I3', amount: '2000.00', status: 'active',  start_date: D(2025, 3, 1),  end_date: D(2027, 3, 1) },
];
/* Chosen so the OPENING BALANCE IS NOT ZERO.
   The December deposit of R3 000 is the opening. The period moves it by
   credits 11 200 − debits 8 830 = +2 370, giving a closing of R5 370. A R1 000
   withdrawal after the period leaves R4 370 in the wallet today.
   With a wallet of 1 370 the opening works out to exactly zero, and a mutation
   that stopped deriving the opening at all still passed — the fixture was
   agreeing with the bug by coincidence. */
const WALLET = 4370;

if (ctx.computeStatementFigures) {
  const F = ctx.computeStatementFigures({
    investor: { id: 'INV-1', wallet_balance: WALLET },
    transactions: TXNS, investments: INVESTMENTS,
    from: FROM, to: TO, complete: true,
  });

  console.log('\nmoney that never arrived is not counted');
  {
    ok('a REJECTED deposit is excluded from the totals', near(F.deposits, 10000),
       `deposits ${F.deposits} — the rejected R50 000 used to be counted`);
    /* deposit 10 000 + return 1 200. The reinvestment is a DEBIT, and the
       pending R7 000 deposit is not counted at all. */
    ok('and so is a PENDING one', near(F.credits, 11200),
       `credits ${F.credits} — expected 11 200 (10 000 deposit + 1 200 return)`);
    ok('but both are still listed', F.transactions.some(t => t.id === 'T2') &&
                                    F.transactions.some(t => t.id === 'T3'),
       'omitting them would be its own kind of lie');
    ok('and named as excluded', F.excluded.length === 2,
       JSON.stringify(F.excluded.map(t => t.id)));
  }

  console.log('\nmoney that did arrive is not dropped');
  {
    ok('an adjustment is classified by its sign',
       ctx._stmtDirection({ type: 'adjustment', amount: -250 }) === 'debit' &&
       ctx._stmtDirection({ type: 'adjustment', amount: 250 }) === 'credit',
       'it used to be in neither list and vanished from both columns');
    ok('a reinvestment is a debit on both surfaces',
       ctx._stmtDirection({ type: 'reinvestment', amount: 500 }) === 'debit');
    ok('a type nobody has classified still lands somewhere',
       ctx._stmtDirection({ type: 'brand_new_thing', amount: -5 }) === 'debit' &&
       ctx._stmtDirection({ type: 'brand_new_thing', amount: 5 }) === 'credit');
    ok('and it is labelled readably rather than as a raw key',
       ctx._stmtLabel({ type: 'brand_new_thing' }) === 'Brand New Thing',
       ctx._stmtLabel({ type: 'brand_new_thing' }));
    /* 8000 investment + 80 fee + 250 adjustment + 500 reinvestment */
    ok('the debits include all of them', near(F.debits, 8830), `debits ${F.debits}`);
  }

  console.log('\nthe statement reconciles');
  {
    ok('opening + credits − debits = closing', F.ties === true,
       `${F.opening} + ${F.credits} − ${F.debits} ≠ ${F.closing}`);
    ok('the closing balance unwinds what happened after the period',
       near(F.closing, 5370),
       `closing ${F.closing} — today's wallet is ${WALLET} and R1 000 was withdrawn after the period`);
    ok('and the opening balance is the December deposit that came before it',
       near(F.opening, 3000), `opening ${F.opening}`);

    /* The check is only meaningful if it can fail. */
    const broken = ctx.computeStatementFigures({
      investor: { id: 'INV-1', wallet_balance: WALLET },
      transactions: TXNS.filter(t => t.id !== 'T1'),   // a row goes missing
      investments: INVESTMENTS, from: FROM, to: TO, complete: false,
    });
    ok('a missing transaction changes the opening balance, and is not hidden',
       !near(broken.opening, F.opening) && broken.complete === false,
       'a dropped row does not just omit a line, it moves the opening balance');
  }

  console.log('\nfigures are labelled with the period they belong to');
  {
    /* Only I1 started inside Jan–Mar 2026. */
    ok('capital counted is what was placed IN the period', near(F.capitalInPeriod, 8000),
       `${F.capitalInPeriod} — it used to sum every investment ever made`);
    ok('the investments shown are those live during the period',
       F.investments.length === 3, JSON.stringify(F.investments.map(i => i.id)));
    ok('portfolio value is named as a today figure',
       'portfolioValueToday' in F && !('portfolioValue' in F),
       'it is active investments plus the wallet as they stand now, not as at the period end');
  }

  console.log('\nthe statement number identifies the statement');
  {
    const a = ctx.statementNumber('INV-1', FROM, TO);
    const b = ctx.statementNumber('INV-1', FROM, TO);
    const c = ctx.statementNumber('INV-2', FROM, TO);
    const d = ctx.statementNumber('INV-1', FROM, new Date(Date.UTC(2026, 3, 30)));
    ok('the same statement always gets the same number', a === b, `${a} vs ${b}`);
    ok('a different investor gets a different one', a !== c);
    ok('and a different period does too', a !== d);
    ok('it carries the period on its face', /^SVC-2026-0101\d{4}-/.test(a), a);
  }
}

console.log('\nthe South African tax year');
{
  const r = y => ctx._statementTaxYearRange(y);
  ok('runs 1 March to the end of February',
     r(2026).from === '2025-03-01' && r(2026).to === '2026-02-28', JSON.stringify(r(2026)));
  ok('AND INCLUDES 29 FEBRUARY IN A LEAP YEAR',
     r(2024).to === '2024-02-29' && r(2028).to === '2028-02-29',
     `${r(2024).to} / ${r(2028).to} — the end was hardcoded to the 28th, silently dropping a day`);

  ok('the server uses the same range, not the calendar year',
     /function taxYearRange/.test(STMTS) &&
     !/EXTRACT\(YEAR FROM created_at\)/.test(strip(STMTS)),
     'a certificate headed "2026" covered January to December and reported the wrong ten months');
  ok("and looks for matured investments, not 'paid_out'",
     /status IN \('matured', 'paid_out'\)/.test(STMTS) &&
     !/status='paid_out'/.test(strip(STMTS)),
     'setup migrates paid_out to matured on every boot, so this matched nothing and every certificate reported R0');
  ok('the two return figures are reported separately, not summed',
     /maturedReturns:/.test(STMTS) && /totalReturns: Math\.round\(returnsPaid/.test(STMTS),
     'adding them would declare income twice on a tax certificate');
}

console.log('\none source of truth, shared by both surfaces');
{
  ok('web and mobile portal-core are identical', CORE === MOBILE,
     'the shared file is the whole point; a drifted copy is the defect it exists to prevent');
  ok("the mobile build matches the mobile source", MOB_SRC === MOB_P,
     'mobile/www is built from mobile/src; a change made only to the build is reverted by the next one');

  for (const [label, code] of [['web', strip(WEB_P)],
                               ['mobile source', strip(MOB_SRC)],
                               ['mobile build', strip(MOB_P)]]) {
    ok(`the ${label} builder no longer carries its own classification`,
       !/isCreditType = t => \['deposit'/.test(code),
       'the two copies had already drifted: mobile knew about reinvestment and the web did not');
    ok(`the ${label} builder uses the shared one`,
       /_stmtDirection\(t\) === 'credit'/.test(code));
    ok(`the ${label} builder takes its totals from the shared figures`,
       /const txDeposits = F\.deposits/.test(code),
       'a row\'s column and the figure it is counted in must come from one place');
    ok(`the ${label} builder shows a running balance`, /let running = Number\(F\.opening\)/.test(code));
    ok(`the ${label} builder prints the reconciliation`, /does not reconcile/.test(code));
    ok(`the ${label} builder says when the history is incomplete`,
       /F\.complete === false/.test(code));
  }
}

console.log('\nthe statement is built from the whole history');
{
  const core = strip(CORE);
  ok('a statement loads every page of transactions',
     /async function loadFullTransactionHistory/.test(core) &&
     /res\.total > 0 && all\.length >= res\.total/.test(core),
     'the portal loads one 200-row page for the dashboard; a statement needs all of it');
  ok('and generateStatement waits for it',
     /async function generateStatement/.test(core) && /await loadFullTransactionHistory/.test(core));
  ok('a failed load is reported, not passed off as complete',
     /return \{ transactions: all, complete: false \};/.test(core));

  /* Scoped to TRANSACTIONS. `i.status !== 'cancelled'` on an investment list is
     correct and stays — a cancelled investment should not count. The defect was
     applying that test to transactions, where it let pending and rejected money
     through. */
  ok('no statement figure counts a non-completed transaction',
     !/\bt\.status !== 'cancelled'/.test(core),
     "every total used to include everything except 'cancelled'");
  ok('and the completed test is the shared one',
     /function _stmtCounts/.test(core) && /_stmtCounts\(t\)/.test(core));
}

/* The document itself, rendered.
 *
 * Everything above proves the arithmetic. This proves the numbers reach the
 * page: buildStatementHTML is a five-hundred-line template literal, and a
 * figure that is computed correctly and then interpolated under the wrong name
 * renders an empty cell with no error anywhere. */
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

console.log('\nthe document, rendered');
if (!CHROME) {
  console.log('  SKIP  no headless Chromium');
} else {
  const os = require('os');
  const { execFileSync } = require('child_process');

  const helpers = ['_stmtDirection', '_stmtLabel', '_stmtCounts', '_stmtNet', '_stmtDate',
                   '_stmtRound', 'computeStatementFigures', 'statementNumber']
    .map(n => sliceFn(CORE, n)).join('\n');
  const builder = sliceFn(WEB_P, 'buildStatementHTML');
  /* The small formatters the builder leans on, taken from the web portal so the
     rendered document is the shipped one rather than an approximation. */
  /* Whatever the builder calls, pulled from wherever it lives. Listing the
     helpers by hand meant discovering each missing one by running the check —
     and a helper added to the builder later would break this silently. */
  const called = new Set([...builder.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  const BUILTIN = new Set(['if','for','while','switch','catch','function','return','typeof',
                           'Number','String','Math','Date','Array','Object','JSON','parseFloat',
                           'parseInt','isNaN','map','filter','reduce','sort','join','includes',
                           'slice','split','replace','toFixed','toUpperCase','toLowerCase','push',
                           'getTime','some','every','find','forEach','concat','indexOf','trim',
                           'padStart','test','match','keys','values','entries','abs','round',
                           'toLocaleString','toISOString','charAt','repeat','startsWith','endsWith']);
  const extras = [...called].filter(n => !BUILTIN.has(n))
    .map(n => {
      for (const src of [WEB_P, CORE]) {
        try { return sliceFn(src, n); } catch (_) {}
        /* Arrow consts too — _esc is `const _esc = s => …` on one line, and a
           resolver that only knows `function` declarations misses it. */
        const m = new RegExp(`^const ${n} = .*$`, 'm').exec(src);
        if (m) return m[0];
      }
      return '';
    })
    .filter(Boolean).join('\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-'));
  fs.writeFileSync(path.join(tmp, 'stub.js'), `
${helpers}
${extras}
${builder}
window.__run = function () {
  const F = computeStatementFigures({
    investor: { id: 'INV-1', wallet_balance: ${WALLET} },
    transactions: TXNS, investments: INVESTMENTS,
    from: new Date(FROM), to: new Date(TO), complete: true,
  });
  return buildStatementHTML({
    investor: { id: 'INV-1', first_name: "S'busiso", last_name: 'Dlamini', date_joined: '2025-01-01' },
    investments: F.investments, transactions: F.transactions,
    from: new Date(FROM), to: new Date(TO),
    totalDeposits: F.deposits, totalReturns: F.returns, walletBal: F.walletNow,
    totalValue: F.portfolioValueToday, activeInv: F.activeInvCount,
    totalCapital: F.capitalInPeriod, activeInvAmt: F.activeInvAmt,
    statementNumber: statementNumber('INV-1', new Date(FROM), new Date(TO)),
    generatedAt: 'today', figures: F,
    incPortfolio: true, incInvestments: true, incTransactions: true, incPerformance: true,
  });
};`);

  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="doc"></div><div id="probe"></div>
<script>
const TXNS = ${JSON.stringify(TXNS).replace(/</g, '\\u003c')};
const INVESTMENTS = ${JSON.stringify(INVESTMENTS).replace(/</g, '\\u003c')};
const FROM = ${JSON.stringify(FROM)}; const TO = ${JSON.stringify(TO)};
const ERRORS = []; window.onerror = m => ERRORS.push(String(m));
<\/script>
<script src="./stub.js"><\/script>
<script>
const out = { errors: ERRORS };
try { document.getElementById('doc').innerHTML = window.__run(); out.rendered = 'ok'; }
catch (e) { out.rendered = 'THREW: ' + e.message; }
const txt = document.getElementById('doc').textContent || '';
out.hasOpening = /Opening Balance/i.test(txt);
out.hasClosing = /Closing Balance/i.test(txt);
out.reconciles = /Opening .* credits .* debits .* closing/i.test(txt) || txt.includes('= closing');
out.saysNotCounted = txt.includes('not counted');
out.mentionsExcluded = /not counted, because/.test(txt);
/* The rejected R50 000 must not appear in any total — only as a listed row. */
out.rejectedListed = txt.includes('rejected');
out.showsAdjustment = /Adjustment/.test(txt);
out.showsReinvestment = /Reinvestment/.test(txt);
out.bodyLength = txt.length;
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
  } catch (_) { /* reported below */ }

  ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 300));
  if (r) {
    ok('the statement renders', r.rendered === 'ok', r.rendered);
    ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));
    ok('it shows an opening balance', r.hasOpening === true);
    ok('and a closing balance', r.hasClosing === true);
    ok('and states the reconciliation on its face', r.reconciles === true);
    ok('a non-completed row is marked "not counted"', r.saysNotCounted === true);
    ok('and the reader is told how many were excluded', r.mentionsExcluded === true);
    ok('the rejected deposit is still listed, with its status',
       r.rejectedListed === true, 'omitting it would be its own kind of lie');
    ok('an adjustment appears on the statement at all',
       r.showsAdjustment === true, 'it used to render a dash in both columns');
    ok('and so does a reinvestment', r.showsReinvestment === true);
  }
  if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
