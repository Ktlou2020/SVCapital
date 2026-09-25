#!/usr/bin/env node
/* A stored document has to actually open.
 *
 * Factsheets, KYC documents and agreements are held as base64 `data:` URLs.
 * Two ways of opening one both fail, and both fail SILENTLY, which is why
 * this arrived as "factsheets are not opening or opening blank" depending on
 * which screen the reporter was on:
 *
 *   <a href="data:…">      Chrome has refused top-level navigation to data:
 *                          URLs since v60. The click does nothing. No error,
 *                          no tab, nothing in the console the user can see.
 *
 *   <iframe src="data:…">  refused by this platform's CSP, whose frame-src
 *                          was 'self' and Paystack. The frame renders blank.
 *                          A blob: frame was refused by the same rule.
 *
 * Both were live at once: the admin factsheet manager used the first, the
 * document viewer used the second, and the portal's KYC row ran its data:
 * URL through _safeUrl, which rewrites anything non-http to "#".
 *
 * The fix is one opener — Utils.documentUrl — that converts data: to a blob,
 * plus blob: in frame-src. data: is deliberately still refused there: a data:
 * frame can carry arbitrary HTML, which is a cross-site-scripting vector.
 *
 * Run: node scripts/check-stored-document-open.cjs
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

/* The shipped Utils, run against a recording Blob so the TYPE it builds is
   observable — that type is what decides whether a document renders or runs. */
function boot() {
  const made = [];
  const s = {
    console, String, Number, Math, JSON, Object, Array, Map, Set, RegExp, Date,
    parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Uint8Array, Promise, Error,
    atob: x => Buffer.from(x, 'base64').toString('binary'),
    Blob: function (parts, opts) { made.push((opts || {}).type); this.type = (opts || {}).type; },
    URL: { createObjectURL: () => 'blob:http://x/' + made.length, revokeObjectURL() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: '', origin: 'http://x' },
    fetch: () => Promise.reject(new Error('no network')),
    document: { addEventListener() {}, body: { style: {}, appendChild() {} },
                createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, append() {} }),
                querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  };
  const opened = [];
  s.open = (u) => { opened.push(u); return {}; };
  s.window = s; s.globalThis = s; s.self = s;
  vm.createContext(s);
  vm.runInContext(read('js/api.js'), s, { filename: 'js/api.js' });
  return { U: vm.runInContext('Utils', s), made, opened };
}

console.log('\nwhat a stored URL is turned into');
{
  const { U } = boot();
  ok('an http URL is left alone',
     U.documentUrl('https://x.co/a.pdf') === 'https://x.co/a.pdf');
  ok('a blob URL is left alone', U.documentUrl('blob:http://x/9') === 'blob:http://x/9');
  ok('a base64 data: URL becomes a blob',
     /^blob:/.test(U.documentUrl('data:application/pdf;base64,JVBERi0=') || ''),
     'a data: URL is what Chrome refuses to navigate to and the CSP refuses to frame');

  ok('a javascript: URL becomes nothing', U.documentUrl('javascript:alert(1)') === null,
     'it must never be possible to build a link out of one');
  ok('an unknown scheme becomes nothing', U.documentUrl('file:///etc/passwd') === null);
  ok('a non-base64 data: URL becomes nothing',
     U.documentUrl('data:text/html,<script>x</script>') === null);
  for (const v of ['', '   ', null, undefined]) {
    ok(`${JSON.stringify(v)} becomes nothing`, U.documentUrl(v) === null);
  }
}

console.log('\nand the blob it builds cannot run as this site');
{
  /* A blob URL inherits the origin that created it. A blob of type text/html
     opened in a tab executes its script AS this platform. The upload route
     only validates the mime when one is present, nothing validates rows
     already in the table, and KYC file_url values are not checked at all. */
  const cases = [
    ['application/pdf',  'application/pdf'],
    ['image/png',        'image/png'],
    ['image/jpeg',       'image/jpeg'],
    ['text/plain',       'text/plain'],
    ['text/html',        'application/octet-stream'],
    ['image/svg+xml',    'application/octet-stream'],
    ['application/javascript', 'application/octet-stream'],
    ['APPLICATION/PDF',  'application/pdf'],
  ];
  for (const [claimed, expected] of cases) {
    const { U, made } = boot();
    U.documentUrl(`data:${claimed};base64,AA==`);
    ok(`${claimed} is served as ${expected}`, made[0] === expected, String(made[0]));
  }
}

console.log('\nnothing navigates to, or frames, a data: URL');
{
  /* Every place a stored document URL reaches the DOM. Matched on the
     attribute, because that is the shape that fails. */
  const FILES = ['admin/js/admin.js', 'js/portal-core.js',
                 'portal/js/portal.js', 'mobile/src/js/portal.js'];
  for (const f of FILES) {
    const src = read(f);
    /* "Straight into" means the raw column value. An expression that has been
       through Utils.documentUrl is the fix, not the fault, and an assertion
       that cannot tell them apart fails on the corrected code. */
    const raw = m => !/Utils\.documentUrl/.test(m);
    const hrefs = (src.match(/href="\$\{[^}"]*(?:file_url|factsheet_url)[^}"]*\}"/g) || []).filter(raw);
    ok(`${f}: no stored URL goes straight into an href`, hrefs.length === 0,
       hrefs.join('\n      '));
    const frames = (src.match(/<iframe[^>]*src="\$\{[^}"]*(?:file_url|factsheet_url)[^}"]*\}"/g) || []).filter(raw);
    ok(`${f}: no stored URL goes straight into an iframe`, frames.length === 0,
       frames.join('\n      '));
  }

  ok('the portal KYC row no longer hands a data: URL to _safeUrl',
     !/_safeUrl\(d\.file_url\)/.test(read('js/portal-core.js')),
     '_safeUrl rewrites anything non-http to "#", so the link rendered and did nothing');
}

console.log('\nevery opener goes through the one implementation');
{
  for (const [f, what] of [
    ['admin/js/admin.js',       'the admin console'],
    ['js/portal-core.js',       'the shared portal'],
    ['portal/js/portal.js',     'the web portal'],
    ['mobile/src/js/portal.js', 'the mobile shell'],
  ]) {
    const src = read(f);
    ok(`${what} calls Utils.documentUrl or Utils.openDocument`,
       /Utils\.(documentUrl|openDocument)\(/.test(src));
    /* The hand-rolled decode is the thing that drifts: four copies of it
       existed and only some constrained the type. */
    const rolled = (src.match(/atob\([^)]*\)[\s\S]{0,200}?createObjectURL\(new Blob\(\[[^\]]*\], \{ type: mime \}\)\)/g) || []);
    ok(`${what} no longer rolls its own data: decode`, rolled.length === 0,
       `${rolled.length} left`);
  }
}

console.log('\nthe CSP admits a blob frame and still refuses a data: one');
{
  const idx = read('server/index.js');
  const frameSrc = (idx.match(/frameSrc:\s*\[([^\]]*)\]/) || [, ''])[1];
  ok('frame-src is declared', frameSrc.length > 0);
  ok("it admits blob:", /'blob:'/.test(frameSrc), frameSrc.trim());
  ok("it still admits 'self'", /'self'/.test(frameSrc));
  ok('it does NOT admit data:', !/'data:'/.test(frameSrc),
     'a data: frame can carry arbitrary HTML — that is a cross-site-scripting vector');
  ok('Paystack checkout is still framed', /checkout\.paystack\.com/.test(frameSrc));

  /* object-src stays 'none'. Chrome's own PDF viewer in a frame is not an
     <object> in this page and is unaffected. */
  ok("object-src is still 'none'", /objectSrc:\s*\["'none'"\]/.test(idx));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
