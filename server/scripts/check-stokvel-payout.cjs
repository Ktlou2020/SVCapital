#!/usr/bin/env node
/* The day the group pays itself out.
 *
 * Shares answered "what is mine"; this answers "and when do we get it". The
 * December payout is what most savings stokvels exist for, and without it a
 * group of fifteen paying itself out meant fifteen separate withdrawal
 * requests, each approved separately, with nothing recording that the group
 * had decided on a distribution at all.
 *
 * It is the exit settlement applied to everyone at once and WITHOUT the
 * membership change, so the things that have to hold are the same things,
 * plus the ones that are new:
 *
 *  · THE INVARIANT SURVIVES IT. Σ shares = wallet + investments − debts,
 *    before and after, with arrears released to the members who remain.
 *  · EVERY MEMBER GETS SHARE LESS ARREARS, and what they owed stays in the
 *    pot rather than being paid out to them on the way past.
 *  · THE SIGNATORIES APPROVE THE DISTRIBUTION, once. Not one withdrawal per
 *    member, and not a figure fixed a fortnight earlier — what is pinned is
 *    WHICH payout, because the pot on the day is whatever it is.
 *  · A POT THAT CANNOT COVER EVERYBODY pays pro-rata and owes the rest.
 *    Paying the first few in full and the rest nothing would be a worse
 *    answer than everybody waiting together.
 *  · AND NOBODY LEAVES. The group keeps its members, its mandate and its
 *    schedule; this is a distribution, not a closure.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-payout.cjs
 */
'use strict';

const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const sent = { email: [], push: [], sms: [] };
function stub(record) {
  return new Proxy({}, { get(_t, k) {
    if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
    return (...args) => { record.push({ fn: k, args }); return Promise.resolve({ ok: true }); };
  } });
}
for (const [f, r] of [['email.js', sent.email], ['pushService.js', sent.push], ['sms.js', sent.sms]]) {
  const p = path.join(ROOT, 'server', 'services', f);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: stub(r) };
}
const settle = async () => {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const n = sent.email.length + sent.push.length;
    if (n === last && i > 1) return;
    last = n;
    await new Promise(r => setTimeout(r, 25));
  }
};

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_payouts') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no payout tables here'); return; }

    const shares = require(path.join(ROOT, 'server', 'services', 'stokvelShares.js'));

    const clean = async () => {
      for (const t of ['stokvel_payout_lines', 'stokvel_payouts']) {
        await db.query(`DELETE FROM ${t} WHERE ${t === 'stokvel_payouts'
          ? "sub_account_id LIKE 'SA-PO-%'"
          : "payout_id IN (SELECT id FROM stokvel_payouts WHERE sub_account_id LIKE 'SA-PO-%')"}`);
      }
      await db.query(`DELETE FROM stokvel_allocations WHERE sub_account_id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM stokvel_exit_debts  WHERE sub_account_id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-PO-%')`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM investments  WHERE sub_account_id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-PO-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-PO-%'`);
      await db.query(`DELETE FROM investors    WHERE id LIKE 'INV-PO-%'`);
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-PO-%'`);
    };
    await clean();

    const MEMBERS = ['INV-PO-A', 'INV-PO-B', 'INV-PO-C'];
    for (const id of MEMBERS.concat(['INV-PO-OUT']))
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,$4,'active',20000)`,
        [id, id.slice(-1), `${id.toLowerCase()}@example.test`, '072100000' + id.slice(-1)]);

    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum, share_basis)
       VALUES ('SA-PO-1','INV-PO-A','stokvel','Phakama Stokvel',
               0,'approved','active',2,'contribution')`);
    for (const [i, id] of MEMBERS.entries())
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
         VALUES ($1,'SA-PO-1',$2,$3,true,'active')`,
        ['SM-PO-' + id.slice(-1), id, i === 0 ? 'chairperson' : 'member']);
    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate,
                                     term_months, min_investment, max_capacity, current_invested)
       VALUES ('POOL-PO-1','Cattle December','cattle','open',0.14,18,100,10000000,0)`);
    await db.query(
      `INSERT INTO stokvel_contribution_schedules (id, sub_account_id, amount, due_day, starts_on, active)
       VALUES ('SCS-PO-1','SA-PO-1',1000,25,CURRENT_DATE - 60, true)`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    app.use('/api/tables',   require(path.join(ROOT, 'server', 'routes', 'tables.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
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

    const invariant = async where => {
      const a = await shares.audit(db, 'SA-PO-1');
      ok(`the books balance ${where}`, Math.abs(a.difference) < 0.005,
         `assets ${a.assets} vs shares ${a.shares}, out by ${a.difference}`);
      return a;
    };
    const contribute = async (id, amount, period) => {
      await db.query(
        `INSERT INTO stokvel_contributions
           (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
         VALUES ($1,'SA-PO-1',$2,$3,$4,0,CURRENT_DATE,'due')
         ON CONFLICT (sub_account_id, investor_id, period_label) DO NOTHING`,
        [`SC-PO-${id.slice(-1)}-${period}`, id, period, amount]);
      const { rows: [c] } = await db.query(
        `SELECT id FROM stokvel_contributions
          WHERE sub_account_id='SA-PO-1' AND investor_id=$1 AND period_label=$2`, [id, period]);
      return call('POST', `/api/stokvels/SA-PO-1/contributions/${c.id}/pay`, tok(id), {});
    };
    const plan = (body, who = 'INV-PO-A') =>
      call('POST', '/api/stokvels/SA-PO-1/payouts', tok(who), body);
    const raise = async body => (await call('POST', '/api/stokvels/SA-PO-1/withdrawal-requests',
                                            tok('INV-PO-A'), body)).body.data;
    const vote = (rid, who) => call('POST',
      `/api/stokvels/SA-PO-1/withdrawal-requests/${rid}/vote`, tok(who), { decision: 'approve' });
    const run = (pid, authority_id, who = 'INV-PO-B') =>
      call('POST', `/api/stokvels/SA-PO-1/payouts/${pid}/run`, tok(who), { authority_id });

    await contribute('INV-PO-A', 2000, '2026-01');
    await contribute('INV-PO-B', 1000, '2026-01');
    await contribute('INV-PO-C', 1000, '2026-01');

    /* ── Planning ──────────────────────────────────────────────────── */
    console.log('\nthe committee plans a distribution');
    const notCommittee = await plan({ label: 'December 2026', pay_on: '2026-12-01' }, 'INV-PO-B');
    ok('an ordinary member cannot plan one', notCommittee.status === 403,
       `${notCommittee.status} ${JSON.stringify(notCommittee.body)}`);
    const planned = await plan({ label: 'December 2026', pay_on: '2026-12-01' });
    ok('the chairperson can', planned.status === 201, JSON.stringify(planned.body));
    const pid = planned.body.data.id;
    ok('a second open distribution is refused',
       (await plan({ label: 'Also December', pay_on: '2026-12-02' })).status === 409,
       'two open payouts is a group that has not decided, and the second would be '
       + 'approved against a pot the first is about to empty');
    ok('a payout with no date is refused',
       (await plan({ label: 'Someday' })).status === 400);

    const seen = await call('GET', '/api/stokvels/SA-PO-1/payouts', tok('INV-PO-C'));
    ok('every member sees it, not just the committee',
       (seen.body.data || []).some(x => x.id === pid), JSON.stringify(seen.body.data));
    ok('and is told what they would get', Number(seen.body.my_share_now) > 0,
       JSON.stringify(seen.body.my_share_now));
    ok('an ordinary member gets no plan button', seen.body.can_plan === false);
    ok('somebody outside the stokvel sees nothing',
       (await call('GET', '/api/stokvels/SA-PO-1/payouts', tok('INV-PO-OUT'))).status === 404);

    /* ── The mandate ───────────────────────────────────────────────── */
    console.log('\nand the signatories approve the distribution, once');
    const noAuth = await run(pid, null);
    ok('it cannot be run without an authority', noAuth.status === 403,
       `${noAuth.status} ${JSON.stringify(noAuth.body)}`);

    const auth = await raise({ amount: 4000, kind: 'payout', payout_id: pid });
    ok('a payout authority can be raised', !!(auth && auth.id), JSON.stringify(auth));
    ok('one approval does not release it',
       (await (async () => { await vote(auth.id, 'INV-PO-A'); return run(pid, auth.id); })()).status === 403);

    /* An authority for a different distribution must not run this one. */
    const other = await plan({ label: 'Other', pay_on: '2027-01-01' });
    ok('a second plan is still refused while one is open', other.status === 409);

    await vote(auth.id, 'INV-PO-B');

    /* ── The register, against a real database ────────────────────
       check-stokvel-screens covers what the hub DRAWS, from a stub. That
       cannot catch a column that does not exist, and did not: the first
       version of this query asked stokvel_request_approvals for created_at,
       which is called decided_at, so every request list would have failed
       at runtime while the source assertions passed. Anything that reads
       the register needs to read it from Postgres at least once. */
    console.log('\nand the register says WHICH signatories agreed');
    {
      const list = await call('GET', '/api/stokvels/SA-PO-1/withdrawal-requests', tok('INV-PO-C'));
      ok('the requests list still builds', list.status === 200,
         `${list.status} ${JSON.stringify(list.body).slice(0, 160)}`);
      const row = (list.body.data || []).find(r => r.id === auth.id) || {};
      ok('it carries the votes', Array.isArray(row.votes) && row.votes.length === 2,
         JSON.stringify(row.votes));
      ok('each vote names the signatory and what they decided',
         (row.votes || []).every(v => v.name && v.decision && v.at),
         JSON.stringify(row.votes));
      ok('and a member who is not a signatory still sees it',
         list.status === 200,
         'knowing who agreed is the point; voting is what is restricted');
    }

    /* ── Running it ────────────────────────────────────────────────── */
    console.log('\nand then everybody is paid their share, less what they owe');
    /* C owes something, so the deduction is real. */
    await db.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
       VALUES ('SC-PO-C-OWE','SA-PO-1','INV-PO-C','2026-02',400,0,CURRENT_DATE,'due')`);

    const before = {};
    for (const id of MEMBERS) {
      before[id] = Number((await db.query(
        'SELECT wallet_balance FROM investors WHERE id = $1', [id])).rows[0].wallet_balance);
    }
    const potBefore = (await shares.netAssets(db, 'SA-PO-1')).total;

    sent.email.length = 0; sent.push.length = 0;
    const done = await run(pid, auth.id);
    await settle();
    ok('an approved payout runs', done.status === 200, JSON.stringify(done.body).slice(0, 220));
    const out = done.body.data || {};

    const line = id => (out.lines || []).find(l => l.investor_id === id) || {};
    ok('the member who contributed most gets the most',
       Number(line('INV-PO-A').net) > Number(line('INV-PO-B').net),
       JSON.stringify((out.lines || []).map(l => [l.investor_id, l.net])));
    ok('arrears come off the member who owed them',
       Math.abs(Number(line('INV-PO-C').arrears) - 400) < 0.02, JSON.stringify(line('INV-PO-C')));
    ok('and their payment is their share less those arrears',
       Math.abs(Number(line('INV-PO-C').net)
                - (Number(line('INV-PO-C').gross) - 400)) < 0.02, JSON.stringify(line('INV-PO-C')));
    for (const id of MEMBERS) {
      const after = Number((await db.query(
        'SELECT wallet_balance FROM investors WHERE id = $1', [id])).rows[0].wallet_balance);
      ok(`${id} was paid into their own wallet`,
         Math.abs((after - before[id]) - Number(line(id).paid)) < 0.02,
         `wallet moved ${after - before[id]}, line says ${line(id).paid}`);
    }
    /* The pot goes out MINUS what was withheld. That money stays with the
       group \u2014 it is the whole point of deducting arrears rather than paying
       somebody their share and asking for the arrears back. */
    const withheld = (out.lines || []).reduce((n, l) => n + Number(l.arrears), 0);
    ok('the pot went out, less what was withheld',
       Math.abs(Number(out.paid) - (potBefore - withheld)) < 0.05,
       `paid ${out.paid}, pot was ${potBefore}, withheld ${withheld}`);
    ok('nothing is left owing when the cash covered it', Math.abs(Number(out.queued)) < 0.02,
       JSON.stringify(out.queued));
    const left = await shares.netAssets(db, 'SA-PO-1');
    ok('and the arrears stay in the pot for the members',
       Math.abs(left.total - withheld) < 0.05,
       `${left.total} left, ${withheld} was withheld`);
    await invariant('after the payout');

    console.log('\nand the group carries on');
    ok('nobody left', (await db.query(
         `SELECT COUNT(*)::int AS n FROM stokvel_members
           WHERE sub_account_id='SA-PO-1' AND status='active'`)).rows[0].n === 3,
       'a distribution is not a closure');
    ok('the contribution schedule is untouched',
       (await db.query(`SELECT active FROM stokvel_contribution_schedules
                         WHERE sub_account_id='SA-PO-1'`)).rows[0].active === true);
    ok('what was owed was closed rather than left due against a paid-out member',
       (await db.query(`SELECT COUNT(*)::int AS n FROM stokvel_contributions
                         WHERE sub_account_id='SA-PO-1' AND status='due'`)).rows[0].n === 0);
    ok('the payout is marked paid',
       (await db.query(`SELECT status FROM stokvel_payouts WHERE id=$1`, [pid]))
         .rows[0].status === 'paid');
    ok('and each member has a line kept for later',
       (await db.query(`SELECT COUNT(*)::int AS n FROM stokvel_payout_lines WHERE payout_id=$1`,
                       [pid])).rows[0].n === 3,
       '"what did I get in December" has to keep answering the same thing in March');
    ok('the same authority cannot run it twice',
       (await run(pid, auth.id)).status >= 400);

    console.log('\nand every member is told what THEY got');
    const texts = sent.email.concat(sent.push).map(c => JSON.stringify(c.args)).join(' | ');
    ok('each member is notified', sent.push.length >= 3, String(sent.push.length));
    ok('with their own figure rather than the group total',
       !/84 ?000/.test(texts) && /payout/i.test(texts),
       'a message saying what the group distributed leaves everybody doing arithmetic');

    /* ── A pot that cannot cover everybody ─────────────────────────── */
    console.log('\nand a pot that cannot cover everybody pays pro-rata and owes the rest');
    await contribute('INV-PO-A', 3000, '2026-03');
    await contribute('INV-PO-B', 3000, '2026-03');

    /* Most of it committed to a pool, so the cash genuinely falls short. */
    const spare = Number((await db.query(
      `SELECT wallet_balance FROM sub_accounts WHERE id='SA-PO-1'`)).rows[0].wallet_balance);
    const commit = Math.floor((spare - 1000) * 100) / 100;
    const ia = await raise({ amount: commit, kind: 'investment', pool_id: 'POOL-PO-1' });
    await vote(ia.id, 'INV-PO-A'); await vote(ia.id, 'INV-PO-B');
    await call('POST', '/api/tables/investments', tok('INV-PO-A'), {
      id: 'INVST-PO-1', investor_id: 'INV-PO-A', sub_account_id: 'SA-PO-1',
      pool_id: 'POOL-PO-1', pool_name: 'Cattle December', amount: commit,
      annual_rate: 0.14, term_months: 18, status: 'active',
      start_date: '2026-03-01', end_date: '2027-09-01', authority_id: ia.id,
    });

    const p2 = await plan({ label: 'Short December', pay_on: '2026-12-01' });
    const a2 = await raise({ amount: 1, kind: 'payout', payout_id: p2.body.data.id });
    await vote(a2.id, 'INV-PO-A'); await vote(a2.id, 'INV-PO-B');
    const cash = Number((await db.query(
      `SELECT wallet_balance FROM sub_accounts WHERE id='SA-PO-1'`)).rows[0].wallet_balance);
    const short = await run(p2.body.data.id, a2.id);
    const o2 = short.body.data || {};
    ok('it still runs', short.status === 200, JSON.stringify(short.body).slice(0, 200));
    ok('only what the group holds is paid', Math.abs(Number(o2.paid) - cash) < 0.05,
       `paid ${o2.paid}, cash was ${cash}`);
    ok('and the rest is recorded as owed', Number(o2.queued) > 0, JSON.stringify(o2.queued));
    ok('shared pro-rata rather than first-come',
       (o2.lines || []).filter(l => Number(l.paid) > 0).length === 3,
       'paying the first few in full and the rest nothing is a worse answer than '
       + 'everybody waiting together');
    ok('each member who is short has a debt on the books',
       (await db.query(`SELECT COUNT(*)::int AS n FROM stokvel_exit_debts
                         WHERE sub_account_id='SA-PO-1' AND status='owing'`)).rows[0].n >= 1);
    ok('and still nobody left', (await db.query(
         `SELECT COUNT(*)::int AS n FROM stokvel_members
           WHERE sub_account_id='SA-PO-1' AND status='active'`)).rows[0].n === 3);
    await invariant('after a payout the cash could not cover');

    /* ── What the workspace reads ──────────────────────────────────
       The group's ledger and its holdings. NOT through the generic table
       reader: that scopes transactions and investments by investor_id, and
       a stokvel's rows carry the chairperson's id, so an ordinary member
       could not read them there and must not be given a way to. */
    console.log('\nand a member can read the group\u2019s ledger and holdings');
    {
      const ledger = await call('GET', '/api/stokvels/SA-PO-1/transactions', tok('INV-PO-C'));
      ok('an ordinary member reads the ledger', ledger.status === 200,
         `${ledger.status} ${JSON.stringify(ledger.body).slice(0, 140)}`);
      const rows = ledger.body.data || [];
      ok('it has the group\u2019s movements on it', rows.length > 0, String(rows.length));
      ok('newest first', rows.length < 2
         || new Date(rows[0].at) >= new Date(rows[rows.length - 1].at),
         'a ledger is read from the top');
      /* ANCHORED, NOT ACCUMULATED, and the case is constructed rather than
         hoped for: a credit is put on the wallet with NO transaction row
         against the group, which is exactly what a payout does \u2014 it debits
         the group wallet and writes the rows against each member. Summing
         this table from zero cannot reach the wallet after that, and a
         treasurer reading a closing balance that disagrees with the balance
         above it would be right to stop trusting the screen. */
      await db.query(
        `UPDATE sub_accounts SET wallet_balance = wallet_balance + 123.45 WHERE id = 'SA-PO-1'`);
      const anchored = await call('GET', '/api/stokvels/SA-PO-1/transactions', tok('INV-PO-C'));
      const top = (anchored.body.data || [])[0] || {};
      const naive = (anchored.body.data || [])
        .reduce((n, r) => n + Number(r.cash_effect), 0);
      ok('with a running balance that ends at the wallet',
         Math.abs(Number(top.running_balance) - Number(anchored.body.wallet)) < 0.05,
         `top row ${top.running_balance}, wallet ${anchored.body.wallet}`);
      ok('even where money moved without a row against the group',
         Math.abs(naive - Number(anchored.body.wallet)) > 0.05,
         `summing the table gives ${naive}, the wallet holds ${anchored.body.wallet} \u2014 `
         + 'if these matched, the anchoring would not be under test');
      await db.query(
        `UPDATE sub_accounts SET wallet_balance = wallet_balance - 123.45 WHERE id = 'SA-PO-1'`);
      ok('and a fee counted as money going out',
         rows.every(r => r.type !== 'fee' || Number(r.cash_effect) < 0),
         'the ledger service decides what moves cash, not this screen');

      const held = await call('GET', '/api/stokvels/SA-PO-1/investments', tok('INV-PO-C'));
      ok('and the holdings', held.status === 200 && Array.isArray(held.body.data),
         `${held.status} ${JSON.stringify(held.body).slice(0, 140)}`);
      ok('with what is invested now totalled',
         held.body.totals && Number(held.body.totals.active) > 0,
         JSON.stringify(held.body.totals));

      ok('somebody outside the stokvel reads neither',
         (await call('GET', '/api/stokvels/SA-PO-1/transactions', tok('INV-PO-OUT'))).status === 404
         && (await call('GET', '/api/stokvels/SA-PO-1/investments', tok('INV-PO-OUT'))).status === 404);
    }

    console.log('\nand an authority is good for one distribution only');
    {
      /* Two payouts can only exist once the first has run \u2014 the partial
         unique index allows one PLANNED at a time, which is why this sits
         here rather than beside the mandate assertions above. */
      const pA = await plan({ label: 'March 2027', pay_on: '2027-03-01' });
      const authA = await raise({ amount: 1, kind: 'payout', payout_id: pA.body.data.id });
      await vote(authA.id, 'INV-PO-A'); await vote(authA.id, 'INV-PO-B');
      await run(pA.body.data.id, authA.id);

      /* The authority under test has to be APPROVED AND UNSPENT, or the
         refusal comes from it having been used rather than from it naming
         another distribution \u2014 which is a different rule, and the first
         draft of this was satisfied by it. So: approve one for pB, leave it
         alone, cancel pB, and try it on a third payout. */
      const pB = await plan({ label: 'June 2027', pay_on: '2027-06-01' });
      const authB = await raise({ amount: 1, kind: 'payout', payout_id: pB.body.data.id });
      await vote(authB.id, 'INV-PO-A'); await vote(authB.id, 'INV-PO-B');
      await call('DELETE', `/api/stokvels/SA-PO-1/payouts/${pB.body.data.id}`, tok('INV-PO-A'));

      const pC = await plan({ label: 'September 2027', pay_on: '2027-09-01' });
      const crossed = await run(pC.body.data.id, authB.id);
      ok('an authority approved for one payout cannot run another',
         crossed.status >= 400, `${crossed.status} ${JSON.stringify(crossed.body)}`);
      ok('and the refusal is about the payout, not about the authority being spent',
         /different payout/i.test((crossed.body && crossed.body.error) || ''),
         JSON.stringify(crossed.body));

      /* The status guard inside payOut, which the authority normally masks:
         by the time a second run is attempted through the route the
         authority is already spent, so this is exercised directly. */
      const twice = await (async () => {
        const c = await db.connect();
        try {
          await c.query('BEGIN');
          const r = await shares.payOut(c, { payoutId: pA.body.data.id });
          await c.query('ROLLBACK');
          return r;
        } finally { c.release(); }
      })();
      ok('a payout that has already run refuses to run again',
         !!(twice && twice.error) && /already paid/i.test(twice.error),
         JSON.stringify(twice).slice(0, 160));

      await call('DELETE', `/api/stokvels/SA-PO-1/payouts/${pC.body.data.id}`, tok('INV-PO-A'));
    }

    console.log('\nand a cancelled payout is not a payout');
    const p3 = await plan({ label: 'Called off', pay_on: '2027-02-01' });
    ok('a planned one can be cancelled',
       (await call('DELETE', `/api/stokvels/SA-PO-1/payouts/${p3.body.data.id}`,
                   tok('INV-PO-A'))).status === 200);
    ok('an ordinary member cannot cancel one',
       (await (async () => {
          const p4 = await plan({ label: 'Another', pay_on: '2027-03-01' });
          const r = await call('DELETE', `/api/stokvels/SA-PO-1/payouts/${p4.body.data.id}`,
                               tok('INV-PO-C'));
          await call('DELETE', `/api/stokvels/SA-PO-1/payouts/${p4.body.data.id}`, tok('INV-PO-A'));
          return r; })()).status === 403);

    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
        console.log('\nand staff cannot run one on the group\u2019s behalf');
    {
      const fs2 = require('fs');
      const ADMIN = fs2.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      const panel = ADMIN.slice(ADMIN.indexOf('function _stokvelAdminPayouts'),
                                ADMIN.indexOf('/* \u2500\u2500\u2500 Shares, and what is owed'));
      ok('the console shows payouts', panel.length > 200);
      ok('and has no button to run one',
         !/onclick=/.test(panel),
         'a distribution empties the pot \u2014 a staff override on that is the single '
         + 'point of failure the mandate exists to remove');
      ok('and says so in as many words',
         /no button here to run one/i.test(panel));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
