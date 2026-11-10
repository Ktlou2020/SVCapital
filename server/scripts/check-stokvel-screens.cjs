#!/usr/bin/env node
/* A stokvel member can reach, and act on, what the first three phases built.
 *
 * Everything so far was server-side. A member could not see any of it,
 * because the sub-accounts grid renders what loadSubAccounts() fetches and
 * that asks for sub_accounts where the caller is parent_investor_id — the
 * chairperson. Everybody else in the stokvel had no row to render and no way
 * in.
 *
 * What this holds:
 *
 *  · A MEMBER WHO DID NOT OPEN IT STILL SEES IT. The grid is the union of
 *    sub-accounts and stokvel memberships, and the badge counts both — a
 *    badge of zero beside a grid with your stokvel in it is its own bug.
 *  · THE STOKVEL OPENS ITS OWN HUB, not the generic sub-account view, which
 *    knows nothing about members, mandates or contributions.
 *  · NAMES ARE ESCAPED. The roster is other people's names, the requests
 *    carry a reason somebody typed, and all of it goes into innerHTML.
 *  · THE DESTINATION IS ASKED FOR WHEN THE REQUEST IS RAISED. The gate
 *    refuses a withdrawal to an account the signatories did not approve, so
 *    a screen that collects the amount alone builds a request that can never
 *    be used.
 *  · A NON-SIGNATORY SEES THE REQUESTS AND GETS NO BUTTONS. Seeing what is
 *    being asked for is the point; voting is not theirs.
 *  · AN INVESTMENT IS RAISED THE SAME WAY, AND READS AS ONE. Both kinds sit
 *    in one list, so a row that does not say which it is asks a signatory to
 *    approve a sum with no idea where it goes. The pool is chosen from the
 *    open pools, the pool's own minimum is tested against the POOL amount,
 *    and the form says what the wallet actually pays once the 1% is on top.
 *  · AND THE MARKETPLACE CARRIES THE APPROVAL. The route refuses a stokvel
 *    investment with no authority id, so a confirm path that does not send
 *    one makes every approved request unspendable. It is checked in BOTH
 *    copies of the marketplace — web and mobile — because there are two.
 *
 * The measured half runs the real portal code against a stub API, because
 * what matters is what renders, and only a browser knows that.
 *
 * Run: node server/scripts/check-stokvel-screens.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');

/* The real Toast object out of js/api.js, lifted whole and rebound to window
   so the page has the one the portal actually loads. Lifted rather than
   written out here: a hand-made Toast is a stand-in, and a stand-in is what
   hid the bug this guards against. If the literal ever cannot be found this
   throws, rather than quietly leaving the page without a Toast and failing
   every assertion below for the wrong reason. */
const TOAST_SRC = (() => {
  const api = fs.readFileSync(path.join(ROOT, 'js', 'api.js'), 'utf8');
  const at  = api.indexOf('const Toast = {');
  const end = api.indexOf('\n};\n', at);
  if (at < 0 || end < 0) throw new Error('could not lift Toast out of js/api.js');
  return api.slice(at, end + 3).replace('const Toast = {', 'window.Toast = {');
})();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* The eleven SECTIONS now live under five TABS, and a tab is only in the bar
   once the group has grown into it — a new group met eleven, ten of them
   empty, which is the screen this was reported as confusing on.

   What this check held before was "every section is offered", by name, in
   the bar. That is no longer true and should not be. What has to stay true
   is the INTENT behind it: a member can still reach every section. So the
   assertions below are about reachability, not about the bar's contents. */
const _svSectionsAll = ['overview', 'contributions', 'approvals', 'proposals', 'shares',
                        'payouts', 'members', 'investments', 'transactions',
                        'statement', 'documents'];

console.log('\nthe member is let in');
{
  ok('stokvels are loaded from the membership endpoint',
     /API\._fetch\('GET', 'stokvels'\)/.test(CORE),
     'the sub-accounts table is scoped to whoever opened the account');
  ok('and the grid is the union of both',
     /_stokvelsNotMine\(\)/.test(CORE) && /joined\.map\(sv => _stokvelCard/.test(CORE));
  ok('the badge counts both too',
     /PORTAL\.subAccounts\.length \+ _stokvelsNotMine\(\)\.length/.test(CORE),
     'a badge of zero beside a grid with your stokvel in it');
  ok('a stokvel opens its own hub',
     /account_type === 'stokvel'\) return openStokvelHub/.test(CORE));
  ok('and the view loader fetches all three before rendering',
     /loadSubAccounts\(\)/.test(CORE) && /loadStokvels\(\)/.test(CORE)
     && /Promise\.all\(\[[^\]]*loadStokvelInvites\(\)/.test(CORE),
     'sub-accounts, stokvels AND invitations — somebody invited before they have '
     + 'opened anything of their own has only the invitation on the screen');
}

console.log('\nand what it renders is escaped');
{
  /* Interpolations of values that came from a person. The roster is other
     members' names; the requests carry a reason somebody typed. */
  const hub = CORE.slice(CORE.indexOf('function _svHeader'), CORE.indexOf('async function payStokvelContribution'));
  const raw = [...hub.matchAll(/\$\{([^}]+)\}/g)].map(m => m[1].trim())
    .filter(x => /\b(name|reason|role|label|status|bank_name|requested_by_name|period_label)\b/.test(x))
    .filter(x => !/_esc\(|Utils\.rand\(|\?|&&|\.length|===|!==/.test(x));
  ok('every person-typed value goes through _esc', raw.length === 0, raw.join(' | '));
  ok('and the hub never builds HTML from an unescaped id',
     !/\$\{(?:r|m|c|s)\.id\}/.test(hub), 'ids are interpolated into onclick handlers');
}

console.log('\nthe request collects what the gate will check');
{
  /* Sliced on the declaration as it actually reads. This looked for
     'async function raiseStokvelWithdrawal'; the flow became a form and
     stopped being async, indexOf returned -1, and slice(-1, n) handed the
     assertions an empty string that then failed for the wrong reason. */
  const fn = CORE.slice(CORE.indexOf('function raiseStokvelWithdrawal'),
                        CORE.indexOf('async function voteStokvelRequest'));
  ok('it asks for the amount', /amount/.test(fn));
  ok('and the bank account it is going to',
     /bank_account_number/.test(fn) && /bank_name/.test(fn),
     'the gate refuses a withdrawal to an account the signatories did not approve, '
     + 'so collecting the amount alone builds a request that can never be used');
}

console.log('\nan investment is raised the same way');
{
  const fn = CORE.slice(CORE.indexOf('function raiseStokvelInvestment'),
                        CORE.indexOf('async function voteStokvelRequest'));
  ok('the request names the pool, not only the amount',
     /kind: 'investment'/.test(fn) && /pool_id: sel\.value/.test(fn),
     'the gate refuses an authority approved for a different pool, so a request '
     + 'without one can never be used');
  ok('the pools offered are the open ones',
     /status === 'open'/.test(fn) && /_poolPastClose\(p\)/.test(fn));
  ok('the pool minimum is tested against the pool amount',
     /amt < min - 0\.005/.test(fn) && !/svcWalletSpend\([^)]*\) < min/.test(fn),
     'the minimum is a rule about the pool, never about the wallet spend');
  ok('and the fee is stated rather than discovered',
     /svcWalletSpend/.test(fn) && /leaves the group wallet/.test(fn),
     'the signatories approve what reaches the pool; the wallet pays 1% more');
}

console.log('\nand the marketplace carries the approval');
{
  for (const rel of ['portal/js/portal.js', 'mobile/src/js/portal.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const fn  = src.slice(src.indexOf('async function confirmInvestment'));
    ok(`${rel} resolves the authority for a stokvel`,
       /account_type === 'stokvel'/.test(fn) && /stokvelInvestAuthority\(/.test(fn),
       'the route refuses a stokvel investment that carries no authority');
    ok(`${rel} sends it with the investment`,
       /authority_id: _stokvelAuthorityId/.test(fn));
    ok(`${rel} stops before asking for a signature`,
       fn.indexOf('stokvelInvestAuthority(') < fn.indexOf('signAgreementFor('),
       'a member with no approval should not be asked to sign for an '
       + 'investment that cannot be placed');
  }
  ok('and the matcher itself lives once, in the shared core',
     /async function stokvelInvestAuthority\(/.test(CORE),
     'the marketplace exists twice; a copy in each is a copy that drifts');
}

console.log('\nand a group wallet is never topped up with unattributed money');
{
  /* The hole beside the contribution flow. Topping a stokvel wallet up
     through the ordinary deposit screen credits it with nothing recording
     whose money it was, and stokvelShares.reconcile then shares the increase
     across every member pro-rata \u2014 right for interest, wrong for a
     treasurer banking R5 000 of their own, who would get back their share
     and no more. */
  /* Sliced on function boundaries rather than by counting characters: the
     first version of these used proximity windows, which the explanatory
     comments then pushed the code out of \u2014 so they failed on correct
     code and would have passed on plenty of wrong code. */
  const depositFn = CORE.slice(CORE.indexOf('function openSaDeposit'),
                               CORE.indexOf('async function payIntoStokvel'));
  const payInFn   = CORE.slice(CORE.indexOf('async function payIntoStokvel'),
                               CORE.indexOf('function _getLevelForXP'));
  ok('the deposit entry point refuses a stokvel',
     /account_type === 'stokvel'/.test(depositFn) && /payIntoStokvel\(saId\)/.test(depositFn),
     'guarded at the function, not only on the buttons that call it');
  ok('and the card offers paying in instead',
     /account_type === 'stokvel' \? `payIntoStokvel/.test(CORE));
  ok('paying in goes through the member\u2019s own wallet',
     /pay-in/.test(payInFn) && !/openTopUpModal/.test(payInFn),
     'a wallet that already knows whose money it is');
  ok('and the hub offers it too', /Pay into the pot/.test(CORE));
}

console.log('\nand the workspace behaves like one');
{
  const ws = CORE.slice(CORE.indexOf('function _svCache'), CORE.indexOf('function _svOverview'));
  ok('moving between sections reuses what is loaded',
     /_svRenderHub\(id, tab, \{ cached: true \}\)/.test(CORE),
     'a tab was seven requests; a dashboard that goes back to the network to '
     + 'change tab does not feel like one');
  const submits = [];
  for (const m of CORE.matchAll(/async function (submitStokvel\w+)\s*\(/g)) {
    const end = CORE.indexOf('\n}\n', m.index);
    submits.push([m[1], CORE.slice(m.index, end === -1 ? CORE.length : end)]);
  }
  ok('every form that changed the group refetches',
     submits.length >= 5 && submits.every(([, body]) =>
       /_svRenderHub\(/.test(body) && !/cached/.test(body)),
     'a stale figure must not survive an action; found ' + submits.length
     + ' forms: ' + submits.filter(([, b]) => /cached/.test(b) || !/_svRenderHub\(/.test(b))
         .map(([n]) => n).join(', '));
  ok('and switching groups starts clean',
     /window\.__SVWS = null/.test(CORE),
     'the member may have been away for days');

  ok('the sections are a real tablist',
     /role="tablist"/.test(ws) && /role="tab"/.test(ws) && /aria-selected/.test(ws));
  const keyFn = CORE.slice(CORE.indexOf('function svTabKeys'),
                           CORE.indexOf('function _svScrollTabIntoView'));
  ok('with arrow keys, and wired to the bar',
     /onkeydown="svTabKeys\(/.test(ws)
     && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].every(k => keyFn.includes(k))
     && /svWorkspaceTab\(/.test(keyFn),
     'a tablist a keyboard cannot move along is a row of buttons wearing the role');
  ok('and the open one scrolled into view',
     /_svScrollTabIntoView/.test(CORE),
     'a tab bar that scrolls and hides where you are is worse than one that does not');
  const phone = ws.slice(ws.indexOf('@media (max-width: 760px)'));
  ok('the labels stay at phone width',
     /\$\{label\}/.test(ws) && !/display\s*:\s*none/.test(phone),
     'nine unnamed icons is a guessing game; the bar scrolls instead');

  ok('nothing is collected through a prompt box any more',
     !/= prompt\(/.test(CORE) && !/await prompt\(/.test(CORE),
     'a prompt cannot be styled, cannot validate before it closes, and on a '
     + 'phone it covers what the member was reading');
  ok('the forms say what is wrong without taking the page away',
     /id="svFormNote"/.test(CORE)
     && submits.every(([, body]) => /_svFormError\(/.test(body)),
     'an alert box throws away what the member typed; these forms do not');
  ok('and a fine picks the member off the roster',
     /id="svFnWho"/.test(CORE) && /<select/.test(CORE.slice(CORE.indexOf('async function levyStokvelFine'))),
     'typing a name could not tell two members called Thandi apart');
}

console.log('\nand a notification opens the thing it is about');
{
  const SW_WEB = read('portal/sw.js');
  const SW_APP = read('mobile/src/sw.js');
  for (const [name, sw] of [['the web', SW_WEB], ['the app', SW_APP]]) {
    /* FOCUS ALONE THREW THE URL AWAY. An open portal tab was brought to the
       front and the notification's destination discarded, so a deep link
       did nothing for anybody who already had the portal open \u2014 which is
       most people, most of the time. */
    const handler = sw.slice(sw.indexOf("notificationclick"));
    ok(`${name} service worker tells the page where to go`,
       /postMessage\(\{\s*type: 'svc-open'/.test(handler),
       'focusing an open tab and dropping the url is why deep links appeared not to work');
    ok(`${name} still opens a window when none is there`,
       /openWindow\(url\)/.test(handler));
  }

  const NATIVE = read('mobile/src/js/native.js');
  ok('the app reads the same url the browser does',
     /data\.url/.test(NATIVE) && /svcOpenDeepLink/.test(NATIVE),
     'one value decides where a notification points, on both channels');

  const router = CORE.slice(CORE.indexOf('async function svcOpenDeepLink'),
                            CORE.indexOf('function svcInitDeepLinks'));
  ok('the portal clears the link once it has acted on it',
     /history\.replaceState/.test(router),
     'otherwise a refresh reopens the hub over whatever the member moved on to');
  ok('and refuses a stokvel that is not theirs',
     /not one of yours/.test(router),
     'rather than an empty modal or a spinner that never resolves');
  ok('boot asks for it last', /svcInitDeepLinks\(\)/.test(read('portal/js/portal.js'))
     && /svcInitDeepLinks\(\)/.test(read('mobile/src/js/portal.js')),
     'the data it needs has to have loaded');
}

console.log('\nand voting is offered only to signatories');
{
  ok('the buttons are behind the signatory flag',
     /meIsSignatory \?/.test(CORE));
  ok('but the list itself is not',
     /_svWithdrawals\(requests, meIsSignatory/.test(CORE)
     && !/meIsSignatory[\s\S]{0,80}return ''/.test(CORE),
     'knowing what is being asked for is the point');
}

/* The product is called a GROUP on screen, and the older word is kept in the
   copy rather than deleted.

   Both halves matter. "Stokvel" is one tradition among several — umgalelo,
   gooi-gooi, motshelo, mohodisano, society — so a label that names only one
   of them turns the others away; which is why nothing a member reads calls
   the feature by that one name any more. But it is also the term 11.5m
   people search for, so it stays in the descriptive copy and on the public
   page. Deleting it everywhere would be the other mistake. */
console.log('\nand it is called a group, without losing the word people search for');
{
  const PORTAL_HTML = read('portal/index.html');
  const MOBILE_HTML = read('mobile/src/index.html');
  const pages = [['web', PORTAL_HTML], ['mobile', MOBILE_HTML]];

  for (const [which, PAGE] of pages) {
    const tile = PAGE.slice(PAGE.indexOf('sa-type-showcase'),
                            PAGE.indexOf('subacctsGrid'));
    ok(`${which}: the type on offer is a group, in full`,
       /Investment &amp; Savings Group/.test(PAGE),
       'the full descriptor is what tells somebody this is for their committee');
    ok(`${which}: and the picker still names the traditions it covers`,
       /stokvel, umgalelo, motshelo, society/.test(PAGE),
       'the one search term 11.5m people type cannot be dropped from the copy');
    ok(`${which}: the showcase tile is not labelled with one tradition`,
       !/sa-type-tile__label">Stokvel</.test(tile),
       'a Xhosa umgalelo reading that tile is being told this is not for them');
  }

  ok('the switcher heading is the member’s groups',
     /My groups/.test(CORE) && !/My stokvels/.test(CORE));
  ok('a card says what kind of account it is, in the new word',
     /sa-card__type[^`]{0,60}> Group</.test(CORE));
  ok('and the workspace tabs are a group’s sections',
     /aria-label="Group sections"/.test(CORE));

  /* Messages, not just labels. A screen renamed while every error it raises
     keeps the old word is a half-done rename the member sees. */
  const MANDATE = read('server/services/stokvelMandate.js');
  const INVITES = read('server/services/stokvelInvites.js');
  ok('the mandate refuses in the same vocabulary the screen uses',
     /A group investment needs an approved authority/.test(MANDATE)
     && /A group withdrawal needs an approved authority/.test(MANDATE));
  ok('and so does the invitation that is turned away',
     /already a member of this group/.test(INVITES));

  /* The public page is the search-term asset and is deliberately NOT
     renamed. check-stokvel-public.cjs owns its content; this only holds the
     decision in place, so a later sweep of the word does not take it. */
  ok('the marketing page keeps the word people search for',
     /stokvel/i.test(read('stokvels.html')),
     'renaming this page is giving up the one term this market types');
}

/* ── Measured ───────────────────────────────────────────────────── */
const CHROME = require('../../scripts/lib/chromium.cjs').findChromium();

if (!CHROME) {
  console.log('\n  SKIP  no chromium under /opt/pw-browsers — the measured half did not run');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* The hub's render path, exercised against stubbed answers. Loading the whole
   portal would drag in a session, a service worker and thirty other fetches;
   what is being checked is that these four payloads become that screen. */
const STUB = {
  'stokvels/SA-1': { data: { id: 'SA-1', name: 'Ubuntu <b>Club</b>', wallet_balance: 12500,
                             stokvel_quorum: 2,
                             total_invested: 0, my_role: 'treasurer' } },
  'stokvels/SA-1/members': { data: [
    { id: 'm1', investor_id: 'I1', first_name: 'Ann', last_name: 'M', role: 'chairperson',
      is_signatory: true, status: 'active', is_me: false },
    { id: 'm2', investor_id: 'I2', first_name: '<img src=x onerror=\"window.__xssFired=1\">', last_name: '',
      role: 'member', is_signatory: false, status: 'active', is_me: true },
  ] },
  'stokvels/SA-1/contributions': {
    data: [{ id: 'c1', investor_id: 'I2', period_label: '2026-11', amount_due: '500.00',
             amount_paid: '0.00', due_date: '2026-11-25', status: 'due', is_me: true, overdue: true }],
    arrears: [{ investor_id: 'I2', name: 'Ben', owed: 500, periods: 1 }] },
  'stokvels/SA-1/withdrawal-requests': { data: [
    { id: 'r1', kind: 'withdrawal', amount: 2000, bank_name: 'FNB',
      reason: 'Funeral <img src=y onerror=\"window.__xssFired=1\">',
      status: 'pending', requested_by_name: 'Ann', approvals: 1, required: 2,
      satisfied: false, blocked_because: '1 of 2 signatory approvals.',
      votes: [
        { investor_id: 'I1', name: 'Ann M', decision: 'approve', at: '2026-11-01', counts: true, is_me: false },
        { investor_id: 'I7', name: 'Old <b>Member</b>', decision: 'approve', at: '2026-10-02', counts: false, is_me: false },
      ] },
    /* The second kind, in the same list. A row that reads only "R5000.00 ·
       Ann" asks a signatory to approve a sum with no idea where it goes. */
    { id: 'r2', kind: 'investment', amount: 5000, pool_id: 'POOL-CATTLE-11',
      pool_name: 'Cattle November', reason: 'Group savings',
      status: 'pending', requested_by_name: 'Ann', approvals: 1, required: 2,
      satisfied: false, blocked_because: '1 of 2 signatory approvals.' },
    /* An exit that the signatories have already carried: it names the person
       leaving, not an account, and somebody has to be able to act on it. */
    { id: 'r3', kind: 'exit', amount: 4100, exit_investor_id: 'I9', exit_name: 'Sipho',
      status: 'pending', requested_by_name: 'Sipho', approvals: 2, required: 2,
      satisfied: true },
    /* A payout the signatories have carried: it names the distribution, not
       a destination, and somebody has to be able to run it. */
    { id: 'r4', kind: 'payout', amount: 12500, payout_id: 'SPO-1',
      payout_label: 'December 2026', status: 'pending', requested_by_name: 'Ann',
      approvals: 2, required: 2, satisfied: true } ] },
  'stokvels/SA-1/payouts': { can_plan: true, my_share_now: 4100, data: [
    { id: 'SPO-1', label: 'December 2026', pay_on: '2026-12-01', status: 'planned',
      authority_id: null, members: 0, my_line: null },
    { id: 'SPO-0', label: 'December 2025', pay_on: '2025-12-01', status: 'paid',
      authority_id: 'SWR-OLD', members: 2, my_line: { paid: 3200, net: 3200, arrears: 0, share: 3200 } },
  ] },
  'stokvels/SA-1/shares': { data: {
    basis: 'contribution', net_assets: 12500, wallet: 10500, invested: 2000,
    owed_to_former_members: 400, my_share: 4100,
    shares: [
      { investor_id: 'I1', first_name: 'Ann', last_name: 'M', is_me: false, share: 8000, gross: 8000, arrears: 0 },
      { investor_id: 'I2', first_name: 'Zo', last_name: '', is_me: true, share: 4100, gross: 4600, arrears: 500 },
    ],
    exit_debts: [{ first_name: 'Sipho', owed: 400 }],
  } },
  'stokvels/SA-1/investments': { totals: { active: 2000, all: 2000, returns: 140 }, data: [
    { id: 'INVST-1', pool_name: 'Cattle November', amount: 2000, status: 'active',
      annual_rate: 0.14, term_months: 18, maturity_date: '2027-09-01' },
  ] },
  'stokvels/SA-1/transactions': { wallet: 10500, data: [
    { id: 't1', type: 'stokvel_contribution_received', amount: 500, description: 'Contribution received',
      at: '2026-11-01', cash_effect: 500, running_balance: 10500 },
    { id: 't2', type: 'fee', amount: 20, description: '1% platform fee', at: '2026-10-28',
      cash_effect: -20, running_balance: 10000 },
  ] },
  'stokvels/SA-1/invites': { can_invite: true, data: [
    { id: 'SVI-9', invitee_name: 'Thabo', contact: 't***@example.test',
      status: 'pending', already_on_the_platform: false,
      invited_by_name: 'Ann', expires_at: '2030-01-01T00:00:00.000Z' } ] },
};

(async () => {
  const port = 9470;
  /* detached, so the kill below reaches the whole process group. Chromium
     forks a zygote, a GPU process and a renderer; killing only the launcher
     leaves those running, and a suite that starts five browsers leaves five
     sets behind. Fourteen of them accumulated during one mutation run and
     starved the box until the next browser could not start inside its
     timeout — which presents as a check that has stopped measuring. */
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', detached: true });
  /* Browser.close asks Chromium to shut itself down, which is the only
     thing that reliably reaps it: --headless=new starts a browser process
     that puts itself in its own session, so killing the launcher's process
     group leaves the renderers running. Twelve survived every run until
     this was added, and a suite that starts five browsers leaves sixty
     behind — which eventually starves the box and presents as a check that
     has stopped measuring rather than one that failed. The group kill stays
     as the fallback for a browser too wedged to answer. */
  const stop = async () => { /* Awaited. Sending it and exiting immediately kills the process
       before the socket flushes, so the browser never hears it — which
       is how twelve of them survived a run that looked clean. */
    try { await Promise.race([send('Browser.close'),
                              new Promise(r => setTimeout(r, 1500))]); } catch (_) {}
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { try { proc.kill('SIGKILL'); } catch (_) {} } };
  const devtools = p => new Promise((res, rej) =>
    http.get({ host: '127.0.0.1', port, path: p }, r => {
      let s = ''; r.on('data', c => s += c); r.on('end', () => res(JSON.parse(s)));
    }).on('error', rej));

  try {
    let tabs;
    const startedAt = Date.now();
    for (let i = 0; i < 60 && !tabs; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { tabs = await devtools('/json/list'); } catch (_) {}
      if (proc.exitCode !== null) break;
    }
    if (!tabs) { ok('the browser started', false, `devtools never answered in ${Date.now() - startedAt}ms`); await stop(); return; }

    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = ev => { const d = JSON.parse(ev.data);
      if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params) => new Promise(r => {
      const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    await send('Page.enable');
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 300));
      }
      return r.result.result.value;
    };

    /* A render is the only thing that catches a layout no assertion can see:
       a grid class that does not exist draws as one unstyled column and
       every text assertion still passes. Off unless asked for:
         SVC_SHOT=/tmp/shots node server/scripts/check-stokvel-screens.cjs */
    const SHOT = process.env.SVC_SHOT;
    const shot = async (name, width, height) => {
      if (!SHOT) return;
      await send('Emulation.setDeviceMetricsOverride', {
        width: width || 1100, height: height || 1500,
        deviceScaleFactor: 1, mobile: (width || 1100) < 500 });
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const data = r.result && r.result.data;
      if (!data) return;
      fs.mkdirSync(SHOT, { recursive: true });
      const out = path.join(SHOT, name + '.png');
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      console.log(`  shot  ${out}`);
    };

    /* The page: the hub's own functions, the few helpers they lean on, and
       the two elements the modal writes into. */
    const harness = `
      window.PORTAL = { subAccounts: [], stokvels: [], pools: [
        { id: 'POOL-CATTLE-11', name: 'Cattle November', status: 'open',
          annual_rate: 0.14, term_months: 18, min_investment: 1000 },
        { id: 'POOL-SHUT', name: 'Closed pool', status: 'closed',
          annual_rate: 0.14, term_months: 18, min_investment: 1000 },
      ] };
      /* Both live elsewhere in portal-core, outside the slice loaded below. */
      window._poolPastClose = () => false;
      window.svcWalletSpend = a => Math.round(Number(a) * 101) / 100;
      window.SA_TYPE_META = { stokvel: { icon:'fa-people-group', label:'Stokvel', color:'#22c55e', bg:'#064e1e' } };
      window._esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      /* toast IS NOT STUBBED HERE, deliberately, and must never be again.
         This harness used to carry a do-nothing toast, and js/portal-core.js
         called Utils.toast in 53 places. Utils has no toast member and never
         has — so every one of those threw in a real browser while this check
         passed, because the single thing that was broken was the single thing
         the harness supplied. A member pressed "Send the invitation", the
         invitation was sent, the throw landed between the toast and the
         re-render, and the screen never moved.

         That is the second time in this repo a stand-in has hidden exactly the
         call it stood in for (the fund console's fmt was the first). The
         rule it leaves behind: supply the real thing, or supply nothing.

         Utils.rand is still a stand-in and should not be — several assertions
         below read its output and expect toFixed(2) rather than the South
         African format the product uses. Noted rather than changed here: it is
         a separate repair with its own assertions to rewrite. */
      window.Utils = { rand: v => 'R' + Number(v || 0).toFixed(2) };
      /* The REAL Toast, lifted whole out of js/api.js. */
      ${TOAST_SRC}
      window.Modal = { open: () => {}, close: () => {} };
      window.API = { _fetch: async (m, p) => {
        const stub = ${JSON.stringify(STUB)};
        if (stub[p]) return stub[p];
        throw new Error('unexpected ' + p);
      } };
      /* The workspace, not a modal. A stokvel is now a view of its own
         with its own sections; the old saDetail* elements are kept so the
         few helpers that still close the sub-account modal find something. */
      /* The portal's own stylesheets, inlined, so a screenshot taken with
         SVC_SHOT shows what a member would see rather than unstyled text.
         The assertions read textContent and innerHTML, so this changes
         nothing they measure \u2014 it only makes a render worth looking at. */
      document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<style>' + ${JSON.stringify(
        ['css/admin.css', 'portal/css/portal.css', 'css/ci-theme.css',
         'portal/css/portal-premium.css']
          .filter(f => fs.existsSync(path.join(ROOT, f)))
          .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'))
      } + '</style>';
      document.body.innerHTML = '<div id="saDetailTitle"></div><div id="saDetailBody"></div>'
        /* Wrapped the way portal/index.html wraps it \u2014 page-content and an
           active .view \u2014 so a screenshot has the gutters and the widths
           the member's screen has, not the bare edges of about:blank. */
        + '<main class="page-content"><div class="view active" id="view-stokvel">'
        + '<div id="svWsHeader"></div><div id="svWsTabs"></div><div id="svWsBody"></div>'
        + '</div></main>'
        + '<div id="svSwitcher"></div>';
      window.navigate = () => {};
    `;
    const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
    /* Only the stokvel section; the rest of portal-core expects a session. */
    const section = core.slice(core.indexOf('async function loadStokvels'));

    await evaluate(`(() => { ${harness} })()`);
    await send('Runtime.evaluate', { expression: section });
    await evaluate(`openStokvelHub('SA-1')`);
    await new Promise(r => setTimeout(r, 400));

    /* The overview on its own — the section a member lands on. */
    const overview = await evaluate(`(() => {
      const b = document.getElementById('svWsBody');
      return { html: b.innerHTML, text: b.textContent,
               header: document.getElementById('svWsHeader').textContent,
               tabs: document.getElementById('svWsTabs').textContent };
    })()`);

    /* And every section, concatenated. The assertions below are about what
       a member CAN SEE, which has not changed — only which section it is
       in — so they read the union, and the tab-specific claims are made
       separately above and below. */
    const rendered = await evaluate(`(async () => {
      let html = '', text = '';
      for (const [key] of _svTabList()) {
        svWorkspaceTab('SA-1', key);
        await new Promise(r => setTimeout(r, 60));
        const b = document.getElementById('svWsBody');
        html += b.innerHTML; text += ' ' + b.textContent;
      }
      return { html, text,
               title: document.getElementById('svWsHeader').textContent };
    })()`);

    console.log('\nthe workspace opens on the group');
    ok('the group is named in the header', /Ubuntu/.test(overview.header), overview.header);
    ok('with the pot and the member\u2019s own share',
       /The pot/.test(overview.header) && /Your share/.test(overview.header),
       overview.header.slice(0, 160));
    ok('and a way back to their own account',
       /My account/.test(overview.header),
       'somebody who switches in and cannot see how to leave will not switch in again');
    /* ── Five tabs, not eleven, and every section still reachable ──── */
    const nav = await evaluate(`(async () => {
      const tabNames = () => [...document.querySelectorAll('#svWsTablist [role=tab]')]
        .map(b => b.textContent.trim());
      const out = { shown: tabNames(), reached: {}, revealed: {} };
      for (const key of ${JSON.stringify(_svSectionsAll)}) {
        await svWorkspaceTab('SA-1', key);
        const body = document.getElementById('svWsBody');
        out.reached[key] = (body.textContent || '').trim().length > 20
          && !!document.getElementById('svSec-' + key);
        /* Navigating to a section must put its tab in the bar, or somebody
           sent there by a checklist or a notification has no way back to it. */
        out.revealed[key] = tabNames().length >= out.shown.length;
      }
      out.after = tabNames();
      await svWorkspaceTab('SA-1', 'overview');
      return out;
    })()`);

    ok('the bar holds a handful of tabs, not one per section',
       nav.shown.length > 0 && nav.shown.length <= 5,
       `${nav.shown.length}: ${nav.shown.join(' | ')} — eleven is the screen this replaced`);
    ok('and every one of them is a real tab name',
       nav.shown.every(t => /Overview|People|Money|Decisions|Records/.test(t)),
       nav.shown.join(' | '));
    /* The intent the old assertion carried: nothing became unreachable. */
    const unreachable = _svSectionsAll.filter(k => !nav.reached[k]);
    ok('EVERY SECTION IS STILL REACHABLE',
       unreachable.length === 0,
       `could not reach: ${unreachable.join(', ')} — a tab hidden from the bar `
       + 'must still be somewhere a checklist or a notification can send somebody');
    ok('and reaching one never shrinks the bar under them',
       _svSectionsAll.every(k => nav.revealed[k]),
       JSON.stringify(nav.revealed));

    /* A tab holds SEVERAL sections stacked. Opening one must draw them all,
       or the five tabs have simply lost nine sections. */
    const stacked = await evaluate(`(async () => {
      await svWorkspaceTab('SA-1', 'contributions');
      const ids = [...document.querySelectorAll('[id^="svSec-"]')].map(e => e.id);
      await svWorkspaceTab('SA-1', 'overview');
      return ids;
    })()`);
    ok('opening a tab draws every section under it, not just the first',
       ['contributions', 'shares', 'investments', 'payouts', 'transactions', 'statement']
         .every(k => stacked.includes('svSec-' + k)),
       JSON.stringify(stacked));

    /* ── A BRAND-NEW GROUP ──────────────────────────────────────────
       The stubbed group has R12 500 and a roster, so every tab is earned.
       The screen that was reported as confusing is the OTHER one: a group
       created a minute ago. Without this scenario the visibility rules are
       never exercised, and "show tabs only when they mean something" can be
       deleted without a single assertion noticing. */
    const fresh = await evaluate(`(async () => {
      const real = API._fetch;
      const G = 'SA-FRESH';
      const empty = { data: [] };
      API._fetch = async (m, p) => {
        const k = String(p).split('?')[0];
        if (k === 'stokvels/' + G) return { data: { id: G, name: 'Brand New Club',
          wallet_balance: 0, total_invested: 0, my_role: 'chairperson', i_opened_it: true,
          kyc_status: 'pending', mandate_state: { has_mandate: false, quorum: null,
            signatories: 0, short_by: null }, setup: { verification: 'pending', schedule: null } } };
        if (k.indexOf('stokvels/' + G) === 0) return k.slice(-6) === 'shares'
          ? { data: { net_assets: 0, wallet: 0, invested: 0, my_share: 0, basis: 'contribution' } }
          : empty;
        return real(m, p);
      };
      const names = () => [...document.querySelectorAll('#svWsTablist [role=tab]')]
        .map(b => b.textContent.trim());
      if (typeof window !== 'undefined') window.__svRevealed = {};
      await _svRenderHub(G, 'overview');
      const atStart = names();
      /* A section inside a tab this group has NOT grown into. */
      await svWorkspaceTab(G, 'shares');
      const afterNav = names();
      const drew = !!document.getElementById('svSec-shares');
      API._fetch = real;
      if (typeof window !== 'undefined') window.__svRevealed = {};
      return { atStart, afterNav, drew };
    })()`);

    ok('a brand-new group opens on a handful of tabs, not eleven',
       fresh.atStart.length <= 3,
       `${fresh.atStart.length}: ${fresh.atStart.join(' | ')}`);
    ok('and is not offered Money before it has any',
       !fresh.atStart.some(t => /Money/.test(t)),
       fresh.atStart.join(' | '));
    ok('nor Decisions before anybody can make one',
       !fresh.atStart.some(t => /Decisions/.test(t)),
       fresh.atStart.join(' | '));
    /* Hidden must mean "not worth a tab yet", never "shut". */
    ok('but a hidden section still opens when something sends them there',
       fresh.drew === true, 'a checklist action or a notification must land somewhere');
    ok('AND ITS TAB APPEARS, so it does not vanish under them',
       fresh.afterNav.some(t => /Money/.test(t)),
       `${fresh.atStart.join(' | ')}  →  ${fresh.afterNav.join(' | ')}`);

    /* ── The way out has to be visible ─────────────────────────────
       btn--ghost is not defined in the portal's stylesheets, so the back
       button fell back to .btn's pale background and drew white text on
       near-white inside the group's green banner. The one control somebody
       needs when they feel lost was the one they could not see. Measured
       off the rendered button, not read off the source. */
    const backBtn = await evaluate(`(() => {
      const b = [...document.querySelectorAll('#svWsHeader button')]
        .find(x => /My account/.test(x.textContent));
      if (!b) return { missing: true };
      const cs = getComputedStyle(b);
      const lum = c => {
        const m = String(c).match(/[\\d.]+/g) || [0, 0, 0];
        const [r, g, bl] = m.slice(0, 3).map(v => {
          const s = Number(v) / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      /* Against what is actually painted behind it. */
      let bg = cs.backgroundColor, el = b;
      while ((!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && el.parentElement) {
        el = el.parentElement; bg = getComputedStyle(el).backgroundColor;
      }
      const a = lum(cs.color), c = lum(bg);
      return { ratio: (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05),
               color: cs.color, bg };
    })()`);
    ok('the way back out of a group is legible against what is behind it',
       !backBtn.missing && backBtn.ratio >= 4.5,
       `contrast ${backBtn.ratio && backBtn.ratio.toFixed(2)} of ${backBtn.color} on ${backBtn.bg} `
       + '— somebody who switches in and cannot see how to leave will not switch in again');
    ok('it lands on the overview, not a blank body', overview.text.trim().length > 40,
       overview.text.slice(0, 120));
    ok('and shows what this member owes', /You owe/.test(overview.text),
       overview.text.slice(0, 220));
    /* The stubbed member is NOT a signatory, so a count of votes is news
       rather than a task and must not be there. Both directions are
       checked, because an OR across the two tiles let either be deleted
       and still pass. */
    ok('and no vote count for a member who cannot vote',
       !/Waiting on you/.test(overview.text),
       'a request they have no say in is not something waiting on them');

    const asSignatory = await evaluate(`(async () => {
      const real = window.API._fetch;
      window.API._fetch = async (m, p) => {
        const r = await real(m, p);
        if (p.endsWith('/members')) {
          return { data: r.data.map(x => x.is_me ? { ...x, is_signatory: true } : x) };
        }
        return r;
      };
      await _svRenderHub('SA-1', 'overview');
      const t = document.getElementById('svWsBody').textContent;
      window.API._fetch = real;
      return t;
    })()`);
    ok('but a signatory with an outstanding vote is led with it',
       /Waiting on you/.test(asSignatory), asSignatory.slice(0, 220));

    console.log('\nthe hub renders');
    ok('the stokvel is named in the title', /Ubuntu/.test(rendered.title), rendered.title);
    ok('the group wallet is shown', /R12500\.00/.test(rendered.text), rendered.text.slice(0, 120));
    ok('the member’s own arrears come first', /You owe/.test(rendered.text));
    ok('with a pay button for the outstanding amount', /Pay R500\.00/.test(rendered.text));
    ok('everybody’s arrears are listed', /Who is behind/.test(rendered.text) && /Ben/.test(rendered.text),
       'the argument this ends is "I paid and you did not"');
    ok('the pending request is shown with its tally', /1 of 2/.test(rendered.text));
    ok('and the roster', /Ann/.test(rendered.text) && /Chairperson/.test(rendered.text));

    console.log('\nand the sections that are new');
    {
      const sect = async key => {
        await evaluate(`svWorkspaceTab('SA-1','${key}')`);
        await new Promise(r => setTimeout(r, 80));
        return evaluate(`(() => { const b = document.getElementById('svWsBody');
          return { html: b.innerHTML, text: b.textContent }; })()`);
      };

      const inv = await sect('investments');
      ok('the holdings name the pool and what matures when',
         /Cattle November/.test(inv.text) && /2027-09-01/.test(inv.text), inv.text.slice(0, 160));
      ok('with what is invested now', /R2000\.00/.test(inv.text), inv.text.slice(0, 160));

      const txn = await sect('transactions');
      ok('the ledger shows movements with a running balance',
         /Contribution received/.test(txn.text) && /R10500\.00/.test(txn.text),
         txn.text.slice(0, 200));
      ok('and a fee reads as money going out',
         /\u2212R20\.00|-R20\.00/.test(txn.text), txn.text.slice(0, 200));

      const st = await sect('statement');
      ok('the statement section asks for a period and builds one',
         /svStFrom/.test(st.html) && /Build it/.test(st.text));
      ok('and says what the document is for',
         /AGM/.test(st.text), 'a committee needs to know why they would produce it');

      /* Back to the overview, which is where the assertions below expect to
         be able to start from. */
      await evaluate(`svWorkspaceTab('SA-1','overview')`);
      await new Promise(r => setTimeout(r, 80));
    }

    console.log('\nand nothing a member typed became markup');
    /* The group's name lives in the workspace HEADER now, not in a section
       body, so the escaping claim is made where the name actually is. */
    ok('a stokvel name with tags is text, not HTML',
       !/<b>Club<\/b>/.test(overview.html) && !/<b>Club<\/b>/.test(rendered.html)
       && /Ubuntu/.test(rendered.title),
       rendered.title);
    ok('an image-onerror name is inert',
       !/<img src=x/.test(rendered.html) && /onerror/.test(rendered.text),
       'the roster is other people’s names rendered into innerHTML');
    ok('and the same in a request reason',
       !/<img src=y/.test(rendered.html) && /Funeral/.test(rendered.text));

    /* The assertion that does not depend on guessing the payload's shape:
       did anything injected actually RUN. The fixtures set a flag rather
       than calling alert(), which is what the first draft used — and an
       alert() with nobody to dismiss it blocks the renderer, so the check
       proving the escaping mattered hung on proving it. */
    const fired = await evaluate(`!!window.__xssFired`);
    ok('nothing a member typed executed', fired === false,
       'a value from the roster ran as script');

    console.log('\nand the group can see who agreed to what');
    ok('the register names who voted',
       /Ann M/.test(rendered.text),
       'members saw "2 of 3" and never which two \u2014 for a product whose claim is that '
       + 'several NAMED people must agree, that is the wrong way round');
    ok('a vote that no longer counts says so',
       /no longer a signatory/.test(rendered.text),
       'otherwise the tally looks wrong to anybody adding the names up');
    ok('and a name in the register is escaped like any other',
       !/<b>Member<\/b>/.test(rendered.html), rendered.html.slice(0, 200));

    console.log('\nand the payout the group has decided on');
    ok('the planned payout is named with its date',
       /December 2026/.test(rendered.text) && /2026-12-01/.test(rendered.text),
       rendered.text.slice(0, 200));
    ok('with the member\u2019s OWN figure, not the group total',
       /R4100\.00/.test(rendered.text) && /would receive/i.test(rendered.text),
       'a member reading what the group distributed has to do their own arithmetic');
    ok('it says the figure moves and arrears come off',
       /owe/i.test(rendered.text) && /moves with/i.test(rendered.text));
    ok('and that nobody leaves',
       /Nobody leaves/i.test(rendered.text),
       'a distribution is not a closure, and that is the first thing a member will ask');
    ok('it still needs the signatories',
       /signatories/i.test(rendered.text));
    ok('and what was paid last time is shown',
       /December 2025/.test(rendered.text) && /R3200\.00/.test(rendered.text),
       '"what did I get in December" has to keep answering the same thing');

    console.log('\nand a member can see what their share is');
    ok('their own share is on the header',
       /Your share/.test(rendered.text) && /R4100\.00/.test(rendered.text),
       rendered.text.slice(0, 200));
    ok('and everybody else’s is listed',
       /R8000\.00/.test(rendered.text) && /Ann/.test(rendered.text),
       'a share only its owner can see is a treasurer’s spreadsheet with extra steps');
    ok('the pot is broken down so the arithmetic can be checked',
       /In the wallet/.test(rendered.text) && /R10500\.00/.test(rendered.text)
       && /R2000\.00/.test(rendered.text),
       'a member doing the sum and finding it comes out is the point');
    ok('what is owed to a member who left is shown as coming off it',
       /Owed to members who have left/.test(rendered.text) && /Sipho/.test(rendered.text),
       rendered.text.slice(0, 300));
    ok('arrears are shown against the member who owes them',
       /owes R500\.00/.test(rendered.text));
    ok('and there is a way to ask to leave',
       /Ask to leave/.test(rendered.text));

    console.log('\nand both kinds of request read as what they are');
    ok('the withdrawal says so, with where it is going',
       /Withdraw/.test(rendered.text) && /FNB/.test(rendered.text));
    ok('the investment says so, and names the pool',
       /Invest/.test(rendered.text) && /Cattle November/.test(rendered.text),
       'a row showing only an amount asks a signatory to approve a sum with '
       + 'no idea where it goes');
    ok('an exit says whose membership ends, not a bank account',
       /Exit/.test(rendered.text) && /Sipho is leaving/.test(rendered.text),
       'a signatory being asked to approve "R4 100 to a bank account" cannot act on it');
    ok('a payout names the distribution, not a destination',
       /Payout/.test(rendered.text) && /everybody paid out/i.test(rendered.text),
       'what a signatory agrees to is that the whole group is paid');
    ok('and an approved one can be carried out',
       /Pay the group out/.test(rendered.text));
    ok('and an approved exit can be carried out',
       /Settle this exit/.test(rendered.text),
       'the approval is the control; somebody still has to press it');
    ok('and the panel is no longer called Withdrawals',
       /Signatory approvals/.test(rendered.text) && !/>Withdrawals</.test(rendered.html),
       'the mandate now governs investments too');

    console.log('\nand the investment request form');
    const form = await evaluate(`(() => {
      raiseStokvelInvestment('SA-1');
      const b = document.getElementById('svWsBody');
      const sel = document.getElementById('svInvPool');
      const out = { html: b.innerHTML, text: b.textContent,
                    inTheModal: document.getElementById('saDetailBody').innerHTML.length,
                    options: [...(sel ? sel.options : [])].map(o => o.value) };
      document.getElementById('svInvAmount').value = '1000';
      _svInvRecalc();
      out.atMinimum = document.getElementById('svInvNote').textContent;
      document.getElementById('svInvAmount').value = '400';
      _svInvRecalc();
      out.belowMinimum = document.getElementById('svInvNote').textContent;
      return out;
    })()`);
    ok('is rendered in the workspace, not the old modal',
       form.text.includes('Request an investment') && form.inTheModal === 0,
       'the stokvel modal is gone; a form drawn into it is a button that does '
       + 'nothing');
    ok('offers the open pools and only those',
       form.options.join(',') === 'POOL-CATTLE-11',
       form.options.join(','));
    ok('shows the rate, the term and the minimum on each',
       /14\.0%/.test(form.text) && /18 months/.test(form.text) && /R1000\.00/.test(form.text),
       'a member choosing where the group’s savings go needs to see them side by side');
    ok('says what the wallet actually pays once the 1% is on top',
       /R1010\.00/.test(form.atMinimum), form.atMinimum);
    ok('and refuses below the pool’s own minimum',
       /R1000\.00 or more/.test(form.belowMinimum) && !/R404/.test(form.belowMinimum),
       form.belowMinimum);

    const invErr = await evaluate(`(async () => {
      const note = () => (document.getElementById('svFormNote') || {}).textContent || '';
      const amt  = () => document.getElementById('svInvAmount');
      const sel  = () => document.getElementById('svInvPool');
      const out  = {};
      raiseStokvelInvestment('SA-1');
      sel().value = ''; await submitStokvelInvestment('SA-1'); out.noPool = note();
      raiseStokvelInvestment('SA-1');
      amt().value = '';  await submitStokvelInvestment('SA-1'); out.noAmount = note();
      amt().value = '400'; await submitStokvelInvestment('SA-1');
      out.tooLittle = document.getElementById('svInvNote').textContent;
      out.saidTwice = (document.getElementById('svWsBody').textContent
        .match(/or more/g) || []).length;
      out.typedKept = amt().value;
      return out;
    })()`);
    await shot('invest-form');
    await shot('invest-form-phone', 390, 844);
    ok('an unanswered question is said under the form',
       /Choose a pool/.test(invErr.noPool)
       && /how much should reach the pool/.test(invErr.noAmount)
       && /R1000\.00 or more/.test(invErr.tooLittle),
       JSON.stringify(invErr));
    ok('and said once, not twice',
       invErr.saidTwice === 1,
       'the live note and the submit error both saying the pool minimum '
       + 'reads as two problems; it is one');
    ok('and what was typed is still there to correct',
       invErr.typedKept === '400',
       'rerendering the form on a mistake throws away the rest of the answers');

    console.log('\nand the invitation form');
    const inv = await evaluate(`(() => {
      inviteToStokvel('SA-1');
      const b = document.getElementById('svWsBody');
      submitStokvelInvite('SA-1');
      return { text: b.textContent,
               fields: ['svInvName', 'svInvEmail', 'svInvCell']
                 .filter(i => document.getElementById(i)).length,
               inTheModal: document.getElementById('saDetailBody').innerHTML.length,
               note: (document.getElementById('svFormNote') || {}).textContent,
               typedKept: (document.getElementById('svInvName') || {}).value };
    })()`);
    await shot('invite-form');
    ok('is rendered in the workspace too',
       inv.text.includes('Invite someone to join') && inv.inTheModal === 0,
       'it was drawn into the modal the workspace replaced');
    ok('with a name, an email address and a cell number',
       inv.fields === 3, String(inv.fields));
    ok('and saying neither is an inline answer, not an alert',
       /email address or a cell number is needed/.test(inv.note || ''),
       inv.note || '(nothing said)');

    /* ── THE SUCCESS PATH ──────────────────────────────────────────
       Reported: "I click Send the invitation, it sends, but no message
       comes and it stays on this screen making you think it hasn't worked."

       It had been sent. submitStokvelInvite called Utils.toast, which does
       not exist, so the throw landed between the request returning and the
       re-render — the invitation was created and the form never moved.

       Only the REFUSAL path was covered here before: the form was submitted
       empty and the inline note asserted. A handler's happy path is the one
       a member actually walks, and it was the one nobody drove. */
    const sent = await evaluate(`(async () => {
      const real = window.API._fetch;
      let posted = null;
      window.API._fetch = async (m, p, body) => {
        if (m === 'POST' && /invites$/.test(p)) { posted = { p, body }; return { data: {} }; }
        return real(m, p, body);
      };
      inviteToStokvel('SA-1');
      document.getElementById('svInvName').value  = 'Ayanda';
      document.getElementById('svInvEmail').value = 'ayanda@svcapital.co.za';
      try { await submitStokvelInvite('SA-1'); }
      catch (e) { window.API._fetch = real; return { threw: String(e && e.message || e) }; }
      window.API._fetch = real;
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent);
      return {
        posted,
        toasts,
        /* Did the screen move? The form is gone once the members section has
           been drawn again. */
        formStillUp: !!document.getElementById('svInvEmail'),
        body: document.getElementById('svWsBody').textContent.slice(0, 200),
      };
    })()`);

    ok('the invitation is actually posted', !!sent.posted && !sent.threw,
       JSON.stringify(sent).slice(0, 300));
    ok('AND THE MEMBER IS TOLD', (sent.toasts || []).some(t => /Sent\./.test(t)),
       `toasts ${JSON.stringify(sent.toasts)} — this is the bug that was reported: `
       + 'the invitation went out and the screen said nothing');
    ok('and the form is replaced, so it does not look like it failed',
       sent.formStillUp === false,
       'sitting on a filled-in form after a successful send reads as a failure');
    ok('and nothing threw between the send and the re-render',
       !sent.threw, sent.threw || '');

    /* ── The invitation card ───────────────────────────────────────
       The one piece of UI in the whole invitation feature that cannot be
       allowed to be subtle: there is no link in a stokvel invitation, so
       this card IS the discovery mechanism. And it has to survive the empty
       state, because somebody invited before they have opened anything of
       their own has nothing else on the screen — the first draft of
       renderSubAccountsView would have sent them to "open your first
       sub-account" while an invitation sat unshown.

       A second slice of portal-core, which is safe to evaluate piecemeal
       because the file may declare no top-level state (check-portal-split
       enforces it), so a slice is only function declarations. */
    const gridSlice = core.slice(core.indexOf('function renderSubAccountsView'),
                                 core.indexOf('function openCreateSubAccountModal'));
    await send('Runtime.evaluate', { expression: gridSlice });
    const invited = await evaluate(`(() => {
      document.body.insertAdjacentHTML('beforeend',
        '<div id="subacctsGrid"></div><div id="subacctsEmpty" style="display:none"></div>' +
        '<span id="subacctsBadge"></span>');
      PORTAL.subAccounts = []; PORTAL.stokvels = [];
      PORTAL.stokvelInvites = [{ id: 'SVI-1', stokvel_name: 'Sizanani <b>Stokvel</b>',
        invited_by_name: 'Nomsa', active_members: 6 }];
      renderSubAccountsView();
      const g = document.getElementById('subacctsGrid');
      return { html: g.innerHTML, text: g.textContent,
               gridShown: g.style.display !== 'none',
               emptyShown: document.getElementById('subacctsEmpty').style.display !== 'none',
               badge: document.getElementById('subacctsBadge').textContent };
    })()`);
    ok('an invitation shows even with nothing else on the screen',
       invited.gridShown && !invited.emptyShown,
       `grid ${invited.gridShown}, empty ${invited.emptyShown} — being invited is not an empty state`);
    ok('it names the stokvel and who asked',
       /Sizanani/.test(invited.text) && /Nomsa/.test(invited.text), invited.text.slice(0, 160));
    ok('and offers both answers',
       />Accept</.test(invited.html.replace(/\s+/g, '')) || /Accept/.test(invited.text),
       'accepting is the invitee’s own act, and so is declining');
    ok('it says what joining means before they tap it',
       /ordinary member/.test(invited.text) && /signator/i.test(invited.text),
       'a group that can see your contributions is not a thing to join by accident');
    ok('the stokvel name is escaped here too',
       !/<b>Stokvel<\/b>/.test(invited.html), invited.html.slice(0, 200));
    ok('and it is counted in the badge', invited.badge === '1', invited.badge);

    /* ── The deep link, driven ────────────────────────────────────
       The source says the router clears the query and refuses a stranger's
       stokvel. This makes it do both. */
    const deep = await evaluate(`(async () => {
      const out = { navigated: [], replaced: 0, opened: null, toast: null };
      window.navigate = v => out.navigated.push(v);
      window.loadSubAccounts = async () => {};
      window.loadStokvelInvites = async () => {};
      /* Stubbed too: the real one refetches and would overwrite the roster
         this test just set, so the membership check saw an empty list. */
      window.loadStokvels = async () => PORTAL.stokvels;
      window.renderSubAccountsView = () => {};
      window.history.replaceState = () => { out.replaced++; };
      const realOpen = window.openStokvelHub;
      window.openStokvelHub = id => { out.opened = id; };
      /* Spies on the REAL Toast and passes the call through, rather than
         replacing it. A capture that swallows the call is a stand-in, and a
         stand-in on this exact function is what hid the invitation bug. */
      const realShow = window.Toast.show.bind(window.Toast);
      window.Toast.show = (m, t) => { out.toast = String(m); return realShow(m, t); };
      PORTAL.stokvels = [{ id: 'SA-1', name: 'Ubuntu' }];
      PORTAL.subAccounts = [];

      await svcOpenDeepLink('/portal/?stokvel=SA-1');
      const mine = { ...out };

      out.opened = null; out.toast = null;
      await svcOpenDeepLink('/portal/?stokvel=SA-NOT-MINE');
      const theirs = { opened: out.opened, toast: out.toast };

      out.navigated.length = 0;
      await svcOpenDeepLink('/portal/?view=subaccounts');
      const invited = { navigated: [...out.navigated] };

      const none = await svcOpenDeepLink('/portal/');
      window.openStokvelHub = realOpen;
      return { mine, theirs, invited, none };
    })()`);

    console.log('\nand the link a notification carries actually opens it');
    ok('a stokvel link opens that stokvel', deep.mine.opened === 'SA-1',
       JSON.stringify(deep.mine));
    ok('after going to the screen it lives on', deep.mine.navigated.includes('subaccounts'));
    ok('and the link is cleared once acted on', deep.mine.replaced > 0,
       'otherwise a refresh reopens the hub over whatever they moved on to');
    ok('a stokvel that is not theirs opens nothing',
       deep.theirs.opened === null && /not one of yours/i.test(deep.theirs.toast || ''),
       JSON.stringify(deep.theirs));
    ok('an invitation link goes to Sub-accounts without opening a hub',
       deep.invited.navigated.includes('subaccounts'), JSON.stringify(deep.invited));
    ok('and an ordinary visit is left alone', deep.none === false,
       'somebody who just opened the portal is not routed anywhere');

    /* Back to a section, so the assertions below read the workspace again. */
    await evaluate(`svWorkspaceTab('SA-1','approvals')`);
    await new Promise(r => setTimeout(r, 300));
    const back = await evaluate(`document.getElementById('svWsBody').innerHTML`);
    ok('cancelling the form puts the section back',
       /Signatory approvals/.test(back) && !/svInvPool/.test(back));

    console.log('\nand a non-signatory is shown the request without a vote');
    ok('no approve button for them',
       !/>Approve</.test(rendered.html),
       'the stubbed member is_me and is_signatory false');
    ok('but the request is on their screen', /Funeral/.test(rendered.text));

    ws.close();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await stop();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
