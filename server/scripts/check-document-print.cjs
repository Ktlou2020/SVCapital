#!/usr/bin/env node
/* "Print / Save PDF" in the packaged app.
 *
 * The purple button called frame.contentWindow.print(). window.print() does
 * NOT exist in the iOS WKWebView, so it threw and the client was told their
 * browser could not open a print dialog — about an app, with no browser
 * setting to change. On Android WebView it exists and does nothing at all, so
 * the button was silent. Neither is fixable from JavaScript.
 *
 * The statement screen in the mobile shell had solved this already:
 * html2canvas to a canvas, jsPDF to A4 pages, and the file handed to the
 * operating system's share sheet. The purple button now takes the same route,
 * and the web keeps printing.
 *
 * Run: node server/scripts/check-document-print.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DOCS = read('js/investor-documents.js');
const SRC  = strip(DOCS);
const MOB  = read('mobile/src/index.html');
const WEB  = read('portal/index.html');

console.log('\nthe button does not just call print any more');
{
  ok('the click goes through one handler',
     /ov\.querySelector\('#svc-doc-print'\)\.onclick = \(\) => _printOrShare\(frame\);/.test(SRC),
     'the handler was an inline print() with a catch');
  ok('which asks whether it is in the app first',
     /function _printOrShare[\s\S]{0,200}if \(!_isNativeApp\(\)\) \{/.test(SRC));
  ok('and the app is recognised by either flag',
     /window\.__SVC_NATIVE__ \|\| window\.Capacitor/.test(SRC),
     'one flag alone misses a shell that sets the other');
}

console.log('\non the web it still prints the document, not the overlay');
{
  ok('print is called on the frame',
     /frame\.contentWindow\.focus\(\); frame\.contentWindow\.print\(\);/.test(SRC),
     'printing the overlay loses the document’s own @page rules');
  ok('and a browser that refuses still says so',
     /could not open the print dialog/.test(SRC));
}

console.log('\nin the app it builds a PDF and hands it to the system');
{
  ok('the document is rendered to a canvas', /html2canvas\(body, \{/.test(SRC));
  ok('and sliced into A4 pages rather than squeezed onto one',
     /while \(remaining > 0\) \{[\s\S]{0,160}pdf\.addPage\(\);/.test(SRC),
     'a long statement would come out as one unreadable page');
  ok('the file goes to the share sheet when there is one',
     /navigator\.canShare && navigator\.canShare\(\{ files: \[file\] \}\)[\s\S]{0,120}navigator\.share\(/.test(SRC));
  ok('with a download as the fallback',
     /a\.download = name;/.test(SRC));
  ok('the libraries are checked before it starts',
     /typeof html2canvas === 'undefined' \|\| !jsPDFCtor/.test(SRC),
     'a missing library would throw halfway through with no explanation');
  ok('and the app actually ships them',
     /html2canvas@/.test(MOB) && /jspdf@/.test(MOB),
     'the native bundle is built from this shell');
}

console.log('\nit never fails silently');
{
  ok('a cancelled share is not reported as an error',
     /err\.name === 'AbortError'/.test(SRC),
     'a client who taps Cancel would be told it failed');
  ok('anything else is', /Could not prepare the PDF/.test(SRC));
  ok('and a document still loading says that instead',
     /The document is still loading/.test(SRC));
}

console.log('\nthe dead button inside the document is hidden');
{
  /* The templates carry their own print button for when a document is opened
     in a window of its own. In the overlay it sits beside the working one,
     and in the app it is the dead one. */
  ok('the overlay hides the document’s own print control',
     /querySelectorAll\('\.no-print button, \.btn-print, button\[onclick\*="print"\]'\)/.test(SRC));
  ok('and the templates keep it for a standalone window',
     /onclick="window\.print\(\)"/.test(DOCS),
     'removing it would break a document opened on its own');
}

console.log('\nthe web portal is unaffected');
{
  ok('it still loads jsPDF for its own exports', /jspdf@/.test(WEB));
  ok('and nothing there depends on html2canvas',
     !/html2canvas/.test(strip(read('portal/js/portal.js'))),
     'the web shell does not ship html2canvas, so a web path needing it would break');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
