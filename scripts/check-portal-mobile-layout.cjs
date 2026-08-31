#!/usr/bin/env node
/* The investor portal must lay out correctly on a phone.
 *
 * Measured, not reviewed. The real markup of portal/index.html is rendered with
 * the real stylesheets at a narrow viewport and every visible element is
 * inspected. What that found, none of which was visible by reading the CSS:
 *
 *   SIDEWAYS SCROLL on every view. A grid item carries an implicit
 *   `min-width: auto`, so a `1fr` track cannot shrink below its content's
 *   min-content width. The container measured 472px while its single track
 *   computed to 514.7px, because a data table would not fit. The page scrolled
 *   27px sideways with nothing on screen saying so.
 *
 *   TAP TARGETS below the 44px both Apple and Google set as the floor: primary
 *   buttons 36px, tabs 40px, filter selects 33px, checkboxes 13px — and the
 *   bottom navigation bar, which every journey starts from, at 32px.
 *
 *   TEXT below 11px in 43 places, the smallest at 9.5px. The cause of the first
 *   attempt at fixing it failing is worth keeping: admin.css sets
 *   `html { font-size: 14px }`, so every rem in this portal is 12.5% smaller
 *   than it reads. A 0.8rem floor written expecting 12.8px rendered 11.2px. The
 *   floors are in PIXELS for that reason — a legible minimum is a physical
 *   threshold, not a scale-relative one.
 *
 * Run: node scripts/check-portal-mobile-layout.cjs
 *      …--report   print every finding rather than just the counts
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

if (!CHROME) {
  console.log('\n  SKIP  no headless Chromium — nothing here can be measured');
  process.exit(0);
}

/* ── Build the page: real markup, real stylesheets, no scripts ────────── */
const SHEETS = ['css/admin.css', 'portal/css/portal.css', 'css/ci-theme.css', 'portal/css/portal-premium.css'];
let html = fs.readFileSync(path.join(ROOT, 'portal', 'index.html'), 'utf8');
const styles = SHEETS.map(f => `<style>/* ${f} */\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}</style>`).join('\n');
html = html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '')
  .replace(/<\/head>/, styles + '</head>');

/* Every view is shown at once. Each is a sibling that the router toggles, so
   measuring only the default one would leave most of the portal unchecked. */
const probe = `
<style>.view{display:block !important}.modal-overlay{display:none !important}</style>
<script>
const vw = innerWidth;
const out = { vw, vh: innerHeight, pageScrollW: document.documentElement.scrollWidth,
              overflow: [], smallTap: [], smallFont: [], zoomInputs: [] };
const sel = el => { let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  if (el.className && typeof el.className === 'string') {
    const c = el.className.trim().split(/\\s+/).slice(0, 2).join('.'); if (c) s += '.' + c; }
  return s; };
const seen = {};
document.querySelectorAll('*').forEach(el => {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const k = sel(el);
  /* The off-canvas drawer sits at negative x deliberately. Content inside a
     horizontal scroller is meant to be wider than its container — that IS the
     fix for wide tables — so only overflow that takes the PAGE sideways counts. */
  if (el.closest('#sidebar')) return;
  let inScroller = false;
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const c = getComputedStyle(n);
    if (c.overflowX === 'auto' || c.overflowX === 'scroll') { inScroller = true; break; }
  }
  if (r.right > vw + 1 && !inScroller && !seen['o' + k]) {
    seen['o' + k] = 1; out.overflow.push({ sel: k, right: Math.round(r.right), w: Math.round(r.width) });
  }
  if (el.matches('button,a,[onclick],[role="button"],input[type=checkbox],input[type=radio],select,.mbn-item,.nav-item,.tab-btn')) {
    let t = { width: r.width, height: r.height };
    /* A checkbox's target is its label, which is what a thumb actually hits. */
    if (el.matches('input[type=checkbox],input[type=radio]')) {
      const lab = el.closest('label') || el.parentElement;
      if (lab) { const lr = lab.getBoundingClientRect();
        if (lr.height >= 44 && lr.width >= 44) t = { width: lr.width, height: lr.height }; }
    }
    if ((t.height < 44 || t.width < 28) && r.height > 0 && !seen['t' + k]) {
      seen['t' + k] = 1; out.smallTap.push({ sel: k, w: Math.round(t.width), h: Math.round(t.height) });
    }
  }
  const fs_ = parseFloat(cs.fontSize) || 0;
  if (!el.children.length && el.textContent.trim() && fs_ < 11.5 && !seen['f' + k]) {
    seen['f' + k] = 1; out.smallFont.push({ sel: k, px: Math.round(fs_ * 10) / 10, txt: el.textContent.trim().slice(0, 26) });
  }
  if (el.matches('input,select,textarea') && fs_ < 16 && !seen['z' + k]) {
    seen['z' + k] = 1; out.zoomInputs.push({ sel: k, px: fs_ });
  }
});
out.rootFontSize = getComputedStyle(document.documentElement).fontSize;
out.mbnHeight = (() => { const n = document.querySelector('.mbn-item');
  return n ? Math.round(n.getBoundingClientRect().height) : null; })();
const d = document.createElement('div'); d.id = 'AUDIT'; d.textContent = JSON.stringify(out);
document.body.appendChild(d);
<\/script></body>`;
html = html.replace(/<\/body>/, probe);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pml-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, html);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=390,844', '--virtual-time-budget=6000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
} catch (err) { dom = (err.stdout || '').toString(); }
const m = dom.match(/id="AUDIT">([\s\S]*?)<\/div>/);
let r = null;
try { r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')); }
catch (_) { /* reported below */ }

console.log('\nthe portal laid out on a narrow screen');
ok('the page rendered and was measured', !!r, (m ? m[1] : dom).slice(0, 250));

if (r) {
  console.log(`  (viewport ${r.vw}×${r.vh}, root font-size ${r.rootFontSize})`);

  ok('the page does not scroll sideways', r.pageScrollW <= r.vw,
     `scrollWidth ${r.pageScrollW} in a ${r.vw}px viewport — it was 527, a grid track that could not shrink`);
  ok('and nothing overflows outside a scroller', r.overflow.length === 0,
     r.overflow.slice(0, 6).map(o => `${o.sel} right:${o.right}`).join('  |  '));

  /* Allowances, named rather than numbered, so the next person knows what the
     slack covers and a NEW violation is still visible in --report. */
  ok('tap targets meet the 44px floor', r.smallTap.length <= 2,
     `${r.smallTap.length} under 44px: ${r.smallTap.map(t => `${t.sel} ${t.w}×${t.h}`).join(', ')}
      (allowance 2: the notification toggle, whose target is its slider, and one unclassed button)`);
  ok('the bottom navigation is comfortably tappable', r.mbnHeight >= 44,
     `${r.mbnHeight}px — it measured 32, the smallest target on the screen and the one every journey starts from`);

  ok('text is legible', r.smallFont.length <= 5,
     `${r.smallFont.length} under 11.5px: ${r.smallFont.map(f => `${f.sel} ${f.px}px`).join(', ')}
      (allowance 5: the gift-card artwork and three secondary captions)`);
  ok('no text drops below 9px anywhere', !r.smallFont.some(f => f.px < 9),
     JSON.stringify(r.smallFont.filter(f => f.px < 9)));

  ok('no form control triggers the iOS zoom', r.zoomInputs.length === 0,
     `every browser on iOS is WebKit, and it zooms on focus below 16px: ${JSON.stringify(r.zoomInputs.slice(0, 5))}`);

  if (process.argv.includes('--report')) {
    for (const k of ['overflow', 'smallTap', 'smallFont', 'zoomInputs']) {
      console.log(`\n  ${k} (${r[k].length})`);
      r[k].forEach(x => console.log('    ' + JSON.stringify(x)));
    }
  }
}

/* The rem trap, kept as an assertion so the next person setting a floor knows. */
console.log('\nthe pixel floors are pixels for a reason');
{
  const prem = fs.readFileSync(path.join(ROOT, 'portal', 'css', 'portal-premium.css'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'css', 'admin.css'), 'utf8');
  ok('the root font-size really is 14px, not 16', /html\s*\{[^}]*font-size:\s*14px/.test(admin),
     'if this changes, the px floors below are no longer the sizes they were chosen to be');
  const block = prem.slice(prem.indexOf('MOBILE WEB — measured fixes'));
  ok('and the legibility floors avoid rem', !/font-size:\s*0\.\d+rem\s*!important/.test(block),
     'a 0.8rem floor written expecting 12.8px rendered 11.2px and changed nothing');
  ok('the app ships the same block', /MOBILE WEB — measured fixes/
     .test(fs.readFileSync(path.join(ROOT, 'mobile', 'www', 'css', 'portal-premium.css'), 'utf8')),
     'the two stylesheets have diverged; this block is appended to both');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
