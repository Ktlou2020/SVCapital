#!/usr/bin/env node
/* The Refer a Friend page — legibility, and telling the truth.
 *
 * Switching the feature on exposed a page nobody had looked at rendered.
 * Four things were wrong, and three of them are invisible in the source:
 *
 *   · The hero rendered near-black text on a dark navy band. The white rule
 *     was written as `.referral-hero__title`, and `.page-content h2` further
 *     down the same file is a class PLUS an element, so it won.
 *   · `.ref-step p` was white, for a hero it is not in — the steps sit in a
 *     white panel. It only looked right because another rule beat it.
 *   · The terms said the bonus is "credited to your SV Capital wallet" two
 *     bullets after saying the programme pays no cash.
 *   · The referred-people list is a <tbody> on web and a <div> on mobile, and
 *     the shared renderer wrote <tr> into both.
 *
 * Run: node server/scripts/check-referral-page.cjs
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

const CI      = read('css/ci-theme.css');
const PREMIUM = read('portal/css/portal-premium.css');
const CORE    = strip(read('js/portal-core.js'));
const WEB     = read('portal/index.html');
const MOB     = read('mobile/src/index.html');
const MOBCSS  = read('mobile/src/css/mobile-app.css');

console.log('\nthe hero is legible on its own background');
{
  /* Specificity, stated as the rule rather than as a colour: the selector has
     to carry at least as much weight as .page-content h2, which is what beat
     the old one. */
  ok('the hero title is scoped to beat .page-content h2',
     /\.page-content \.referral-hero__title\s*\{[^}]*color:\s*#ffffff/i.test(CI),
     'one class loses to a class plus an element — this is how it went dark on dark');
  ok('and the sub-heading with it',
     /\.page-content \.referral-hero__sub\s*\{[^}]*color:\s*rgba\(255,255,255/i.test(CI));
  ok('.page-content h2 is still the rule it has to beat',
     /\.page-content h2\s*\{[^}]*color/.test(CI),
     'if this is gone the scoping above is over-specified, not wrong');

  ok('the step text is no longer coloured for a hero it is not in',
     !/^\s*\.ref-step p\s*\{[^}]*color:\s*rgba\(255,255,255/m.test(CI),
     'white text in a white panel, saved only by another rule winning');
}

console.log('\nthe page uses the CI, not colours of its own');
{
  ok('the code is drawn in the CI gradient',
     /\.referral-code\s*\{[\s\S]{0,400}--ci-orange-dark[\s\S]{0,80}--ci-orange/.test(PREMIUM),
     'the code is the thing people came to this page for');
  ok('and falls back where background-clip:text is unsupported',
     /@supports not \(\(-webkit-background-clip: text\)[\s\S]{0,200}\.referral-code/.test(PREMIUM),
     'clipped text with no fallback paints nothing at all');
  ok('the step numbers are markers rather than bare text',
     /\.ref-step__num\s*\{[\s\S]{0,300}border-radius:\s*50%/.test(PREMIUM),
     'they rendered as a stray 1 2 3 4 down the panel');
  ok('and take their colour from the CI tokens',
     /\.ref-step__num\s*\{[\s\S]{0,300}--ci-orange-dark/.test(PREMIUM));
  ok('the hero has a real icon treatment',
     /\.referral-hero__icon\s*\{[\s\S]{0,300}--ci-orange/.test(PREMIUM));
}

console.log('\nthe terms agree with what the programme actually pays');
{
  for (const [label, html] of [['the web portal', WEB], ['the mobile shell', MOB]]) {
    /* The heading uses a raw ampersand in the markup, not an entity. */
    const terms = (html.match(/Terms &(amp;)? ?Conditions[\s\S]*?<\/ul>/) || [''])[0];
    ok(`${label} does not promise a wallet credit`,
       !/credited to your SV Capital wallet/.test(terms),
       'the programme pays XP — this bullet promised money two lines after denying it');
    ok(`${label} says plainly that there is no cash`,
       /no cash bonus/.test(terms), 'the one thing a reader needs to know');
    ok(`${label} does not call XP a "bonus paid"`,
       !/Referral bonus paid when/.test(terms));
  }
  ok('the steps agree that XP lands on signup',
     /You earn 100 XP towards your next level as soon as they do/.test(WEB),
     'the steps said the XP arrives on first investment; the terms said signup');
}

console.log('\nthe referred list fits the container each shell gives it');
{
  ok('the renderer checks what it is writing into',
     /const asRows = body\.tagName === 'TBODY';/.test(CORE),
     'it wrote <tr> into a <div> on mobile, and the browser threw the tags away');
  ok('rows for the web portal', /if \(asRows\) return `[\s\S]{0,40}<tr>/.test(CORE));
  ok('and a list for mobile', /<div class="ref-person">/.test(CORE));
  ok('the mobile list is styled', /\.ref-person\s*\{/.test(MOBCSS),
     'an unstyled list of names run together');

  const heads = (WEB.match(/<th>Name<\/th>[\s\S]*?<\/tr>/) || [''])[0];
  const cols  = (heads.match(/<th>/g) || []).length;
  ok('the web table is four columns, not five', cols === 4,
     `${cols} columns — the fifth was clipped off the sidebar`);
  ok('and its placeholder row spans all of them',
     /<td colspan="4"[^>]*>Loading/.test(WEB), 'the empty row spanned 4 of 5');
  ok('as does the empty state the renderer writes',
     /colspan="4"[^`]*No referrals yet/.test(CORE));
  ok('the constant XP column is gone from the table',
     !/<th>Bonus Earned<\/th>/.test(WEB),
     'a column reading 100 XP on every row is a constant, not data');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
