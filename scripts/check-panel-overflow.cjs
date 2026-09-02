#!/usr/bin/env node
/* Panels that did not fit the phone they were drawn on.
 *
 * Three separate faults, one shape: content laid out as though the width were
 * whatever it needed to be.
 *
 *   The cattle herd strip was a flex row where every item was flex:0 0 auto,
 *   with a flex:1 spacer pushing "survival rate" to the right, inside
 *   overflow:hidden. Nothing could shrink, so on a phone the survival stat was
 *   CLIPPED by the container rather than wrapped — the number a client is most
 *   likely to be looking for, cut in half.
 *
 *   The product metric row put four metrics in one flex row. flex:1 lets them
 *   shrink but never below their min-content width, so the values crowded into
 *   each other and "AVG RETURN P.A." wrapped onto two lines.
 *
 *   The investment certificate drew values with doc.text(value, x, y), which
 *   takes a POINT, not a box. A migrated investment id — "INV-MIGR-" plus a
 *   twenty-character key — ran over its white panel, over the certificate
 *   border and off the sheet.
 *
 * HOW THE VIEWPORT IS SET. --window-size does NOT set the CSS viewport in this
 * headless build: a page loaded at --window-size=390 still reports
 * (max-width:430px) as not matching. Every screenshot taken that way is
 * measuring a desktop-width viewport while looking like a phone, which is how
 * a working media query can be mistaken for a broken one. An iframe carries
 * its own viewport, so the narrow case is rendered inside one.
 *
 * Run: node scripts/check-panel-overflow.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
                '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function sliceFn(src, name) {
  const at = src.search(new RegExp(`(async\\s+)?function ${name}\\(`));
  if (at < 0) throw new Error(`${name} not found`);
  let i = src.indexOf('(', at), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') d++;
    else if (src[i] === ')') { d--; if (d === 0) { i++; break; } }
  }
  i = src.indexOf('{', i); d = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(at, i + 1);
}

/* ── 1. The herd strip, rendered at phone width ────────────────────────── */
console.log('\nthe live herd status strip');
if (!CHROME) {
  console.log('  SKIP  no headless Chromium');
} else {
  const STATS = {
    total_purchased: 86368, avg_current_weight: 868.4, mortality_count: 640,
    by_gender: [{ label: 'Male', count: 64 }, { label: 'Female', count: 36 }],
    by_breed: [{ label: 'Bonsmara', count: 18 }, { label: 'Brahman', count: 12 }],
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
  const inner = [
    '<!doctype html><meta charset="utf-8"><style>',
    ':root{--text:#111827;--text-muted:#6b7280}html{font-size:14px}',
    'body{margin:0;padding:10px;background:#fff;font-family:system-ui,sans-serif}',
    '</style><div id="herd"></div><div id="probe"></div><script>',
    'function _esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){' +
      'return {"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c];});}',
    sliceFn(CORE, '_cattleHerdStatusHtml'),
    'var h=document.getElementById("herd");',
    'h.innerHTML=_cattleHerdStatusHtml(' + JSON.stringify(STATS) + ');',
    /* Every leaf that carries a label, measured against the box that holds it. */
    'var strip=h.querySelector("div > div:nth-child(2)");',
    'var cells=strip?[].slice.call(strip.children):[];',
    'var box=strip?strip.getBoundingClientRect():null;',
    'var over=cells.filter(function(c){var r=c.getBoundingClientRect();' +
      'return box && (r.right > box.right + 0.5 || r.left < box.left - 0.5);})' +
      '.map(function(c){return (c.textContent||"").trim().slice(0,24);});',
    'document.getElementById("probe").textContent=JSON.stringify({' +
      'innerWidth:innerWidth, cells:cells.length, over:over,' +
      'text:(h.textContent||"").replace(/\\s+/g," ")});',
    '</scr' + 'ipt>',
  ].join('\n');
  fs.writeFileSync(path.join(tmp, 'inner.html'), inner);
  fs.writeFileSync(path.join(tmp, 'outer.html'),
    '<!doctype html><meta charset="utf-8"><body style="margin:0">' +
    '<iframe id="f" src="inner.html" width="390" height="420" style="border:0"></iframe>' +
    '<div id="probe"></div><script>' +
    'window.addEventListener("load",function(){var d=document.getElementById("f").contentDocument;' +
    'document.getElementById("probe").textContent=d?d.getElementById("probe").textContent:"NOFRAME";});' +
    '</scr' + 'ipt>');

  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--allow-file-access-from-files', '--virtual-time-budget=5000', '--dump-dom',
      'file://' + path.join(tmp, 'outer.html')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) { dom = (err.stdout || '').toString(); }
  fs.rmSync(tmp, { recursive: true, force: true });

  const m = dom.match(/id="probe">([\s\S]*?)<\/div>/);
  let r = null;
  try {
    r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"));
  } catch (_) {}

  ok('it renders at 390px', !!r && r.cells > 0, (m ? m[1] : dom).slice(0, 200));
  if (r) {
    ok('the iframe really is 390px wide, not the desktop default',
       r.innerWidth === 390, `innerWidth=${r.innerWidth}`);
    ok('all three stats are present',
       /purchased to date/.test(r.text) && /average weight/.test(r.text) &&
       /survival rate/.test(r.text), r.text.slice(0, 160));
    ok('and none of them is clipped by the strip',
       Array.isArray(r.over) && r.over.length === 0,
       `outside the box: ${JSON.stringify(r.over)} — this is what a flex:0 0 auto ` +
       `row inside overflow:hidden does when the content does not fit`);
  }

  ok('the strip wraps rather than hiding what does not fit',
     /grid-template-columns:repeat\(auto-fit,minmax\(\d+px,1fr\)\)[^"]*"[^>]*>\s*<div style="min-width:0"/
       .test(sliceFn(CORE, '_cattleHerdStatusHtml').replace(/\n\s*/g, '\n        ')) ||
     /repeat\(auto-fit,minmax\(104px,1fr\)\)/.test(sliceFn(CORE, '_cattleHerdStatusHtml')),
     'auto-fit is what lets the third stat move to a second line');
}

/* ── 2. The product metric row ─────────────────────────────────────────── */
console.log('\nthe product metric row');
for (const rel of ['portal/css/portal-premium.css', 'mobile/src/css/portal-premium.css']) {
  const css = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const label = rel.startsWith('portal/') ? 'web' : 'app';

  ok(`${label}: metrics can shrink below their content width`,
     /\.mpc2-metric\s*\{[^}]*min-width:0/.test(css),
     'flex:1 alone stops at min-content, which is what crowded the values');

  const mq = css.indexOf('@media (max-width: 430px)');
  ok(`${label}: four metrics become two columns on a phone`,
     mq > -1 && /\.mpc2-metrics\s*\{\s*display:grid/.test(css.slice(mq, mq + 400)));

  /* A media query adds no specificity, so its position decides whether it
     wins. This is the mistake that made the rule look broken. */
  /* The BASE rule, at the start of a line. A descendant rule such as
     body.dark-mode .mpc2-metric__val carries higher specificity and wins
     wherever it sits, so counting it here would report a false conflict. */
  const baseRe = /^\.mpc2-metric__val\s*\{/gm;
  let base = -1, mm;
  while ((mm = baseRe.exec(css))) base = mm.index;
  ok(`${label}: the phone rules come after the base rules they override`,
     mq > -1 && base > -1 && mq > base,
     `@media at ${mq}, base .mpc2-metric__val at ${base} — a later base rule wins`);
}

/* ── 3. The empty card on the app's Transactions screen ────────────────── */
console.log('\nthe transactions screen');
{
  const shell = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'index.html'), 'utf8');
  ok('no element is styled as a card and left empty',
     !/id="txnSummary"/.test(shell),
     'nothing has ever written to #txnSummary, and .txn-summary paints a white ' +
     'card with a shadow — it read as a search field');
  const writers = ['js/portal-core.js', 'portal/js/portal.js', 'mobile/src/js/portal.js']
    .filter(f => /txnSummary/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok('and still nothing writes to it', writers.length === 0, writers.join(', '));
}

/* ── 4. The investment certificate ─────────────────────────────────────── */
console.log('\nthe investment certificate');
{
  const fn = sliceFn(CORE, 'downloadCertificate');
  ok('panel values are wrapped, not drawn at a point',
     /splitTextToSize\(String\(val \|\| '—'\), maxW\)/.test(fn),
     'doc.text() takes a point and draws past the page edge');
  ok('the wrap width is derived from the panel that was drawn',
     /const PANEL_W\s*=\s*\(W - 28\) \/ 2 - 6;/.test(fn) &&
     /leftValMax\s*=\s*\(leftX \+ 4 \+ PANEL_W\)/.test(fn) &&
     /rightValMax\s*=\s*\(rightX \+ PANEL_W\)/.test(fn),
     'a hard-coded width drifts the moment the panel moves');
  ok('a wrapped value pushes the next row down',
     /return Math\.max\(7, lines\.length \* LINE/.test(fn),
     'a fixed row height would let two lines overlap the row beneath');

  /* The arithmetic, for A4. A negative width means splitTextToSize returns the
     string unbroken and the overflow comes straight back. */
  const W = 210, leftX = 14, rightX = W / 2 + 4, valLeft = 70, valRight = W / 2 + 54;
  const PANEL_W = (W - 28) / 2 - 6;
  const leftValMax  = (leftX + 4 + PANEL_W) - valLeft  - 5;
  const rightValMax = (rightX + PANEL_W)    - valRight - 5;
  ok('both value columns have real width on A4',
     leftValMax > 15 && rightValMax > 15, `left ${leftValMax}mm, right ${rightValMax}mm`);
  ok('and each stays inside its own panel',
     valLeft + leftValMax <= leftX + 4 + PANEL_W &&
     valRight + rightValMax <= rightX + PANEL_W);

  ok('the disclaimers sit inside the certificate border',
     /maxWidth: W - 36/.test(fn) && !/, 14, y, \{ maxWidth: W - 28 \}/.test(fn),
     'at x=14 with maxWidth W-28 the text runs to the border itself');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
