#!/usr/bin/env node
/* "Approve & Credit Wallet" must open a dialog you can see and click.
 *
 * It did neither. admin.css styles the base class as
 *
 *     .modal-overlay      { opacity: 0; pointer-events: none; }
 *     .modal-overlay.open { opacity: 1; pointer-events: all; }
 *
 * Every modal in the console is opened by adding `open`. The EFT amount
 * confirmation is the one built by hand in JS, and it never got the class: it
 * set `display:flex` inline on an element that was still fully transparent and
 * click-through. Pressing Approve appended an invisible dialog, nothing
 * appeared, nothing could be clicked, and the promise the handler awaits never
 * resolved — so no request was ever sent and no error was ever shown.
 *
 * The button worked. What it opened could not be seen.
 *
 * This is the same shape as the portal toast that sat behind a `.show` class
 * the JS never added, and it is the reason both are checked by RENDERING them
 * with the real stylesheet rather than by reading the source. A class name is
 * not a defect you can see by reading either half on its own.
 *
 * Run: node scripts/check-eft-confirm-dialog.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthe stylesheet still hides an overlay that is not marked open');
{
  /* If this ever stops being true the fix below is merely belt-and-braces, and
     the next person should know which it is. */
  ok('.modal-overlay is transparent by default',
     /\.modal-overlay \{[^}]*opacity: 0/.test(CSS), 'the premise of this whole check');
  ok('and only .open makes it visible', /\.modal-overlay\.open \{[^}]*opacity: 1/.test(CSS));
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — the dialog was not rendered');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* The shipped function, lifted out and run against the shipped stylesheet. */
/* Skips the PARAMETER LIST before looking for the body.
   `function _eftConfirmAmount({ declared, name, ref, fileName })` destructures,
   so "the first { after the name" is the parameter brace: matching from there
   ended the slice at the end of the parameters and produced a function with no
   body, which parsed as a syntax error and left the page blank. */
function slice(name) {
  const at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  let i = SRC.indexOf('(', at), depth = 0;
  for (; i < SRC.length; i++) {                       // walk out of the parameter list
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  i = SRC.indexOf('{', i);                            // now the body
  depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(at, i + 1);
}
const escSrc = (SRC.match(/^const _esc = .*$/m) || [])[0];
let fn = '';
try { fn = slice('_eftConfirmAmount'); }
catch (err) { ok('_eftConfirmAmount could be extracted', false, err.message); }

const page = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div id="out"></div>
<script>
${escSrc}
const TOASTS = [];
const Toast = { error: m => TOASTS.push(m), success: m => TOASTS.push(m) };
${fn}

(async () => {
  const out = {};
  try {
  /* A normal approval: R2,500 declared, confirmed unchanged. */
  const p = _eftConfirmAmount({ declared: 2500, name: "S'busiso Dlamini", ref: 'EFT-1787825155331', fileName: 'POP.pdf' });

  const el = document.querySelector('.modal-overlay');
  const cs = el ? getComputedStyle(el) : null;
  const box = el ? el.querySelector('.modal') : null;
  const bcs = box ? getComputedStyle(box) : null;
  out.exists  = !!el;
  out.opacity = cs ? parseFloat(cs.opacity) : null;
  out.pointerEvents = cs ? cs.pointerEvents : null;
  out.boxOpacity = bcs ? parseFloat(bcs.opacity) : null;
  out.boxTransform = bcs ? bcs.transform : null;
  out.hasOpenClass = el ? el.classList.contains('open') : false;

  /* Is the Approve button actually reachable by a click at its own centre? */
  const go = el && el.querySelector('#eftGo');
  if (go) {
    const r = go.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    out.buttonHittable = !!(hit && (hit === go || go.contains(hit)));
    out.declaredShown = el.textContent.includes('R2 500,00') || el.textContent.includes('R2,500.00');
    out.nameEscaped = !el.querySelector('script') && el.textContent.includes("S'busiso");
    go.click();
  }
  const resolved = await Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), 600))]);
  out.resolved = resolved === 'TIMEOUT' ? 'TIMEOUT' : JSON.stringify(resolved);
  out.dialogRemoved = !document.querySelector('.modal-overlay');
  out.toasts = TOASTS;

  } catch (err) { out.threw = String(err && err.message || err); }
  document.getElementById('out').textContent = JSON.stringify(out);
})();
<\/script></body></html>`;

if (process.env.DUMP) { fs.writeFileSync('/tmp/dlg.html', page); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eftdlg-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, page);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=5000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
} catch (err) { dom = (err.stdout || '').toString(); }
const m = dom.match(/id="out">([\s\S]*?)<\/div>/);
let r = null;
try { r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")); }
catch (_) { /* reported below */ }

console.log('\nthe dialog, rendered with the shipped stylesheet');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 260));

if (r) {
  ok('the dialog is added to the page', r.exists === true);
  ok('it is VISIBLE', r.opacity === 1,
     `opacity ${r.opacity} — this was 0, so pressing Approve appeared to do nothing at all`);
  ok('and accepts clicks', r.pointerEvents !== 'none',
     `pointer-events ${r.pointerEvents} — "none" makes it invisible AND unclickable`);
  ok('the inner panel is not left scaled down', r.boxTransform === 'none' || r.boxTransform === 'matrix(1, 0, 0, 1, 0, 0)',
     `${r.boxTransform} — only .modal-overlay.open resets the modal's transform`);
  ok('it carries the open class the stylesheet expects', r.hasOpenClass === true,
     'every other modal in the console is opened by adding it');

  ok('the Approve button can actually be hit', r.buttonHittable === true,
     'an overlay above it, or pointer-events:none, and the click lands elsewhere');
  ok('the declared amount is shown to check against the proof', r.declaredShown === true);
  ok('an apostrophe in a name renders as text', r.nameEscaped === true);

  ok('clicking Approve resolves the promise the handler awaits',
     r.resolved !== 'TIMEOUT',
     'it never resolved, so no request was sent and no error was shown — the button "did nothing"');
  ok('and returns the amount to credit', /"amount":2500/.test(r.resolved || ''), r.resolved);
  ok('the dialog is removed afterwards', r.dialogRemoved === true);
  ok('nothing was reported as an error', (r.toasts || []).length === 0, JSON.stringify(r.toasts));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
