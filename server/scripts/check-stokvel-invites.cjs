#!/usr/bin/env node
/* A stokvel can now build its own roster — without building a way round the
 * mandate while it does it.
 *
 * Onboarding was a staff typing job: somebody in the console pasted an
 * investor id into a prompt, and the only thing that moved a member from
 * 'invited' to 'active' was a staff dropdown. A fifteen-member stokvel
 * needed fifteen people already registered and fifteen manual rows, and the
 * chairperson could add nobody.
 *
 * THE ASSERTION THAT MATTERS MOST, and the reason to be careful here rather
 * than anywhere else in the feature:
 *
 *     AN INVITATION CAN NEVER PRODUCE A SIGNATORY.
 *
 * If it could, the mandate would be theatre: invite two friends, sign them
 * up, approve your own withdrawal. Everything the last five releases built
 * rests on no single person being able to manufacture a quorum, and an
 * invite endpoint is the shortest route to one. So: every membership this
 * creates is an ordinary member, there is no parameter that says otherwise,
 * and a member who once held signing power and left does not get it back by
 * being re-invited.
 *
 * The rest of what this holds:
 *
 *  · ONLY THE COMMITTEE INVITES. A stokvel wallet holds everybody's savings
 *    and "any member can add anyone" is not a door a savings club wants
 *    open.
 *  · ACCEPTING IS THE INVITEE'S OWN ACT, and it is checked against the
 *    contact the invitation was addressed to. There is no link, because a
 *    link is a capability: forwarded once it would let a stranger see a
 *    group's balances and roster. The match IS the authorisation, so the
 *    match is where the security is.
 *  · AN INVITATION IS SPENT ONCE. Not twice, not after it is revoked, not
 *    after it expires.
 *  · AN INVITEE SEES NOTHING UNTIL THEY ACCEPT, and a member who has left
 *    stops seeing it.
 *  · CONTACTS ARE MASKED to the group and closed to the generic table
 *    reader, which is open by default — unlisted, it would hand every
 *    signed-in investor a contact list of everybody any stokvel has asked.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-invites.cjs
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
const codeOnly = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

console.log('\nthe generic reader cannot hand out the contacts');
{
  const TB = codeOnly(read('server/routes/tables.js'));
  const list = TB.slice(TB.indexOf('ADMIN_ONLY_TABLES'), TB.indexOf('ADMIN_ONLY_TABLES') + 1400);
  ok('stokvel_invites is admin-only', /'stokvel_invites'/.test(list),
     'a table with no INVESTOR_COLS entry is readable by every signed-in investor, and '
     + 'these rows are an email address and a cell number for somebody who may not be a user');
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

/* Both channels stubbed. An invitation is the one message in the feature
   sent to somebody who may not be a user at all, so what matters is that
   each available channel is tried — not that any particular one is. */
const sent = { email: [], push: [], sms: [] };
function stub(record) {
  return new Proxy({}, {
    get(_t, k) {
      if (typeof k !== 'string' || k === 'then' || k === 'inspect') return undefined;
      return (...args) => { record.push({ fn: k, args }); return Promise.resolve({ ok: true }); };
    },
  });
}
function preload(rel, exports) {
  const p = path.join(ROOT, 'server', 'services', rel);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports };
}
preload('email.js',       stub(sent.email));
preload('pushService.js', stub(sent.push));
preload('sms.js',         stub(sent.sms));
const reset = () => { sent.email.length = 0; sent.push.length = 0; sent.sms.length = 0; };
const settle = async () => {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const n = sent.email.length + sent.push.length + sent.sms.length;
    if (n === last && i > 1) return;
    last = n;
    await new Promise(r => setTimeout(r, 25));
  }
};

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_invites') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no invitations table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_invites  WHERE sub_account_id LIKE 'SA-IV-%'`);
      await db.query(`DELETE FROM stokvel_members  WHERE sub_account_id LIKE 'SA-IV-%'`);
      await db.query(`DELETE FROM sub_accounts     WHERE id LIKE 'SA-IV-%'`);
      await db.query(`DELETE FROM investors        WHERE id LIKE 'INV-IV-%'`);
    };
    await clean();

    /* CHAIR opened it. SEC is the secretary. PLAIN is an ordinary member.
       OUTSIDE has an account and is not in the group. NOPHONE has an
       account under a different address from the one they will be invited
       at, which is the one real weakness of an addressed invitation. */
    const people = {
      'INV-IV-CHAIR':   { email: 'chair@example.test',   phone: '0721110001' },
      'INV-IV-SEC':     { email: 'sec@example.test',     phone: '0721110002' },
      'INV-IV-PLAIN':   { email: 'plain@example.test',   phone: '0721110003' },
      'INV-IV-OUTSIDE': { email: 'outside@example.test', phone: '0721110004' },
      'INV-IV-OTHERML': { email: 'work@example.test',    phone: '0721110005' },
      'INV-IV-SIGBACK': { email: 'sigback@example.test', phone: '0721110006' },
    };
    for (const [id, c] of Object.entries(people))
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, phone, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,$4,'active',0)`,
        [id, id.replace('INV-IV-', ''), c.email, c.phone]);

    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum)
       VALUES ('SA-IV-1','INV-IV-CHAIR','stokvel','Sizanani Stokvel',
               10000,'approved','active',2)`);
    const member = (inv, role, sig, status = 'active') => db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
       VALUES ($1,'SA-IV-1',$2,$3,$4,$5)`,
      ['SM-IV-' + inv.slice(-6), inv, role, sig, status]);
    await member('INV-IV-CHAIR', 'chairperson', true);
    await member('INV-IV-SEC',   'secretary',   false);
    await member('INV-IV-PLAIN', 'member',      false);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
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
    const invite = (who, body) => call('POST', '/api/stokvels/SA-IV-1/invites', tok(who), body);
    const mine   = who => call('GET', '/api/stokvels/invites/mine', tok(who));
    const accept = (who, vid) => call('POST', `/api/stokvels/invites/${vid}/accept`, tok(who), {});
    const roster = async inv => (await db.query(
      `SELECT role, is_signatory, status FROM stokvel_members
        WHERE sub_account_id='SA-IV-1' AND investor_id=$1`, [inv])).rows[0] || null;

    /* ── Who may invite ────────────────────────────────────────────── */
    console.log('\nonly the committee can ask somebody to join');
    const asPlain = await invite('INV-IV-PLAIN', { name: 'Thabo', email: 'thabo@example.test' });
    ok('an ordinary member cannot invite', asPlain.status === 403,
       `${asPlain.status} ${JSON.stringify(asPlain.body)}`);
    const asStranger = await invite('INV-IV-OUTSIDE', { name: 'Thabo', email: 'thabo@example.test' });
    ok('somebody outside the stokvel cannot either', asStranger.status === 404,
       '404 rather than 403 — they learn nothing, not even that the id is real');
    const asSec = await invite('INV-IV-SEC', { name: 'Thabo', email: 'Thabo@Example.TEST' });
    ok('the secretary can', asSec.status === 201, JSON.stringify(asSec.body));
    const asChair = await invite('INV-IV-CHAIR', { name: 'Zanele', cell: '072 111 0004' });
    ok('and so can whoever opened the account', asChair.status === 201, JSON.stringify(asChair.body));

    /* ── Contacts ──────────────────────────────────────────────────── */
    console.log('\nand a contact is stored so that "the same person" is decidable');
    const { rows: [stored] } = await db.query(
      `SELECT email, cell, matched_investor_id FROM stokvel_invites WHERE id = $1`,
      [asSec.body.data.id]);
    ok('an email is lower-cased', stored.email === 'thabo@example.test', stored.email);
    const { rows: [byCell] } = await db.query(
      `SELECT cell, matched_investor_id FROM stokvel_invites WHERE id = $1`,
      [asChair.body.data.id]);
    ok('a cell keeps its last nine digits only', byCell.cell === '721110004', byCell.cell);
    ok('and a contact that already has an account is resolved at once',
       byCell.matched_investor_id === 'INV-IV-OUTSIDE', JSON.stringify(byCell));
    ok('the contact is masked in what comes back',
       !/thabo@example\.test/.test(JSON.stringify(asSec.body)), JSON.stringify(asSec.body));

    console.log('\nand each channel we have is tried');
    reset();
    const reach = await invite('INV-IV-CHAIR', { name: 'Both', email: 'both@example.test', cell: '0821234567' });
    await settle();
    ok('an email address gets an email',
       sent.email.some(c => c.fn === 'sendStokvelInvite'), JSON.stringify(sent.email.map(c => c.fn)));
    ok('a cell number gets an SMS',
       sent.sms.some(c => c.fn === 'sendStokvelInvite'), JSON.stringify(sent.sms.map(c => c.fn)));
    ok('and the SMS number is dialable, not nine bare digits',
       sent.sms.some(c => /^0\d{9}$|^\+27/.test(String(c.args[0] || ''))),
       JSON.stringify(sent.sms.map(c => c.args[0])));
    ok('a contact that already has an account is pushed as well',
       (await (async () => { reset();
          await invite('INV-IV-CHAIR', { name: 'Known', email: 'sigback@example.test' });
          await settle();
          return sent.push.some(c => c.fn === 'sendPushToInvestor'); })()),
       'they are holding the phone — an email is the slow way to reach them');
    ok('and no message carries a join link',
       !/\/invites?\/[A-Z0-9-]{8,}/.test(JSON.stringify(sent.email) + JSON.stringify(sent.sms)),
       'a link is a capability — forwarded once it shows a stranger the group’s money');
    await db.query(`DELETE FROM stokvel_invites WHERE email IN ('both@example.test','sigback@example.test')`);

    /* ── Refusals ──────────────────────────────────────────────────── */
    console.log('\nand the obvious mistakes are refused with a reason');
    const twice = await invite('INV-IV-CHAIR', { name: 'Thabo again', email: 'thabo@example.test' });
    ok('inviting the same contact twice is refused', twice.status === 409,
       `${twice.status} ${JSON.stringify(twice.body)}`);
    const existing = await invite('INV-IV-CHAIR', { name: 'Plain', email: 'plain@example.test' });
    ok('inviting somebody already in the stokvel is refused', existing.status === 409,
       JSON.stringify(existing.body));
    const self = await invite('INV-IV-CHAIR', { email: 'chair@example.test' });
    ok('inviting yourself is refused', self.status >= 400, JSON.stringify(self.body));
    const nothing = await invite('INV-IV-CHAIR', { name: 'Nobody' });
    ok('an invitation with no contact at all is refused', nothing.status === 400,
       JSON.stringify(nothing.body));
    const junk = await invite('INV-IV-CHAIR', { name: 'Junk', email: 'not-an-address' });
    ok('and so is one to something that is not an address', junk.status === 400,
       JSON.stringify(junk.body));

    /* ── Before accepting, they see nothing ────────────────────────── */
    console.log('\nan invitee sees the invitation and nothing else');
    const outsideList = await call('GET', '/api/stokvels', tok('INV-IV-OUTSIDE'));
    ok('the stokvel is not in their list yet',
       !((outsideList.body.data || []).some(x => x.id === 'SA-IV-1')),
       JSON.stringify(outsideList.body.data));
    const outsideHub = await call('GET', '/api/stokvels/SA-IV-1', tok('INV-IV-OUTSIDE'));
    ok('and its detail is a 404 to them', outsideHub.status === 404, String(outsideHub.status));
    const theirs = await mine('INV-IV-OUTSIDE');
    ok('but the invitation is on their own screen',
       (theirs.body.data || []).some(v => v.id === asChair.body.data.id),
       JSON.stringify(theirs.body));
    ok('with who asked and how big the group is',
       (theirs.body.data || [])[0] && (theirs.body.data || [])[0].invited_by_name === 'CHAIR',
       JSON.stringify(theirs.body.data));

    /* ── The match is the authorisation ────────────────────────────── */
    console.log('\nand accepting is checked against who it was addressed to');
    const wrongHands = await accept('INV-IV-PLAIN', asChair.body.data.id);
    ok('somebody else holding the id cannot accept it', wrongHands.status === 403,
       `${wrongHands.status} ${JSON.stringify(wrongHands.body)}`);
    ok('and is told which contact it went to, masked',
       /\*/.test(wrongHands.body.error || '') && !/0721110004|721110004/.test(wrongHands.body.error || ''),
       wrongHands.body.error);
    const otherAddr = await invite('INV-IV-CHAIR', { name: 'Other', email: 'personal@example.test' });
    const notTheirs = await accept('INV-IV-OTHERML', otherAddr.body.data.id);
    ok('an account under a different address sees and accepts nothing',
       notTheirs.status === 403 &&
       !((await mine('INV-IV-OTHERML')).body.data || []).some(v => v.id === otherAddr.body.data.id),
       'the cost of an addressed invitation, and why the committee can see pending ones');

    /* ── Accepting ─────────────────────────────────────────────────── */
    console.log('\naccepting makes an ordinary member, and only that');
    reset();
    const joined = await accept('INV-IV-OUTSIDE', asChair.body.data.id);
    await settle();
    ok('the invitee can accept their own invitation', joined.status === 200,
       `${joined.status} ${JSON.stringify(joined.body)}`);
    const r = await roster('INV-IV-OUTSIDE');
    ok('they are active', r && r.status === 'active', JSON.stringify(r));
    ok('THEY ARE NOT A SIGNATORY', r && r.is_signatory === false, JSON.stringify(r));
    ok('and they hold no office', r && r.role === 'member', JSON.stringify(r));
    ok('the stokvel is now in their list',
       ((await call('GET', '/api/stokvels', tok('INV-IV-OUTSIDE'))).body.data || [])
         .some(x => x.id === 'SA-IV-1'));
    ok('the invitation is gone from their screen',
       !((await mine('INV-IV-OUTSIDE')).body.data || []).some(v => v.id === asChair.body.data.id));
    ok('and whoever invited them is told it worked',
       sent.push.concat(sent.email).some(c => JSON.stringify(c.args).includes('INV-IV-CHAIR')
                                           || /accepted/i.test(JSON.stringify(c.args))),
       'an invitation sent into silence is indistinguishable from one sent to the wrong address');

    console.log('\nand an invitation is spent once');
    const again = await accept('INV-IV-OUTSIDE', asChair.body.data.id);
    ok('it cannot be accepted twice', again.status === 409,
       `${again.status} ${JSON.stringify(again.body)}`);

    const revokeMe = await invite('INV-IV-CHAIR', { name: 'Gone', email: 'gone@example.test' });
    const notCommittee = await call('DELETE',
      `/api/stokvels/SA-IV-1/invites/${revokeMe.body.data.id}`, tok('INV-IV-PLAIN'));
    ok('an ordinary member cannot withdraw an invitation', notCommittee.status === 403,
       String(notCommittee.status));
    const revoked = await call('DELETE',
      `/api/stokvels/SA-IV-1/invites/${revokeMe.body.data.id}`, tok('INV-IV-CHAIR'));
    ok('the committee can', revoked.status === 200, JSON.stringify(revoked.body));
    await db.query(
      `INSERT INTO investors (id, first_name, email, phone, status, wallet_balance)
       VALUES ('INV-IV-GONE','Gone','gone@example.test','0729990000','active',0)`);
    const afterRevoke = await accept('INV-IV-GONE', revokeMe.body.data.id);
    ok('and a withdrawn invitation cannot be accepted', afterRevoke.status === 409,
       `${afterRevoke.status} ${JSON.stringify(afterRevoke.body)}`);
    ok('nor is it on the screen of the person it went to',
       !((await mine('INV-IV-GONE')).body.data || []).some(v => v.id === revokeMe.body.data.id));

    const expired = await invite('INV-IV-CHAIR', { name: 'Late', email: 'late@example.test' });
    await db.query(`UPDATE stokvel_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
                   [expired.body.data.id]);
    await db.query(
      `INSERT INTO investors (id, first_name, email, phone, status, wallet_balance)
       VALUES ('INV-IV-LATE','Late','late@example.test','0729990001','active',0)`);
    ok('an expired invitation cannot be accepted',
       (await accept('INV-IV-LATE', expired.body.data.id)).status === 409);
    ok('and is not shown as something to answer',
       !((await mine('INV-IV-LATE')).body.data || []).some(v => v.id === expired.body.data.id));

    /* ── The hole this must never open ─────────────────────────────── */
    console.log('\nand signing power cannot be reached through an invitation');
    const sneaky = await invite('INV-IV-CHAIR', {
      name: 'Ally', email: 'sigback@example.test',
      /* Everything a caller might hope is read back off the request. */
      is_signatory: true, role: 'treasurer', status: 'active',
    });
    ok('an invitation that asks for signing power is still just an invitation',
       sneaky.status === 201, JSON.stringify(sneaky.body));
    const sneakyAccept = await accept('INV-IV-SIGBACK', sneaky.body.data.id);
    const sr = await roster('INV-IV-SIGBACK');
    ok('and accepting it grants none',
       sneakyAccept.status === 200 && sr && sr.is_signatory === false && sr.role === 'member',
       JSON.stringify(sr));
    ok('the mandate still counts the signatories it counted before',
       (await db.query(`SELECT COUNT(*)::int AS n FROM stokvel_members
                         WHERE sub_account_id='SA-IV-1' AND status='active' AND is_signatory=true`))
         .rows[0].n === 1,
       'if an invitation could add one, a chairperson could manufacture a quorum alone');

    /* A signatory who leaves and is invited back does NOT get it back. */
    await db.query(
      `UPDATE stokvel_members SET status='exited', is_signatory=true
        WHERE sub_account_id='SA-IV-1' AND investor_id='INV-IV-SIGBACK'`);
    const backAgain = await invite('INV-IV-CHAIR', { name: 'Ally', email: 'sigback@example.test' });
    ok('somebody who has left can be invited back', backAgain.status === 201, JSON.stringify(backAgain.body));
    await accept('INV-IV-SIGBACK', backAgain.body.data.id);
    const back = await roster('INV-IV-SIGBACK');
    ok('and comes back WITHOUT the signing power they used to hold',
       back && back.status === 'active' && back.is_signatory === false, JSON.stringify(back));

    /* ── Transparency, with the contact still masked ───────────────── */
    console.log('\nthe group can see who has been asked, and not their details');
    const seen = await call('GET', '/api/stokvels/SA-IV-1/invites', tok('INV-IV-PLAIN'));
    ok('an ordinary member sees the list', seen.status === 200 && Array.isArray(seen.body.data),
       JSON.stringify(seen.status));
    ok('but gets no invite button', seen.body.can_invite === false, JSON.stringify(seen.body.can_invite));
    /* The LOCAL PART is what must not be there. Masking the domain too
       would be pointless — it is the half that tells a member "that is the
       work address, not the one she uses", which is the whole reason this
       list exists. */
    ok('and no full contact details',
       !/(thabo|plain|personal|gone|late)@/.test(JSON.stringify(seen.body.data)),
       JSON.stringify(seen.body.data).slice(0, 300));
    ok('though enough of one to spot the wrong address',
       /\*+@example\.test/.test(JSON.stringify(seen.body.data)),
       JSON.stringify(seen.body.data).slice(0, 300));
    ok('the committee does get the button',
       (await call('GET', '/api/stokvels/SA-IV-1/invites', tok('INV-IV-SEC'))).body.can_invite === true);
    ok('and somebody outside the stokvel sees nothing at all',
       (await call('GET', '/api/stokvels/SA-IV-1/invites', tok('INV-IV-OTHERML'))).status === 404);

    /* ── Bounds on abuse ───────────────────────────────────────────── */
    console.log('\nand the endpoint is not an email cannon');
    const svc = require(path.join(ROOT, 'server', 'services', 'stokvelInvites.js'));
    await db.query(
      `INSERT INTO stokvel_invites (id, sub_account_id, invited_by, email, expires_at)
       SELECT 'SVI-BULK-' || g, 'SA-IV-1', 'INV-IV-CHAIR', 'bulk' || g || '@example.test',
              NOW() + INTERVAL '10 days'
         FROM generate_series(1, $1) g`, [svc.MAX_PENDING_INVITES]);
    const capped = await invite('INV-IV-CHAIR', { name: 'One more', email: 'onemore@example.test' });
    ok('there is a ceiling on invitations waiting at once', capped.status === 429,
       `${capped.status} ${JSON.stringify(capped.body)}`);
    await db.query(`DELETE FROM stokvel_invites WHERE id LIKE 'SVI-BULK-%'`);

    /* The roster cap, at BOTH ends. Measured rather than read off the
       source: the first draft of this scanned for MAX_MEMBERS inside
       accept() with an unbounded slice, which caught module.exports instead
       and passed with the whole check deleted.

       The case is a real one. A group fills up while an invitation is
       outstanding, and the invitation is then accepted, so the cap has to be
       re-checked at the moment of joining and not only when inviting. */
    const pendingLast = await invite('INV-IV-CHAIR', { name: 'Last', email: 'last@example.test' });
    await db.query(
      `INSERT INTO investors (id, first_name, email, phone, status, wallet_balance)
       VALUES ('INV-IV-LAST','Last','last@example.test','0729990002','active',0)`);
    for (let g = 1; g <= svc.MAX_MEMBERS; g++) {
      await db.query(
        `INSERT INTO investors (id, first_name, email, phone, status, wallet_balance)
         VALUES ($1,'Fill',$2,$3,'active',0)`,
        [`INV-IV-FILL-${g}`, `fill${g}@example.test`, `073000${String(g).padStart(4, '0')}`]);
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status)
         VALUES ($1,'SA-IV-1',$2,'member',false,'active')
         ON CONFLICT (sub_account_id, investor_id) DO NOTHING`,
        [`SM-IV-FILL-${g}`, `INV-IV-FILL-${g}`]);
    }
    const overflowed = await accept('INV-IV-LAST', pendingLast.body.data.id);
    ok('and a ceiling on the roster, re-checked when they accept',
       overflowed.status === 409, `${overflowed.status} ${JSON.stringify(overflowed.body)}`);
    ok('the member who could not join is not half-added',
       (await roster('INV-IV-LAST')) === null, JSON.stringify(await roster('INV-IV-LAST')));
    await db.query(`DELETE FROM stokvel_members WHERE id LIKE 'SM-IV-FILL-%'`);
    await db.query(`DELETE FROM investors WHERE id LIKE 'INV-IV-FILL-%'`);

    /* ── The rule, in the one place it is written ──────────────────── */
    console.log('\nand the rule is written where there is no parameter for it');
    const SVC = codeOnly(read('server/services/stokvelInvites.js'));
    const acceptFn = SVC.slice(SVC.indexOf('async function accept'), SVC.indexOf('async function decline'));
    ok('accept writes is_signatory false as a literal',
       /is_signatory = false|,false,/.test(acceptFn.replace(/\s+/g, '')) || /false,'active'/.test(acceptFn.replace(/\s+/g, '')),
       acceptFn.slice(0, 200));
    ok('and never reads a signatory flag off the invitation',
       !/invite\.is_signatory|invite\.role/.test(acceptFn),
       'the values are written here so that there is nothing to tamper with');

    await clean();
    await db.query(`DELETE FROM investors WHERE id IN ('INV-IV-GONE','INV-IV-LATE','INV-IV-LAST')`);
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
