#!/usr/bin/env node
/* The clients CSV has to say what the clients screen says.
 *
 * It did not. The export wrote investors.total_invested; the table beside it
 * counted the investment rows. Those are different numbers, and they are most
 * different for exactly the clients it was reported on — Puno Stokvel
 * Association, CODE NXT Stokvel, Junior Ramela Burial Aid, Tshegofatso Burial
 * Society — because investors.total_invested is a running total kept by hand
 * and NOT kept by every path that creates an investment:
 *
 *   from the client's own wallet     kept
 *   from a SUB-ACCOUNT wallet        NOT kept — the increment goes to
 *                                    sub_accounts.total_invested instead
 *                                    (server/routes/tables.js, the
 *                                    `if (body.sub_account_id)` branch)
 *   a rollover at maturity           NOT kept — server/jobs/maturityCron.js
 *                                    inserts the investment and never touches
 *                                    the column
 *   a recurring investment           kept
 *
 * Stokvels and burial societies do both of the things in the NOT column, so
 * their row read R0,00 against real money. Reproduced against the live route
 * before this was written: an investment of R50 000 placed from a sub-account
 * left investors.total_invested at 0.
 *
 * The column is also a LIFETIME total that is never reduced at maturity, so
 * it is not a current position even where it is accurate.
 *
 * So the export counts the rows, through the same function the table uses.
 * One definition is the point: a figure somebody reads on screen and the same
 * figure in the file they downloaded must not be able to disagree.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investor-export.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ADMIN = read('admin/js/admin.js');

/* ── The real export, run ───────────────────────────────────────────── */
function runExport(state) {
  const node = () => ({ innerHTML: '', style: {}, textContent: '', value: '',
    classList: { add() {}, remove() {} }, addEventListener() {}, click() {},
    setAttribute() {}, appendChild() {}, removeChild() {}, remove() {},
    querySelectorAll: () => [], querySelector: () => null });
  const ctx = { console: { log() {}, warn() {}, error() {} },
    Math, Number, String, Object, Array, Boolean, JSON, RegExp, Set, Map, Date,
    parseFloat, parseInt, isNaN, setTimeout, clearTimeout,
    encodeURIComponent, decodeURIComponent,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: function (p) { this.parts = p; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { getElementById: () => node(), querySelector: () => node(),
                querySelectorAll: () => [], createElement: () => node(),
                addEventListener() {}, body: node() } };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  const from = ADMIN.indexOf('function _investorLiveTotals');
  const mid  = ADMIN.indexOf('function renderInvestorsTable');
  const exp  = ADMIN.indexOf('function exportInvestorsCSV');
  const end  = ADMIN.indexOf('function ', exp + 40);
  if (!(from > 0 && mid > from && exp > 0 && end > exp)) return null;
  /* js/api.js alongside it, the way the browser loads them, so Utils is the
     real one and not a stand-in that agrees with whatever is asked of it. */
  vm.runInContext(read('js/api.js') + '\n'
    + ADMIN.slice(from, mid) + '\n' + ADMIN.slice(exp, end) + '\n'
    + 'globalThis._downloadCSV = rows => { globalThis.__rows = rows; };'
    + 'globalThis.filteredInvestors = [];', ctx);
  ctx.STATE = state;
  try { ctx.exportInvestorsCSV(); } catch (_) { /* the toast needs a real DOM */ }
  return ctx.__rows || null;
}

const COL = (rows, name) => rows[0].indexOf(name);
const cell = (rows, r, name) => { const i = COL(rows, name); return i < 0 ? undefined : rows[r][i]; };

/* THE REPORTED SHAPE: a stokvel whose money went in through a sub-account,
   with one holding already matured. */
const REPORTED = {
  investors: [{ id: 'SV-PUNO', first_name: 'Puno Stokvel Association', last_name: '',
                email: 'p@x.test', investor_type: 'group', fica_status: 'approved',
                wallet_balance: 0, total_invested: 0, total_returns: 0,
                date_joined: '2026-01-05' }],
  investments: [
    { investor_id: 'SV-PUNO', sub_account_id: 'SA-1', amount: '50000.00', status: 'active' },
    { investor_id: 'SV-PUNO', sub_account_id: 'SA-1', amount: '25000.00', status: 'active' },
    { investor_id: 'SV-PUNO', sub_account_id: 'SA-1', amount: '10000.00', status: 'matured' },
  ],
};

console.log('\nthe export counts the investments, not a column kept by hand');
{
  const rows = runExport(REPORTED);
  ok('the export was found and ran', !!rows && rows.length === 2,
     'a slice that missed it would test nothing while passing');
  /* THE BUG, AS REPORTED. Every one of these investments was placed from a
     sub-account wallet, so investors.total_invested is 0 and the row read
     R0,00 for a client holding R75 000. */
  ok('a client who invests through a sub-account shows their real position',
     Number(cell(rows, 1, 'Active Invested')) === 75000,
     `${cell(rows, 1, 'Active Invested')} — the recorded column says `
     + `${cell(rows, 1, 'Recorded Lifetime Invested')}`);
  ok('and the counts come with it',
     Number(cell(rows, 1, 'Active Investments')) === 2
     && Number(cell(rows, 1, 'Total Investments')) === 3,
     JSON.stringify({ a: cell(rows, 1, 'Active Investments'), t: cell(rows, 1, 'Total Investments') }));
  /* Active is a position, not a history: the matured holding is counted in
     the total and not in the money. */
  ok('a matured holding is counted, and not counted as active money',
     Number(cell(rows, 1, 'Total Investments')) - Number(cell(rows, 1, 'Active Investments')) === 1
     && Number(cell(rows, 1, 'Active Invested')) === 75000);
  /* Kept, because it is not this export's place to drop a field somebody's
     spreadsheet may read — but named so nobody mistakes it for the position. */
  ok('the hand-kept column is still exported, under a name that says what it is',
     COL(rows, 'Recorded Lifetime Invested') >= 0 && COL(rows, 'Total Invested') < 0,
     rows[0].join(','));
  ok('and the type is on the row, since this was reported on stokvels',
     cell(rows, 1, 'Investor Type') === 'Group', String(cell(rows, 1, 'Investor Type')));
}

console.log('\nand a client with nothing still exports as nothing');
{
  const rows = runExport({ investors: [{ id: 'SV-NEW', first_name: 'New', last_name: 'Client',
    email: 'n@x.test', fica_status: 'pending', wallet_balance: 0, total_invested: 0,
    total_returns: 0 }], investments: [] });
  ok('zero, not blank', Number(cell(rows, 1, 'Active Invested')) === 0
     && Number(cell(rows, 1, 'Active Investments')) === 0,
     JSON.stringify(rows[1]));
  ok('and an unclassified client reads "Not set" rather than empty',
     cell(rows, 1, 'Investor Type') === 'Not set', String(cell(rows, 1, 'Investor Type')));
}

console.log('\nand the screen and the file cannot disagree');
{
  const src = strip(ADMIN);
  /* The whole point. Two copies of this sum drift, and the drift is what
     somebody reconciles a spreadsheet against at month end. */
  ok('there is one function that counts them',
     (src.match(/function _investorLiveTotals\(\)/g) || []).length === 1);
  ok('the table reads it', /const \{ invested: liveInvestedMap[\s\S]{0,120}_investorLiveTotals\(\)/.test(src),
     'the table used to count them inline, which is the copy that drifted');
  ok('and so does the export', /const live = _investorLiveTotals\(\);/.test(src));
  ok('the export no longer takes the invested figure from the stored column',
     !/live\.invested\[i\.id\][^,]*total_invested/.test(src)
     && /'Active Invested'/.test(src) && /live\.invested\[i\.id\] \|\| 0/.test(src));
  /* Sub-account investments carry the parent's investor_id, which is why
     keying on it picks them up. If that ever stops being true this is where
     it shows. */
  ok('and it counts by investor_id, which a sub-account investment carries too',
     /invested\[i\.investor_id\]/.test(src) && /total\[i\.investor_id\]/.test(src));
}

console.log('\nand the reason the stored column cannot be trusted is still true');
{
  const TABLES = strip(read('server/routes/tables.js'));
  ok('an investment from a sub-account still credits the SUB-ACCOUNT column',
     /if \(body\.sub_account_id\)[\s\S]{0,260}UPDATE sub_accounts SET[\s\S]{0,120}total_invested/.test(TABLES),
     'if this ever also credited the investor, the stored column would start '
     + 'agreeing — and this check should be revisited, not deleted');
  const MATURITY = read('server/jobs/maturityCron.js');
  ok('and a rollover still does not touch it at all',
     /INSERT INTO investments/.test(MATURITY) && !/total_invested/.test(MATURITY),
     'the nightly engine writes the investment and leaves the column behind');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
