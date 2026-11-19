#!/usr/bin/env node
/* Handing a document to the person who asked for it.
 *
 * REPORTED, from the app: "it says the document has been downloaded but when
 * I check in Files I do not see it."
 *
 * It had not been. Every document went out through jsPDF's doc.save() or an
 * <a download> click — a blob URL and a synthetic click, which is how a
 * BROWSER downloads a file. A native WebView has no download manager: on iOS
 * WKWebView the click does nothing at all, and on Android it needs a
 * DownloadListener that Capacitor does not wire up for blob URLs. Nothing is
 * written, nothing throws, and the success toast fired regardless.
 *
 * Eleven places did it: investment certificates (two routes), receipts, the
 * IT3b tax certificate, sub-account statements, the analytics CSV, the POPIA
 * data export, and the stored-document viewer.
 *
 * THE APP ALREADY HAD THE ANSWER IN ONE PLACE. The statement PDF reached the
 * share sheet through navigator.share({files}), which WKWebView does support,
 * and fell back to a download on the web. That is exactly why statements
 * worked and certificates did not — one surface had been fixed and the rule
 * stayed local to it. It is now svcDeliverFile, and every document uses it.
 *
 * Run: node server/scripts/check-document-delivery.cjs
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

const CORE = read('js/portal-core.js');
const DOCS = read('js/investor-documents.js');

/* ── The rule, RUN rather than read ──────────────────────────────────── */
function load(env) {
  const from = CORE.indexOf('async function svcDeliverFile');
  const to   = CORE.indexOf('function svcCanonProductType');
  const ctx = Object.assign({
    Toast: { success(m) { ctx._toast = ['success', m]; }, error(m) { ctx._toast = ['error', m]; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    File: class { constructor(parts, name, o) { this.name = name; this.type = (o || {}).type; } },
    setTimeout: fn => fn,
    document: {
      _clicks: 0,
      createElement() { const self = ctx.document; return { set href(v) {}, set download(v) { self._name = v; }, click() { self._clicks++; } }; },
      body: { appendChild() {}, removeChild() {} },
    },
    console,
  }, env);
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE.slice(from, to) + '\nthis.deliver = svcDeliverFile; this.say = svcDeliverToast;', ctx);
  return ctx;
}
const blob = { type: 'application/pdf' };

(async () => {

console.log('\nthe share sheet is tried first, because a phone has no download manager');
{
  const shared = [];
  const ctx = load({
    navigator: { canShare: () => true, share: async o => { shared.push(o); } },
    __SVC_NATIVE__: true,
  });
  const out = await ctx.deliver(blob, 'SVC-Certificate-1.pdf', 'Certificate');
  ok('IT SHARES RATHER THAN DOWNLOADING', out === 'shared', String(out));
  ok('and hands over the file, not a url',
     shared.length === 1 && Array.isArray(shared[0].files) && shared[0].files[0].name === 'SVC-Certificate-1.pdf',
     JSON.stringify(shared));
  ok('and no download was attempted', ctx.document._clicks === 0, String(ctx.document._clicks));
}

console.log('\nand a browser still downloads, exactly as it did');
{
  const ctx = load({ navigator: {} });       // no share support at all
  const out = await ctx.deliver(blob, 'SVC-Receipt-9.pdf', 'Receipt');
  ok('it falls back to the download', out === 'downloaded', String(out));
  ok('with the right filename', ctx.document._name === 'SVC-Receipt-9.pdf', String(ctx.document._name));
  ok('and the click really happened', ctx.document._clicks === 1, String(ctx.document._clicks));
}

console.log('\nand canShare is asked about THE FILE, not merely about sharing');
{
  /* Safari exposes navigator.share without file support. Testing for share
     alone hands it a file it refuses, and the document is lost. */
  let askedWithFiles = false;
  const ctx = load({
    navigator: {
      canShare: o => { if (o && o.files) askedWithFiles = true; return false; },
      share: async () => { throw new Error('should not be called'); },
    },
  });
  const out = await ctx.deliver(blob, 'x.pdf', 'Doc');
  ok('canShare is called with the files', askedWithFiles);
  ok('and a no answer means the download, not a failed share', out === 'downloaded', String(out));
}

console.log('\nand closing the share sheet is a decision, not a failure');
{
  const ctx = load({
    navigator: { canShare: () => true, share: async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; } },
    __SVC_NATIVE__: true,
  });
  const out = await ctx.deliver(blob, 'x.pdf', 'Doc');
  ok('it reports a cancellation', out === 'cancelled', String(out));
  ok('AND DOES NOT THEN DOWNLOAD THE FILE ANYWAY',
     ctx.document._clicks === 0,
     'on a phone that writes a file the person just declined');
  ctx.say(out, 'Certificate');
  ok('and says nothing at all about it', ctx._toast === undefined, JSON.stringify(ctx._toast));
}

console.log('\nand the app is never told a file was downloaded when it was not');
{
  /* The native WebView with no share support is the case the original bug
     was: the click does nothing. It must not claim success. */
  const ctx = load({ navigator: {}, __SVC_NATIVE__: true });
  const out = await ctx.deliver(blob, 'x.pdf', 'Doc');
  ok('the outcome is reported as unavailable', out === 'unavailable', String(out));
  ctx.say(out, 'Certificate');
  ok('AND THE TOAST DOES NOT SAY "DOWNLOADED"',
     ctx._toast && ctx._toast[0] === 'error' && !/downloaded/i.test(ctx._toast[1]),
     JSON.stringify(ctx._toast) + ' — this is the sentence that was the bug');
  ok('and it says what to do instead', /browser/i.test(ctx._toast[1]), ctx._toast[1]);
}

console.log('\nand each outcome has its own sentence');
{
  const ctx = load({ navigator: {} });
  ctx.say('shared', 'Certificate');
  ok('shared does not claim a download',
     !/downloaded/i.test(ctx._toast[1]) && /save/i.test(ctx._toast[1]), ctx._toast[1]);
  ctx.say('downloaded', 'Certificate');
  ok('downloaded does', /downloaded/i.test(ctx._toast[1]), ctx._toast[1]);
}

/* ── Every call site ─────────────────────────────────────────────────── */
console.log('\nand every document a client can ask for goes through it');
{
  /* The failure mode is a NEW surface added with doc.save(), which works on
     the developer's laptop and silently does nothing on a phone. */
  const stripped = CORE.replace(/\/\*[\s\S]*?\*\//g, ' ');
  ok('NO BARE jsPDF SAVE REMAINS', !/\.\s*save\(\s*[`'"]/.test(stripped),
     (stripped.match(/\.\s*save\(\s*[`'"][^\n]*/) || [''])[0]
     + ' — doc.save() is a browser download and the app has no download manager');

  /* Exactly one <a download> click: the fallback inside the helper itself. */
  const clicks = (stripped.match(/a\.click\(\)/g) || []).length;
  ok('and exactly one download click, the helper\'s own fallback',
     clicks === 1, `${clicks} found — every other one should go through svcDeliverFile`);

  for (const noun of ['Certificate', 'Receipt', 'Tax certificate', 'Statement',
                      'Analytics export', 'Your data', 'Document'])
    ok(`${noun} is delivered through the helper`,
       new RegExp(`svcDeliverFile\\([\\s\\S]{0,160}?'${noun}'`).test(CORE), noun);

  /* await needs an async caller; a missing one is a syntax error, but a
     forgotten await is not — it would deliver the Promise to the toast. */
  /* Not the declaration. The first version matched `function
     svcDeliverToast(outcome, ...` as a call missing its await and reported
     a bug in the helper's own definition. */
  const bad = [...CORE.matchAll(/(?<!function )svcDeliverToast\(\s*(?!await\b)/g)];
  ok('and every call awaits the result',
     bad.length === 0, `${bad.length} call(s) pass a Promise to the toast`);
}

/* ── The surface that was already right ──────────────────────────────── */
console.log('\nand the document viewer that already shared keeps doing so');
{
  ok('investor-documents tries canShare with files first',
     /navigator\.canShare[\s\S]{0,80}files: \[file\]/.test(DOCS), 'js/investor-documents.js');
  ok('and treats a cancelled share as a decision',
     /AbortError/.test(DOCS), 'js/investor-documents.js');
  /* And the buttons inside a generated statement that cannot work in the
     app are hidden there — print and CSV are both `.no-print button`. */
  ok('the statement\'s own buttons are hidden in the app',
     /querySelectorAll\('\.no-print button, \.btn-print/.test(DOCS),
     'window.print() and an <a download> both do nothing in the WebView; '
     + 'a visible button that cannot work is the same bug wearing a hat');
  ok('and the CSV button is one of them',
     /\.btn-csv\{/.test(DOCS) && /no-print button\{/.test(DOCS),
     'btn-csv is styled under .no-print, so the hide above covers it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
