#!/usr/bin/env node
/* A document has to reach the client in the packaged app, not only in a browser.
 *
 * Two faults, reported together from a phone:
 *
 *  · "THE PRINT/SAVE PDF BUTTON DOES NOT LOAD WHEN CLICKED ON." _present tried
 *    window.open first and fell back to the full-screen overlay when it
 *    returned null. That is right in a browser and wrong in a WebView: the
 *    Capacitor shell does not return null — it hands back a window object for
 *    a view the client never sees, or routes the URL to the system browser,
 *    which has nothing to show because the document is written in afterwards.
 *    Either way the fallback never fires and the button looks dead.
 *
 *  · "INVESTMENT INCOME CERTIFICATES ARE NOT LOADING NOR IS THERE A DOWNLOAD
 *    OPTION." The statement archive called _downloadTaxCert, a SECOND tax
 *    certificate built in the browser with jsPDF. It ended in doc.save(),
 *    which is an anchor download and does nothing inside a WebView — so the
 *    app built a PDF and silently dropped it. It also printed `totalReturns`
 *    and dropped `maturedReturns`, which for a client whose income comes from
 *    maturities IS their income; and it destructured window.jspdf without
 *    checking, so a missing library threw first.
 *
 * The overlay already carries the right route for a WebView — render to
 * canvas, slice with jsPDF, hand the file to the share sheet — so the fix is
 * to stop stepping over it, and to have one certificate rather than two.
 *
 * Run: node scripts/check-native-document-delivery.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* The real module, run twice: once as a browser, once as the packaged app.
   What is asserted is whether it ASKED for a window — the thing that goes
   wrong in a WebView — and whether the overlay it falls back to was built. */
function present({ native, openReturns }) {
  const opened = [];
  const made = [];
  const el = () => ({
    id: '', style: {}, innerHTML: '', className: '',
    appendChild() {}, remove() {}, querySelector: () => el(),
    querySelectorAll: () => [], addEventListener() {}, setAttribute() {},
    contentDocument: { body: { scrollHeight: 100 }, querySelectorAll: () => [] },
    contentWindow: { focus() {}, print() {} }, getBoundingClientRect: () => ({ width: 390 }),
  });
  const s = {
    console, Math, JSON, Number, String, Object, Array, Date, Error, RegExp,
    parseFloat, parseInt, isNaN, setTimeout: () => 0, clearTimeout() {},
    navigator: { userAgent: 'node' }, location: { href: '', origin: '' },
    Toast: { error() {}, info() {}, success() {} },
    document: {
      getElementById: id => (id === 'svc-doc-overlay' ? null : el()),
      createElement: tag => { const e = el(); made.push(tag); return e; },
      body: { appendChild() {}, removeChild() {}, style: {} },
      addEventListener() {},
    },
    addEventListener() {},
    open: (...args) => { opened.push(args); return openReturns; },
  };
  if (native) s.Capacitor = { isNativePlatform: () => true };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  /* The page provides this; portal/js/portal.js:56 is where it lives. Taken
     verbatim rather than approximated — an escaper that differs from the
     shipped one would hide a real escaping bug in the markup. */
  vm.runInContext(
    "var _esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')" +
    ".replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');", s);
  vm.runInContext(read('js/investor-documents.js'), s, { filename: 'investor-documents.js' });
  const docs = vm.runInContext('typeof SVCDocs !== "undefined" ? SVCDocs : null', s);
  return { docs, opened, made, sandbox: s };
}

console.log('\nin the packaged app the document never asks for a window');
{
  /* A WebView that returns something truthy is the case that broke it. If the
     code still asks, this is exactly the state it ends up in. */
  const win = { document: { write() {}, close() {} } };
  const app = present({ native: true, openReturns: win });
  ok('the module loaded', !!app.docs, 'nothing below means anything otherwise');
  app.docs.openAccountStatement
    ? null : ok('openAccountStatement exists', false, Object.keys(app.docs || {}).join(', '));

  const data = { investor: { id: 'I-1', first_name: 'A', last_name: 'B' },
                 taxYear: 2026, from: '2025-03-01', to: '2026-02-28',
                 returns: [], totalReturns: 0, deposits: [], totalDeposits: 0,
                 maturedInvestments: [], maturedReturns: 0, maturedUnposted: 0 };
  app.docs.openIncomeReference(data);
  ok('window.open was not called', app.opened.length === 0,
     `called ${app.opened.length} time(s) — a WebView returns a window the client never sees, ` +
     'and the overlay then never renders');
  ok('and the overlay was built instead', app.made.includes('div') && app.made.includes('iframe'),
     JSON.stringify(app.made));
}

console.log('\nand in a browser it still gets its own window');
{
  const win = { document: { write() {}, close() {} } };
  const web = present({ native: false, openReturns: win });
  const data = { investor: { id: 'I-1', first_name: 'A', last_name: 'B' },
                 taxYear: 2026, from: '2025-03-01', to: '2026-02-28',
                 returns: [], totalReturns: 0, deposits: [], totalDeposits: 0,
                 maturedInvestments: [], maturedReturns: 0, maturedUnposted: 0 };
  web.docs.openIncomeReference(data);
  ok('window.open was called', web.opened.length === 1, JSON.stringify(web.opened));
  ok('and no overlay was needed', !web.made.includes('iframe'),
     'a real window is the better experience where one is allowed');
}

console.log('\nand a browser that REFUSES the pop-up still shows the document');
{
  const blocked = present({ native: false, openReturns: null });
  const data = { investor: { id: 'I-1', first_name: 'A', last_name: 'B' },
                 taxYear: 2026, from: '2025-03-01', to: '2026-02-28',
                 returns: [], totalReturns: 0, deposits: [], totalDeposits: 0,
                 maturedInvestments: [], maturedReturns: 0, maturedUnposted: 0 };
  blocked.docs.openIncomeReference(data);
  ok('the overlay is built', blocked.made.includes('iframe'),
     'a blocked pop-up must not be a dead button either');
}

console.log('\nthere is one Investment Income Certificate, not two');
{
  const CORE = strip(read('js/portal-core.js'));
  ok('the statement archive asks for the real document',
     /onclick="generateTaxCertificate\(\$\{y\}\)"/.test(CORE),
     'it called _downloadTaxCert, which built a different certificate');
  ok('and generateTaxCertificate accepts the year those buttons name',
     /async function generateTaxCertificate\(yearArg\)/.test(CORE)
     && /Number\.isFinite\(yearArg\) \? yearArg/.test(CORE),
     'the buttons have no picker to read');
  ok('the browser-built duplicate is gone',
     !/function _downloadTaxCert/.test(CORE),
     'two implementations are two answers to what the client earned');
  ok('and nothing calls it any more', !/_downloadTaxCert\(/.test(CORE));
  ok('no certificate path ends in a doc.save() the app cannot honour',
     !/SVC-TaxCert-/.test(CORE),
     'doc.save() is an anchor download; inside a WebView it drops the file silently');
  ok('the real path renders through the shared builder',
     /SVCDocs\.openIncomeReference\(data\)/.test(CORE),
     'which is the one that reaches the share sheet on a phone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
