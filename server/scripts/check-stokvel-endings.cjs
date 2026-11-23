#!/usr/bin/env node
/* How a group ends — one member leaving, and the whole group winding up.
 *
 * DRIVEN IN A BROWSER AS FOUR PEOPLE and every one of these was found
 * there, because the pieces each had cover and the path through them had
 * none. check-stokvel-dissolve asserts the mandate service, the schema and
 * that the client functions exist — and never calls POST /:id/dissolve. The
 * one line that actually closes a group had never run.
 *
 * FOUR THINGS, in the order a committee meets them:
 *
 *  1. A WIND-UP COULD NOT BE ASKED FOR. The kind dispatch in
 *     withdrawal-requests handles mandate, notice_deposit, investment,
 *     payout and exit, and 'dissolve' fell through to the withdrawal
 *     branch — so it was refused with "the bank name and account number
 *     must be part of the request", about a decision that moves no money
 *     and has no destination. Everything else existed: the form, the
 *     permission gate, the approval, the button, the route behind it.
 *
 *  2. IT RENDERED AS "R 0,00 WITHDRAW". 'dissolve' was in neither the
 *     amount list nor the chip list, so the most irreversible decision a
 *     group can take reached the signatories as a zero-rand withdrawal.
 *
 *  3. CARRYING IT OUT THREW. The route ends every membership with
 *     status = 'ended' and the constraint allowed only
 *     invited/active/exited, so the UPDATE failed, the transaction rolled
 *     back, and a group whose signatories had agreed and whose members had
 *     been paid out was never closed. The error reached the log and
 *     nothing else.
 *
 *  4. AND A WOUND-UP GROUP SHOWED THE ONBOARDING CHECKLIST. Its pot is
 *     zero because the members were paid, its roster is empty because the
 *     memberships ended — which is exactly what a brand-new group looks
 *     like. The chairperson who had just closed a two-year-old stokvel was
 *     told to go and invite some members.
 *
 * Run: DATABASE_URL=… node server/scripts/check-stokvel-endings.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function portal() {
  const ctx = { window: {}, document: { getElementById: () => null },
                location: { search: '' },
                localStorage: { getItem: () => null, setItem() {} },
                sessionStorage: { getItem: () => null, setItem() {} },
                Utils: { rand: n => 'R ' + Number(n || 0).toFixed(2), date: d => String(d || '') },
                encodeURIComponent, console };
  vm.createContext(ctx);
  vm.runInContext(read('js/portal-core.js'), ctx);
  ctx._esc = v => String(v == null ? '' : v);
  ctx.PORTAL = { investor: { id: 'INV-1' }, transactions: [], stokvels: [], subAccounts: [], pools: [] };
  return ctx;
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
const sent = [];
function stub() {
  return new Proxy({}, { get(_t, k) {
    if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
    return (...a) => { sent.push({ fn: k, args: a }); return Promise.resolve({ ok: true }); };
  } });
}
for (const f of ['email.js', 'pushService.js', 'sms.js', 'stokvelNotify.js']) {
  const p = path.join(ROOT, 'server', 'services', f);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: stub() };
}

/* ══ 1. What a wind-up LOOKS like, driven ══════════════════════════ */
console.log('\na wind-up reads as a wind-up, not as a zero-rand withdrawal');
{
  const P = portal();
  const REQ = over => Object.assign({
    id: 'SWR-D', kind: 'dissolve', amount: 0, status: 'pending',
    approvals: 0, required: 2, satisfied: false, votes: [],
    requested_by_name: 'Lerato', reason: 'Winding the group up',
  }, over || {});
  const render = rows => P._svWithdrawals({ data: rows }, true, 'SA-1',
    { g: { stokvel_quorum: 2, wallet_balance: 0 }, signatories: 2, canPropose: true });

  const html = render([REQ()]);
  const words = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  ok('THE HEADLINE IS THE DECISION, NOT A FIGURE',
     /Close the group for good/.test(words) && !/R 0\.00/.test(words),
     'it fell through to Utils.rand(0) and a signatory asked to END THE '
     + 'GROUP was shown "R 0,00": ' + words.slice(0, 260));
  ok('and the chip says what kind it is',
     /CLOSING|Closing/.test(words),
     'the chip fell through to "Withdraw": ' + words.slice(0, 260));
  ok('AND IT SAYS WHAT IS BEING ASKED FOR',
     /end this group permanently/.test(words),
     'every other kind names its destination here; a dissolve’s is the '
     + 'group itself: ' + words.slice(0, 300));
  ok('and it is drawn in the colour of the one that cannot be undone',
     /#ef4444/.test(html.slice(html.indexOf('SWR-D') - 2000, html.indexOf('SWR-D') + 2000))
     || /dissolve' \? '#ef4444'/.test(read('js/portal-core.js')),
     'red, alone among the kinds');

  /* And it must not have taken the other kinds with it. */
  const w = render([Object.assign(REQ({ id: 'SWR-W', kind: 'withdrawal', amount: 2000,
                                        bank_name: 'FNB' }))]).replace(/<[^>]*>/g, ' ');
  ok('a withdrawal still shows its amount',
     /R 2000\.00/.test(w) && !/Close the group for good/.test(w), w.slice(0, 200));
  const m = render([REQ({ id: 'SWR-M', kind: 'mandate', change_summary: 'add a signatory' })])
    .replace(/<[^>]*>/g, ' ');
  ok('and a mandate change still says so',
     /Change to the mandate/.test(m) && !/Close the group for good/.test(m), m.slice(0, 200));
}

/* ══ 2. A group that has ended is not a group starting ═════════════ */
console.log('\nand a group that has been wound up says so');
{
  const P = portal();
  const ctx = { g: { id: 'SA-1', name: 'Siyakhula Savings', status: 'closed',
                     wallet_balance: 0, stokvel_quorum: 2, my_role: 'chairperson' },
                shareData: { data: { net_assets: 0, my_share: 0, shares: [] } },
                payoutData: { data: [] }, contributions: { data: [], arrears: [] },
                requests: { data: [] }, members: { data: [] }, mine: [], meIsSignatory: true };
  const closed = P._svOverview('SA-1', ctx).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  ok('IT IS NOT ASKED TO GET ITSELF GOING',
     !/Getting Siyakhula Savings going/.test(closed),
     'its pot is zero because the members were paid and its roster is empty '
     + 'because the memberships ended — which is exactly what a new group '
     + 'looks like: ' + closed.slice(0, 260));
  ok('it says it has been wound up',
     /has been wound up/.test(closed), closed.slice(0, 260));
  ok('and it says the record is still there',
     /statement/i.test(closed),
     'what a group did is the thing its members still need afterwards');

  /* The same group, still open, must still get its checklist. */
  const open = P._svOverview('SA-1', Object.assign({}, ctx,
    { g: Object.assign({}, ctx.g, { status: 'active' }) })).replace(/<[^>]*>/g, ' ');
  ok('AND A GROUP THAT IS STILL GOING STILL GETS ITS CHECKLIST',
     /Getting Siyakhula Savings going/.test(open) && !/has been wound up/.test(open),
     'the fix must not take the onboarding away from the groups that need '
     + 'it: ' + open.slice(0, 200));
}

/* ══ 3. The routes, against a real database ════════════════════════ */
(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_withdrawal_requests') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no stokvel tables here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-EN-%')`);
      for (const t of ['stokvel_withdrawal_requests', 'stokvel_allocations', 'stokvel_exit_debts',
                       'stokvel_contributions', 'stokvel_members', 'stokvel_payouts'])
        await db.query(`DELETE FROM ${t} WHERE sub_account_id LIKE 'SA-EN-%'`);
      await db.query(`DELETE FROM investments  WHERE sub_account_id LIKE 'SA-EN-%'`);
      await db.query(`DELETE FROM transactions WHERE sub_account_id LIKE 'SA-EN-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-EN-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-EN-%'`);
    };
    await clean();

    const MEM = ['INV-EN-CHAIR', 'INV-EN-SIG', 'INV-EN-PLAIN'];
    for (const id of MEM)
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
         VALUES ($1,$2,'M',$3,$4,'active',0)`,
        [id, id.slice(-5), `${id.toLowerCase()}@example.test`, '078000000' + id.slice(-1)]);
    const makeGroup = async (gid, wallet) => {
      await db.query(
        `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                   kyc_status, status, stokvel_quorum, share_basis)
         VALUES ($1,'INV-EN-CHAIR','stokvel','Siyakhula',$2,'approved','active',2,'contribution')`,
        [gid, wallet]);
      for (const [i, id] of MEM.entries())
        await db.query(
          `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
           VALUES ($1,$2,$3,$4,$5,'active', NOW() - INTERVAL '2 years')`,
          [`SM-${gid}-${i}`, gid, id, i === 0 ? 'chairperson' : 'member', i < 2]);
    };
    await makeGroup('SA-EN-1', 0);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id,
                                 firstName: 'A', lastName: 'B' },
                               process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });
    const raise = (gid, who, body) =>
      call('POST', `/api/stokvels/${gid}/withdrawal-requests`, tok(who),
           Object.assign({ kind: 'dissolve' }, body || {}));
    const vote = (gid, who, rid) =>
      call('POST', `/api/stokvels/${gid}/withdrawal-requests/${rid}/vote`, tok(who), { decision: 'approve' });
    const close = (gid, who, authorityId) =>
      call('POST', `/api/stokvels/${gid}/dissolve`, tok(who), { authority_id: authorityId });

    console.log('\nand a wind-up can be asked for at all');
    let authority;
    {
      const r = await raise('SA-EN-1', 'INV-EN-CHAIR', { reason: 'The group has run its course' });
      ok('THE COMMITTEE CAN ASK TO CLOSE THE GROUP',
         r.status === 201 || r.status === 200,
         'it fell through to the withdrawal branch and was refused with '
         + '"the bank name and account number must be part of the request" — '
         + 'about a decision that moves no money: ' + JSON.stringify(r.body));
      authority = r.body.data && r.body.data.id;
      ok('and it is stored as a dissolve, with no amount',
         !!authority && r.body.data.kind === 'dissolve' && Number(r.body.data.amount) === 0,
         JSON.stringify(r.body.data));
      ok('AND IT ASKS FOR NO BANK ACCOUNT',
         !/bank/i.test(JSON.stringify(r.body)),
         'a group being closed has no destination: ' + JSON.stringify(r.body));

      const plain = await raise('SA-EN-1', 'INV-EN-PLAIN', {});
      ok('but not every member can put it in front of the group',
         plain.status === 403, JSON.stringify(plain.body));
    }

    console.log('\nand closing it needs the signatories, like anything else');
    {
      const early = await close('SA-EN-1', 'INV-EN-CHAIR', authority);
      ok('ONE APPROVAL SHORT CLOSES NOTHING', early.status === 403,
         'the mandate is the control on the one decision that cannot be '
         + 'undone: ' + JSON.stringify(early.body));
      const { rows: [g] } = await db.query(`SELECT status FROM sub_accounts WHERE id = 'SA-EN-1'`);
      ok('and the group is untouched', g.status === 'active', g.status);

      await vote('SA-EN-1', 'INV-EN-CHAIR', authority);
      await vote('SA-EN-1', 'INV-EN-SIG', authority);
      const { rows: [r] } = await db.query(
        `SELECT status FROM stokvel_withdrawal_requests WHERE id = $1`, [authority]);
      ok('two approvals carry it', r.status === 'approved', r.status);
    }

    console.log('\nand it refuses to close a group that still holds anything');
    {
      await db.query(`UPDATE sub_accounts SET wallet_balance = 9000 WHERE id = 'SA-EN-1'`);
      const r = await close('SA-EN-1', 'INV-EN-CHAIR', authority);
      ok('MONEY IN THE WALLET STOPS IT',
         r.status === 409 && /Pay the members out/.test(r.body.error || ''),
         'closing does not split the pot by share, so closing one with money '
         + 'in it would strand it: ' + JSON.stringify(r.body));
      await db.query(`UPDATE sub_accounts SET wallet_balance = 0 WHERE id = 'SA-EN-1'`);

      /* A real pool, because investments reference one. */
      const { rows: [anyPool] } = await db.query(
        `SELECT id FROM investment_pools ORDER BY created_at ASC LIMIT 1`);
      await db.query(
        `INSERT INTO investments (id, investor_id, sub_account_id, pool_id, amount, status, start_date)
         VALUES ('INVST-EN-1','INV-EN-CHAIR','SA-EN-1',$1,1000,'active',CURRENT_DATE)`,
        [anyPool && anyPool.id]);
      const live = await close('SA-EN-1', 'INV-EN-CHAIR', authority);
      ok('and so does money still in a pool',
         live.status === 409 && /investment/i.test(live.body.error || ''),
         'holdings belonging to a group that no longer exists are holdings '
         + 'nobody goes looking for: ' + JSON.stringify(live.body));
      await db.query(`DELETE FROM investments WHERE id = 'INVST-EN-1'`);
    }

    console.log('\nand then it really closes');
    {
      const spare = await raise('SA-EN-1', 'INV-EN-SIG', { reason: 'a second ask, left pending' });
      const r = await close('SA-EN-1', 'INV-EN-CHAIR', authority);
      ok('THE GROUP IS CLOSED',
         r.status === 200 && r.body.data && r.body.data.closed === true,
         'the route set every membership to a status the constraint did not '
         + 'allow, so the UPDATE threw, the whole transaction rolled back, '
         + 'and the group was never closed — with the error in the log and '
         + 'nowhere else: ' + JSON.stringify(r.body));

      const { rows: [g] } = await db.query(`SELECT status, closed_at FROM sub_accounts WHERE id = 'SA-EN-1'`);
      ok('and it says so on the account', g.status === 'closed' && !!g.closed_at, JSON.stringify(g));

      const { rows: mem } = await db.query(
        `SELECT status, COUNT(*)::int AS n FROM stokvel_members
          WHERE sub_account_id = 'SA-EN-1' GROUP BY status`);
      ok('EVERY MEMBERSHIP ENDED WITH IT',
         mem.length === 1 && mem[0].status === 'ended' && mem[0].n === 3,
         'nobody is an active member of a group that has been wound up: '
         + JSON.stringify(mem));
      ok('AND NOT AS AN EXIT, which is a different thing',
         !mem.some(x => x.status === 'exited'),
         'an exit is one person leaving a group that carries on, with a '
         + 'share settled and maybe a debt still owed; reading a wind-up as '
         + 'an exit would have anything looking for people owed money '
         + 'looking at the whole former roster');

      const { rows: left } = await db.query(
        `SELECT status FROM stokvel_withdrawal_requests WHERE id = $1`, [spare.body.data.id]);
      ok('and anything still waiting on a signature is moot',
         left[0] && left[0].status === 'expired', JSON.stringify(left));
      const { rows: [used] } = await db.query(
        `SELECT status FROM stokvel_withdrawal_requests WHERE id = $1`, [authority]);
      ok('and the authority is spent', used.status === 'used', used.status);

      const again = await close('SA-EN-1', 'INV-EN-CHAIR', authority);
      ok('AND IT CANNOT BE CLOSED TWICE', again.status === 409 || again.status === 403,
         JSON.stringify(again.body));
    }

    console.log('\nand everybody who should hear about it, does');
    {
      /* THE OPPOSITE OF THE CASH CHECK, deliberately. Recording a cash
         receipt sends nothing because nothing has happened yet. Ending a
         group is the loudest thing that can happen to one, and a decision
         nobody is told about is a queue, not a mandate. */
      const fns = sent.map(x => x.fn);
      ok('THE SIGNATORIES ARE ASKED',
         fns.includes('approvalNeeded'),
         'a request for a signature that nobody is told about waits for '
         + 'somebody to happen to look: ' + JSON.stringify(fns));
      ok('and each vote is reported back',
         fns.filter(f => f === 'decided').length >= 2,
         'the person who raised it hears either way, and the other '
         + 'signatories hear when the answer is final: ' + JSON.stringify(fns));
      ok('AND THE GROUP IS TOLD WHEN IT IS CLOSED',
         fns.includes('dissolved'),
         'the one thing every member of a group must not find out by '
         + 'noticing it has gone: ' + JSON.stringify(fns));
    }

    await clean();
  } catch (err) {
    fail += 1;
    console.log('  ✗ the check itself fell over\n      ' + (err && err.stack || err));
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
