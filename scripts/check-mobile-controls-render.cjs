#!/usr/bin/env node
/* What the packaged app actually DRAWS — measured, not read.
 *
 * Two faults reported from a phone, both CSS-only, and neither findable by
 * reading the JavaScript:
 *
 *  · THE REWARDS STATS WERE INVISIBLE. mobile-app.css redesigned the stats row
 *    as one dark panel and set the value text to #ffffff, but never reset the
 *    `background:#fff` and the 3px coloured ::before strip that
 *    portal-premium.css gives each .rewards-stat for the light web layout. So
 *    five white cards, each with a coloured bar across the top, and white text
 *    on white: exactly the blank cards a client photographed. Reported as an
 *    iOS problem; Chromium renders it identically, which is the point of
 *    measuring rather than reasoning.
 *
 *  · THE SWITCHES WERE BLOBS. portal-premium.css gives a 44px floor to
 *    `label:has(> input[type="checkbox"])` — written for `<label><input> some
 *    text`, where the label is the hit area. A switch is a label of exactly
 *    that shape, so a 24px pill with a 24px radius was stretched to 44px and
 *    became an orange circle with the knob stranded at the bottom. :has() is
 *    why it showed on a current iOS WebView and not on an older Android one.
 *
 * Measured against the BUILT app (mobile/www) and its own markup, lifted from
 * the shipped index.html, so this cannot pass against a copy that has drifted
 * from what ships.
 *
 * Run: node scripts/check-mobile-controls-render.cjs
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const WWW    = path.join(ROOT, 'mobile', 'www');
const CHROME = require('./lib/chromium.cjs').findChromium();

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const shell = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');

/* The app's own markup for one control, by the id inside it. Lifted rather
   than retyped: a copy here would keep agreeing with itself. */
function liftLabel(id) {
  const at = shell.lastIndexOf('<label', shell.indexOf(`id="${id}"`));
  return shell.slice(at, shell.indexOf('</label>', at) + 8);
}
/* The page's own <style> blocks carry the switch knob rules. */
const inlineCSS = (shell.match(/<style[^>]*>[\s\S]*?<\/style>/g) || [])
  .join('\n').replace(/<\/?style[^>]*>/g, '');

/* index.html's stylesheet order. */
const SHEETS = ['admin.css', 'portal.css', 'ci-theme.css', 'portal-premium.css',
                'mobile-overrides.css', 'mobile-app.css'];
for (const s of SHEETS) {
  if (!fs.existsSync(path.join(WWW, 'css', s))) {
    console.log(`  ✗ the built app is missing css/${s}`);
    console.log('\n0 passed, 1 failed'); process.exit(1);
  }
}

if (!CHROME) {
  console.log('  SKIP  no chromium found — this check measures a rendered page');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const stat = (val, label) =>
  `<div class="rewards-stat"><div class="rewards-stat__val">${val}</div>` +
  `<div class="rewards-stat__label">${label}</div></div>`;

const page = `<!doctype html><html><head><meta charset="utf-8">
${SHEETS.map(s => `<link rel="stylesheet" href="${path.join(WWW, 'css', s)}">`).join('\n')}
<style>${inlineCSS}</style></head><body>
<div class="rewards-stats-row" id="row">
  ${stat('175 XP', 'Total XP Earned')}${stat('Sprout', 'Current Level')}
  ${stat('2', 'Quests Completed')}${stat('R0', 'Referral Bonuses')}
  ${stat('2 / 7', 'Levels Reached')}
</div>
<div id="switches">${liftLabel('pushNotifSlider')}${liftLabel('recurringToggleSlider')}</div>
<div id="out"></div>
<script>
const cs = el => getComputedStyle(el);
const box = el => { const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) }; };
/* Perceived brightness. Two things the same brightness are the same thing to
   a reader, whatever their hex. */
const lum = c => { const m = String(c).match(/[\\d.]+/g);
  return m && m.length >= 3 ? (0.299*+m[0] + 0.587*+m[1] + 0.114*+m[2]) : null; };
const alpha = c => { const m = String(c).match(/[\\d.]+/g);
  return m && m.length >= 4 ? +m[3] : 1; };

const row  = document.getElementById('row');
const card = row.children[0];
const val  = card.querySelector('.rewards-stat__val');
const lab  = card.querySelector('.rewards-stat__label');

/* The panel is the dark gradient; a transparent card sits on it, so the
   background a reader sees behind the text is the ROW's. */
const cardBg   = cs(card).backgroundColor;
const cardClear = alpha(cardBg) === 0;
const behind   = cardClear ? cs(row).backgroundColor : cardBg;
const rowDark  = /gradient/.test(cs(row).backgroundImage);

const sw = id => {
  const sp = document.getElementById(id), lb = sp.closest('label');
  const b = box(sp), knob = getComputedStyle(sp, '::before');
  return { w: b.w, h: b.h, isPill: b.w - b.h >= 12,
           hasKnob: knob.content !== 'none' && knob.content !== '',
           hit: parseFloat(getComputedStyle(lb, '::after').height) || box(lb).h };
};

document.getElementById('out').textContent = JSON.stringify({
  rowIsDarkPanel: rowDark,
  cardTransparent: cardClear,
  stripHidden: getComputedStyle(card, '::before').display === 'none',
  valVsBackdrop: Math.abs((lum(cs(val).color) ?? 0) - (lum(behind) ?? 0)),
  labelVsBackdrop: Math.abs((lum(cs(lab).color) ?? 0) - (lum(behind) ?? 0)),
  push: sw('pushNotifSlider'),
  recurring: sw('recurringToggleSlider'),
});
<\/script></body></html>`;

const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'mctl-'));
const file = path.join(tmp, 'p.html');
fs.writeFileSync(file, page);
let dom = '';
try {
  dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--allow-file-access-from-files', '--window-size=500,900',
    '--virtual-time-budget=4000', '--dump-dom', 'file://' + file],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000 });
} catch (err) { dom = (err.stdout || '').toString(); }

const m = dom.match(/id="out">([\s\S]*?)<\/div>/);
let r = null;
try {
  r = JSON.parse((m ? m[1] : '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
} catch (_) { /* reported below */ }

console.log('\nthe rewards stats are legible on their own panel');
ok('the page reported', !!r, (m ? m[1] : dom).slice(0, 300));

if (r) {
  ok('the row is the dark panel the design asks for', r.rowIsDarkPanel === true);
  ok('and the stat is NOT a white card on top of it', r.cardTransparent === true,
     'portal-premium gives it background:#fff for the light web layout');
  ok('the light-layout colour strip is gone with it', r.stripHidden === true,
     'that strip is the coloured bar across the top of each blank card in the report');
  /* The fault was not a colour that was slightly off — it was the SAME colour.
     Brightness, not hex, because that is what a reader sees. */
  ok('the value text is not the same brightness as what is behind it',
     r.valVsBackdrop > 80, ``+`difference ${r.valVsBackdrop} — white text on a white card reads as nothing`);
  ok('and neither is the label', r.labelVsBackdrop > 60, String(r.labelVsBackdrop));

  console.log('\nand the switches are switches, not blobs');
  for (const which of ['push', 'recurring']) {
    const s = r[which];
    ok(`${which}: the track is a pill, not a circle`, s.isPill === true,
       `${s.w}×${s.h} — the 44px checkbox floor stretched a 24px track`);
    ok(`${which}: it has a knob`, s.hasKnob === true);
    ok(`${which}: and still offers a 44px tap target`, s.hit >= 44,
       `${s.hit}px — the floor the rule above was there to provide`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
