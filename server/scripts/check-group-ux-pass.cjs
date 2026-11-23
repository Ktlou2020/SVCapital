#!/usr/bin/env node
/* Four things a pass over the group workspace turned up, on real screens.
 *
 * The workspace was driven in a browser as a chairperson, a signatory and a
 * member who was behind on her contributions, against groups at four stages
 * of life. These are the four defects that pass found which are small
 * enough to state exactly, so they are held exactly.
 *
 * 1. A NOTIFICATION COULD NOT LINK TO THE DECISION. Every message the group
 *    sends carried /portal/?stokvel=<id> and nothing else, so a signatory
 *    told "it needs your approval — yours is one of them" landed on the
 *    Overview with the decision behind a tab. A signature is the one thing
 *    that holds a group's money up, and the message asking for it put the
 *    person two taps away from giving it.
 *
 * 2. THE GROUP SCREENS USED THE BROWSER'S confirm(). Twelve of them,
 *    including every one that moves money. The rest of the portal has used
 *    Confirm.ask since it was written — so at the moment a member was asked
 *    to part with money, the app handed them an operating-system dialog
 *    headed with the host name. The contribution one did not even name the
 *    amount.
 *
 * 3. EVERY SECTION HEADING DREW TWICE. The hub heads each section of a
 *    stacked tab and six builders also headed themselves:
 *    CONTRIBUTIONS / CONTRIBUTIONS, SHARES / SHARES, PAYOUTS / PAYOUT.
 *
 * 4. THE TAB BAR SLICED ITS OWN LABELS. The open tab was scrolled to the
 *    CENTRE of the strip, so at 430px the bar came to rest with the first
 *    tab cut down the middle: "Overview" read as "view", "Records" as "Re".
 *
 * Run: node server/scripts/check-group-ux-pass.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* A comment that explains a fix quotes the thing it warns about. */
const strip = src => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ')
                                .replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const CORE   = strip(read('js/portal-core.js'));
const NOTIFY = strip(read('server/services/stokvelNotify.js'));

/* ── 1. The link carries the section ──────────────────────────────── */
console.log('\na notification links to the decision, not just the group');
{
  ok('hubUrl takes a section', /function hubUrl\(groupId, section\)/.test(NOTIFY),
     'it took the group alone, so every message landed on the Overview');
  ok('AND PUTS IT IN THE LINK',
     /tab=\$\{encodeURIComponent\(section\)\}/.test(NOTIFY), NOTIFY.slice(0, 200));
  ok('and a message with no section still opens the group',
     /if \(!groupId\) return '\/portal\/';/.test(NOTIFY),
     'a link that opens nothing is worse than one that opens the Overview');

  /* The one that matters most: the request for a signature. */
  const approval = NOTIFY.slice(NOTIFY.indexOf('async function approvalNeeded'),
                                NOTIFY.indexOf('async function decided'));
  ok('THE REQUEST FOR A SIGNATURE OPENS THE APPROVALS',
     /hubUrl\(groupId, 'approvals'\)/.test(approval),
     'this is the message that unblocks a group’s money: ' + approval.slice(0, 200));

  const vote = NOTIFY.slice(NOTIFY.indexOf('async function decided'),
                            NOTIFY.indexOf('async function spent'));
  ok('and so does the news that somebody voted',
     /hubUrl\(groupId, 'approvals'\)/.test(vote), vote.slice(0, 160));

  const sched = NOTIFY.slice(NOTIFY.indexOf('async function scheduleChanged'));
  ok('a changed contribution opens the contributions',
     /hubUrl\(groupId, 'contributions'\)/.test(sched), sched.slice(0, 160));

  ok('NO MESSAGE STILL LINKS TO THE GROUP ALONE',
     !/hubUrl\(groupId\)/.test(NOTIFY),
     'one left behind is one notification that still lands nowhere useful');

  /* And the portal end of the same link. */
  ok('the portal reads the section off the url',
     /params\.get\('tab'\)/.test(CORE), 'js/portal-core.js svcOpenDeepLink');
  ok('AND CHECKS IT AGAINST THE SECTIONS THAT EXIST',
     /_svKnownSection\(wantTab\)/.test(CORE),
     'a crafted or stale ?tab= must not decide what renders');
  ok('and hands it to the hub',
     /openStokvelHub\(stokvel, tab\)/.test(CORE), CORE.slice(0, 120));
  ok('which takes a section and opens at it',
     /async function openStokvelHub\(id, section\)/.test(CORE)
     && /_svRenderHub\(id, at\)/.test(CORE), 'openStokvelHub took the id alone');

  /* RUN, NOT READ. The first version of this guard asked
     _svTabList().includes(key) — and that returns [key, label, icon]
     triples, so it was false for every section that exists and the fix
     silently did nothing. The source matched the pattern; only calling it
     showed it was wrong. */
  {
    const ctx = { window: {}, document: { getElementById: () => null },
                  location: { search: '' },
                  localStorage: { getItem: () => null, setItem() {} },
                  sessionStorage: { getItem: () => null, setItem() {} },
                  Utils: { rand: n => 'R ' + n }, encodeURIComponent };
    vm.createContext(ctx);
    vm.runInContext(read('js/portal-core.js'), ctx);
    ok('AND THE GUARD ADMITS A REAL SECTION',
       ctx._svKnownSection('approvals') === true
       && ctx._svKnownSection('contributions') === true
       && ctx._svKnownSection('payouts') === true,
       'a guard that rejects everything is a fix that does nothing, and it '
       + 'reads exactly like one that works');
    ok('and refuses one that is not',
       ctx._svKnownSection('nonsense') === false
       && ctx._svKnownSection('') === false
       && ctx._svKnownSection(null) === false,
       'a crafted ?tab= must not reach the renderer');
    ok('and the sections it admits are the ones the tabs are built from',
       Object.keys(ctx._svSections()).every(k => ctx._svKnownSection(k)),
       'two lists of what a section is would drift');
  }
  ok('and reveals the tab holding it, for a group that has not grown into it',
     /__svRevealed\[_svGroupOf\(at\)\] = true/.test(CORE),
     'arriving at a section whose tab is hidden would land on nothing');
}

/* ── 2. The portal's own dialog, not the browser's ────────────────── */
console.log('\nand the group asks in the portal’s own words');
{
  ok('there is one helper, as there is for the toast',
     /async function _svConfirm\(message, opts\)/.test(CORE), 'js/portal-core.js');
  ok('it uses Confirm.ask where the bundle provides one',
     /C\.ask === 'function'/.test(CORE), CORE.slice(0, 200));
  ok('AND FALLS BACK RATHER THAN SILENTLY AGREEING',
     /catch \(_\) \{ return false; \}/.test(CORE),
     'a dialog that cannot be drawn must never become a yes');

  /* Every call site, counted. One left behind is one screen that still
     shows an operating-system dialog at the moment money moves. */
  const natives = (CORE.match(/(?:^|[^_.\w])confirm\(/g) || []).length;
  ok('NO GROUP SCREEN CALLS THE BROWSER’S confirm() ANY MORE',
     natives === 1,
     `${natives} left — only the one inside _svConfirm itself may remain`);
  const asked = (CORE.match(/_svConfirm\(/g) || []).length;
  ok('and the twelve that did now ask through the helper',
     asked >= 13, `${asked} call sites including the definition`);

  /* The money one names the figure. */
  const pay = CORE.slice(CORE.indexOf('async function payStokvelContribution'),
                         CORE.indexOf('async function payStokvelContribution') + 900);
  ok('PAYING A CONTRIBUTION NAMES THE AMOUNT',
     /Pay \$\{due\}/.test(pay),
     'it asked "Pay this contribution from your wallet?" over a button the '
     + 'dialog had just covered: ' + pay.slice(0, 200));
  ok('and the button passes the amount for it to name',
     /payStokvelContribution\('\$\{_esc\(gid\)\}','\$\{_esc\(c\.id\)\}',\$\{/.test(CORE),
     'the handler had no amount to show');
  ok('and says whose wallet it comes out of',
     /comes out of your own wallet/.test(pay), pay.slice(0, 300));
}

/* ── 3. One heading per section ───────────────────────────────────── */
console.log('\nand a section is headed once');
{
  /* Driven rather than read: the hub stacks a tab's sections and heads
     each one, so the test is whether a builder adds a second. */
  const ctx = { window: {}, document: { getElementById: () => null },
                location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2), date: d => String(d || '') },
                encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  /* The builders call these; portal-core expects the bundle to provide
     them. Same stand-ins check-group-schedule uses. */
  ctx._esc = v => String(v == null ? '' : v);
  ctx.PORTAL = { investor: { id: 'INV-1' }, transactions: [], stokvels: [], subAccounts: [] };

  const titles = html => (String(html).match(/class="sa-section-title/g) || []).length;

  const contributions = ctx._svContributions({ data: [] }, [], 'G1', { name: 'G' });
  ok('CONTRIBUTIONS CARRIES NO HEADING OF ITS OWN',
     titles(contributions) === 0,
     `${titles(contributions)} — the hub heads it, and this drew "CONTRIBUTIONS" under it`);

  const shares = ctx._svShares({ data: [], basis: 'contribution' }, 'G1');
  ok('nor does shares', titles(shares) === 0, String(titles(shares)));

  const payouts = ctx._svPayouts({ data: [] }, 'G1');
  ok('nor payouts', titles(payouts) === 0, String(titles(payouts)));

  const approvals = ctx._svWithdrawals({ data: [] }, true, 'G1', { g: {}, signatories: 2 });
  ok('nor the signatory approvals', titles(approvals) === 0, String(titles(approvals)));

  const statement = ctx._svStatement({ name: 'G' }, 'G1');
  ok('nor the statement', titles(statement) === 0, String(titles(statement)));

  /* A tab that holds ONE section still has to be labelled, and it is the
     builder that labels it — those keep theirs. */
  const members = ctx._svMembers({ data: [] }, 'G1', false, { g: {} });
  ok('BUT MEMBERS KEEPS ITS OWN, because its tab holds nothing else',
     titles(members) >= 1,
     'People is a single-section tab: the hub adds no heading there, so '
     + 'stripping this one would leave the screen unlabelled');

  ok('and the hub still heads a stacked section, with its anchor',
     /<section id="svSec-\$\{key\}"/.test(CORE) && /sa-section-title/.test(CORE),
     'the anchor is what the checklist and the deep links scroll to');
}

/* ── 4. The tab bar ───────────────────────────────────────────────── */
console.log('\nand the tab bar does not cut its own labels');
{
  const tabs = CORE.slice(CORE.indexOf('function _svWsTabs'),
                          CORE.indexOf('function svTabKeys'));
  ok('a tab snaps to its START, not its centre',
     /scroll-snap-align:start/.test(tabs),
     'centring a tab in a strip narrower than the tabs leaves the one at the '
     + 'edge sliced down the middle');
  ok('and a tab does not shrink below its own label',
     /flex:0 0 auto/.test(tabs), tabs.slice(0, 300));
  ok('and the five fit on a phone',
     /max-width: 460px/.test(tabs) && /font-size: 0\.74rem/.test(tabs),
     'at 430px the bar overflowed and the scroll did the damage');

  const scroll = CORE.slice(CORE.indexOf('function _svScrollTabIntoView'),
                            CORE.indexOf('function svLeaveWorkspace'));
  ok('SCROLLING MOVES THE BAR ONLY WHEN THE TAB IS OUT OF SIGHT',
     /inline: 'nearest'/.test(scroll),
     'inline:center scrolled even when the open tab was fully visible, which '
     + 'is what cut "Overview" down to "view": ' + scroll.slice(0, 200));
  ok('and it still keeps the open tab on screen',
     /scrollIntoView/.test(scroll), scroll.slice(0, 160));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
