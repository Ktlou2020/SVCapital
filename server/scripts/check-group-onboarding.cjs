#!/usr/bin/env node
/* Getting a group going, from the invitation to the first rand.
 *
 * Four places a group stalled, each now checked by rendering it:
 *
 *  · THE CHECKLIST was three steps, sent the mandate step to WhatsApp after
 *    founders could set it themselves, and never mentioned the contribution
 *    schedule or the group's documents — the two things only SV Capital can
 *    complete today, which a group found out about when a withdrawal was
 *    refused. It is now read off the group's real state, six steps, each
 *    saying who does it.
 *  · THE INVITATION told a person with no account to "sign in" and look on a
 *    "Sub-accounts screen". It now sends them to sign-up, and the SMS says
 *    the one thing that decides whether they ever see it: use THIS number.
 *  · THE CREATION FORM asked for a member count nothing read (2 to 200,
 *    against a limit of 50) and club contact details nothing used.
 *  · GROUPS were filed under More → My Accounts. They now have a menu entry,
 *    a screen, and a dashboard banner when an invitation is waiting.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-group-onboarding.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CORE = read('js/portal-core.js');

/* The shared core declares functions and nothing else, so it loads into a
   sandbox without running anything. */
function sandbox() {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', style: {} });
    return els.get(id);
  };
  const ctx = {
    window: {}, PORTAL: {}, location: { search: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [] },
    Utils: { rand: n => 'R' + Number(n || 0).toFixed(2) },
    encodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx);
  ctx._esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  ctx.el = el;
  return ctx;
}

/* A group at a given point in its setup. */
function group(over = {}) {
  return Object.assign({
    id: 'SA-ON-1', name: 'Kopanang Savings Club', my_role: 'chairperson', i_opened_it: true,
    stokvel_quorum: 2, wallet_balance: 0,
    mandate_state: { has_mandate: true, quorum: 2, signatories: 2, short_by: 0 },
    setup: { schedule: { amount: 500, cadence: 'monthly', due_day: 1 }, verification: 'approved' },
  }, over);
}
const members = n => ({ data: Array.from({ length: n }, (_, i) =>
  ({ status: 'active', is_signatory: i < 2, investor_id: 'M' + i })) });
const shares = pot => ({ data: { net_assets: pot, wallet: pot, invested: 0, my_share: pot / 2, basis: 'contribution' } });
const overview = (s, g, opts = {}) => s._svOverview('SA-ON-1', {
  g, members: opts.members || members(3), shareData: shares(opts.pot == null ? 1000 : opts.pot),
  payoutData: { data: [] }, contributions: { data: [], arrears: [] }, requests: { data: [] },
  mine: [], meIsSignatory: true });

console.log('\nthe checklist is the group’s real state');
{
  const s = sandbox();
  const fresh = group({ stokvel_quorum: null,
    mandate_state: { has_mandate: false, quorum: null, signatories: 0, short_by: null },
    setup: { schedule: null, verification: 'pending' } });
  const steps = s._svSetupSteps('SA-ON-1', { g: fresh, members: members(1) }, shares(0).data);
  ok('six steps, in the order a committee works through them',
     steps.map(x => x.key).join(',') === 'rules,members,signatories,schedule,documents,money',
     steps.map(x => x.key).join(','));
  ok('a brand-new group has done none of them', steps.every(x => !x.done));
  ok('the founder sets the rules in the app, not on WhatsApp',
     /svWorkspaceTab\('SA-ON-1','approvals'\)/.test(steps[0].action) && !/whatsapp/i.test(steps[0].action));
  const html = overview(s, fresh, { members: members(1), pot: 0 });
  ok('and the overview is the checklist, saying how many things are left',
     /Getting Kopanang Savings Club going/.test(html) && /6 things are/.test(html), html.slice(0, 300));

  const member = s._svSetupSteps('SA-ON-1', { g: Object.assign({}, fresh, { my_role: 'member', i_opened_it: false }),
    members: members(1) }, shares(0).data);
  ok('an ordinary member is told who does a step, and given no button for it',
     /chairperson, secretary or treasurer/.test(member[0].note) && !member[0].action);

  const half = s._svSetupSteps('SA-ON-1', { g: group({
    mandate_state: { has_mandate: true, quorum: 3, signatories: 1, short_by: 2 }, i_am_nominated: true }),
    members: members(4) }, shares(0).data);
  ok('it counts the signatures still missing',
     /1 of the 3 signatories needed have confirmed\. 2 more/.test(half[2].note), half[2].note);
  ok('and a nominee is offered the button to confirm', /Confirm I will sign/.test(half[2].action));
  const running = overview(s, group({ mandate_state: { has_mandate: true, quorum: 2, signatories: 1, short_by: 1 } }));
  ok('a group already running keeps its overview, with the missing step above it',
     /Your share/.test(running) && /Still to do/.test(running) && /Signatories confirm/.test(running)
     && !/Getting .* going/.test(running), running.slice(0, 300));
}

console.log('\nthe two steps only we can finish yet');
{
  const s = sandbox();
  const lagging = group({ setup: { schedule: null, verification: 'pending' } });
  const html = overview(s, lagging);
  ok('once the group works, they sit above the ordinary overview as still to do',
     /Still to do/.test(html) && /Your share/.test(html) && !/Getting .* going/.test(html));
  ok('the schedule step says we set it, and how to ask',
     /SV Capital sets this for you/.test(html) && /whatsapp/i.test(html));
  ok('the documents step says withdrawals wait for verification',
     /withdrawals open once the group is verified/.test(html));
  const reviewing = overview(s, group({ setup: { schedule: { amount: 500, due_day: 1 }, verification: 'under_review' } }));
  ok('documents being checked are said to be being checked, with no button to send them again',
     /are checking them/.test(reviewing) && !/Email the documents/.test(reviewing));
  const done = overview(s, group());
  ok('and a group with everything done sees no checklist at all',
     !/Still to do/.test(done) && !/going<\/div>/.test(done) && /Your share/.test(done));
  const older = overview(s, group({ mandate_state: undefined, setup: undefined, kyc_status: 'approved' }));
  ok('a group record from before mandate_state is judged on its quorum and roster',
     /Your share/.test(older) && !/Getting .* going/.test(older), older.slice(0, 200));
}

console.log('\ngroups have a place of their own');
{
  for (const page of ['portal/index.html', 'mobile/src/index.html']) {
    const h = read(page);
    ok(`${page}: My Groups is in the main menu, not under More`,
       /data-view="groups"[^>]*>\s*<i class="fa-solid fa-people-group"><\/i> My Groups/.test(h)
       && h.indexOf('data-view="groups"') < h.indexOf('id="navMoreSection"'));
    ok(`${page}: with a screen and a dashboard banner slot`,
       /id="view-groups"/.test(h) && /id="groupsBody"/.test(h)
       && h.indexOf('id="svInviteBanner"') > h.indexOf('id="view-overview"'));
  }
  const s = sandbox();
  s.PORTAL.stokvelInvites = [{ id: 'V1', stokvel_name: 'Letsema Club', invited_by_name: 'Thandi', mandate_line: '2 signatories must approve.' }];
  s.PORTAL.stokvels = [{ id: 'G1', name: 'Kopanang', my_role: 'treasurer', active_members: 9, wallet_balance: 4500, awaiting_my_vote: 1 }];
  s.PORTAL.subAccounts = [];
  s._svRenderGroupSurfaces();
  const view = s.el('groupsBody').innerHTML, banner = s.el('svInviteBanner').innerHTML;
  ok('the screen shows the invitation, with the group’s rules on it',
     /Waiting for your answer/.test(view) && /Letsema Club/.test(view) && /2 signatories must approve/.test(view));
  ok('and the groups, with what is waiting on this member',
     /Kopanang/.test(view) && /1 waiting on your approval/.test(view) && /openStokvelHub\('G1'\)/.test(view));
  ok('and a way to start one', /openCreateSubAccountModal\('stokvel'\)/.test(view));
  ok('the dashboard says who invited them to what',
     /Thandi invited you to join Letsema Club/.test(banner) && /navigate\('groups'/.test(banner));
  ok('and the menu badge counts it', s.el('navGroupsBadge').textContent === '1');

  s.PORTAL.stokvelInvites = []; s.PORTAL.stokvels = [];
  s._svRenderGroupSurfaces();
  ok('with nothing waiting, no banner', s.el('svInviteBanner').innerHTML === '');
  ok('and an empty screen explains how a person gets into a group',
     /not in a group yet/.test(s.el('groupsBody').innerHTML)
     && /email\s+address or cell number they used/.test(s.el('groupsBody').innerHTML));
  ok('groups load once at start-up, so the menu is right without visiting a screen',
     /function renderOverview\(skipCharts\) \{\n  _svBootGroups\(\);/.test(CORE)
     && /if \(window\.__SVGRPBOOT\) return;/.test(CORE));
  ok('a notification link to view=groups opens My Groups', /view === 'groups' \? 'groups'/.test(CORE));
}

console.log('\nthe invitation sends a new person to sign-up');
{
  const EMAIL = read('server/services/email.js'), SMS = read('server/services/sms.js');
  const NOTE = read('server/services/stokvelNotify.js');
  const noComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('no message talks about a Sub-accounts screen any more',
     !/Sub-accounts screen/.test(noComments(EMAIL + SMS + NOTE)));
  ok('the email’s button goes to sign-up for somebody with no account',
     /alreadyAUser \? `\$\{BASE_URL\}\/portal\/` : `\$\{BASE_URL\}\/signup\.html`/.test(EMAIL)
     && /Create my account/.test(EMAIL));
  ok('and tells them documents can wait', /You can upload your documents later/.test(EMAIL));
  ok('the SMS says to use THIS number, and where', /Sign up with THIS number/.test(SMS) && /\/signup/.test(SMS));
  ok('and knows whether they already have an account',
     /alreadyAUser: !!v\.matched_investor_id \}/.test(NOTE));
  ok('and still carries no join link', !/invites?\/\$\{/.test(EMAIL + SMS));
}

console.log('\nthe creation form asks only what the group decides');
{
  ok('no member count', !/saFieldMembers/.test(CORE) && !/member_count\s*=/.test(CORE));
  const stokvelForm = CORE.slice(CORE.indexOf("if (type === 'stokvel') return common"), CORE.indexOf('// Minor'));
  ok('no club email or phone', !/saFieldEmail|saFieldPhone/.test(stokvelForm));
  ok('and the 50-member limit is said where members are mentioned', /up to 50 members/.test(stokvelForm));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const http = require('http');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  let srv;
  try {
    const G = 'SA-ON-DB', P = 'INV-ON-';
    const clean = async () => {
      await db.query(`DELETE FROM stokvel_contribution_schedules WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [G]);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-ON-%'`);
    };
    await clean();
    await db.query(`INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
                    VALUES ($1,'Chair','On','chair-on@example.test','active',0)`, [P + 'CHAIR']);
    await db.query(`INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, kyc_status, status)
                    VALUES ($1,$2,'stokvel','Onboarding Club','under_review','active')`, [G, P + 'CHAIR']);
    await db.query(`INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
                    VALUES ('SM-ON-1',$1,$2,'chairperson',false,'active',NOW())`, [G, P + 'CHAIR']);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const tok = jwt.sign({ id: 'u-on', role: 'investor', investorId: P + 'CHAIR' }, process.env.JWT_SECRET);
    const get = p => new Promise(res => http.get({ port: srv.address().port, path: p,
      headers: { Authorization: 'Bearer ' + tok } }, x => { let b = ''; x.on('data', c => b += c);
      x.on('end', () => res({ status: x.statusCode, body: JSON.parse(b || '{}') })); }));

    console.log('\nthe server reports both steps');
    const before = await get(`/api/stokvels/${G}`);
    ok('a group with no schedule says so', before.status === 200
       && before.body.data.setup && before.body.data.setup.schedule === null, JSON.stringify(before.body.data && before.body.data.setup));
    ok('and reports its verification as it stands', before.body.data.setup.verification === 'under_review');
    await db.query(`INSERT INTO stokvel_contribution_schedules (id, sub_account_id, amount, due_day)
                    VALUES ('SCS-ON-1',$1,750,5)`, [G]);
    const after = await get(`/api/stokvels/${G}`);
    const sc = after.body.data.setup.schedule || {};
    ok('and the schedule once staff have set it', Number(sc.amount) === 750 && Number(sc.due_day) === 5,
       JSON.stringify(sc));
    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
