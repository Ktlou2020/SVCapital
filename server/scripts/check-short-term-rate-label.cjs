#!/usr/bin/env node
/* A five-month return is not a per-annum return.
 *
 * /api/products returns TWO averages, and the difference between them is the
 * whole of this check:
 *
 *   avg_actual_rate   the return achieved over each pool's OWN period.
 *                     Deliberately not annualised — the portal's grid shows it
 *                     under a "(N MO)" label and depends on that.
 *   avg_annual_rate   the same thing × 12 / term_months, which exists so a
 *                     tile that says "p.a." has a figure that is actually one.
 *
 * The landing page fills its product cards from the FIRST and printed "p.a."
 * underneath. On a twelve-month product the two coincide, which is why cattle
 * looked right and nobody noticed; short-term pools run five months, so the
 * card was showing a five-month return — 5.74% — as though it were a year's,
 * understating what the product pays by more than half.
 *
 * So: nothing that renders a short-term return may call it per annum. The
 * number is what was earned over the term printed beside it.
 *
 * This is a label rule, not an arithmetic one. The card still shows the period
 * figure; it just no longer claims to be annual.
 *
 * Run: node server/scripts/check-short-term-rate-label.cjs
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\nthe short-term card does not call its return per annum');
{
  const html = read('index.html');
  const i = html.indexOf('<h3 class="product-card__title">Short-Term Investment</h3>');
  ok('the short-term card is on the page', i > -1);
  /* The card ends where the next one begins; everything between is its own. */
  const next = html.indexOf('<h3 class="product-card__title"', i + 10);
  /* Comments are not rendered, and the one on that card explains why the
     words are gone — so it is stripped before the card is read. */
  const card = html.slice(i, next > -1 ? next : i + 3000).replace(/<!--[\s\S]*?-->/g, '');
  ok('and carries no "p.a." anywhere in it', !/p\.a\./i.test(card),
     (card.match(/.{0,60}p\.a\..{0,30}/i) || [''])[0].trim());
  ok('while the twelve-month products still do',
     /Cattle Investment<\/h3>[\s\S]{0,900}?p\.a\./.test(html),
     'this is a rule about period returns, not a blanket ban on the words');
}

console.log('\nnor does anything that fills it in afterwards');
for (const f of ['js/main.js', 'mobile/src/js/main.js']) {
  const src = read(f);
  ok(`${f}: the live figure is written without a per-annum qualifier for short-term`,
     /st\.val = pct \+ \(key === 'short' \? '' : ' p\.a\.'\)/.test(src),
     'the card is overwritten from the API on load, so fixing only the markup fixes nothing');
  ok(`${f}: the calculator says the same thing as the card`,
     /calcRate'\)\.textContent = \(product\.rate \* 100\)\.toFixed\(2\) \+ '%' \+\s*\n?\s*\(String\(currentCalcProduct\) === 'short' \? '' : ' p\.a\.'\)/.test(src),
     'it is fed the same period figure, so it carried the same wrong qualifier');
  const modal = src.slice(src.indexOf('\n  short: {', src.indexOf('MODAL_DATA')));
  ok(`${f}: and the static value it starts from has none either`,
     /\{ label: 'Avg\. Return', val: '[\d.]+%' \}/.test(modal.slice(0, 900)),
     'the static value shows until the API answers, and on a slow connection that is what is read');
}

console.log('\nand the two averages the API returns are still different things');
{
  const products = read('server/routes/products.js');
  ok('avg_actual_rate is still the per-period figure',
     /AVG\(ip\.actual_rate\)::numeric, 4\)[\s\S]{0,400}?AS avg_actual_rate/.test(products),
     'the portal grid shows this under "(N MO)" and depends on it not being annualised');
  ok('and avg_annual_rate is still the annualised one beside it',
     /ip\.actual_rate \* 12\.0 \/ ip\.term_months[\s\S]{0,400}?AS avg_annual_rate/.test(products),
     'a tile that wants to say "p.a." has a figure to use — this is where it comes from');
  const main = read('js/main.js');
  ok('the landing page reads the per-period one, which is why the label had to go',
     /p\.avg_actual_rate != null \? parseFloat\(p\.avg_actual_rate\) : null/.test(main),
     'if this is ever switched to avg_annual_rate, the label can come back — and should');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
