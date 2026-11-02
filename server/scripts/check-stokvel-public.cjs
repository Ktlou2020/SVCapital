#!/usr/bin/env node
/* The stokvel product, as the public and the contract describe it.
 *
 * The platform could run a stokvel before it could tell anybody about one:
 * "stokvel" appeared nowhere on the site and nowhere in the terms, so there
 * was no page to point a committee at and nothing in the T&Cs describing a
 * group account, the mandate, or what happens when a member leaves.
 *
 * Most of what this holds is about NOT OVERSTATING. A savings club is being
 * asked to move money it has already collected from people who know each
 * other, and every sentence on that page is one they will hold us to:
 *
 *  · NO RATE IS QUOTED. The wallet is interest-bearing; the rate is set by a
 *    distribution we import and is not this page's to promise.
 *  · NO GUARANTEE, and capital at risk stated where investing is mentioned
 *    rather than only in the footer.
 *  · THE PAGE AND THE CLAUSE AGREE. A page that promises what the terms do
 *    not say, or terms that impose what the page does not mention, is worse
 *    than either alone — and the page cites clause 26 by number, so the
 *    clause has to exist.
 *  · AND IT IS PUBLISHED IN BOTH BUILDS. The front end ships twice, through
 *    the Dockerfile and through pages:build. A page in one and not the other
 *    is live on one host and a 404 on the other, which has happened here
 *    before. check-deployed-pages owns that; this only makes sure the page
 *    is a page and not a draft.
 *
 * Run: node server/scripts/check-stokvel-public.cjs
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

/* Comments are not copy. An HTML comment explaining what the page should say
   must not satisfy an assertion that it says it — three assertions in this
   suite have been satisfied that way before. */
const visible = html => html.replace(/<!--[\s\S]*?-->/g, '');

/* Whitespace collapsed before anything is matched. HTML wraps where the
   author happened to wrap it, so "we do not lend to stokvels" is split
   across two lines in the source and a regex written with single spaces
   finds nothing \u2014 which reads as the sentence being absent when it is
   right there. Four assertions failed that way on the first run. */
const flat = html => visible(html).replace(/\s+/g, ' ');

const PAGE  = flat(read('stokvels.html'));
const TERMS = flat(read('terms.html'));
const CSS   = read('css/stokvels.css');

console.log('\nthere is a page, and it is wired up');
{
  ok('the page exists and names the product', /Stokvels/.test(PAGE));
  ok('it has its own stylesheet', /css\/stokvels\.css/.test(PAGE) && CSS.length > 500);
  ok('it is reachable from the home page', /stokvels\.html/.test(read('index.html')),
     'a page nothing links to is a page nobody reads');
  ok('and it carries the canonical and social tags the other audience pages do',
     /rel="canonical"[^>]*stokvels\.html/.test(PAGE) && /og:title/.test(PAGE));
  ok('the single canonical purple is the only purple on it',
     !/#(?!eda5ff)[0-9a-f]*(?:[89ab][0-9a-f]ff|a5ff)\b/i.test(CSS) || /--sv-accent:\s*#eda5ff/.test(CSS),
     'the platform has one purple and it is #eda5ff');
}

console.log('\nand it does not promise what we cannot deliver');
{
  ok('no interest rate is quoted',
     !/\b\d{1,2}(?:[.,]\d+)?\s*%\s*(?:per\s*(?:annum|year)|p\.?a\.?|interest)/i.test(PAGE)
     && !/interest\s+(?:of|at)\s+\d/i.test(PAGE),
     'the rate comes from a distribution we import, and is not this page’s to promise');
  ok('the balance is still described as interest-bearing',
     /interest[- ]bearing|earns interest|earning interest/i.test(PAGE),
     'which is true, and is the reason the notice period exists');
  ok('nothing is guaranteed', !/guarantee[ds]?\s+return|guaranteed\s+\d/i.test(PAGE));
  ok('and that is said outright', /not guaranteed/i.test(PAGE));
  ok('capital at risk is stated where investing is offered, not only in the footer',
     /capital is at risk/i.test(PAGE.slice(0, PAGE.indexOf('sv-foot'))),
     'a risk warning only a footer carries is one nobody reads before deciding');
  ok('the platform fee is stated as charged ON TOP',
     /1%\s*of the amount invested/i.test(PAGE) && /on top of it/i.test(PAGE),
     'the amount a client enters is what reaches the pool; the wallet pays that plus the fee');
  ok('we are said not to be a bank', /not a bank/i.test(PAGE));
  ok('and the licence is named with its number',
     /SmartVest Financial Services/.test(PAGE) && /FSP\s*52449/.test(PAGE));
  ok('no NASASA or self-regulatory membership is claimed',
     !/NASASA/i.test(PAGE),
     'we have not verified one, and a committee would reasonably rely on it');
  ok('and no minimum is invented',
     !/minimum[^.]{0,40}R\s?\d/i.test(PAGE),
     'there is no stokvel minimum; pool minimums are per pool and move');
}

console.log('\nthe mandate is described the way the platform actually behaves');
{
  ok('no single member, including the chairperson',
     /chairperson/i.test(PAGE) && /(no one member|no single member)/i.test(PAGE));
  ok('never fewer than two approvals', /fewer than two/i.test(PAGE));
  ok('one rejection ends a request rather than being out-voted',
     /not a majority/i.test(PAGE) || /one rejection ends/i.test(PAGE));
  ok('an approval is good for one payment only', /cannot be reused|one payment/i.test(PAGE));
  ok('and staff cannot approve on the group’s behalf',
     /staff cannot approve/i.test(PAGE),
     'a page that left this out would be selling the feature short, and a page that '
     + 'claimed the opposite would be selling something we do not do');
  ok('the 48 hours is stated, and the set date with it',
     /48\s*hours/i.test(PAGE) && /set date/i.test(PAGE));
  ok('with the later of the two governing',
     /later of the two|whichever is the later/i.test(PAGE),
     'they combine rather than being alternatives');
  ok('leaving is described, including being paid in part',
     /when a member leaves/i.test(PAGE) && /paid what the group holds now/i.test(PAGE));
  ok('and we say we will not break an investment to pay one member out',
     /force an early exit|not realise an investment/i.test(PAGE));
}

console.log('\nand the terms carry a clause for a group account');
{
  ok('there is a stokvel clause', /id="s26"/.test(TERMS));
  ok('it is in the table of contents', /href="#s26"/.test(TERMS),
     'a clause nothing indexes is a clause nobody finds');
  const s26 = TERMS.slice(TERMS.indexOf('id="s26"'));

  ok('THE CLIENT IS THE STOKVEL, not the member who acts',
     /Client in respect of a stokvel account is the <strong>stokvel itself<\/strong>/.test(s26),
     'the same defect as the investment agreement named the wrong party');
  ok('and a member who acts is not personally liable',
     /not personally liable/.test(s26));
  ok('the mandate is a term, not just a feature', /may not be fewer than two/.test(s26));
  ok('and we undertake not to act on one member alone',
     /will not act on the instruction of one member alone/.test(s26));
  ok('membership requires the member to accept',
     /becomes a member only when they themselves accept/.test(s26));
  ok('an invitation confers no signatory status',
     /does not confer signatory status/.test(s26));
  ok('shares are defined, on either basis',
     /in proportion to contributions/.test(s26) && /in equal parts/.test(s26));
  ook_exit(s26);
  ok('we disclaim arbitrating between members',
     /do not arbitrate, adjudicate or mediate disputes/.test(s26),
     'the one thing a platform cannot take on for a savings club');
  ok('we do not lend to stokvels', /do not lend to stokvels/.test(s26));
  ok('and the clause says it is not a bank account',
     /not a bank account/.test(s26) && /Deposit Insurance Scheme/.test(s26));
  ok('the page’s citation of clause 26 resolves',
     /terms\.html#s26/.test(PAGE) && /id="s26"/.test(TERMS),
     'the page sends a reader to a clause by number; it has to be there');
  ok('and the fee cross-reference still resolves',
     /#s9-4/.test(s26) && /id="s9-4"/.test(TERMS),
     'clause 9.4 is cited by number, which is why 26 was appended rather than inserted');
}

/* Pulled out because the exit terms are the ones a committee will read
   hardest, and they have to match what settleExit actually does. */
function ook_exit(s26) {
  ok('an exit requires approval like any other payment out',
     /requires approval in accordance with clause 26\.2/.test(s26));
  ok('arrears are deducted and stay in the account',
     /amounts the member owes the stokvel are deducted and remain in the/.test(s26));
  ok('a short settlement becomes a recorded debt',
     /balance is recorded as owed to them/.test(s26));
  ok('which ranks ahead of remaining members and earns nothing',
     /ranks ahead/.test(s26) && /does not itself earn a return/.test(s26),
     'exactly what stokvelShares.reconcile does — the terms have to say so');
  ok('and we undertake not to realise an investment early for it',
     /will not realise an investment before its maturity/.test(s26));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
