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
  /* The calculator reaches the same answer by a different route: its rate
     line is the return over the term, and it only says "p.a." on a
     twelve-month term. Short-term runs five months, so it says nothing —
     asserted off the product's own term rather than by naming the product,
     so changing the term changes the answer. */
  {
    const m = src.slice(src.indexOf('\n  short: {')).match(/termYears:\s*([\d.]+)\s*(?:\/\s*([\d.]+))?/);
    const years = m ? (m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1])) : null;
    ok(`${f}: short-term's term is still not a year, so its rate line says nothing`,
       years != null && Math.abs(years - 1) >= 0.001, `termYears = ${years}`);
  }
  const modal = src.slice(src.indexOf('\n  short: {', src.indexOf('MODAL_DATA')));
  ok(`${f}: and the static value it starts from has none either`,
     /\{ label: 'Avg\. Return', val: '[\d.]+%' \}/.test(modal.slice(0, 900)),
     'the static value shows until the API answers, and on a slow connection that is what is read');
}

console.log('\nthe calculator is fed the annual figure, because it multiplies by the term');
for (const f of ['js/main.js', 'mobile/src/js/main.js']) {
  const src = read(f);
  ok(`${f}: both averages are read off the API, not just one`,
     /avg_actual_rate != null \? parseFloat\(p\.avg_actual_rate\)/.test(src)
     && /avg_annual_rate != null \? parseFloat\(p\.avg_annual_rate\)/.test(src));
  ok(`${f}: PRODUCTS[].rate takes the ANNUAL one`,
     /const annual = annualForHome\(key\);[\s\S]{0,160}PRODUCTS\[key\]\.rate = annual;/.test(src),
     'it is multiplied by termYears, so a period rate is prorated twice');
  ok(`${f}: and never the per-period one`,
     !/PRODUCTS\[key\]\.rate = rate;/.test(src),
     'that is the line that made a five-month return come out at 5/12 of itself');
  ok(`${f}: a product the API has no annual figure for keeps its static rate`,
     /if \(annual != null && typeof PRODUCTS/.test(src),
     'falling back to the period figure would be the same bug with an extra step');
  ok(`${f}: the rate shown is the one the rand figures reconcile to`,
     /const effective = amount > 0 \? returnsEarned \/ amount : 0;/.test(src)
     && /\(effective \* 100\)\.toFixed\(2\)/.test(src),
     'printing the annual rate beside a five-month rand return cannot be squared by a reader');
  ok(`${f}: and it says "p.a." only where the term is a year`,
     /const perAnnum  = Math\.abs\(product\.termYears - 1\) < 0\.001;/.test(src)
     && /\(perAnnum \? ' p\.a\.' : ''\)/.test(src));
}

/* The arithmetic itself, stated once so an inverted conversion is caught
   rather than argued about. The annualised figure is the period one × 12 /
   term, so multiplying it back by the term in years must return exactly the
   period figure — which is what the card shows and what the client was paid. */
{
  const annualise = (period, months) => period * 12 / months;
  const payout    = (amount, annual, years) => amount * annual * years;
  const cases = [
    { name: 'short-term, five months', period: 0.0574, months: 5  },
    { name: 'cattle, twelve months',   period: 0.1483, months: 12 },
    { name: 'solar, seven years',      period: 0.2140, months: 84 },
  ];
  for (const c of cases) {
    const annual = annualise(c.period, c.months);
    const earned = payout(10000, annual, c.months / 12);
    ok(`${c.name}: R10,000 earns the period return, not a prorated one`,
       Math.abs(earned - 10000 * c.period) < 0.000001,
       `got ${earned.toFixed(2)}, expected ${(10000 * c.period).toFixed(2)}`);
  }
  ok('and on a twelve-month term the two averages are the same number',
     Math.abs(annualise(0.1483, 12) - 0.1483) < 1e-12,
     'which is why cattle looked right while short-term and solar did not');
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
