#!/usr/bin/env node
/* The four tick boxes on the statement screen, and whether they do anything.
 *
 * REPORTED FROM THE LIVE PORTAL: "these selections don't work when the
 * client selects them, the statement does not change". They did not.
 *
 * generateStatement read all four, worked out which were on, computed
 * effectivePortfolio / effectiveInvestments / effectiveTransactions /
 * effectivePerformance — and then called SVCDocs.accountStatementHTML
 * with the server payload and nothing else. Three of those four variables
 * were never read by anything at all; the fourth chose a word in a
 * one-line summary. The builder had no notion of sections to begin with.
 *
 * AND THE PAGE SAID OTHERWISE. The assist card beside the boxes prints
 * "Included sections: Portfolio, Transactions" from the same checkboxes,
 * so a client who cleared two of them was told the selection had been
 * honoured while the document ignored it.
 *
 * PERFORMANCE ANALYSIS HAD NO SECTION ANYWHERE. The portal used to build
 * its own statement, and that builder had one. When the portal switched
 * to the shared document — the same one the console sends, so that a
 * client and staff cannot hold two different answers — the section went
 * with it and the tick box stayed. It is rebuilt here from the server
 * payload, which carries capital, status, actual and expected return.
 *
 * ── THE TRAP THIS CHECK KEEPS FALLING INTO ───────────────────────────
 *
 * Probing the rendered document for a section's NAME proves nothing:
 *
 *   · "Active Pools" is also a label in the Statement Details info box,
 *     so it is present on every statement whether the pool tables are or
 *     not.
 *   · "txn-hdr" is also a CSS class in the stylesheet, so it is present
 *     even when the ledger is omitted.
 *
 * Both passed against a document that had dropped the section. Every
 * probe below is therefore anchored to the markup only the RENDERED
 * header produces.
 *
 * Run: node server/scripts/check-statement-sections.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The document builder, run for real. */
function docs() {
  const ctx = {
    document: { addEventListener() {}, removeEventListener() {},
                getElementById: () => null, querySelector: () => null,
                querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
                body: { appendChild() {}, classList: { add() {}, remove() {} } },
                head: { appendChild() {} } },
    console,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    unescape: s => s, encodeURIComponent,
    location: { origin: 'https://platform.svcapital.test', search: '', href: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgent: '' },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  /* THE REAL Utils, not four stubs of it. The document asks Utils which
     rate basis an investment is on — what it actually earned, what the
     pool posted, or what was promised — and a hand-written stand-in here
     would be a second answer to that, drifting from js/api.js the first
     time either moved. This check is about sections, and it should not
     quietly acquire its own opinion about rates on the way. */
  vm.runInContext(read('js/api.js'), ctx);
  vm.runInContext(read('js/investor-documents.js'), ctx);
  /* Utils is declared `const`, so it lives in the context's lexical scope
     and never appears on the global object — asked for from out here it
     reads as undefined even though the document can see it perfectly
     well. It is read by running an expression inside the context. */
  if (vm.runInContext('typeof Utils.rateBasis', ctx) !== 'function')
    throw new Error('js/api.js did not define Utils.rateBasis — the document '
                  + 'cannot be built, so nothing below would be testing it');
  return ctx.SVCDocs;
}

const PAYLOAD = over => Object.assign({
  investor: { id: 'INV-SS', first_name: 'Test', last_name: 'Client' },
  period: { from: '2026-01-01', to: '2026-11-25' },
  opening_balance: 0, closing_balance: 1000,
  paid: { returns: 500, deposited: 2000, invested: 1500, fees: 15 },
  investments: [
    /* TWO PROJECTED, IN DIFFERENT PRODUCTS, so a row's figure is never
       also the total's. With one active investment the projected row and
       the projected total both read 650,00, and a probe for "650,00 est."
       passes off the TOTAL while every row has lost its marker. */
    { id: 'I1', amount: 5000, status: 'active',  product_type: 'cattle',
      expected_return: 650, annual_rate: 0.13, end_date: '2027-01-01' },
    { id: 'I3', amount: 2000, status: 'active',  product_type: 'solar',
      expected_return: 260, annual_rate: 0.13, end_date: '2027-03-01' },
    { id: 'I2', amount: 3000, status: 'matured', product_type: 'solar',
      actual_return: 390, annual_rate: 0.13, end_date: '2026-06-01' },
  ],
  transactions: [{ type: 'deposit', amount: 2000, description: 'Dep',
                   transaction_date: '2026-02-01', running_balance: 2000 }],
}, over || {});

/* ANCHORED TO WHAT ONLY THE RENDERED HEADER PRODUCES — see the header. */
const HAS = {
  portfolio:    h => /#eda5ff">Portfolio Summary/.test(h),
  performance:  h => /#656565">Performance Analysis/.test(h),
  investments:  h => /class="sec-hdr active-hdr">Active Pools/.test(h),
  transactions: h => /class="sec-hdr txn-hdr">Transaction Ledger/.test(h),
};
const shown = h => Object.keys(HAS).filter(k => HAS[k](h)).sort().join(',') || '(none)';

const SVCDocs = docs();
const build = sections => SVCDocs.accountStatementHTML(
  PAYLOAD(), sections ? { sections } : undefined);

/* ══ 1. Each box, on its own ═══════════════════════════════════════ */
console.log('\neach selection changes the document');
{
  const ALL = { portfolio: true, investments: true, transactions: true, performance: true };
  const only = k => Object.assign({ portfolio: false, investments: false,
                                    transactions: false, performance: false }, { [k]: true });

  for (const k of Object.keys(HAS)) {
    const h = build(only(k));
    ok(`${k} alone brings ${k} and nothing else`, shown(h) === k,
       `asked for ${k}, got: ${shown(h)} — this is the whole bug report: the `
       + 'client clears three boxes and the statement does not change');
  }

  const none = build({ portfolio: false, investments: false,
                       transactions: false, performance: false });
  ok('ALL FOUR OFF LEAVES NO SECTION AT ALL', shown(none) === '(none)',
     'the portal never sends this — it falls back to everything when '
     + 'nothing is ticked — but the builder must do as it is told: ' + shown(none));

  const all = build(ALL);
  ok('and all four on brings all four',
     shown(all) === 'investments,performance,portfolio,transactions', shown(all));

  /* Pairs, because a gate that works alone can still take a neighbour
     with it: the pool tables and the overdue warning sit between the
     portfolio block and the ledger. */
  const pair = build({ portfolio: true, investments: false,
                       transactions: true, performance: false });
  ok('AND A PAIR BRINGS EXACTLY THAT PAIR', shown(pair) === 'portfolio,transactions',
     'the blocks are adjacent in one array, so a mis-placed boundary '
     + 'swallows the neighbour: ' + shown(pair));
}

/* ══ 2. The console asked for nothing and must get everything ══════ */
console.log('\nand the console, which offers no such choice, still gets all of it');
{
  const h = SVCDocs.accountStatementHTML(PAYLOAD());
  ok('NO OPTIONS MEANS THE WHOLE DOCUMENT',
     shown(h) === 'investments,performance,portfolio,transactions',
     'staff would silently start sending less than they used to: ' + shown(h));
  const empty = SVCDocs.accountStatementHTML(PAYLOAD(), {});
  ok('and an options object with no sections in it means the same',
     shown(empty) === 'investments,performance,portfolio,transactions', shown(empty));
}

/* ══ 3. Performance analysis is real, and says what it is ══════════ */
console.log('\nand performance analysis exists at all, which it did not');
{
  const h = build({ portfolio: false, investments: false,
                    transactions: false, performance: true });
  const w = h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  ok('THE SECTION IS IN THE DOCUMENT', HAS.performance(h),
     'the tick box has offered this since the screen shipped and the '
     + 'document has never had one');
  ok('confirmed returns are shown', /Confirmed/.test(w) && /Solar Investment/.test(w), w.slice(0, 300));
  ok('and projected ones separately', /Projected/.test(w) && /Cattle Investment/.test(w), w.slice(0, 300));

  /* NOT ADDED TOGETHER. A matured investment's return is money the client
     has been credited; an active one's is the pool's rate applied to
     capital that has not come back. One total holding both reads as
     earnings and is not. */
  ok('AND THE TWO ARE NEVER SUMMED',
     !/R 1 300,00/.test(w),
     '390 confirmed + 910 projected = 1300, a number that must not appear '
     + 'anywhere on this document: ' + w.slice(0, 400));
  /* EVERY PROJECTED ROW, not only the figure that is also the total. */
  ok('and every projected figure is marked as an estimate',
     /650,00 est\./.test(w) && /260,00 est\./.test(w) && /910,00 est\./.test(w),
     'a client reading an estimate as a credit has been told they earned '
     + 'money they have not: ' + w.slice(0, 400));
  ok('and a confirmed one is not',
     !/390,00 est\./.test(w),
     'money already credited is not an estimate: ' + w.slice(0, 400));

  const none = SVCDocs.accountStatementHTML(PAYLOAD({ investments: [] }),
    { sections: { portfolio: false, investments: false, transactions: false, performance: true } });
  ok('and with no investments it says so rather than drawing an empty table',
     /No investments in this period to analyse/.test(none), 'empty tables read as a failure to load');
}

/* ══ 4. The portal hands the choice over ═══════════════════════════ */
console.log('\nand the portal passes what the client picked');
{
  const core = read('js/portal-core.js');
  ok('GENERATE PASSES THE SECTIONS',
     /accountStatementHTML\(stmtData, \{ sections: stmtSections \}\)/.test(core),
     'it read the four boxes, computed effective* from them, and then '
     + 'called the builder with the payload alone');
  ok('and they are the effective values, so nothing ticked still gives a statement',
     /portfolio:\s*effectivePortfolio/.test(core)
     && /transactions:\s*effectiveTransactions/.test(core),
     'the raw flags would produce an empty document when a client clears '
     + 'all four');
  ok('and it remembers them for the print and save paths',
     /PORTAL\._lastStatementSections = stmtSections/.test(core));

  /* THE SAME DOCUMENT FROM EVERY BUTTON. Print and Save re-render the
     payload, so a path that forgets the sections hands back what the
     client just cleared — the defect moved one button along. */
  for (const [what, rel] of [['the web portal', 'portal/js/portal.js'],
                             ['the app',        'mobile/src/js/portal.js']]) {
    const src = read(rel);
    const print = (src.match(/function printStatement\(\)[\s\S]*?\n\}/) || [''])[0];
    ok(`${what}'s print button sends them too`,
       /openAccountStatement\(data, null, \{ sections: PORTAL\._lastStatementSections \}\)/.test(print),
       'printing must not restore a section the client removed: ' + print.slice(-200));
  }
  const app = read('mobile/src/js/portal.js');
  ok('AND THE SAVED PDF MATCHES WHAT WAS ON SCREEN',
     /accountStatementHTML\(PORTAL\._lastStatement,\s*\n?\s*\{ sections: PORTAL\._lastStatementSections \}\)/.test(app),
     'the app builds the PDF from the same payload a second time');
}

/* ══ 5. The boxes themselves ═══════════════════════════════════════ */
console.log('\nand the boxes the client ticks are still there to tick');
{
  for (const [what, rel] of [['the web portal', 'portal/index.html'],
                             ['the app',        'mobile/src/index.html']]) {
    const html = read(rel);
    const ids = ['stmtIncPortfolio', 'stmtIncInvestments',
                 'stmtIncTransactions', 'stmtIncPerformance'];
    ok(`${what} offers all four`, ids.every(id => html.includes(`id="${id}"`)),
       ids.filter(id => !html.includes(`id="${id}"`)).join(', '));
    ok(`  and every one of them starts ticked`,
       ids.every(id => new RegExp(`id="${id}"[^>]*\\bchecked\\b`).test(html)),
       'a statement that arrives missing sections by default is the '
       + 'opposite complaint');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
