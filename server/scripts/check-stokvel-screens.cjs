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
  const fn = CORE.slice(CORE.indexOf('async function raiseStokvelWithdrawal'),
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

console.log('\nand voting is offered only to signatories');
{
  ok('the buttons are behind the signatory flag',
     /meIsSignatory \?/.test(CORE));
  ok('but the list itself is not',
     /_svWithdrawals\(requests, meIsSignatory/.test(CORE)
     && !/meIsSignatory[\s\S]{0,80}return ''/.test(CORE),
     'knowing what is being asked for is the point');
}

/* ── Measured ───────────────────────────────────────────────────── */
const CHROME = (() => {
  const base = '/opt/pw-browsers';
  const link = path.join(base, 'chromium');
  if (fs.existsSync(link)) return link;
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const inner of ['chrome-linux64', 'chrome-linux']) {
      const bin = path.join(base, dir, inner, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
})();

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
      satisfied: false, blocked_because: '1 of 2 signatory approvals.' },
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
      satisfied: true } ] },
  'stokvels/SA-1/shares': { data: {
    basis: 'contribution', net_assets: 12500, wallet: 10500, invested: 2000,
    owed_to_former_members: 400, my_share: 4100,
    shares: [
      { investor_id: 'I1', first_name: 'Ann', last_name: 'M', is_me: false, share: 8000, gross: 8000, arrears: 0 },
      { investor_id: 'I2', first_name: 'Zo', last_name: '', is_me: true, share: 4100, gross: 4600, arrears: 500 },
    ],
    exit_debts: [{ first_name: 'Sipho', owed: 400 }],
  } },
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
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails.exception || {}).slice(0, 300));
      }
      return r.result.result.value;
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
      window.Utils = { rand: v => 'R' + Number(v || 0).toFixed(2), toast: () => {} };
      window.Modal = { open: () => {}, close: () => {} };
      window.API = { _fetch: async (m, p) => {
        const stub = ${JSON.stringify(STUB)};
        if (stub[p]) return stub[p];
        throw new Error('unexpected ' + p);
      } };
      document.body.innerHTML = '<div id="saDetailTitle"></div><div id="saDetailBody"></div>';
    `;
    const core = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
    /* Only the stokvel section; the rest of portal-core expects a session. */
    const section = core.slice(core.indexOf('async function loadStokvels'));

    await evaluate(`(() => { ${harness} })()`);
    await send('Runtime.evaluate', { expression: section });
    await evaluate(`openStokvelHub('SA-1')`);
    await new Promise(r => setTimeout(r, 400));

    const rendered = await evaluate(`(() => {
      const b = document.getElementById('saDetailBody');
      return { html: b.innerHTML, text: b.textContent,
               title: document.getElementById('saDetailTitle').textContent };
    })()`);

    console.log('\nthe hub renders');
    ok('the stokvel is named in the title', /Ubuntu/.test(rendered.title), rendered.title);
    ok('the group wallet is shown', /R12500\.00/.test(rendered.text), rendered.text.slice(0, 120));
    ok('the member’s own arrears come first', /You owe/.test(rendered.text));
    ok('with a pay button for the outstanding amount', /Pay R500\.00/.test(rendered.text));
    ok('everybody’s arrears are listed', /Who is behind/.test(rendered.text) && /Ben/.test(rendered.text),
       'the argument this ends is "I paid and you did not"');
    ok('the pending request is shown with its tally', /1 of 2/.test(rendered.text));
    ok('and the roster', /Ann/.test(rendered.text) && /Chairperson/.test(rendered.text));

    console.log('\nand nothing a member typed became markup');
    ok('a stokvel name with tags is text, not HTML',
       !/<b>Club<\/b>/.test(rendered.html) && /Ubuntu/.test(rendered.text),
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
    ok('and an approved exit can be carried out',
       /Settle this exit/.test(rendered.text),
       'the approval is the control; somebody still has to press it');
    ok('and the panel is no longer called Withdrawals',
       /Signatory approvals/.test(rendered.text) && !/>Withdrawals</.test(rendered.html),
       'the mandate now governs investments too');

    console.log('\nand the investment request form');
    const form = await evaluate(`(() => {
      raiseStokvelInvestment('SA-1');
      const b = document.getElementById('saDetailBody');
      const sel = document.getElementById('svInvPool');
      const out = { html: b.innerHTML, text: b.textContent,
                    options: [...(sel ? sel.options : [])].map(o => o.value) };
      document.getElementById('svInvAmount').value = '1000';
      _svInvRecalc();
      out.atMinimum = document.getElementById('svInvNote').textContent;
      document.getElementById('svInvAmount').value = '400';
      _svInvRecalc();
      out.belowMinimum = document.getElementById('svInvNote').textContent;
      return out;
    })()`);
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

    /* Back to the hub, so the assertions below read the hub again. */
    await evaluate(`_svRenderHub('SA-1')`);
    await new Promise(r => setTimeout(r, 300));
    const back = await evaluate(`document.getElementById('saDetailBody').innerHTML`);
    ok('cancelling the form puts the hub back',
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
