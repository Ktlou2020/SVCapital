#!/usr/bin/env node
/* The client statement must actually draw, with the figures on it.
 *
 * check-admin-statement-balance proves the arithmetic. This proves the document
 * built from it: _openAccountStatementWindow is a four-hundred-line array of
 * HTML strings, and a figure computed correctly and then interpolated under the
 * wrong name renders an empty cell with no error anywhere — which is how the
 * whole class of defect in this statement survived in the first place.
 *
 * Run: node scripts/check-admin-statement-renders.cjs
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
  console.log('  SKIP  no headless Chromium — the statement was not rendered');
  process.exit(0);
}

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

/* Shaped exactly like the endpoint's response, using the figures from the real
   statement that prompted this work. */
const DATA = {
  investor: { id: 'S-111628', first_name: 'Devin', last_name: 'Padayachy',
              email: 'devin@example.test', id_number: '7202275224082',
              mobile: '0837968449', wallet_balance: 227.78 },
  period: { from: '2026-01-01T00:00:00.000Z', to: '2026-09-01T23:59:59.999Z' },
  investments: [
    { id: 'I-A1', amount: '254302.85', status: 'active', start_date: '2026-06-29',
      maturity_date: '2026-06-30', pool_name: 'Cattle Investment - June 2026',
      product_type: 'cattle', annual_rate: '0.0285', pool_start_date: '2026-05-01',
      pool_end_date: '2026-06-30', expected_return: '7247.63', actual_return: null },
    { id: 'I-A2', amount: '207906.94', status: 'active', start_date: '2026-06-30',
      maturity_date: '2027-06-30', pool_name: 'Short Term Investment - June 2026',
      product_type: 'short_term', annual_rate: '0.0323', pool_start_date: '2026-06-01',
      pool_end_date: '2027-06-30', expected_return: '6715.39', actual_return: null },
    /* Started in 2024, matured inside the period — the row the old filter
       dropped, and the reason the client said products were missing. */
    { id: 'I-M1', amount: '344683.42', status: 'matured', start_date: '2024-02-01',
      maturity_date: '2026-02-28', pool_name: 'Short Term Investment - February 2026',
      product_type: 'short_term', annual_rate: '0.0285', pool_start_date: '2024-02-01',
      pool_end_date: '2026-02-28', expected_return: '4117.79', actual_return: '4117.79',
      maturity_instruction: 'reinvest' },
    { id: 'I-M2', amount: '346708.26', status: 'matured', start_date: '2026-01-01',
      maturity_date: '2026-01-31', pool_name: 'Short Term Investment - January 2026',
      product_type: 'short_term', annual_rate: '0.0323', pool_start_date: '2026-01-01',
      pool_end_date: '2026-01-31', expected_return: '4602.20', actual_return: '4602.20',
      maturity_instruction: 'reinvest' },
  ],
  transactions: [
    { type: 'investment', amount: '346708.26', description: 'RE-INVESTMENT', reference: 'R1',
      txn_date: '2026-01-31T00:00:00.000Z', cash_effect: -346708.26, running_balance: 2308760.43 },
    { type: 'payout', amount: '354506.90', description: 'Maturity payout', reference: 'R2',
      txn_date: '2026-07-31T00:00:00.000Z', cash_effect: 354506.90, running_balance: 354506.90 },
    { type: 'withdrawal', amount: '354506.90', description: 'Withdrawal to Capitec', reference: 'R3',
      txn_date: '2026-08-03T00:00:00.000Z', cash_effect: -354506.90, running_balance: 0 },
    { type: 'interest', amount: '227.78', description: 'Interest — 2026-07_2', reference: 'R4',
      txn_date: '2026-08-18T00:00:00.000Z', cash_effect: 227.78, running_balance: 227.78 },
    /* An accrual: on the statement, moving nothing. */
    { type: 'return', amount: '900.00', description: 'Accrued return', reference: 'R5',
      txn_date: '2026-08-20T00:00:00.000Z', cash_effect: 0, running_balance: 227.78 },
  ],
  opening_balance: 2655468.69,
  closing_balance: 227.78,
  wallet_balance: 227.78,
  derived_opening_balance: -11762864.82,
  reconciles: false,
  ledger_gap: 14418333.51,
  paid: { returns: 354734.68, withdrawn: 354506.90, deposited: 40000,
          invested: 346708.26, fees: 400, accrued: 900 },
};

const fn = sliceFn(ADMIN, '_openAccountStatementWindow');
const esc = (ADMIN.match(/^const _esc = .*$/m) || [])[0];
/* The builder leans on Utils.effectiveRate for the return column. Taken from
   the shipped file so the rendered document is the real one. */
let effRate = '';
try { effRate = sliceFn(ADMIN, 'effectiveRate'); } catch (_) {}
const utilsStub = effRate
  ? `const Utils = { effectiveRate: (function(){ ${effRate}; return effectiveRate; })() };`
  : `const Utils = { effectiveRate: i => parseFloat(i && i.annual_rate) || 0 };`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astmt-'));
fs.writeFileSync(path.join(tmp, 'stub.js'), `
${esc}
${utilsStub}
/* The real builder writes into a popup. Captured instead. */
window.__html = '';
window.open = function () {
  return { document: { write(h) { window.__html += h; }, close() {} }, focus() {}, print() {} };
};
${fn}
`);

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="doc"></div><div id="probe"></div>
<script>const ERRORS=[];window.onerror=m=>ERRORS.push(String(m));<\/script>
<script src="./stub.js"><\/script>
<script>
const DATA = ${JSON.stringify(DATA).replace(/</g, '\\u003c')};
const out = { errors: ERRORS };
try { _openAccountStatementWindow(DATA); out.built = 'ok'; }
catch (e) { out.built = 'THREW: ' + e.message; }
document.getElementById('doc').innerHTML = window.__html || '';
const txt = (document.getElementById('doc').textContent || '').replace(/\\s+/g, ' ');
out.len = txt.length;

out.hasSummary   = /Portfolio Summary/.test(txt);
out.hasActiveCap = /Active investment capital/.test(txt);
out.hasWallet    = /Wallet balance/.test(txt);
out.hasTotal     = /Total portfolio value/.test(txt);
/* 254 302,85 + 207 906,94 = 462 209,79 active, + 227,78 wallet = 462 437,57 */
out.activeSum    = /462 209,79|462,209.79/.test(txt);
out.totalSum     = /462 437,57|462,437.57/.test(txt);

out.hasPaid      = /Paid in this Period/.test(txt);
out.paidReturns  = /354 734,68|354,734.68/.test(txt);
out.noWithdrawnRow = !/Withdrawn to your bank/.test(txt);
out.accrualApart = /Returns accrued, not yet paid/.test(txt);

out.maturedCount = /Matured Pools . 2 investments/.test(txt) || /Matured Pools/.test(txt);
out.hasOldMatured= /February 2026/.test(txt);
out.overdueFlag  = /still marked active although/.test(txt);
out.gapWarning   = /Balances are anchored/.test(txt) && /14 418 333,51|14,418,333.51/.test(txt);
out.noCashLabel  = /no cash movement/.test(txt);
out.undef        = (txt.match(/undefined/g) || []).length;
out.nan          = (txt.match(/NaN/g) || []).length;

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

console.log('\nthe client statement, rendered');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 300));

if (r) {
  ok('the statement builds', r.built === 'ok', r.built);
  ok('nothing threw', (r.errors || []).length === 0, JSON.stringify(r.errors));
  ok('and it produced a document', r.len > 500, `${r.len} characters`);

  console.log('\nthe portfolio summary');
  ok('is on the statement', r.hasSummary === true);
  ok('with the active investment capital', r.hasActiveCap === true);
  ok('and it is the sum of the active investments', r.activeSum === true,
     'R254 302,85 + R207 906,94 = R462 209,79');
  ok('the wallet balance is beside it', r.hasWallet === true);
  ok('and the two are totalled', r.hasTotal === true && r.totalSum === true,
     'R462 209,79 + R227,78 = R462 437,57');

  console.log('\nwhat was paid, in rands');
  ok('the box is on the statement', r.hasPaid === true);
  ok('returns paid are shown', r.paidReturns === true);
  ok('and withdrawals are left to the ledger below', r.noWithdrawnRow === true,
     'the box is what the fund paid the client, not what they then moved');
  ok('with accrued returns kept apart from paid ones', r.accrualApart === true,
     'a client must not read cash and accrual as one figure');

  console.log('\nthe things the client said were missing');
  ok('an investment that started in 2024 and matured in the period is listed',
     r.hasOldMatured === true,
     'the endpoint filtered on start date, so this row never reached the document');
  ok('an active investment past its maturity date is flagged', r.overdueFlag === true);
  ok('and the reconciliation gap is stated with its amount', r.gapWarning === true);
  ok('an accrual is labelled rather than left blank', r.noCashLabel === true);

  console.log('\nnothing renders as undefined or NaN');
  ok('no field renders as "undefined"', r.undef === 0, String(r.undef));
  ok('and none as NaN', r.nan === 0, String(r.nan));
}

if (!process.env.DUMP) fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
