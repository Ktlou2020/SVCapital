#!/usr/bin/env node
/* Step 4 of signup has two ways out, and both are findable.
 *
 * Production created ONE account in seven days while the signup page sent 91
 * batches of friction telemetry — people were working through the form and not
 * coming out of it. The last thing they meet is step 4:
 *
 *   - a primary button, "Create Account & Submit FICA", which refuses to
 *     submit until an ID, a proof of address AND a selfie are all attached,
 *     and answers a missing one with a red error; and
 *   - the other way to finish, which the product has always supported —
 *     rendered as an underlined link at 0.71rem inside a paragraph of grey
 *     0.71rem text, below the fold on a phone.
 *
 * Somebody at that step without a proof of address to hand had, in practice,
 * no route forward. This does not weaken FICA: the account is created either
 * way and investing still requires approved documents. It stops hiding the
 * door that was already there.
 *
 * Two smaller faults on the same page, both of which end a session badly:
 *
 *   - The duplicate-ID notice — shown to exactly the people who already tried
 *     once — offered "reset your password" pointing at /forgot-password.html.
 *     No such file. The .html redirect strips it to /forgot-password, nothing
 *     matches, and the catch-all in server/index.js serves index.html: the
 *     marketing home page. Not a 404, which is worse. The real flow is a panel
 *     inside login.html, deep-linked at /login#forgot.
 *
 *   - Promise.allSettled over the FICA uploads had its result discarded, so
 *     every upload could fail and the success screen still read "Your FICA
 *     documents have been submitted … reviewed within 1–2 business days."
 *
 * Reads the shipped pages. Needs no database.
 *
 * Run: node server/scripts/check-signup-completion.cjs
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

/* Comments out, so a paragraph describing the old behaviour cannot satisfy an
   assertion about the new one.

   The block-comment rule requires whitespace, ';', '{' or '(' before the
   opening delimiter. Without that guard it matched the one inside
   accept="image(slash)(star),.pdf" on the upload inputs and ran to the next
   closing delimiter eleven thousand characters later, swallowing the whole of
   step 4 — including the two things this file exists to check. Every assertion
   over that span passed or failed for a reason that had nothing to do with the
   page. */
const decomment = s => s.replace(/<!--[\s\S]*?-->/g, ' ')
                        .replace(/(^|[\s;{(])\/\*[\s\S]*?\*\//g, '$1 ')
                        .replace(/^\s*\/\/.*$/gm, ' ');

/* Every shipped copy. mobile/www is generated from mobile/src, and a fix that
   lands in one and not the others ships to some users and not others. */
const PAGES = ['signup.html',
               path.join('mobile', 'src', 'signup.html'),
               path.join('mobile', 'www', 'signup.html')];

for (const rel of PAGES) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const src = decomment(raw);

  console.log(`\n${rel} — the second way to finish is a button, not a footnote`);
  {
    const m = src.match(/id="btnSkipFica"([\s\S]{0,400}?)<\/button>/);
    ok('the skip control still exists', !!m, 'the alternative path is gone entirely');
    if (m) {
      const tag = src.slice(src.lastIndexOf('<button', src.indexOf('id="btnSkipFica"')),
                            src.indexOf('</button>', src.indexOf('id="btnSkipFica"')));
      ok('it is styled as a button rather than inline text',
         /class="[^"]*btn-secondary/.test(tag),
         'it was background:none;border:none;text-decoration:underline — a link wearing a button tag');
      ok('and is not set in 0.71rem',
         !/font-size:\s*0\.7\d*rem/.test(tag),
         'the old control was the same size as the small print around it');
      ok('its label says what it does, not what it skips',
         /Create account/i.test(tag) && !/^\s*Skip for now\s*$/i.test(tag.replace(/<[^>]*>/g, '').trim()),
         '"Skip for now" reads as the wrong choice; it is a supported way to finish');
    }
  }

  console.log(`${rel} — a missing document names the alternative`);
  {
    ok('the error points at the other button',
       /Still needed:[\s\S]{0,200}Create account — upload documents later/.test(src),
       'listing what is missing is only half an answer if the way past it is invisible');
  }

  console.log(`${rel} — the password reset link goes somewhere`);
  {
    ok('no link to the page that does not exist',
       !/forgot-password\.html/.test(src),
       'server/index.js serves index.html for it — the marketing home page, silently');
    ok('it deep-links the panel that does exist',
       /href="\/login#forgot"/.test(src),
       'login.html opens #forgotPanel on location.hash === "#forgot"');
  }

  console.log(`${rel} — the success screen does not overstate what was stored`);
  {
    ok('the upload outcomes are read',
       /const outcomes = await Promise\.allSettled\(/.test(src),
       'allSettled never rejects, so an unread result means failures are invisible');
    ok('successes are counted',
       /docsStored\s*=\s*outcomes\.filter\(o => o\.status === 'fulfilled'\)\.length/.test(src));
    ok('and failures with them',
       /docsFailed\s*=\s*outcomes\.length - docsStored/.test(src));
    ok('the 1–2 business days promise is conditional on them arriving',
       /docsFailed === 0[\s\S]{0,200}1–2 business days/.test(src),
       'this sentence used to be printed whether or not a single byte was stored');
    ok('a total failure says so plainly',
       /docsStored === 0[\s\S]{0,160}could not be uploaded/.test(src));
    ok('a partial one gives the numbers',
       /\$\{docsStored\} of \$\{docsStored \+ docsFailed\} documents were uploaded/.test(src));
    ok('and the compliance ticket is warned too',
       /upload\(s\) FAILED and are not attached/.test(src),
       'the team opening that ticket is the one who can chase it');
  }

  console.log(`${rel} — the account is still created either way`);
  {
    ok('skipping still submits', /_doSubmit\(true\)/.test(src));
    ok('uploading still submits', /_doSubmit\(false\)/.test(src));
    /* The point of the change is reach, not a weaker FICA rule. */
    ok('the required-document list is unchanged',
       /REQUIRED_DOCS = \['id', 'address', 'selfie'\]/.test(src),
       'this check exists to stop a "completion" fix quietly becoming a compliance one');
  }
}

console.log('\nthe alternative is reachable without scrolling past small print');
{
  const css = fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf8');
  ok('the block has styles of its own', /\.fica-alt\s*\{/.test(css));
  ok('the button fills the row like the primary one does',
     /\.fica-alt__btn\s*\{[^}]*width:\s*100%/.test(css),
     'a narrow secondary button next to a wide primary one still reads as the minor option');
}

console.log('\nand the friction tracker still records which path was taken');
{
  const src = decomment(fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf8'));
  ok('skipping is recorded', /_FT\.ficaSkipped\(\)/.test(src),
     'without this the next week of data cannot say whether the new button is being used');
  ok('attempts are recorded', /_FT\.submitAttempted\(\)/.test(src));
  ok('successes are recorded', /_FT\.submitSuccess\(\)/.test(src));
  ok('and failures carry the reason', /_FT\.submitFailed\(err\.message/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
