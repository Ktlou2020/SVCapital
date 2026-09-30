#!/usr/bin/env node
/* The auto top-up switch says which state it is in.
 *
 * It was a 48x26 capsule with a background colour and nothing else — no knob,
 * nothing that moved, and no word for the state. A client could not tell
 * whether their card was about to be charged every month, which is what was
 * reported. Every other toggle in the portal (push notifications, recurring
 * investments) already had a ::before knob and a :checked rule; this one had
 * neither.
 *
 * Worse, it did not work on the phone. The markup was
 *
 *     <label>
 *       <input type="checkbox" id="atuEnabled">
 *       <span onclick="cb.checked = !cb.checked; this.style.background = …">
 *     </label>
 *
 * so a tap ran the span's handler (flip to on, paint it orange) and then the
 * wrapping <label> performed its own default activation (flip back to off).
 * The control turned orange and stayed unchecked. A client set up what they
 * believed was a monthly debit order, pressed Save, and stored it DISABLED.
 * Driven in Chromium before the fix: {"checked":false,"colour":"rgb(255,155,12)"}.
 *
 * So: state comes from :checked and from nowhere else, the control carries a
 * knob and the word, and it holds no inline handler that can fight the label.
 *
 * No database.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const PAGES = { 'web portal': 'portal/index.html', 'mobile': 'mobile/src/index.html' };
const CSS   = read('portal/css/portal-premium.css');
const CORE  = read('js/portal-core.js');

/* The switch markup, from the opening <label class="svc-switch"> that holds
   #atuEnabled to its close. */
function control(html) {
  const i = html.indexOf('id="atuEnabled"');
  if (i < 0) return '';
  const start = html.lastIndexOf('<label', i);
  const end   = html.indexOf('</label>', i);
  return start < 0 || end < 0 ? '' : html.slice(start, end + 8);
}

console.log('\nit is a switch, on both surfaces');
{
  for (const [name, page] of Object.entries(PAGES)) {
    const c = control(read(page));
    ok(`${name}: the control exists`, !!c, page);
    ok(`${name}: it has a track and a knob`,
       /class="svc-switch__track"/.test(c) && /class="svc-switch__knob"/.test(c),
       'a capsule with no knob does not read as a switch');
    ok(`${name}: and a word for each state`,
       /class="off">Off</.test(c) && /class="on">On</.test(c),
       'colour alone fails for anyone who cannot separate the two hues');
  }
  const [a, b] = Object.values(PAGES).map(p => control(read(p)));
  ok('the two surfaces carry the same control', a === b && a.length > 0,
     'the phone and the browser must not drift apart on a money setting');
}

console.log('\nnothing can fight the label for the click');
{
  /* The bug. An inline handler on the control flips the checkbox, then the
     wrapping <label> flips it back, and the tap is swallowed. */
  for (const [name, page] of Object.entries(PAGES)) {
    const c = control(read(page));
    ok(`${name}: the control holds no inline event handler`,
       !/\son(click|change|input|mousedown|touchstart)\s*=/.test(c),
       'an inline handler inside a <label> is undone by the label\'s own activation');
    ok(`${name}: and paints no colour from markup`,
       !/style\.background|background:#(ccc|ff9b0c|fec24f)/i.test(c),
       'the state is :checked, and only :checked');
  }
  ok('and the portal no longer paints it from JavaScript either',
     !/atuEnabled[\s\S]{0,400}?style\.background/.test(CORE)
     && !/querySelector\('label span'\)/.test(CORE),
     'it was painted from three places and two disagreed on which orange meant on');
}

console.log('\nthe stylesheet does the work');
{
  ok('there is a .svc-switch component', /\.svc-switch\s*\{/.test(CSS));
  ok('the knob moves when the input is checked',
     /\.svc-switch__input:checked ~ \.svc-switch__track \.svc-switch__knob\s*\{[^}]*transform:\s*translateX/.test(CSS));
  ok('the track changes colour when the input is checked',
     /\.svc-switch__input:checked ~ \.svc-switch__track\s*\{[^}]*background/.test(CSS));
  ok('the word swaps when the input is checked',
     /\.svc-switch__input:checked ~ \.svc-switch__state \.on\s*\{\s*display:\s*inline/.test(CSS)
     && /\.svc-switch__input:checked ~ \.svc-switch__state \.off\s*\{\s*display:\s*none/.test(CSS));
  ok('the two states are told apart by more than colour',
     /translateX/.test(CSS) && /\.svc-switch__state \.on/.test(CSS),
     'position and word as well as hue');
  ok('a keyboard user can see where they are',
     /\.svc-switch__input:focus-visible ~ \.svc-switch__track\s*\{[^}]*outline/.test(CSS));
  ok('and the animation is dropped for anyone who asked for that',
     /prefers-reduced-motion[\s\S]{0,220}\.svc-switch__knob/.test(CSS));

  /* The input is hidden from sight but not from the keyboard: display:none or
     visibility:hidden would take it out of the tab order and silence it. */
  const input = (CSS.match(/\.svc-switch__input\s*\{[^}]*\}/) || [''])[0];
  ok('the checkbox is hidden by clipping, not by display:none',
     /clip-path|clip:/.test(input) && !/display:\s*none/.test(input) && !/visibility:\s*hidden/.test(input),
     'display:none would drop it out of the tab order entirely');
}

console.log('\nand it announces itself');
{
  for (const [name, page] of Object.entries(PAGES)) {
    const html = read(page);
    const c = control(html);
    ok(`${name}: the input is a switch, not a bare checkbox`, /role="switch"/.test(c));
    const labelledby = (c.match(/aria-labelledby="([^"]+)"/) || [])[1];
    ok(`${name}: it points at a label that exists`,
       !!labelledby && html.includes(`id="${labelledby}"`), String(labelledby));
    const describedby = (c.match(/aria-describedby="([^"]+)"/) || [])[1];
    ok(`${name}: and at the hint that explains it`,
       !!describedby && html.includes(`id="${describedby}"`), String(describedby));
    ok(`${name}: the decorative parts are hidden from screen readers`,
       (c.match(/aria-hidden="true"/g) || []).length >= 2,
       'the track and the word would otherwise be read twice');
  }
}

console.log('\nthe change reaches a browser that already has the old one');
{
  for (const [name, page] of Object.entries(PAGES)) {
    const html = read(page);
    const m = html.match(/portal-premium\.css\?v=(\d+)/);
    ok(`${name}: portal-premium.css carries a version stamp`, !!m, 'stamped assets are cached for a year');
  }
  const stamps = Object.values(PAGES).map(p => (read(p).match(/portal-premium\.css\?v=(\d+)/) || [])[1]);
  ok('and both surfaces are on the same one', stamps[0] === stamps[1], stamps.join(' vs '));
  ok('the service worker cache was bumped with it',
     /svc-portal-v(\d+)/.test(read('mobile/src/sw.js')));
  ok('and the built bundle carries the component',
     /\.svc-switch\s*\{/.test(read('mobile/www/css/portal-premium.css')),
     'run npm run build:mobile');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
