#!/usr/bin/env node
/* The console shows staff what the server will and will not allow.
 *
 * Three releases built the group, the mandate and the contribution ledger,
 * and staff ran all of it through the raw table editor — typing a quorum
 * into a column with nothing to say it must be at least two, flipping
 * is_signatory on rows identified by id, and having no way to see whether a
 * stokvel could withdraw at all.
 *
 * This screen writes through the same generic table API as the rest of the
 * console, and that is the point: the rules live at the gate, not here. What
 * it adds is SIGHT of them, and the two states a table editor cannot show:
 *
 *  · NO MANDATE MEANS NO WITHDRAWALS. The gate refuses rather than guessing
 *    a default, so a stokvel with no quorum on file is stuck — and that has
 *    to be visible in the list, not discovered when a member is refused.
 *  · A QUORUM ABOVE THE SIGNATORY COUNT IS UNREACHABLE. Three approvals
 *    required and two signatories named is a stokvel that can never
 *    withdraw; the column would take it without comment.
 *
 * And one thing the screen must NOT offer: approving on a stokvel's behalf.
 * The mandate is the members' and staff are not party to it. A console
 * button that satisfied it would hand back the single point of failure the
 * whole feature removes.
 *
 * Run: node server/scripts/check-stokvel-admin.cjs
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

/* Code without its commentary. Every assertion below about what a STAFF
   MEMBER SEES runs against this, because an explanation of a warning reads
   the same to a regex as the warning: twice in this file a mutation that
   deleted the visible string left the comment describing it, and the check
   passed on the sentence that exists to explain the thing it had lost. */
const codeOnly = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ')
                           .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

const JS   = read('admin/js/admin.js');
const HTML = read('admin/index.html');
const SVC  = read('server/services/stokvelMandate.js');
const SQL  = read('server/db/setup.js');

/* The stokvel section only — admin.js is twenty thousand lines and a
   substring test against the whole file proves nothing about this screen. */
const SEC = JS.slice(JS.indexOf('const STOKVEL_ROLES'));

console.log('\nthe screen exists and is reachable');
{
  ok('there is a nav entry', /data-view="stokvels"/.test(HTML));
  ok('and a view to land in', /id="view-stokvels"/.test(HTML));
  ok('the loader is registered', /stokvels: loadStokvels/.test(JS));
  ok('and the title map knows it', /stokvels: 'Stokvels'/.test(JS));
  ok('the console script was re-stamped',
     /js\/admin\.js\?v=(\d+)/.test(HTML) && Number(HTML.match(/js\/admin\.js\?v=(\d+)/)[1]) >= 195,
     'an unstamped change is served from cache to every staff member');
}

console.log('\nit shows the two states a table editor cannot');
{
  /* In the LIST, which is the at-a-glance signal. The first draft matched
     anywhere in the section and passed off the warning inside the detail
     panel — so dropping it from the list, where staff would actually notice
     a stuck stokvel, went unseen. */
  const LIST = codeOnly(SEC.slice(SEC.indexOf('function renderStokvelList'),
                                  SEC.indexOf('async function openStokvelAdmin')));
  ok('a stokvel with no mandate is flagged in the list',
     LIST.length > 0 && /cannot withdraw/i.test(LIST),
     'the gate refuses rather than guessing, so this is a stuck stokvel');
  ok('and a quorum above the signatory count is called out',
     /cannot reach its own mandate/.test(codeOnly(SEC)));
  ok('the minimum is the server’s, not a number typed here',
     /STOKVEL_MIN_QUORUM = 2/.test(SEC) && /MIN_QUORUM = 2/.test(SVC),
     'two definitions of the minimum is two answers');
  ok('and saving below it is refused',
     /n >= STOKVEL_MIN_QUORUM/.test(SEC));
  ok('saving an unreachable quorum asks first',
     /will not be able to withdraw until more are named[\s\S]{0,40}confirm|confirm\([\s\S]{0,200}until more are named/.test(SEC));
}

console.log('\nand staff cannot stand in for the signatories');
{
  /* The console may read requests and approvals. It may not create one. */
  ok('no approval is written from here',
     !/tables\/stokvel_request_approvals/.test(SEC)
     && !/withdrawal-requests\/[^']*\/vote/.test(SEC),
     'a console button that satisfied a mandate hands back the single point '
     + 'of failure the feature removes');
  ok('and the screen says so',
     /cannot approve on a stokvel/i.test(codeOnly(SEC)));
  ok('pending requests are shown read-only',
     /Awaiting approval/.test(SEC));
}

console.log('\nthe schedule is replaced, never duplicated');
{
  /* Both have to BE there. indexOf returns -1 for a missing needle, and
     -1 is less than every real index — so the first draft of this passed
     when the deactivation was deleted outright, which is the only mutation
     that matters. */
  const ends   = SEC.indexOf('{ active: false }');
  const starts = SEC.indexOf("'tables/stokvel_contribution_schedules', {");
  ok('the old one is ended before a new one is written',
     ends > -1 && starts > -1 && ends < starts,
     `end at ${ends}, insert at ${starts} — one live schedule per stokvel is a `
     + 'partial unique index, and a second active insert is refused by the database');
  ok('and the database is what enforces it',
     /CREATE UNIQUE INDEX IF NOT EXISTS scs_one_active[\s\S]{0,120}WHERE active/.test(SQL));
  ok('staff are told what replacing does to existing obligations',
     /keep the amount they were raised at/.test(codeOnly(SEC)));
}

console.log('\nand what it renders is escaped');
{
  /* Markup only. The first draft scanned every interpolation in the section
     and flagged two ids being put into API URLs — where _esc would be
     actively wrong, since it would HTML-encode a path segment. A line that
     calls the API is not a line that renders. */
  const interps = [];
  for (const line of SEC.split('\n')) {
    if (/API\._fetch|await fetch\(/.test(line)) continue;
    for (const m of line.matchAll(/\$\{([^}]+)\}/g)) {
      const x = m[1].trim();
      if (!/\b(name|investor_id|bank_name|stokvel_reg_number|role|status|amount|due_day|quorum_required|created_at|id)\b/.test(x)) continue;
      if (/_esc\(|Utils\.rand\(|\?|&&|\|\||\.length|===|!==|>=|\.map\(|\.filter\(|STOKVEL_|signatories|arrears|pending|owed|active/.test(x)) continue;
      interps.push(x);
    }
  }
  ok('every value rendered as markup goes through _esc', interps.length === 0, interps.join(' | '));
}


console.log('\nand the shares panel reads rather than edits');
{
  ok('the share basis is settable, because it is the group\u2019s own constitution',
     /svShareBasis/.test(JS) && /saveStokvelShareBasis/.test(JS));
  ok('and changing it asks first',
     /saveStokvelShareBasis[\s\S]{0,400}confirm\(/.test(JS),
     'it re-states every member\u2019s share at once');
  const panel = JS.slice(JS.indexOf('function _stokvelAdminShares'),
                         JS.indexOf('function _stokvelAdminInvites'));
  ok('a share itself has nothing to edit',
     panel.length > 100 && !/onchange=/.test(panel) && !/tables\/stokvel_allocations/.test(panel),
     'a staff field overriding a share would be a second answer to the question the '
     + 'ledger exists to answer');
  ok('and an unpaid exit is surfaced rather than actioned',
     /Still owed to members who have left/.test(panel) && /Nothing to do here/.test(panel),
     'it is paid automatically as investments mature');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
