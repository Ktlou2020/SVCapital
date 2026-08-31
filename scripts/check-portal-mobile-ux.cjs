#!/usr/bin/env node
/* The portal must be usable on a phone, and a form must say why it refused.
 *
 * WHAT WENT WRONG
 *
 * A client on an iPhone could not submit a maturity instruction. The cause was
 * not the instruction code — that sends the right body, and the endpoint
 * accepts it. It was that the portal's toasts were BROKEN in two ways at once,
 * so the client could see neither the confirmation nor the reason:
 *
 *   · js/api.js builds `<div class="toast toast--error">` and never adds a
 *     `.show` class. portal.css hid every toast behind `opacity: 0` and
 *     revealed it with `.toast.show`, and coloured `.toast.error` — two classes
 *     the JS does not set. A toast was therefore invisible except for the frame
 *     or two of an inherited animation.
 *   · It was positioned twice: admin.css pins the CONTAINER top-right, while
 *     portal.css made each toast `position: fixed; left: 50%`. Measured at
 *     phone width the toast landed 310px off the right edge — which is exactly
 *     what the client's screenshot showed, a red bar half off the screen.
 *
 * So: tap Submit, see nothing, tap again. Both halves are measured here in a
 * real browser at phone size, because both were CSS-only faults that no amount
 * of reading the JavaScript would have found.
 *
 * The form now also states its own errors inline, and will not offer an
 * instruction it cannot complete.
 *
 * Run: node scripts/check-portal-mobile-ux.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const CORE   = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ── The two portal-core copies must not drift ─────────────────────────── */
console.log('\nthe portal and the app run the same code');
{
  const mob = path.join(ROOT, 'mobile', 'www', 'js', 'portal-core.js');
  ok('portal-core.js is identical in both places',
     fs.readFileSync(mob, 'utf8') === CORE,
     'the app ships a copy; a fix applied to one and not the other is a fix half-made');
}

console.log('\nthe form refuses in a way the client can act on');
{
  ok('there is an inline error slot', /function _matErrorSlot\(\)/.test(CORE));
  ok('both modals render it', (CORE.match(/\$\{_matErrorSlot\(\)\}/g) || []).length === 2,
     'the per-investment and the pool modal');
  ok('it is announced to a screen reader', /role="alert"/.test(CORE));
  ok('failures show inline, not only as a toast',
     (CORE.match(/_matShowError\(/g) || []).length >= 6, 'every refusal path');
  ok('and the server\'s own message is shown',
     /_matShowError\(e\.message \|\| 'Could not save this instruction/.test(CORE),
     'the reason the server gave is the only thing that tells the client what to change');
  ok('changing anything clears the error', /_matClearError\(\);/.test(CORE));
  ok('an instruction with no product to switch into is disabled',
     /_switchOptionAttrs\(canSwitch\)/.test(CORE) && /return canSwitch \? '' : ' disabled'/.test(CORE),
     'it led to a select holding nothing but a disabled placeholder');
  ok('and says why in the option itself',
     /no other product is open right now/.test(CORE));
  ok('the product is read from the selected option, not the value',
     /if \(!opt \|\| opt\.disabled\) return null;/.test(CORE),
     'a disabled placeholder must resolve to nothing, not to an empty string');
  ok('the failed payload is logged for diagnosis',
     /console\.error\('\[maturity\]', e, \{ instruction: type/.test(CORE));
}

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — nothing below was measured');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Measured in a browser, at phone width, with the real stylesheets ──── */
const SHEETS = ['css/admin.css', 'portal/css/portal.css', 'css/ci-theme.css', 'portal/css/portal-premium.css'];
const css = SHEETS.map(f => `<style>/* ${f} */\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}</style>`).join('\n');

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
${css}</head><body>
<div class="modal-overlay open" id="maturityModal" style="display:flex">
  <div class="modal">
    <div class="modal__header"><span class="modal__title">Submit Maturity Instruction</span>
      <button class="modal__close">x</button></div>
    <div class="modal__body" id="maturityModalBody">
      <div id="matError" role="alert" style="display:none"></div>
      ${Array.from({ length: 6 }, (_, i) => `<div class="form-group"><label class="form-label">Field ${i}</label>
        <select class="form-select"><option>Switch Product — into a different product</option></select></div>`).join('')}
    </div>
    <div class="modal__footer"><button class="btn btn--secondary">Cancel</button>
      <button class="btn btn--primary" id="maturityConfirmBtn">Submit Instruction</button></div>
  </div></div>
<div id="out"></div>
<script>
const c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c);
const t = document.createElement('div'); t.className = 'toast toast--error';
const i = document.createElement('i'); i.className = 'fa-solid fa-circle-xmark';
const m = document.createElement('span'); m.className = 'toast__msg';
m.textContent = 'A product to switch into is required for this instruction. Choose one and try again.';
t.append(i, m); c.appendChild(t);
const vw = innerWidth, vh = innerHeight;
const box = el => { const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
           right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
const cs = el => getComputedStyle(el);
const btn = document.getElementById('maturityConfirmBtn');
const body = document.getElementById('maturityModalBody');
const modal = document.querySelector('.modal');
const tb = box(t);
document.getElementById('out').textContent = JSON.stringify({
  vw, vh,
  toastVisible: parseFloat(cs(t).opacity) > 0,
  toastMinWidth: parseFloat(cs(t).minWidth) || 0,
  containerLeft: cs(c).left, containerRight: cs(c).right, containerBox: box(c),
  toastOnScreen: tb.x >= 0 && tb.right <= vw,
  toastLines: tb.h,
  toastWraps: cs(t).whiteSpace !== 'nowrap',
  submitVisible: box(btn).bottom <= vh && box(btn).y >= 0,
  submitHeight: box(btn).h,
  bodyScrolls: cs(body).overflowY === 'auto' || cs(body).overflowY === 'scroll',
  modalClipsOwnScroll: cs(modal).overflow === 'hidden',
  horizontalScroll: document.documentElement.scrollWidth > vw,
});
<\/script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, page);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=390,844', '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
} catch (err) { dom = (err.stdout || '').toString(); }
const mm = dom.match(/id="out">([\s\S]*?)<\/div>/);
let r = null;
try { r = JSON.parse((mm ? mm[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
catch (_) { /* reported below */ }

/* Headless Chrome refuses a window narrower than 500px, so this runs at 500 —
   inside the ≤768px mobile breakpoint, but wider than a real handset. The
   width-independent properties are asserted separately below. */
console.log('\nmeasured on a narrow screen');
ok('the page reported', !!r, (mm ? mm[1] : dom).slice(0, 250));

if (r) {
  console.log(`  (viewport ${r.vw}×${r.vh})`);
  ok('a toast is visible without needing a class the JS never adds',
     r.toastVisible === true,
     'portal.css hid it behind opacity:0 and revealed it with .toast.show');
  ok('and sits entirely on screen', r.toastOnScreen === true,
     'it was measured 310px off the right edge before this');
  /* Headless Chrome clamps its window to 500px wide, so the run above cannot
     be narrower than that. These are what make the layout safe at ANY width,
     so they are asserted directly rather than inferred from one viewport.

     getComputedStyle().top returns the USED value for a positioned element, so
     a bottom-anchored container reports a pixel offset rather than 'auto' —
     asserting on the literal was wrong. What matters is that the container
     wraps its toast instead of spanning the screen, which is what having both
     top and bottom set produced. */
  ok('the container is inset from both edges, at any width',
     r.containerLeft === '12px' && r.containerRight === '12px',
     `left ${r.containerLeft}, right ${r.containerRight}`);
  ok('and hugs its content instead of spanning the screen',
     r.containerBox.h < r.vh / 2,
     `container is ${r.containerBox.h}px tall in a ${r.vh}px viewport — top and bottom both anchored`);
  ok('sitting in the lower half, clear of the bottom nav',
     r.containerBox.y > r.vh / 2 && r.containerBox.bottom <= r.vh,
     JSON.stringify(r.containerBox));
  ok('the toast has no minimum width to overflow a narrow phone',
     r.toastMinWidth === 0, `min-width ${r.toastMinWidth}px`);
  ok('a long message wraps rather than overflowing', r.toastWraps === true,
     'the app copy had white-space:nowrap on a fixed-position toast');
  ok('the message gets more than one line', r.toastLines > 24, `${r.toastLines}px tall`);

  ok('the Submit button is on screen with a full form', r.submitVisible === true,
     'the footer scrolled with the body, so on a long form Submit was below the fold');
  ok('and is a thumb-sized target', r.submitHeight >= 44, `${r.submitHeight}px — 44px is the floor`);
  ok('the body scrolls, not the whole sheet', r.bodyScrolls === true);
  ok('so the sheet itself does not scroll its own footer away',
     r.modalClipsOwnScroll === true);
  ok('nothing forces the page sideways', r.horizontalScroll === false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
