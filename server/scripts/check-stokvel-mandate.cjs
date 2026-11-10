#!/usr/bin/env node
/* No single person gets money out of a stokvel.
 *
 * That sentence is the entire product. A stokvel puts up with an account
 * paying nothing because three people have to sign before a rand leaves; any
 * platform that cannot promise the same is asking them to trust one member
 * with everyone's savings.
 *
 * Before this, a stokvel withdrawal was a sub-account withdrawal, and that
 * route asks one question: is the caller sub_accounts.parent_investor_id?
 * The chairperson, alone, could empty it.
 *
 * And INVESTING was not gated at all, which left the smaller half of the
 * same hole: a chairperson who could not take R50 000 out of the group
 * wallet could still put it into a seven-year pool on their own. Money in a
 * pool is money out of the wallet. Both now clear the same mandate, matched
 * by the same code — a withdrawal against a bank account, an investment
 * against a pool.
 *
 * Now a stokvel withdrawal must quote an authority the signatories granted.
 * Everything below is a way somebody would try to get round that, and most
 * of this file is the refusals rather than the happy path:
 *
 *  · No authority at all.
 *  · An authority short of quorum.
 *  · An authority for less money than is being taken.
 *  · An authority approved for a DIFFERENT BANK ACCOUNT — the one that makes
 *    the difference between a mandate and a formality. Approving a sum while
 *    the carrier picks the destination authorises nothing worth having.
 *  · The same authority used twice.
 *  · A non-signatory voting.
 *  · One signatory voting twice to reach quorum alone.
 *  · Approvals from somebody who was a signatory when they voted and is not
 *    one now — add an ally, collect the vote, remove them, withdraw.
 *  · A rejection being out-voted.
 *
 * And one thing it must NOT do: get in the way of an ordinary sub-account.
 * A trust or a child's account is not a stokvel and keeps working as before.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-mandate.cjs
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

const WD  = read('server/routes/withdrawals.js');
const SVC = read('server/services/stokvelMandate.js');

console.log('\nand an exit is matched on the member, not the amount');
{
  const code = SVC.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('an exit authority pins WHOSE membership ends',
     /exit_investor_id/.test(code) && /approved to settle a different member/.test(SVC),
     'otherwise the signatories authorise a sum and the carrier picks whose exit it pays');
  ok('and deliberately does not pin the amount',
     /want\.kind !== 'exit' && want\.kind !== 'payout' &&/.test(code),
     '"settle her share" is whatever it comes to on the day \u2014 interest arriving between '
     + 'the approval and the settlement must not send her round the signatories again');
  ok('every kind is constrained in the schema',
     /kind IN \('withdrawal','investment','exit','payout','mandate','notice_deposit'\)/.test(read('server/db/setup.js')),
     'a kind the database will not store is a feature that fails at the last step');
  ok('a payout authority pins WHICH distribution',
     /payout_id/.test(code) && /approved for a different payout/.test(SVC),
     'the signatories approve the distribution, once \u2014 not one withdrawal per member');
  ok('and the old constraint is dropped first, not skipped',
     /DROP CONSTRAINT swr_kind_chk/.test(read('server/db/setup.js')),
     'ADD CONSTRAINT with EXCEPTION duplicate_object keeps the old one on a database that '
     + 'already has it, refusing every exit while reporting success');
}

console.log('\nthe rule is written once');
{
  ok('the mandate is a service, not a copy in each caller',
     /module\.exports = \{[^}]*evaluate/.test(SVC));
  ok('and both the vote and the withdrawal gate use it',
     /require\('\.\.\/services\/stokvelMandate'\)/.test(WD)
     && /require\('\.\.\/services\/stokvelMandate'\)/.test(read('server/routes/stokvels.js')),
     'two definitions of "is this authorised" is two answers, and the wrong one holds the money');
  ok('only current signatories are counted',
     /signatories\.has\(v\.investor_id\)/.test(SVC),
     'otherwise: add an ally, take their vote, remove them, withdraw');
  ok('a rejection is not out-voted',
     /rejections > 0/.test(SVC));
  ok('and the quorum can only go up',
     /Math\.max\([\s\S]{0,200}quorum_required[\s\S]{0,200}stokvel_quorum/.test(SVC),
     'lowering the mandate must not release requests already in flight');
  ok('a mandate of one is refused',
     /MIN_QUORUM = 2/.test(SVC) && /quorum_required >= 2/.test(read('server/db/setup.js')));
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

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-MD-%')`);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id LIKE 'SA-MD-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-MD-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-MD2-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-MD-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-MD2-%'`);
    };
    await clean();

    for (const id of ['INV-MD2-CHAIR','INV-MD2-SIG1','INV-MD2-SIG2','INV-MD2-PLAIN','INV-MD2-EX'])
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1,$2,'Sig',$3,'active',0)`,
        [id, id.replace('INV-MD2-',''), `${id.toLowerCase()}@example.test`]);

    /* Quorum 2 of 3. KYC approved so the withdrawal route gets as far as the
       mandate rather than stopping before it. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status, stokvel_quorum)
       VALUES ('SA-MD-1','INV-MD2-CHAIR','stokvel','Masakhane Stokvel',
               50000,'approved','active',2)`);
    /* An ordinary sub-account, to prove the gate is about stokvels. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status)
       VALUES ('SA-MD-2','INV-MD2-CHAIR','trust','A Family Trust',50000,'approved','active')`);

    const member = (inv, role, sig, status='active') => db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
       VALUES ($1,'SA-MD-1',$2,$3,$4,$5,NOW())`,
      [`SM2-${inv}`, inv, role, sig, status]);
    await member('INV-MD2-CHAIR','chairperson', true);
    await member('INV-MD2-SIG1', 'treasurer',   true);
    await member('INV-MD2-SIG2', 'secretary',   true);
    await member('INV-MD2-PLAIN','member',      false);
    await member('INV-MD2-EX',   'member',      true);   // signatory for now

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels',    require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    app.use('/api/withdrawals', require(path.join(ROOT, 'server', 'routes', 'withdrawals.js')));
    app.use('/api/tables',      require(path.join(ROOT, 'server', 'routes', 'tables.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    /* investorId, camelCase — the shape server/routes/auth.js signToken
       actually issues. Signing investor_id instead tested a token the
       platform never mints, and hid a route that read the wrong field and
       answered "no stokvels" to every real client. */
    const tok = id => jwt.sign({ id: 'u-' + id, role: 'investor', investorId: id },
                               process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = (method, p, token, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s2 = ''; x.on('data', c => s2 += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s2 || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });

    const DEST = { bank_name: 'FNB', bank_account_number: '62012345678' };
    const raise = async (amount, by = 'INV-MD2-PLAIN', dest = DEST) =>
      (await call('POST', '/api/stokvels/SA-MD-1/withdrawal-requests', tok(by),
                  Object.assign({ amount, reason: 'December payout' }, dest))).body.data;
    /* Same endpoint, different kind — one mandate, two sorts of movement. */
    const raiseInvest = async (amount, poolId = 'POOL-MD-OPEN') =>
      (await call('POST', '/api/stokvels/SA-MD-1/withdrawal-requests', tok('INV-MD2-PLAIN'),
                  { amount, kind: 'investment', pool_id: poolId, reason: 'Into the November pool' })).body.data;
    const vote = (rid, who, decision = 'approve') =>
      call('POST', `/api/stokvels/SA-MD-1/withdrawal-requests/${rid}/vote`, tok(who), { decision });
    const withdraw = (amount, authority_id, dest = DEST) =>
      call('POST', '/api/withdrawals/request', tok('INV-MD2-CHAIR'),
           Object.assign({ amount, sub_account_id: 'SA-MD-1', authority_id }, dest));
    const balance = async () => Number((await db.query(
      `SELECT wallet_balance::float b FROM sub_accounts WHERE id='SA-MD-1'`)).rows[0].b);

    console.log('\nthe chairperson, acting alone');
    const alone = await withdraw(5000, '');
    ok('is refused outright', alone.status === 403, `${alone.status} ${JSON.stringify(alone.body)}`);
    ok('and told what to do instead', /approved authority/i.test(alone.body.error || ''));
    ok('the money has not moved', await balance() === 50000);

    console.log('\none approval short of the mandate');
    const r1 = await raise(5000);
    ok('a member can raise a request', !!r1 && !!r1.id, JSON.stringify(r1));
    await vote(r1.id, 'INV-MD2-SIG1');
    const short = await withdraw(5000, r1.id);
    ok('one of two does not release it', short.status === 403, `${short.status}`);
    ok('and says how far short it is', /1 of 2/.test(short.body.error || ''), short.body.error);

    console.log('\nthe ways a signatory might try to reach quorum alone');
    const twice = await vote(r1.id, 'INV-MD2-SIG1');
    ok('voting twice is refused', twice.status === 409, `${twice.status}`);
    const outsider = await vote(r1.id, 'INV-MD2-PLAIN');
    ok('a member who is not a signatory cannot vote', outsider.status === 403, `${outsider.status}`);

    console.log('\nthe mandate satisfied');
    const carried = await vote(r1.id, 'INV-MD2-SIG2');
    ok('the second signatory carries it', carried.body.data && carried.body.data.satisfied === true,
       JSON.stringify(carried.body));

    console.log('\nbut only for what was approved');
    const more = await withdraw(9000, r1.id);
    ok('a larger amount is refused', more.status === 403 && /not R9000/.test(more.body.error || ''),
       more.body.error);
    const elsewhere = await withdraw(5000, r1.id, { bank_name: 'FNB', bank_account_number: '99999999999' });
    ok('a different bank account is refused', elsewhere.status === 403
       && /different bank account/i.test(elsewhere.body.error || ''), elsewhere.body.error);
    ok('and nothing has moved yet', await balance() === 50000);

    console.log('\nand then it goes through, once');
    const paid = await withdraw(5000, r1.id);
    ok('the approved withdrawal is accepted', paid.status === 200 || paid.status === 201,
       `${paid.status} ${JSON.stringify(paid.body).slice(0,120)}`);
    ok('the money left the stokvel', await balance() === 45000, String(await balance()));
    const reuse = await withdraw(5000, r1.id);
    ok('the same authority cannot be used again', reuse.status === 403,
       `${reuse.status} ${JSON.stringify(reuse.body)}`);
    ok('and the balance is unchanged by the attempt', await balance() === 45000);

    console.log('\nthe signatory who was added and then removed');
    const r2 = await raise(1000);
    await vote(r2.id, 'INV-MD2-SIG1');
    await vote(r2.id, 'INV-MD2-EX');
    /* Quorum reached — then the second approver stops being a signatory. */
    await db.query(`UPDATE stokvel_members SET is_signatory = false WHERE investor_id = 'INV-MD2-EX'`);
    const stale = await withdraw(1000, r2.id);
    ok('their approval stops counting the moment the mandate changes',
       stale.status === 403, `${stale.status} ${JSON.stringify(stale.body)}`);
    ok('the balance is untouched', await balance() === 45000);

    console.log('\na signatory who says no');
    const r3 = await raise(2000);
    await vote(r3.id, 'INV-MD2-SIG1', 'reject');
    const overruled = await vote(r3.id, 'INV-MD2-SIG2', 'approve');
    ok('cannot be out-voted', overruled.status === 409, `${overruled.status}`);
    const rejected = await withdraw(2000, r3.id);
    ok('and the money stays put', rejected.status === 403 && await balance() === 45000);

    console.log('\nand an ordinary sub-account is left alone');
    const trust = await call('POST', '/api/withdrawals/request', tok('INV-MD2-CHAIR'),
      Object.assign({ amount: 1000, sub_account_id: 'SA-MD-2' }, DEST));
    ok('a trust still withdraws without a mandate',
       trust.status === 200 || trust.status === 201,
       `${trust.status} ${JSON.stringify(trust.body).slice(0,120)}`);

    console.log('\nand investing is money leaving too');
    /* An open pool to invest into, and a stokvel wallet with enough in it. */
    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months,
                                     start_date, end_date, maturity_date, min_investment)
       VALUES ('POOL-MD-OPEN','Cattle - open','cattle','open',0.13,12,
               CURRENT_DATE - 1, CURRENT_DATE + 20, CURRENT_DATE + 380, 100)`);
    /* A second OPEN pool, so "a different pool" is refused by the mandate
       rather than by the route's own open-pool rule — otherwise the
       assertion passes for the wrong reason. */
    await db.query(
      `INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months,
                                     start_date, end_date, maturity_date, min_investment)
       VALUES ('POOL-MD-OTHER','Cattle - another open','cattle','open',0.13,12,
               CURRENT_DATE - 1, CURRENT_DATE + 20, CURRENT_DATE + 380, 100)`);
    await db.query(`UPDATE sub_accounts SET wallet_balance = 50000 WHERE id = 'SA-MD-1'`);

    const invest = (amount, authority_id, poolId = 'POOL-MD-OPEN') =>
      call('POST', '/api/tables/investments', tok('INV-MD2-CHAIR'), {
        investor_id: 'INV-MD2-CHAIR', sub_account_id: 'SA-MD-1', pool_id: poolId,
        amount, product_type: 'cattle', annual_rate: 0.13, term_months: 12,
        authority_id,
      });

    const alone2 = await invest(1000, '');
    ok('the chairperson cannot invest the group\u2019s money alone',
       alone2.status === 403, `${alone2.status} ${JSON.stringify(alone2.body).slice(0, 140)}`);
    ok('and is told to get an authority first',
       /needs an approved authority/i.test(alone2.body.error || ''), alone2.body.error);

    const ri = await raiseInvest(1000);
    ok('an investment request can be raised', !!ri && ri.kind === 'investment', JSON.stringify(ri));
    await vote(ri.id, 'INV-MD2-SIG1');
    const shortI = await invest(1000, ri.id);
    ok('one approval does not release it', shortI.status === 403, String(shortI.status));
    await vote(ri.id, 'INV-MD2-SIG2');

    const wrongPool = await invest(1000, ri.id, 'POOL-MD-OTHER');
    ok('and a different pool is refused', wrongPool.status === 403
       && /different pool/i.test(wrongPool.body.error || ''), wrongPool.body.error);

    const okInvest = await invest(1000, ri.id);
    ok('the approved investment goes through',
       okInvest.status === 200 || okInvest.status === 201,
       `${okInvest.status} ${JSON.stringify(okInvest.body).slice(0, 140)}`);
    ok('and the money left the group wallet', await balance() === 49000 - 10, String(await balance()),
       'R1 000 into the pool plus the 1% platform fee');

    console.log('\nand the two kinds do not substitute for each other');
    const rw = await raise(2500);
    await vote(rw.id, 'INV-MD2-SIG1'); await vote(rw.id, 'INV-MD2-SIG2');
    const crossed = await invest(2500, rw.id);
    ok('a withdrawal authority cannot fund an investment',
       crossed.status === 403 && /approved for a withdrawal/i.test(crossed.body.error || ''),
       crossed.body.error);

    await db.query(`DELETE FROM investments WHERE sub_account_id = 'SA-MD-1'`);
    await db.query(`DELETE FROM investment_pools WHERE id IN ('POOL-MD-OPEN','POOL-MD-OTHER')`);
    await clean();
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
