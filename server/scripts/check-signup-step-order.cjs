#!/usr/bin/env node
/* Identity is asked for on step 2, and the validation went with it.
 *
 * The console's friction panel, over thirty days:
 *
 *     step 1  Contact ............ 280 sessions
 *     step 2  Identity ...........  39   -86%
 *     step 3  Profile ............  36    -8%
 *     step 4  FICA Docs ..........  35    -3%
 *
 * One step destroyed 86% of everyone who opened the page; the other three lost
 * 10% between them. Only 17 validation errors were recorded across the 241
 * lost, so they were not failing the form — most never attempted it. A
 * 13-digit ID number, a passport number or a nationality is a large thing to
 * ask before anything has been offered in return, and 62% of these people are
 * on a phone. Name, email and phone is a lower bar to clear, and effort already
 * spent is what carries somebody through the rest.
 *
 * The one way this change could do real harm is if the markup moved and the
 * validation did not: step 1 would then refuse to advance over an ID number
 * that is no longer on the page, and the person would be stuck with an error
 * naming a field they cannot see. That is what most of this file is about.
 *
 * Reads the shipped pages structurally — which step DIV each field id falls
 * inside — rather than grepping the file as one string, because every one of
 * these ids appears in the page whichever step it is on.
 *
 * Run: node server/scripts/check-signup-step-order.cjs
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

const PAGES = ['signup.html',
               path.join('mobile', 'src', 'signup.html'),
               path.join('mobile', 'www', 'signup.html')];

/* Identity, and the things that must NOT have travelled with it. */
const IDENTITY = ['idNumber', 'passportNumber', 'passportExpiry', 'nationality', 'countryResidence'];
const CONTACT  = ['firstName', 'lastName', 'email', 'phone'];

for (const rel of PAGES) {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const i1 = s.indexOf('<div id="step1">');
  const i2 = s.indexOf('<div id="step2">');
  const i3 = s.indexOf('<div id="step3">');
  const step1 = s.slice(i1, i2), step2 = s.slice(i2, i3);

  console.log(`\n${rel} — where each field is asked for`);
  ok('the step divs are still in order', i1 > 0 && i2 > i1 && i3 > i2, `${i1} ${i2} ${i3}`);

  for (const id of IDENTITY) {
    ok(`${id} is on step 2`,
       step2.includes(`id="${id}"`) && !step1.includes(`id="${id}"`),
       step1.includes(`id="${id}"`) ? 'still on step 1' : 'not found on either step');
  }
  for (const id of CONTACT) {
    ok(`${id} stays on step 1`,
       step1.includes(`id="${id}"`) && !step2.includes(`id="${id}"`),
       'step 1 is the low bar — moving these defeats the point');
  }

  /* The toggle switches the identity groups AND the address block and phone
     hint, which are still on step 1. It has to stay where the things it
     governs mostly are, and it reaches the moved groups by id regardless. */
  ok('the citizenship toggle stays on step 1',
     step1.includes('id="btnCitizenSA"') && step1.includes('id="btnCitizenIntl"'));
  ok('and the groups it toggles are still addressable by id',
     s.includes('id="saIdGroup"') && s.includes('id="passportGroup"'));

  console.log(`${rel} — the validation moved with the fields`);
  {
    const vs  = s.slice(s.indexOf('function validateStep'));
    const s1  = vs.slice(vs.indexOf('if (n === 1)'), vs.indexOf('if (n === 2)'));
    const s2  = vs.slice(vs.indexOf('if (n === 2)'), vs.indexOf('if (n === 3)'));

    for (const id of IDENTITY) {
      ok(`step 1 no longer demands ${id}`,
         !s1.includes(`'${id}'`),
         'an error about a field that is not on the page is worse than no validation at all');
    }
    ok('step 2 checks the SA ID', /13-digit South African ID number/.test(s2));
    ok('step 2 checks the passport branch', /valid passport number/.test(s2));
    /* The guard, not the mention. `if (false && _idDuplicateBlocked)` contains
       the name and gates nothing, and an earlier version of this assertion was
       satisfied by exactly that. */
    ok('step 2 still blocks a duplicate ID',
       /if \(_idDuplicateBlocked\)\s*\n\s*return showError\(/.test(s2),
       'the returning user must be stopped and sent to the reset link, not let through');
    ok('step 1 still checks name, email and phone',
       CONTACT.every(id => s1.includes(`'${id}'`)));
    ok('step 2 still checks the password', /pw\.length < 10/.test(s2));
  }

  console.log(`${rel} — the step names describe what they now ask`);
  {
    ok('step 1 reads Contact', /<span class="step-label">Contact<\/span>/.test(s));
    ok('step 2 reads Identity', /<span class="step-label">Identity<\/span>/.test(s));
    ok('neither still says Personal', !/<span class="step-label">Personal<\/span>/.test(s));
    ok('nor Security alone', !/<span class="step-label">Security<\/span>/.test(s),
       'the label is what someone reads before deciding to continue');
  }
}

console.log('\nthe duplicate-ID check is still wired to the field');
{
  const s = fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf8');
  ok('checkIdDuplicate still exists', /async function checkIdDuplicate/.test(s));
  ok('and is still bound to the input',
     /checkIdDuplicate/.test(s.slice(s.indexOf('addEventListener'))),
     'it catches returning users early, which is the top error in the panel');
}

console.log('\nthe draft still carries the moved fields');
{
  const s = fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf8');
  const draft = s.slice(s.indexOf('function persistDraft'), s.indexOf('function restoreDraft'));
  for (const id of ['idNumber', 'passportNumber', 'passportExpiry', 'nationality'])
    ok(`${id} is persisted`, draft.includes(`${id}: draftValue('${id}')`),
       'the draft is keyed by field id, not by step — but only for fields it lists');
}

console.log('\nthe console labels the steps the way the form is built');
{
  const adm = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
  ok('step names match the new order',
     /1: 'Contact', 2: 'Identity & Security', 3: 'Profile', 4: 'FICA Docs'/.test(adm),
     'a panel still reading "Personal Info" would misdescribe the first week of comparison data');
  const idx = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
  const m = idx.match(/js\/admin\.js\?v=(\d+)/);
  ok('admin.js is version-bumped', m && Number(m[1]) >= 174, m && m[0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
