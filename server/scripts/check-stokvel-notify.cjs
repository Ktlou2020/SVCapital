#!/usr/bin/env node
/* A mandate nobody is told about is a queue, not a mandate.
 *
 * Everything the last four releases built — members, the mandate, the
 * contributions, the investment gate — sat behind one unstated assumption:
 * that a signatory would happen to open the app. Nothing told them. A
 * treasurer raised a request and then phoned three people to ask them to go
 * and tap approve, which is a worse system than the bank form it replaced.
 *
 * What this holds:
 *
 *  · ASKED tells the OTHER signatories. Not the person who raised it, who
 *    was there; not the ordinary members, who cannot vote and would learn
 *    only to be unable to help.
 *  · THE DESTINATION IS IN THE MESSAGE. "R10 000 needs your approval" tells
 *    a signatory nothing they can check. The destination is the half of a
 *    request the mandate exists to pin down, so it is in every message —
 *    the bank for a withdrawal, the pool for an investment.
 *  · A VOTE THAT DOES NOT CARRY tells only the person waiting. Telling three
 *    signatories that a signatory has voted is telling them what they are in
 *    the middle of doing.
 *  · CARRIED and REFUSED are final, so the whole mandate hears. A dead
 *    request that still reads as pending is how three people go on waiting
 *    to vote on nothing.
 *  · SPENT tells everybody who approved it, once each. This is the message
 *    that is easiest to leave out and the one that matters most: an approval
 *    is a promise about money, and it is the only chance anyone has to
 *    notice an authority used in a way they did not expect while it is
 *    still recent.
 *  · AND NONE OF IT CAN BREAK THE MONEY. With the mail provider and the
 *    push service both throwing on every call, a withdrawal still goes
 *    through and a vote is still recorded. A notification is a courtesy; the
 *    ledger is not.
 *
 * Plus the surface that cannot fail silently: push needs a permission the
 * member may never have granted and email needs an address that may bounce,
 * so the count of what is waiting on them is on the card in the app.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-notify.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* Comments are not code. Three assertions in this suite have been satisfied
   by a sentence in a comment that said what the code was supposed to do, so
   every source scan here reads the code with the prose taken out. */
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

/* ── The shape of it, before any of it runs ───────────────────────── */
const SVK = codeOnly(read('server/routes/stokvels.js'));
const WD  = codeOnly(read('server/routes/withdrawals.js'));
const TB  = codeOnly(read('server/routes/tables.js'));

console.log('\nnotifying cannot roll back the money');
{
  /* The order is the assertion. A send inside the transaction that moved the
     money can fail it; a send before the commit can describe money that then
     rolls back. Both are the same bug seen from either side. */
  for (const [name, src, hook] of [
    ['the vote', SVK, 'decided'],
    ['a sub-account withdrawal', WD, 'spent'],
    ['an investment', TB, 'spent'],
  ]) {
    const fn = src.slice(0, src.indexOf(`.${hook}(`));
    ok(`${name} commits before it notifies`,
       /COMMIT/.test(fn), 'a send inside the money’s transaction can roll it back');
  }
  ok('and no hook is awaited',
     !/await\s+(?:_?n|_notify|notify\(\))\s*\.\s*(approvalNeeded|decided|spent)\(/.test(SVK + WD + TB),
     'awaiting a mail provider inside a money route is a request that hangs on it');
  ok('every hook catches its own failure',
     (SVK + WD + TB).match(/\.(approvalNeeded|decided|spent)\([\s\S]{0,320}?\.catch\(/g || []).length >= 4,
     'an unhandled rejection in a fire-and-forget send takes the process down');
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* ── Both channels, intercepted ───────────────────────────────────── */
const sent = { email: [], push: [] };
let BREAK = false;   // when true, every channel throws — the outage case

function stub(record) {
  return new Proxy({}, {
    get(_t, k) {
      if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
      return (...args) => {
        if (BREAK) return Promise.reject(new Error('channel down'));
        record.push({ fn: k, args });
        return Promise.resolve({ ok: true });
      };
    },
  });
}
function preload(rel, exports) {
  const p = path.join(ROOT, 'server', 'services', rel);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports };
}
preload('email.js',       stub(sent.email));
preload('pushService.js', stub(sent.push));

/* Who was told, by either channel. The two are not alternatives — a member
   who never granted push and a member whose address bounces are different
   members — so "told" means reached on at least one. */
const told = () => new Set([
  ...sent.push.filter(c => c.fn === 'sendPushToInvestor').map(c => c.args[0]),
  ...sent.email.filter(c => c.fn === 'sendStokvelMandate').map(c => c.args[0] && c.args[0].id),
].filter(Boolean));
const texts = () => [
  ...sent.push.map(c => JSON.stringify(c.args[1] || {})),
  ...sent.email.map(c => JSON.stringify(c.args[1] || {})),
].join(' | ');
/* The push body alone. Kept separate because the email carries the facts of
   the request as a table, so an assertion over both is satisfied by the
   table even when the sentence a signatory actually reads on their lock
   screen has lost the destination entirely — which is how a mutation that
   gutted it passed. The push body is the message; the email is the record. */
const pushBodies = () => sent.push
  .filter(c => c.fn === 'sendPushToInvestor')
  .map(c => (c.args[1] || {}).body || '').join(' | ');
const reset = () => { sent.email.length = 0; sent.push.length = 0; };
/* The hooks are fire-and-forget, so a response can arrive before the sends
   do. Waits for quiet rather than for a count, so an assertion about who was
   NOT told cannot pass by being checked too early. */
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
      `SELECT to_regclass('public.stokvel_withdrawal_requests') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no mandate tables here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-NT-%')`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-NT-%'`);
      await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id LIKE 'SA-NT-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-NT-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-NT-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-NT-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-NT-%'`);
      await db.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-NT-%'`);
    };
    await clean();

    for (const id of ['INV-NT-CHAIR','INV-NT-SIG1','INV-NT-SIG2','INV-NT-PLAIN'])
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,'active',0)`,
        [id, id.replace('INV-NT-',''), `${id.toLowerCase()}@example.test`]);

    /* Three signatories, quorum two: enough that "the other signatories"
       and "all of them" are different sets, which is what separates the
       progress message from the final one. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum)
       VALUES ('SA-NT-1','INV-NT-CHAIR','stokvel','Vukuzenzele Stokvel',
               60000,'approved','active',2)`);
    const member = async (inv, sig, role = 'member') => db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
       VALUES ($1,'SA-NT-1',$2,$3,$4,'active')`,
      ['SM-NT-' + inv.slice(-5), inv, role, sig]);
    await member('INV-NT-CHAIR', true, 'chairperson');
    await member('INV-NT-SIG1',  true, 'treasurer');
    await member('INV-NT-SIG2',  true, 'secretary');
    await member('INV-NT-PLAIN', false);

    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate,
                                     term_months, min_investment, max_capacity, current_invested)
       VALUES ('POOL-NT-OPEN','Cattle November','cattle','open',0.14,18,1000,1000000,0)`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels',    require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    app.use('/api/withdrawals', require(path.join(ROOT, 'server', 'routes', 'withdrawals.js')));
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

    const DEST = { bank_name: 'Capitec', bank_account_number: '1234567890' };
    const raise = async (body, by = 'INV-NT-PLAIN') =>
      (await call('POST', '/api/stokvels/SA-NT-1/withdrawal-requests', tok(by), body)).body.data;
    const vote = (rid, who, decision = 'approve') =>
      call('POST', `/api/stokvels/SA-NT-1/withdrawal-requests/${rid}/vote`, tok(who), { decision });

    /* ── ASKED ─────────────────────────────────────────────────────── */
    console.log('\nasking tells the signatories, and only them');
    reset();
    const r1 = await raise(Object.assign({ amount: 5000, reason: 'December payout' }, DEST));
    await settle();
    const t1 = told();
    ok('every signatory is told', ['INV-NT-CHAIR','INV-NT-SIG1','INV-NT-SIG2'].every(i => t1.has(i)),
       [...t1].join(','));
    ok('the member who raised it is not told what they just did',
       !t1.has('INV-NT-PLAIN'), 'they were there');
    ok('and the destination is in the message', /Capitec/.test(texts()),
       'an amount with no destination is nothing a signatory can check');
    ok('including in the line they read on the lock screen',
       /Capitec/.test(pushBodies()), pushBodies().slice(0, 200));
    ok('so is how many approvals it needs', /\b2\b/.test(texts()));
    ok('both channels were used, not one as a fallback for the other',
       sent.push.length >= 3 && sent.email.length >= 3,
       `push ${sent.push.length}, email ${sent.email.length}`);
    /* WHERE IT POINTS. Every message used to carry '/portal/' \u2014 the
       dashboard \u2014 so a signatory told that money needs their approval
       arrived at a summary and had to find Sub-accounts, then the group,
       then the panel. */
    const urls = sent.push.filter(c => c.fn === 'sendPushToInvestor')
      .map(c => (c.args[1] || {}).url || '');
    ok('and it points at the stokvel it is about',
       urls.length > 0 && urls.every(u => u.includes('stokvel=SA-NT-1')),
       JSON.stringify(urls));

    /* A signatory who raises their own request is told by nobody. */
    reset();
    const rSelf = await raise(Object.assign({ amount: 1500 }, DEST), 'INV-NT-SIG1');
    await settle();
    ok('a signatory raising their own request is left out of it',
       !told().has('INV-NT-SIG1') && told().has('INV-NT-CHAIR'), [...told()].join(','));

    /* ── PROGRESS ──────────────────────────────────────────────────── */
    console.log('\na vote that does not carry tells only the person waiting');
    reset();
    await vote(r1.id, 'INV-NT-CHAIR');
    await settle();
    const t2 = told();
    ok('the member who asked hears the tally', t2.has('INV-NT-PLAIN'), [...t2].join(','));
    ok('the other signatories are not told a signatory voted',
       !t2.has('INV-NT-SIG1') && !t2.has('INV-NT-SIG2'),
       'that is telling them what they are in the middle of doing');
    ok('and the tally says where it stands', /1 of 2/.test(pushBodies()), pushBodies().slice(0, 160));
    /* The channel split is deliberate and worth pinning: an email per vote
       is the noise that gets the useful messages muted, and the useful ones
       are the finals below. */
    ok('progress goes by push alone', sent.email.length === 0,
       `${sent.email.length} email(s) for one vote on a request needing two`);

    /* ── CARRIED ───────────────────────────────────────────────────── */
    console.log('\nthe vote that carries tells the whole mandate');
    reset();
    await vote(r1.id, 'INV-NT-SIG1');
    await settle();
    const t3 = told();
    ok('the member who asked is told it is approved', t3.has('INV-NT-PLAIN'));
    ok('and the signatories that nothing more is needed',
       t3.has('INV-NT-CHAIR') && t3.has('INV-NT-SIG2'),
       'a carried request that still reads as pending leaves them waiting to vote on nothing');
    ok('the message says what happens next', /notice period|paid out/i.test(texts()),
       texts().slice(0, 200));
    ok('and a final answer is emailed, not only pushed',
       sent.email.length >= 3,
       `${sent.email.length} email(s) — push needs a permission a member may never have granted`);

    /* ── REFUSED ───────────────────────────────────────────────────── */
    console.log('\nand a rejection closes it for everybody');
    reset();
    const r2 = await raise(Object.assign({ amount: 2500 }, DEST));
    await settle();
    reset();
    await vote(r2.id, 'INV-NT-SIG2', 'reject');
    await settle();
    const t4 = told();
    ok('the member who asked is told, and by whom',
       t4.has('INV-NT-PLAIN') && /SIG2/.test(texts()), texts().slice(0, 200));
    ok('the other signatories are told to stop waiting',
       t4.has('INV-NT-CHAIR') && t4.has('INV-NT-SIG1'), [...t4].join(','));
    ok('the signatory who rejected it is not told what they just did',
       !t4.has('INV-NT-SIG2'));
    ok('and it is not described as out-votable',
       /not a majority/i.test(texts()), 'one rejection ends a request');
    ok('a rejection is emailed too', sent.email.length >= 3,
       `${sent.email.length} email(s) — "stop waiting, it is dead" is not a push-only message`);

    /* ── SPENT ─────────────────────────────────────────────────────── */
    console.log('\nspending an authority tells everyone who granted it');
    const notify = require(path.join(ROOT, 'server', 'services', 'stokvelNotify.js'));
    reset();
    const r3 = await raise(Object.assign({ amount: 3000 }, DEST));
    await vote(r3.id, 'INV-NT-CHAIR'); await vote(r3.id, 'INV-NT-SIG1');
    await settle(); reset();
    const spentRes = await notify.spent({ groupId: 'SA-NT-1', authorityId: r3.id, reference: 'WDL-9' });
    const t5 = told();
    ok('every signatory hears where the money went',
       ['INV-NT-CHAIR','INV-NT-SIG1','INV-NT-SIG2'].every(i => t5.has(i)), [...t5].join(','));
    ok('and so does the member who asked', t5.has('INV-NT-PLAIN'));
    ok('nobody is told twice',
       spentRes.notified.length === new Set(spentRes.notified).size,
       spentRes.notified.join(','));
    ok('the destination is named', /Capitec/.test(pushBodies()), pushBodies().slice(0, 200));
    ok('and the reference is on it', /WDL-9/.test(texts()));

    /* An investment says the pool, and says what the wallet actually paid —
       the one figure that differs from the one approved. */
    reset();
    const r4 = await raise({ amount: 10000, kind: 'investment', pool_id: 'POOL-NT-OPEN' });
    await settle();
    ok('an investment request names the pool, not a pool id',
       /Cattle November/.test(pushBodies()) && !/POOL-NT-OPEN/.test(pushBodies()),
       pushBodies().slice(0, 200));
    reset();
    await notify.spent({ groupId: 'SA-NT-1', authorityId: r4.id, reference: 'INVST-3' });
    ok('and the fee on top is stated rather than discovered',
       /* South African formatting: a space for thousands, a COMMA for the
          decimal. A regex written with a decimal point passes nowhere while
          reading as though it should pass everywhere. */
       /10[\s\u00a0]?100[.,]00/.test(texts()), texts().slice(0, 400));

    /* ── A member who cannot vote is not pestered ──────────────────── */
    console.log('\nand nobody is told about something they cannot act on');
    await db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
       VALUES ('SM-NT-EXIT','SA-NT-1','INV-NT-PLAIN','member',true,'exited')
       ON CONFLICT (sub_account_id, investor_id)
       DO UPDATE SET status = 'exited', is_signatory = true`);
    reset();
    const r5 = await raise(Object.assign({ amount: 900 }, DEST), 'INV-NT-CHAIR');
    await settle();
    ok('a signatory who has left the stokvel is not asked to approve anything',
       !told().has('INV-NT-PLAIN'),
       'the mandate stopped counting them, so telling them is asking for a vote that cannot count');
    await db.query(
      `UPDATE stokvel_members SET status='active', is_signatory=false
        WHERE sub_account_id='SA-NT-1' AND investor_id='INV-NT-PLAIN'`);

    /* ── THE OUTAGE ────────────────────────────────────────────────── */
    console.log('\nand with both channels down the money still moves');
    BREAK = true;
    const r6 = await raise(Object.assign({ amount: 1200 }, DEST), 'INV-NT-CHAIR');
    ok('a request is still raised when nothing can be sent', !!(r6 && r6.id), JSON.stringify(r6));
    const v6 = await vote(r6.id, 'INV-NT-SIG1');
    ok('and a vote is still recorded', v6.status === 200, `${v6.status} ${JSON.stringify(v6.body)}`);
    const v6b = await vote(r6.id, 'INV-NT-SIG2');
    ok('and the mandate still carries', v6b.body.data && v6b.body.data.satisfied === true,
       JSON.stringify(v6b.body));
    const out = await notify.spent({ groupId: 'SA-NT-1', authorityId: r6.id, reference: 'X' });
    ok('a broken channel is reported, not thrown', Array.isArray(out.notified),
       JSON.stringify(out));
    const { rows: still } = await db.query(
      `SELECT status FROM stokvel_withdrawal_requests WHERE id = $1`, [r6.id]);
    ok('and the request is in the state the votes put it in',
       still[0] && still[0].status === 'approved', JSON.stringify(still));
    BREAK = false;

    /* ── THE SURFACE THAT CANNOT FAIL SILENTLY ─────────────────────── */
    console.log('\nwhat is waiting on you is on the card');
    await db.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, period_label, amount_due, amount_paid, due_date, status)
       VALUES ('SC-NT-1','SA-NT-1','INV-NT-SIG2','2026-11',500,0,CURRENT_DATE,'due')`);
    const listFor = async who =>
      ((await call('GET', '/api/stokvels', tok(who))).body.data || [])
        .find(x => x.id === 'SA-NT-1') || {};
    const sig2 = await listFor('INV-NT-SIG2');
    const plain = await listFor('INV-NT-PLAIN');
    ok('a signatory sees the votes outstanding on them',
       sig2.awaiting_my_vote >= 1, JSON.stringify(sig2.awaiting_my_vote));
    ok('a member who cannot vote is shown none',
       Number(plain.awaiting_my_vote) === 0, JSON.stringify(plain.awaiting_my_vote));
    /* Measured as a delta on one person rather than by comparing two, which
       the first draft did — and which then passed or failed on whatever the
       assertions above happened to leave pending. */
    const rBadge = await raise(Object.assign({ amount: 777 }, DEST), 'INV-NT-CHAIR');
    const mid = (await listFor('INV-NT-SIG2')).awaiting_my_vote;
    ok('a new request raises the count by one',
       mid === sig2.awaiting_my_vote + 1, `${sig2.awaiting_my_vote} -> ${mid}`);
    await vote(rBadge.id, 'INV-NT-SIG2');
    const after = (await listFor('INV-NT-SIG2')).awaiting_my_vote;
    ok('and a vote already cast stops counting', after === mid - 1,
       `${mid} -> ${after}; otherwise the badge never clears and is ignored`);
    ok('but it still counts for the signatories who have not voted',
       (await listFor('INV-NT-SIG1')).awaiting_my_vote === mid,
       'one signatory voting must not clear everybody else\u2019s badge');
    ok('money the member owes is on it too',
       Math.round(parseFloat(sig2.my_outstanding)) === 500, JSON.stringify(sig2.my_outstanding));
    ok('and it is their own, not the group’s',
       Number(plain.my_outstanding) === 0, JSON.stringify(plain.my_outstanding));

    /* The badge itself: rendered for the chairperson too, whose stokvel is
       drawn by the sub-account card and carries none of these counts. */
    const CORE = codeOnly(read('js/portal-core.js'));
    ok('the card reads the counts back off the stokvel list',
       /function _svBadge\(id\)/.test(CORE) && /PORTAL\.stokvels \|\| \[\]\)\.find/.test(CORE));
    ok('and the chairperson gets it as well as the members',
       /account_type === 'stokvel' \? _svBadge\(sa\.id\)/.test(CORE)
       && /_svBadge\(s\.id\)/.test(CORE),
       'the chairperson’s stokvel is a sub-account card — without this the one '
       + 'person most likely to be holding up a request is the one not told');

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
