#!/usr/bin/env node
/* The constitution and investment-policy templates say what the account
 * actually does, and stay marked draft until legal review approves them.
 *
 * A template that disagreed with the platform would be worse than none: a
 * group would adopt a rule — one signatory, a majority out-voting a "no",
 * lending from the pot — that its own account refuses, and find out on the
 * day it mattered. So each clause the Terms of Use (clause 26) and the mandate
 * fix is checked for here, and the things the public page may not say (a
 * rate, a guarantee, advice) are checked for in the templates too.
 *
 * Run: node server/scripts/check-group-templates.cjs
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
const text = html => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

const CON = read('group-constitution-template.html');
const POL = read('group-investment-policy-template.html');
const CT = text(CON), PT = text(POL);

for (const [name, html, t] of [['constitution', CON, CT], ['investment policy', POL, PT]]) {
  console.log(`\nthe ${name}: held back until approved`);
  ok('carries a draft notice', /id="tpDraft"/.test(html) && /under legal review/i.test(t));
  ok('which is shown unless the templates are released',
     /templates_live === true\) document\.getElementById\('tpDraft'\)\.remove\(\)/.test(html),
     'shown by default, so a page that cannot reach the server still says draft');
  ok('and the notice prints, so a printed draft cannot pass for the final document',
     /<div class="tp-draft" id="tpDraft"/.test(html));
  ok('is kept out of search engines', /<meta name="robots" content="noindex/.test(html));
  ok('says it is not advice', /not (financial or )?legal advice|not legal advice/i.test(t));
  ok('names the licence', /SmartVest Financial Services/.test(t) && /FSP 52449/.test(t));
  ok('says we are not a bank', /not a bank/i.test(t));
  ok('quotes no interest rate',
     !/\b\d{1,2}(?:[.,]\d+)?\s*%\s*(?:per\s*(?:annum|year)|p\.?a\.?|interest|return)/i.test(t));
  ok('promises no return', !/guaranteed? (a )?return(?!s are not)/i.test(t.replace(/returns are not guaranteed/ig, '')));
  ok('and points to clause 26', /terms\.html#s26/.test(html));
}

console.log('\nthe constitution agrees with the mandate');
ok('never fewer than two signatories', /never fewer than two/i.test(CT));
ok('no single member, including the chairperson', /No single member, including the chairperson/.test(CT));
ok('one rejection ends a request', /rejects a request, the request ends/i.test(CT) && /not out-voted/i.test(CT));
ok('an approval is for one payment', /one payment only/i.test(CT));
ok('a specific amount to a specific destination', /specific amount going to that specific destination/.test(CT));
ok('changing the mandate goes through the signatories, and not on one’s own removal',
   /approve in the same way as a payment/.test(CT) && /does not vote on their own removal/.test(CT));
ok('membership only by accepting an invitation', /they themselves accept the invitation/.test(CT));
ok('an office is not a signature', /does not, on its own, give anybody the right to approve a payment/.test(CT));
ok('the group does not lend', /does not lend money from its account/.test(CT));
ok('a leaver is settled under the mandate, in part if money is invested',
   /needs the signatories’ approval/.test(CT) && /does not end an investment early/.test(CT));
ok('shares on either basis the account supports',
   /in proportion to what each member has contributed/.test(CT) && /in equal parts between active members/.test(CT));
ok('and we do not settle disputes', /does not settle disputes between members/.test(CT));

console.log('\nthe investment policy agrees with how the group decides');
ok('the members vote, then the signatories approve',
   /does not move any money/.test(PT) && /signatories must then approve that amount/.test(PT));
ok('capital at risk, returns not guaranteed, committed for the term',
   /capital is at risk/i.test(PT) && /returns are not guaranteed/i.test(PT) && /committed for its full term/.test(PT));
ok('money for the payout matures before the payout', /matures before the payout date/.test(PT));
ok('the fee is charged on top', /1% platform fee is charged on top of the amount invested/.test(PT));
ok('no product is recommended', /does not recommend any investment/.test(PT) && !/cattle|solar/i.test(PT));

console.log('\nlinked only once released');
const PAGE = read('stokvels.html');
ok('the public page’s templates section is hidden by default',
   /<section class="sv-sec" id="svTemplates" hidden>/.test(PAGE));
ok('and shown only when the flag says so',
   /templates_live === true\) document\.getElementById\('svTemplates'\)\.hidden = false/.test(PAGE));
ok('the app links them only when released',
   /\(window\.__SVREL \|\| \{\}\)\.templates \?/.test(read('js/portal-core.js')));
ok('both pages are part of the Pages build',
   /group-constitution-template\.html group-investment-policy-template\.html/.test(read('package.json')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
