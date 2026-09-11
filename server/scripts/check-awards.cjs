#!/usr/bin/env node
/* The awards strip on the landing page.
 *
 * The interesting failure here was not the content. .award-card already
 * existed in premium.css — fully styled, already in main.js's reveal list,
 * and never once used in markup. Writing a second .award-card in the page's
 * own <style> collided with it and produced a white card carrying white
 * text on a dark band: styled twice, readable neither time.
 *
 * So the assertion that matters is that the page uses the component rather
 * than redefining it.
 *
 * Run: node server/scripts/check-awards.cjs
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

const HTML    = read('index.html');
const PREMIUM = read('css/premium.css');
const MAIN    = read('js/main.js');

/* The page's own <style> block, which is where the collision happened. */
const inlineCss = (HTML.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];

console.log('\nthe award is on the page');
{
  ok('there is an awards section', /class="awards-section"/.test(HTML));
  ok('it is labelled as awards and recognition',
     /Awards &amp; recognition/i.test(HTML) || /Awards &amp;amp; recognition/i.test(HTML),
     'the strip has no heading');
  ok('the award is named in full',
     /Best Alternative Investment Solutions &mdash; South Africa/.test(HTML),
     'the award title is missing or reworded');
  ok('the body that gave it is credited',
     /Global Financial Market Review/.test(HTML), 'an award with no issuer is a claim');
  ok('and the year is shown', /award-card__year">2025</.test(HTML));
}

console.log('\nit uses the component that already existed');
{
  ok('.award-card is styled in premium.css', /\.award-card\s*\{/.test(PREMIUM));
  /* A BARE .award-card rule redefines the component. `.awards-row .award-card`
     is a scoped layout override and is fine — it is asserted below to touch
     only layout. Anchoring to the start of a line is what separates them. */
  ok('and the page does NOT define its own',
     !/^\s*\.award-card\s*[,{]/m.test(inlineCss),
     'a second definition collides with the real one — white card, white text');
  ok('nor its parts',
     !/^\s*\.award-card__(year|content|title|issuer|icon)\s*[,{]/m.test(inlineCss),
     'the year pill and the content block belong to the component');
  ok('the markup matches the shape the component expects',
     /<span class="award-card__year">[\s\S]{0,40}<div class="award-card__content">[\s\S]{0,200}<strong>/.test(HTML),
     'the component styles .award-card__content strong and .award-card__content p');
  ok('the reveal animation already covers it',
     /'\.award-card',/.test(MAIN),
     'the card would sit invisible if the reveal list did not name it');
}

console.log('\nthe section around it is the page’s own, and is light');
{
  ok('the section wrapper is defined in the page', /\.awards-section\s*\{/.test(inlineCss));
  ok('on a light ground, because the card is light',
     /\.awards-section\s*\{[^}]*background:\s*#fff/.test(inlineCss),
     'a light card on a dark band is the bug this replaced');
  ok('the card keeps its own look, with only layout overridden',
     /\.awards-row \.award-card\s*\{[^}]*margin-bottom:0/.test(inlineCss) &&
     !/\.awards-row \.award-card\s*\{[^}]*background/.test(inlineCss),
     'overriding its colours here recreates the two-definitions problem');
}

console.log('\nsearch engines are told about it too');
{
  const ld = (HTML.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || ['', ''])[1];
  let parsed = null;
  try { parsed = JSON.parse(ld); } catch (e) { /* reported below */ }
  ok('the structured data still parses', !!parsed,
     'a broken JSON-LD block costs every rich result on the page');
  const org = parsed && (parsed['@graph'] || []).find(n => n['@type'] === 'Organization');
  ok('the organisation carries an award property', !!(org && org.award), JSON.stringify(org && org.award));
  ok('naming the award and who gave it',
     !!(org && /Best Alternative Investment Solutions/.test(org.award) &&
        /Global Financial Market Review/.test(org.award)),
     String(org && org.award));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
