#!/usr/bin/env node
/* A maturity report that can be brought up to date.
 *
 * The pool maturity report is a SNAPSHOT: the console fetches it and writes
 * it into a popup with document.write. Change a maturity instruction, post
 * a pool's return or cancel an investment, and the report somebody has open
 * on the other screen is quietly wrong — and it is the document they
 * reconcile a bank file against.
 *
 * Three things this has to get right, and one trap the file already walked
 * into once and documented:
 *
 *   the timestamp must be the server's stamp for when the figures were
 *   READ, not the browser's clock when the page was drawn — otherwise a
 *   report rebuilt from data already in hand claims to be as current as the
 *   moment it was rendered, which is the exact lie a refresh button exists
 *   to stop;
 *
 *   a refresh must rewrite the SAME window, or two reports sit on screen
 *   with no way to tell which is current, and the second meets the popup
 *   blocker besides;
 *
 *   and every failure must be said IN THE REPORT WINDOW. The download
 *   callbacks this file used to have reported through Toast — in the
 *   console, behind the report — so a failure looked exactly like a button
 *   that did nothing. That lesson is written in the file; this check is
 *   what stops it being unlearned.
 *
 * Run: node server/scripts/check-maturity-report-refresh.cjs
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

const ADMIN = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');

/* Asserted against the whole file.

   The first version sliced out just this function, to avoid matching the
   console's OTHER report window, which shares its stylesheet. Two
   boundaries were tried and both cut the slice off inside the report's own
   embedded script — once at a brace at column zero, once at a nested
   function declaration — and the assertions past that point then failed
   against an empty string rather than against the code.

   The patterns below are unique to this feature (svcRefreshBtn,
   _POOL_MATURITY_WIN, takenClock, d.generatedAt), so there is nothing for
   a slice to protect them from, and the mutation runs confirm each one
   fails when the thing it names is removed. */

console.log('the report says when its figures were read');
{
  ok('the report window builder is there', ADMIN.includes('function _openPoolMaturityReportWindow(d, into)'), 'the report window builder was not found');
  ok('the stamp comes from the server, not the browser clock',
     /const takenAt = d\.generatedAt \? new Date\(d\.generatedAt\)/.test(ADMIN),
     'new Date() at render time says when the page was DRAWN, which a '
     + 'rebuild from data already in hand would report as fresh');
  ok('and it is on the report where somebody reading it will see it',
     /figures as at \$\{takenClock\}/.test(ADMIN));
  ok('the issued line uses the same moment',
     /const issuedAt = takenAt\.toLocaleString/.test(ADMIN),
     'two timestamps on one document that disagree is worse than one');
}

console.log('\nand it can be brought up to date');
{
  ok('there is a Refresh control', /id="svcRefreshBtn"/.test(ADMIN) && /Refresh<\/button>/.test(ADMIN));
  ok('it asks the console, which is where the session lives',
     /opener\.refreshPoolMaturityReport\(\)/.test(ADMIN));

  ok('the console exposes that entry point',
     /async function refreshPoolMaturityReport\(\)/.test(ADMIN));
  ok('which knows which pool to ask for again',
     /_POOL_MATURITY_POOL/.test(ADMIN)
     && /openPoolMaturityReport\(_POOL_MATURITY_POOL, _POOL_MATURITY_WIN\)/.test(ADMIN));
  ok('and rejects rather than resolving when it fails',
     /throw e;/.test(ADMIN.slice(ADMIN.indexOf('async function openPoolMaturityReport'),
                                 ADMIN.indexOf('async function openPoolMaturityReport') + 1400)),
     'a refresh that swallows its error leaves the report window showing '
     + 'stale figures and no sign anything went wrong');
}

console.log('\nand it rewrites the window it is in, not a second one');
{
  ok('an existing window is reused',
     /const reuse = into && !into\.closed;/.test(ADMIN)
     && /reuse \? into : window\.open/.test(ADMIN));
  ok('and reopened for writing first',
     /if \(reuse\) win\.document\.open\(\);/.test(ADMIN),
     'document.write onto a document that was never reopened appends to the '
     + 'old report rather than replacing it');
  ok('the handle is kept so the next refresh finds it',
     /_POOL_MATURITY_WIN = win;/.test(ADMIN));
}

console.log('\nand nothing fails silently behind the report');
{
  ok('there is somewhere in the report to say so', /id="svcRefreshNote"/.test(ADMIN));
  ok('a closed console is explained, with what to do instead',
     /admin console[\s\S]{0,40}is closed/.test(ADMIN)
     && /run the maturity\s*'?\s*\+?\s*'?\s*report again/.test(ADMIN.replace(/'\s*\n\s*\+\s*'/g, '')),
     'the console having been closed is the commonest way this fails and '
     + 'the one the window cannot do anything about');
  /* The call must be the FIRST thing the handler does. A looser pattern
     matched `if (0) svcRefreshFail(...)` just as happily, so a rejection
     could be swallowed with the assertion still green. */
  ok('a rejected refresh is reported too',
     /\.catch\(function \(e\) \{\s*\n\s*svcRefreshFail\(/.test(ADMIN),
     'the handler must call it, not merely mention it');
  ok('and says the figures on screen are still the old ones',
     /still as at \$\{takenClock\}/.test(ADMIN),
     'a failed refresh that leaves the reader unsure which figures they are '
     + 'looking at is worse than no button');
  ok('the button comes back rather than staying stuck on Refreshing',
     /b\.disabled = false; b\.textContent = 'Refresh';/.test(ADMIN));

  /* The trap this file already fell into once. */
  /* The popup's own script, which IS worth isolating: the rest of the file
     is the console, where Toast is exactly the right thing to call. */
  const POPUP = ADMIN.slice(ADMIN.indexOf('function svcRefreshFail'),
                            ADMIN.indexOf('<\\/script>'));
  ok('no failure path reports through the console behind the report',
     POPUP.length > 400 && !/Toast\.(error|info|success)/.test(POPUP),
     'Toast draws in the admin console, which is behind this window — the '
     + 'file documents that exact mistake with the download buttons');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
