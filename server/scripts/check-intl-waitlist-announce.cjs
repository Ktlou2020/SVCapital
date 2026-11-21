#!/usr/bin/env node
/* Telling the international waitlist that they can sign up.
 *
 * The list was collected for exactly one message and there was no way to
 * send it. The broadcast tool segments INVESTORS, and these people have no
 * account — that is the whole reason they are on a list. So the only route
 * was a CSV export and somebody's own mail client.
 *
 * THE ONE WAY TO GET THIS WRONG IS TO SEND IT TWICE, so who has been told
 * is a column, stamped as each message goes rather than at the end: a run
 * that dies half way through must not start again from the beginning.
 *
 * AND THE TAB WAS NOT MISSING, it had moved. The sidebar consolidation that
 * took 25 nav items to 17 folded International Interest into a tab under
 * Clients, where nobody found it again.
 *
 * Run: node server/scripts/check-intl-waitlist-announce.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ADMIN = strip(read('admin/js/admin.js'));
const HTML  = read('admin/index.html');
const ROUTE = strip(read('server/routes/waitlist.js'));
const SETUP = read('server/db/setup.js');
const MAIL  = strip(read('server/services/email.js'));

console.log('\nthe list is reachable in the console');
{
  ok('THE INTERNATIONAL INTEREST TAB EXISTS',
     /data-pane="intlinterest"/.test(HTML),
     'it was reported as removed; the sidebar consolidation moved it into a '
     + 'tab under Clients rather than deleting it');
  ok('and it is a pane with a table to fill',
     /id="intlInterestBody"/.test(HTML), 'admin/index.html');
  ok('and something loads it', /function loadIntlInterest/.test(ADMIN), 'admin/js/admin.js');
}

console.log('\nand there is a way to tell them, which there was not');
{
  ok('the button is on the tab', /id="ii-announce"/.test(HTML), 'admin/index.html');
  ok('and it calls the announcement',
     /function announceIntlSignupOpen/.test(ADMIN)
     && /waitlist\/international\/announce/.test(ADMIN), 'admin/js/admin.js');
  ok('THE COUNT IS NAMED BEFORE THE CONFIRM',
     /untold\.length[\s\S]{0,400}?Confirm\.ask/.test(ADMIN),
     'this leaves the building — real email to real people — and "are you '
     + 'sure" over an unnamed number is not a decision anybody can make');
  ok('and the confirm says it cannot be unsent',
     /cannot be unsent/.test(ADMIN), 'admin/js/admin.js');

  ok('the endpoint is staff only',
     /requireAuth, requireRole\('admin', 'director'\)/.test(ROUTE),
     'server/routes/waitlist.js');
  ok('and the public sign-up endpoint still needs no auth',
     /router\.post\('\/international', async/.test(ROUTE),
     'that one is reached by somebody who has no account by definition');
}

console.log('\nand nobody is told twice');
{
  ok('the column exists', /notified_at TIMESTAMPTZ/.test(SETUP), 'server/db/setup.js');
  ok('and is added to databases that predate it',
     /ADD COLUMN IF NOT EXISTS notified_at/.test(SETUP), 'server/db/setup.js');
  ok('THE SELECT SKIPS WHOEVER HAS BEEN TOLD',
     /notified_at IS NULL/.test(ROUTE),
     'a second press must reach only whoever has been added since');
  ok('and each one is stamped AS IT GOES, not at the end',
     /sendInternationalSignupOpen[\s\S]{0,220}?UPDATE international_waitlist SET notified_at = NOW\(\)/.test(ROUTE),
     'stamping at the end means a run that dies half way through starts '
     + 'again from the beginning');
  ok('a failure for one does not stop the rest',
     /failed\+\+/.test(ROUTE), 'server/routes/waitlist.js');
  ok('and the resend is explicit and audited',
     /resend/.test(ROUTE) && /RESEND, including people already told/.test(ROUTE),
     'server/routes/waitlist.js');
}

console.log('\nand the badge reads the same column the sender writes');
{
  /* It read r.status === "contacted" and the button PATCHed a `status`
     column that has never existed on this table, so the button always
     failed and the badge could never be green. */
  ok('THE BADGE READS notified_at',
     /const contacted = !!r\.notified_at/.test(ADMIN),
     'it read a status enum that the table does not have');
  ok('and marking somebody by hand writes the same column',
     /tables\/international_waitlist\/\$\{id\}`, \{ notified_at/.test(ADMIN),
     'it PATCHed `status`, which is why that button never worked');
  ok('and no status enum is left behind',
     !/status: 'contacted'/.test(ADMIN),
     'two columns answering one question is how they disagree');
}

console.log('\nand the email says the thing they were waiting for');
{
  ok('there is one', /function sendInternationalSignupOpen/.test(MAIL), 'server/services/email.js');
  const fn = MAIL.slice(MAIL.indexOf('function sendInternationalSignupOpen'),
                        MAIL.indexOf('function sendMaturityInstructionConfirmed'));
  ok('the slice found it', fn.length > 400, String(fn.length));
  ok('it links to the sign-up page', /\/signup/.test(fn), fn.slice(0, 160));
  ok('IT SAYS RANDS ONLY BEFORE THEY START',
     /South African rands/.test(fn),
     'after four steps of a form is too late to learn you cannot pay in euros');
  ok('and that US persons cannot be accepted',
     /US citizens or US persons/.test(fn), 'the other thing that wastes their time');
  ok('and it offers a way out',
     /rather not hear from us again/.test(fn),
     'these people asked to be told once, not to be subscribed');
  ok('it is exported', /sendInternationalSignupOpen,/.test(MAIL), 'server/services/email.js');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
