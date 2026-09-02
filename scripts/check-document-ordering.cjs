#!/usr/bin/env node
/* What order the client's documents list things in.
 *
 *   Active investments   — newest first by START date
 *   Matured investments  — newest first by MATURITY date
 *   Transactions         — newest first by transaction date
 *
 * The statement used to sort BOTH investment tables by maturity date, so the
 * active table was ordered by a date its own first column does not show: the
 * Date column reads the start date, and the rows were arranged by something
 * else. The ledger ran oldest first.
 *
 * The fixture below is built so the two orderings genuinely disagree — an
 * investment that started later but matures earlier, and a matured holding
 * whose start order is the reverse of its maturity order. A fixture where
 * start order and maturity order coincide cannot tell a correct sort from the
 * bug it replaced, and the fixtures already in the suite are exactly that.
 *
 * The transactions are supplied oldest first, the way the endpoint returns
 * them, so "no sort at all" fails rather than passes.
 *
 * THE LEDGER'S RUNNING BALANCE. running_balance is computed in date order and
 * is the balance AFTER its own row, so reversing the display leaves each row
 * correct — closing at the top, opening at the bottom, as a bank statement
 * reads. This asserts that the balances still travel with their rows, because
 * re-sorting a ledger and recomputing nothing is the way that silently breaks.
 *
 * Run: node scripts/check-document-ordering.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
/* The two document builders moved out of admin.js into
   js/investor-documents.js, which the investor portal loads too — one
   implementation, so the console and the portal cannot drift. This reads
   them from where they now live. */
const ADMIN = fs.readFileSync(path.join(ROOT, 'js', 'investor-documents.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

if (!CHROME) {
  console.log('  SKIP  no headless Chromium — no document was rendered');
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

function render(stubJs, pageJs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docorder-'));
  fs.writeFileSync(path.join(tmp, 'stub.js'), stubJs);
  fs.writeFileSync(path.join(tmp, 'p.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="doc"></div><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));<\/script>
<script src="./stub.js"><\/script>
<script>
const out = { errors: ERRORS };
${pageJs}
document.getElementById('probe').textContent = JSON.stringify(out);
<\/script></body></html>`);

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=5000', '--dump-dom', 'file://' + path.join(tmp, 'p.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }
  fs.rmSync(tmp, { recursive: true, force: true });

  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  try {
    return JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) { return null; }
}

/* Reads the rows under a section heading, as arrays of cell text. */
const TABLE_READER = `
/* The section heading is a SIBLING of its table, not an ancestor. Walking up
   to the nearest ancestor containing a table finds the portfolio summary
   instead, which is a different table with plausible-looking rows. */
function tableAfter(root, heading) {
  const h = [...root.querySelectorAll('div,h2,h3')].find(d =>
    (d.textContent || '').trim().startsWith(heading) && !d.querySelector('table'));
  if (!h) return null;
  for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
    const t = n.tagName === 'TABLE' ? n : n.querySelector && n.querySelector('table');
    if (t) return [...t.querySelectorAll('tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()));
  }
  return null;
}`;

/* ── The account statement ─────────────────────────────────────────────── */
console.log('\nthe account statement');
{
  /* A-LATE started last but matures FIRST; A-EARLY started first but matures
     LAST. Any sort keyed on the wrong date puts these the other way round.
     The matured pair invert the same way. */
  const DATA = {
    investor: { id: 'S-1', first_name: 'Devin', last_name: 'Padayachy',
                email: 'd@example.test', wallet_balance: 100 },
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-09-01T23:59:59.999Z' },
    investments: [
      { id: 'A-EARLY', amount: '100', status: 'active', start_date: '2026-01-10',
        maturity_date: '2028-12-31', pool_name: 'ACTIVE STARTED FIRST', product_type: 'short_term',
        annual_rate: '0.03', pool_start_date: '2026-01-10', pool_end_date: '2028-12-31' },
      { id: 'A-LATE', amount: '200', status: 'active', start_date: '2026-08-20',
        maturity_date: '2026-09-30', pool_name: 'ACTIVE STARTED LAST', product_type: 'short_term',
        annual_rate: '0.03', pool_start_date: '2026-08-20', pool_end_date: '2026-09-30' },
      { id: 'M-OLDMAT', amount: '300', status: 'matured', start_date: '2026-05-01',
        maturity_date: '2026-06-30', pool_name: 'MATURED EARLIER', product_type: 'short_term',
        annual_rate: '0.03', pool_start_date: '2026-05-01', pool_end_date: '2026-06-30',
        expected_return: '10', actual_return: '10', maturity_instruction: 'reinvest' },
      { id: 'M-NEWMAT', amount: '400', status: 'matured', start_date: '2024-01-01',
        maturity_date: '2026-08-31', pool_name: 'MATURED LATER', product_type: 'short_term',
        annual_rate: '0.03', pool_start_date: '2024-01-01', pool_end_date: '2026-08-31',
        expected_return: '20', actual_return: '20', maturity_instruction: 'reinvest' },
    ],
    /* Oldest first, as the endpoint returns them, each with the balance after
       itself. */
    transactions: [
      { type: 'deposit',    amount: '1000', description: 'FIRST',  reference: 'T1',
        txn_date: '2026-02-01T00:00:00.000Z', cash_effect: 1000, running_balance: 1000 },
      { type: 'withdrawal', amount: '400',  description: 'SECOND', reference: 'T2',
        txn_date: '2026-05-05T00:00:00.000Z', cash_effect: -400, running_balance: 600 },
      { type: 'interest',   amount: '25',   description: 'THIRD',  reference: 'T3',
        txn_date: '2026-08-18T00:00:00.000Z', cash_effect: 25, running_balance: 625 },
    ],
    opening_balance: 0, closing_balance: 625, wallet_balance: 625,
    derived_opening_balance: 0, reconciles: true, ledger_gap: 0,
    paid: { returns: 25, withdrawn: 400, deposited: 1000, invested: 0, fees: 0, accrued: 0 },
  };

  let effRate = '';
  try { effRate = sliceFn(ADMIN, 'effectiveRate'); } catch (_) {}
  const stub = `
/* _esc lives in each surface's own bundle, not in the shared document file.
   Stubbed to the same behaviour so the builders can run here. */
const _esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const Utils = ${effRate
    ? `{ effectiveRate: (function(){ ${effRate}; return effectiveRate; })() }`
    : `{ effectiveRate: i => parseFloat(i && i.annual_rate) || 0 }`};
window.__html = '';
window.open = function () {
  return { document: { write(h) { window.__html += h; }, close() {} }, focus() {}, print() {} };
};
${ADMIN}
${TABLE_READER}
`;
  const r = render(stub, `
try { SVCDocs.openAccountStatement(${JSON.stringify(DATA).replace(/</g, '\\u003c')}); out.built = 'ok'; }
catch (e) { out.built = 'THREW: ' + e.message; }
const doc = document.getElementById('doc');
doc.innerHTML = window.__html || '';
out.active  = tableAfter(doc, 'Active Pools');
out.matured = tableAfter(doc, 'Matured Pools');
out.ledger  = tableAfter(doc, 'Transaction');
`);

  ok('the statement rendered', !!r && r.built === 'ok', r ? r.built : 'no probe');
  if (r && r.built === 'ok') {
    const names = rows => (rows || []).map(c => c.find(x => /^(ACTIVE|MATURED)/.test(x)) || '');
    const active  = names(r.active);
    const matured = names(r.matured);

    ok('active investments run newest START first',
       active[0] === 'ACTIVE STARTED LAST' && active[1] === 'ACTIVE STARTED FIRST',
       `${JSON.stringify(active)} — sorting these by maturity date reverses them`);
    ok('matured investments run newest MATURITY first',
       matured[0] === 'MATURED LATER' && matured[1] === 'MATURED EARLIER',
       `${JSON.stringify(matured)} — sorting these by start date reverses them`);

    /* The ledger is bookended by an opening and a closing balance row. */
    const led  = r.ledger || [];
    const txn  = led.filter(c => c.some(x => /^(FIRST|SECOND|THIRD)$/.test(x)));
    const desc = txn.map(c => c.find(x => /^(FIRST|SECOND|THIRD)$/.test(x)));
    ok('the ledger runs newest first',
       desc.join(',') === 'THIRD,SECOND,FIRST',
       `${JSON.stringify(desc)} — supplied oldest first, so no sort at all fails here`);
    ok('and each balance still travels with its own row',
       (txn[0] || []).some(c => /625/.test(c)) &&
       (txn[1] || []).some(c => /600/.test(c)) &&
       (txn[2] || []).some(c => /1[ ,]?000/.test(c)),
       `${JSON.stringify(txn)} — running_balance is the balance AFTER its row; ` +
       `reversing must move the numbers with the rows, not renumber them`);
    ok('the closing balance leads and the opening balance closes',
       /Closing Balance/.test((led[0] || []).join(' ')) &&
       /Opening Balance/.test((led[led.length - 1] || []).join(' ')),
       `${JSON.stringify(led.map(c => c[0]))} — with newest-first rows, an opening ` +
       `balance at the top sits above the most recent transaction`);
  }
}

/* ── The Investment Income Reference ───────────────────────────────────── */
console.log('\nthe Investment Income Reference');
{
  const DATA = {
    investor: { id: 'S-1', first_name: 'Devin', last_name: 'Padayachy', email: 'd@example.test' },
    taxYear: 2026, from: '2025-03-01', to: '2026-02-28',
    returns: [
      { id: 'r1', txn_date: '2025-04-01', type: 'interest', description: 'INCOME OLDEST', amount: '10.00' },
      { id: 'r2', txn_date: '2025-12-15', type: 'interest', description: 'INCOME NEWEST', amount: '20.00' },
    ],
    totalReturns: 30,
    deposits: [
      { id: 'd1', txn_date: '2025-05-01', type: 'deposit', description: 'DEPOSIT OLDEST', amount: '100.00' },
      { id: 'd2', txn_date: '2026-01-20', type: 'deposit', description: 'DEPOSIT NEWEST', amount: '200.00' },
    ],
    totalDeposits: 300,
    maturedInvestments: [
      { id: 'A', pool_name: 'MATURED EARLIER', amount: '80000.00',
        end_date: '2025-03-31', realised_return: 1704, return_posted: true },
      { id: 'B', pool_name: 'MATURED LATER', amount: '179440.00',
        end_date: '2026-01-29', realised_return: 900, return_posted: true },
    ],
    maturedReturns: 2604, maturedUnposted: 0,
  };

  const stub = `
/* _esc lives in each surface's own bundle, not in the shared document file.
   Stubbed to the same behaviour so the builders can run here. */
const _esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
window.__html = '';
window.open = function () {
  return { document: { write(h) { window.__html += h; }, close() {} }, focus() {}, print() {} };
};
${ADMIN}
${TABLE_READER}
`;
  const r = render(stub, `
try { SVCDocs.openIncomeReference(${JSON.stringify(DATA).replace(/</g, '\\u003c')}); out.built = 'ok'; }
catch (e) { out.built = 'THREW: ' + e.message; }
const doc = document.getElementById('doc');
doc.innerHTML = window.__html || '';
out.rows = [...doc.querySelectorAll('tbody tr')].map(tr =>
  [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()).join(' | '));
`);

  ok('the certificate rendered', !!r && r.built === 'ok', r ? r.built : 'no probe');
  if (r && r.built === 'ok') {
    const at = needle => (r.rows || []).findIndex(x => x.includes(needle));
    const before = (a, b) => at(a) > -1 && at(b) > -1 && at(a) < at(b);

    ok('income runs newest first',
       before('INCOME NEWEST', 'INCOME OLDEST'),
       JSON.stringify((r.rows || []).filter(x => x.includes('INCOME'))));
    ok('deposits run newest first',
       before('DEPOSIT NEWEST', 'DEPOSIT OLDEST'),
       JSON.stringify((r.rows || []).filter(x => x.includes('DEPOSIT'))));
    ok('matured investments run newest MATURITY first',
       before('MATURED LATER', 'MATURED EARLIER'),
       JSON.stringify((r.rows || []).filter(x => x.includes('MATURED'))));
  }
}

/* ── The investor-facing copies ────────────────────────────────────────── */
console.log('\nthe client’s own copies order the same way');
{
  const CORE   = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  const PORTAL = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'portal.js'), 'utf8');
  const stmt   = sliceFn(PORTAL, 'buildStatementHTML');

  ok('the portal statement sorts active by start date, matured by maturity',
     /_stmtNewest\(_startedMs\)/.test(stmt) && /_stmtNewest\(_maturedMs\)/.test(stmt),
     'both tables used to sort by maturity date');
  ok('and its ledger is reversed for display, not re-sorted',
     /\}\)\.reverse\(\)\.join\(''\)/.test(stmt),
     'the running balance is accumulated walking forward; re-sorting the source array breaks it');
  ok('the next-maturity figure is computed on its own',
     /soonest one still ahead|\.sort\(\(a, b\) => new Date\(a\) - new Date\(b\)\)\[0\]/.test(stmt),
     'it used to fall out of the active table being sorted by earliest maturity');

  /* The investor certificate is no longer rebuilt in the browser: it asks the
     server for the same payload the console reads and renders it with the same
     builder. So the properties that used to be asserted against the portal's
     own copy now belong to the service both routes call. */
  const cert = sliceFn(CORE, 'generateTaxCertificate');
  ok('the investor certificate asks the server for the same document',
     /statements\/income-reference/.test(cert) && /SVCDocs\.openIncomeReference/.test(cert),
     'it used to rebuild the certificate from whatever the browser had cached');
  ok('and rebuilds nothing of its own',
     !/INCOME_TYPES/.test(cert) && !/interestTxns/.test(cert),
     'a second implementation is a second answer to "what did I earn"');

  const svc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'incomeReference.js'), 'utf8');
  ok('the service counts income, not returned capital',
     /incomeTypesSQL\(\)/.test(svc) && !/'payout'/.test(svc),
     'a payout is capital PLUS return; counting it declares the client’s own capital as income');
  ok('and windows the tax year on the date the money moved',
     /COALESCE\(transaction_date, created_at\) >= \$2::date/.test(svc),
     'created_at is when the row was written — one import timestamp across a migrated ledger');
  /* Tested against CODE, not prose. The service's own comment explains why it
     is NOT COALESCE(actual_return, expected_return), and a naive search finds
     that sentence and reports the bug the comment warns against. */
  const svcCode = svc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('and reads the realised return off the pool',
     /postedReturn\(\{/.test(svcCode) && !/COALESCE\(actual_return, expected_return/.test(svcCode),
     'actual_return defaults to 0, not NULL, so reading it directly prints R 0,00');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
