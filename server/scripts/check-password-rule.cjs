#!/usr/bin/env node
/* One password rule, stated once, enforced everywhere.
 *
 * The signup console's friction data recorded this, three times in thirty days,
 * against STEP 4:
 *
 *     Password must be at least 10 characters.
 *
 * Step 4 is the FICA upload. The password is on step 2. The message came from
 * the SERVER, at the moment of submission, because three rules disagreed:
 *
 *     signup.html step 2 ......... >= 8    (and "Min 8 characters" on the input,
 *                                           and the strength meter scoring 8)
 *     auth.js /register .......... >= 10
 *     auth.js /reset-password .... >= 8
 *
 * So a person choosing an eight- or nine-character password was told it was
 * fine, spent another two minutes on steps 3 and 4, uploaded an ID, a proof of
 * address and a selfie, pressed Create Account — and was refused, over a field
 * three steps behind them. Maximum effort, then rejection on the first thing
 * they had filled in.
 *
 * The reset route was the loosest rule in the system and the one reachable from
 * an emailed link: it could set a password that registration would have
 * refused. Everything is aligned UP to 10, so nothing that was refused before
 * is accepted now, and no existing password is affected — login does not
 * re-check length.
 *
 * Run: node server/scripts/check-password-rule.cjs
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

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* The guard on the opening delimiter matters: without it the naive rule
   matches the one inside accept="image(slash)(star),.pdf" and eats the rest of
   the page. */
const decomment = s => s.replace(/<!--[\s\S]*?-->/g, ' ')
                        .replace(/(^|[\s;{(])\/\*[\s\S]*?\*\//g, '$1 ')
                        .replace(/^\s*\/\/.*$/gm, ' ');

const MIN = 10;

const SIGNUPS = ['signup.html',
                 path.join('mobile', 'src', 'signup.html'),
                 path.join('mobile', 'www', 'signup.html')];

console.log('\nthe server states one minimum, in every place it checks');
{
  const auth = decomment(read(path.join('server', 'routes', 'auth.js')));
  const lens = [...auth.matchAll(/(?:password|newPassword)\.length < (\d+)/g)].map(m => Number(m[1]));
  /* `length < 1` is a different question — "was a password supplied at all",
     guarding the hash call — and it belongs where it is. Only the policy checks
     are under test here; lumping the two together made this assertion fail on
     correct code, which is its own kind of wrong. */
  const presence = lens.filter(n => n === 1);
  const policy   = lens.filter(n => n > 1);
  ok('the presence guards are still there', presence.length >= 2, `found ${presence.length}`);
  ok('every policy check found', policy.length >= 3, `found ${policy.length}`);
  ok(`all of them are ${MIN}`, policy.every(n => n === MIN), `got ${JSON.stringify(policy)}`);
  ok('registration says so in the message',
     /at least 10 characters/.test(auth));
  ok('and no route still accepts 8',
     !/\.length < 8\b/.test(auth),
     'reset-password was the loose one, and it is reachable from an emailed link');
}

for (const rel of SIGNUPS) {
  const src = decomment(read(rel));
  console.log(`\n${rel} — the form asks for what the server will accept`);
  ok('the step 2 check matches the server',
     new RegExp(`pw\\.length < ${MIN}\\b`).test(src),
     'a shorter client rule turns a step 2 mistake into a step 4 rejection');
  ok('and says the right number', /at least 10 characters/.test(src));
  ok('the input placeholder agrees', /Min 10 characters/.test(src),
     'the placeholder is the first thing read and was telling people 8');
  ok('the requirement list agrees', /At least 10 characters/.test(src));
  ok('the strength meter agrees', /len:\s*pw\.length >= 10/.test(src),
     'a meter that turns green at 8 is the same promise made a third time');
  ok('nothing on the page still says 8', !/8 characters/.test(src),
     'one stale hint is enough to send somebody back to step 2 from step 4');
}

console.log('\nthe reset page agrees with the route behind it');
{
  const reset = decomment(read(path.join('portal', 'reset-password.html')));
  ok('its check is 10', /pw\.length < 10\b/.test(reset));
  ok('its hint is 10', /At least 10 characters/.test(reset));
  ok('its placeholder is 10', /Min\. 10 characters/.test(reset));
  ok('nothing there still says 8', !/8 characters/.test(reset));
}

console.log('\nvalidation errors name the field, so the console can group them');
{
  /* "Most Friction — Fields" read "No field data yet" for the whole of its
     existence: field_name was never sent. It is the panel that answers which
     field costs step 1 its 86%, and the message alone cannot — several fields
     produce "Please enter a valid …". */
  for (const rel of SIGNUPS) {
    const src = decomment(read(rel));
    ok(`${rel} — the tracker takes a field`,
       /validationError\(step, msg, field\)/.test(src));
    ok(`${rel} — and sends it as field_name`,
       /field_name: field \|\| null/.test(src));
    ok(`${rel} — showError passes it through`,
       /function showError\(msg, field\)[\s\S]{0,120}_FT\.validationError\(currentStep, msg, field\)/.test(src));
    const untagged = (src.match(/return showError\('[^']*'\);/g) || []);
    ok(`${rel} — every validation error is tagged`,
       untagged.length === 0,
       `${untagged.length} untagged: ${untagged.slice(0, 3).join(' ')}`);
  }
}

console.log('\nand the server stores what the form now sends');
{
  const fr = decomment(read(path.join('server', 'routes', 'friction.js')));
  ok('field_name is inserted', /field_name/.test(fr) && /e\.field_name \? String\(e\.field_name\)/.test(fr));
  ok('validation_error is an accepted type', /validation_error/.test(fr));
  ok('and the summary groups by it',
     /GROUP BY field_name, step/.test(fr),
     'this is the query behind the panel that was empty');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
