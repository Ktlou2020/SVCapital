#!/usr/bin/env node
/* A group changes its own mandate — and still no one person can.
 *
 * Who signs, how many must agree, and the date the money is locked until
 * used to be set by SV Capital staff in the console. A group now proposes the
 * change itself, and the signatories approve it to the quorum exactly as they
 * approve money. That is only safe if every way round the quorum is closed,
 * so most of this file is refusals:
 *
 *  · A member who is neither on the committee nor a signatory proposing.
 *  · A mandate of one, or a quorum the signatories could never reach.
 *  · Making somebody a signatory who is not an active member.
 *  · A signatory voting on their own removal.
 *  · A rejection being out-voted.
 *  · A lock date in the past.
 *  · A change that was valid when raised and is not when it carries.
 *
 * And the happy path: carried changes take effect in the same vote, once.
 * Plus the warning a savings club needs: an investment that matures after
 * the group's lock date says so on the request.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-mandate-change.cjs
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

console.log('\nthe rules are written once');
{
  const SVC = read('server/services/stokvelMandateChange.js');
  const ROUTE = read('server/routes/stokvels.js');
  ok('the change is counted by the same mandate as money',
     /require\('\.\/stokvelMandate'\)/.test(SVC) && /currentSignatories/.test(SVC));
  ok('and applied inside the vote that carries it',
     /mandateChange\.apply\(client, group, request\)/.test(ROUTE),
     'an approved change waiting on a second button is a change one person can sit on');
  ok('a mandate of one is refused here too', /MIN_QUORUM/.test(SVC));
  ok('the schema allows the new kind',
     /'payout','mandate'[,)]/.test(read('server/db/setup.js')));
  ok('and an invitation still never produces a signatory',
     !/is_signatory\s*=\s*true/.test(read('server/services/stokvelInvites.js')));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const http = require('http');
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows: ready } = await db.query(
      `SELECT to_regclass('public.stokvel_withdrawal_requests') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no mandate tables here'); return; }

    const G = 'SA-MC-1';
    const P = 'INV-MC-';
    const clean = async () => {
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id = $1)`, [G]);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [G]);
      await db.query(`DELETE FROM investment_pools WHERE id = 'POOL-MC-LONG'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-MC-%'`);
    };
    await clean();

    for (const who of ['CHAIR', 'SIG1', 'SIG2', 'PLAIN', 'NEW', 'OUTSIDER'])
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1,$2,'Mc',$3,'active',0)`,
        [P + who, who.charAt(0) + who.slice(1).toLowerCase(), `${(P + who).toLowerCase()}@example.test`]);
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum)
       VALUES ($1,$2,'stokvel','Kopanang Savings Club',20000,'approved','active',2)`, [G, P + 'CHAIR']);
    const member = (who, role, sig) => db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
       VALUES ($1,$2,$3,$4,$5,'active',NOW())`, ['SM-MC-' + who, G, P + who, role, sig]);
    await member('CHAIR', 'chairperson', true);
    await member('SIG1',  'treasurer',   true);
    await member('SIG2',  'member',      true);
    await member('PLAIN', 'member',      false);
    await member('NEW',   'member',      false);
    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months, min_investment)
       VALUES ('POOL-MC-LONG','Cattle - eighteen months','cattle','open',0.14,18,500)`);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
                               process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, who, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${tok(P + who)}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s2 = ''; x.on('data', c => s2 += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s2 || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });
    const propose = (who, change) =>
      call('POST', `/api/stokvels/${G}/withdrawal-requests`, who, Object.assign({ kind: 'mandate' }, change));
    const vote = (rid, who, decision = 'approve') =>
      call('POST', `/api/stokvels/${G}/withdrawal-requests/${rid}/vote`, who, { decision });
    const isSig = async who => (await db.query(
      `SELECT is_signatory FROM stokvel_members WHERE sub_account_id = $1 AND investor_id = $2`,
      [G, P + who])).rows[0].is_signatory;
    const groupRow = async () => (await db.query(
      `SELECT stokvel_quorum, to_char(withdrawal_date, 'YYYY-MM-DD') AS lock FROM sub_accounts WHERE id = $1`,
      [G])).rows[0];
    const future = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

    console.log('\nwho may propose');
    const plain = await propose('PLAIN', { quorum: 3 });
    ok('an ordinary member who is not a signatory cannot', plain.status === 403, `${plain.status}`);

    console.log('\nwhat is never a mandate');
    const one = await propose('CHAIR', { quorum: 1 });
    ok('a quorum of one is refused', one.status === 400 && /mandate of one/i.test(one.body.error || ''),
       one.body.error);
    const tooMany = await propose('CHAIR', { quorum: 4 });
    ok('nor more approvals than there are signatories',
       tooMany.status === 400 && /nothing could ever be approved/i.test(tooMany.body.error || ''),
       tooMany.body.error);
    const outsider = await propose('CHAIR', { add_signatory: P + 'OUTSIDER' });
    ok('only an active member can be made a signatory', outsider.status === 400, outsider.body.error);
    const past = await propose('CHAIR', { lock_date: '2020-12-01' });
    ok('a lock date in the past is refused', past.status === 400 && /future/i.test(past.body.error || ''),
       past.body.error);
    const nothing = await propose('CHAIR', {});
    ok('and so is a change that changes nothing', nothing.status === 400, nothing.body.error);

    console.log('\nadding a signatory, carried by the quorum');
    const add = await propose('CHAIR', { add_signatory: P + 'PLAIN' });
    ok('the chairperson can propose it', add.status === 201 && add.body.data.kind === 'mandate',
       JSON.stringify(add.body));
    ok('and it says what it does in words', /make Plain Mc a signatory/.test(add.body.data.change_summary || ''),
       add.body.data.change_summary);
    await vote(add.body.data.id, 'CHAIR');
    ok('one approval does not apply it', (await isSig('PLAIN')) === false);
    const nonSigVote = await vote(add.body.data.id, 'PLAIN');
    ok('the person being added cannot vote for themselves', nonSigVote.status === 403, `${nonSigVote.status}`);
    const carried = await vote(add.body.data.id, 'SIG1');
    ok('the second approval carries it and applies it',
       carried.status === 200 && carried.body.data.applied === true && (await isSig('PLAIN')) === true,
       JSON.stringify(carried.body));
    const again = await vote(add.body.data.id, 'SIG2');
    ok('and it is spent: nobody votes on it again', again.status === 409, `${again.status}`);

    console.log('\nremoving a signatory');
    const rm = await propose('SIG1', { remove_signatory: P + 'SIG2' });
    ok('a signatory can propose it', rm.status === 201, JSON.stringify(rm.body));
    const self = await vote(rm.body.data.id, 'SIG2', 'reject');
    ok('the signatory being removed cannot vote it down',
       self.status === 403 && /own removal/i.test(self.body.error || ''), self.body.error);
    await vote(rm.body.data.id, 'CHAIR');
    await vote(rm.body.data.id, 'SIG1');
    ok('the others carry it without them', (await isSig('SIG2')) === false);

    console.log('\na rejection ends it');
    const lockDate = future(40);
    const lk = await propose('CHAIR', { lock_date: lockDate });
    await vote(lk.body.data.id, 'CHAIR');
    const no = await vote(lk.body.data.id, 'PLAIN', 'reject');
    ok('one signatory saying no closes it', no.body.data && no.body.data.status === 'rejected',
       JSON.stringify(no.body));
    ok('and the lock date is unchanged', (await groupRow()).lock === null);

    console.log('\nlocking the money until a date');
    const lk2 = await propose('CHAIR', { lock_date: lockDate, quorum: 3 });
    await vote(lk2.body.data.id, 'CHAIR');
    await vote(lk2.body.data.id, 'SIG1');
    const row = await groupRow();
    ok('carried, it sets the lock date and the quorum together',
       row.lock === lockDate && Number(row.stokvel_quorum) === 3, JSON.stringify(row));
    const detail = await call('GET', `/api/stokvels/${G}`, 'PLAIN');
    ok('and every member can see the lock date',
       String(detail.body.data.lock_date || '').slice(0, 10) === lockDate, JSON.stringify(detail.body.data));

    console.log('\nre-checked when it carries, not only when it is raised');
    const drop = await propose('CHAIR', { quorum: 2 });
    /* The roster moves underneath it: a signatory leaves before the vote. */
    await db.query(`UPDATE stokvel_members SET is_signatory = false
                     WHERE sub_account_id = $1 AND investor_id = $2`, [G, P + 'PLAIN']);
    await db.query(`UPDATE stokvel_members SET is_signatory = true
                     WHERE sub_account_id = $1 AND investor_id = $2`, [G, P + 'NEW']);
    const rmChair = await propose('SIG1', { remove_signatory: P + 'NEW' });
    ok('a change that would leave too few signatories is refused when raised',
       rmChair.status === 400 && /nothing could ever be approved/i.test(rmChair.body.error || ''),
       rmChair.body.error);
    await vote(drop.body.data.id, 'CHAIR');
    await vote(drop.body.data.id, 'SIG1');
    const done = await vote(drop.body.data.id, 'NEW');
    ok('a valid change still carries with the new roster',
       done.status === 200 && Number((await groupRow()).stokvel_quorum) === 2, JSON.stringify(done.body));

    const stale = await propose('CHAIR', { add_signatory: P + 'PLAIN' });
    ok('a change can be raised while it is valid', stale.status === 201, JSON.stringify(stale.body));
    await db.query(`UPDATE stokvel_members SET is_signatory = true
                     WHERE sub_account_id = $1 AND investor_id = $2`, [G, P + 'PLAIN']);
    await vote(stale.body.data.id, 'CHAIR');
    const late = await vote(stale.body.data.id, 'SIG1');
    ok('and is refused when it carries if the roster no longer allows it',
       late.status === 409 && /no longer be made/i.test(late.body.error || ''), late.body.error);

    console.log('\nan investment that outlasts the lock date');
    const inv = await call('POST', `/api/stokvels/${G}/withdrawal-requests`, 'PLAIN',
      { kind: 'investment', amount: 1000, pool_id: 'POOL-MC-LONG' });
    ok('is still allowed to be raised', inv.status === 201, JSON.stringify(inv.body));
    ok('but says it will not be back in time',
       /after the group’s lock date/.test(inv.body.data.lock_warning || ''), inv.body.data.lock_warning);
    const reg = await call('GET', `/api/stokvels/${G}/withdrawal-requests`, 'SIG1');
    const onReg = (reg.body.data || []).find(r => r.id === inv.body.data.id);
    ok('and the signatories see the same warning on the request',
       !!(onReg && onReg.lock_warning), JSON.stringify(onReg));
    const mc = (reg.body.data || []).find(r => r.kind === 'mandate');
    ok('a mandate change on the register carries its summary', !!(mc && mc.change_summary));

    console.log('\nthe returns view and the maturity calendar');
    const after = future(400), before = future(20);
    await db.query(
      `INSERT INTO investments (id, investor_id, sub_account_id, pool_id, amount, status, end_date, expected_return)
       VALUES ('INV-MC-I1',$1,$2,'POOL-MC-LONG',5000,'active',$3,700),
              ('INV-MC-I2',$1,$2,'POOL-MC-LONG',2000,'active',$4,120)`, [P + 'CHAIR', G, after, before]);
    const iv = await call('GET', `/api/stokvels/${G}/investments`, 'PLAIN');
    ok('says what the active money is expected to earn',
       iv.status === 200 && Number(iv.body.totals.expected_active) === 820, JSON.stringify(iv.body.totals));
    ok('and when the next of it comes back', iv.body.totals.next_maturity === before,
       JSON.stringify(iv.body.totals));
    ok('alongside the lock date it is measured against', iv.body.lock_date === lockDate,
       String(iv.body.lock_date));
    await db.query(`DELETE FROM investments WHERE id IN ('INV-MC-I1','INV-MC-I2')`);

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
