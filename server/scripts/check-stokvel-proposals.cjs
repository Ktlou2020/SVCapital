#!/usr/bin/env node
/* The members decide; the signatories authorise.
 *
 * A proposal is the group's vote before money is asked for — "should we put
 * R50 000 into the eighteen-month pool?". It must be a fair count (one vote
 * per member, only members, decided by a majority of the membership or by
 * yes beating no at the close) and it must authorise NOTHING: a carried
 * proposal becomes an investment request only for exactly what was voted on,
 * only once, and the signatories still approve that to the quorum.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-proposals.cjs
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

console.log('\nthe rule, without a database');
{
  const P = require(path.join(ROOT, 'server', 'services', 'stokvelProposals.js'));
  const t = (yes, no, abstain, members) => ({ yes, no, abstain, members,
    voted: yes + no + abstain, needed: Math.floor(members / 2) + 1 });
  ok('a majority of the membership carries it at once', P.outcome(t(3, 0, 0, 5), false) === 'carried');
  ok('two of five is not yet decided', P.outcome(t(2, 1, 0, 5), false) === null);
  ok('it is defeated early only when it could not carry at the close',
     P.outcome(t(0, 3, 0, 5), false) === 'defeated' && P.outcome(t(1, 2, 0, 5), false) === null);
  ok('at the close, yes must beat no', P.outcome(t(1, 0, 2, 5), true) === 'carried'
     && P.outcome(t(1, 1, 0, 5), true) === 'defeated');
  ok('and a proposal moves no money: the service writes no request',
     !/stokvel_withdrawal_requests/.test(read('server/services/stokvelProposals.js')));
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
    const { rows: ready } = await db.query(`SELECT to_regclass('public.stokvel_proposals') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no proposals table here'); return; }

    const G = 'SA-PR-1', P = 'INV-PR-';
    const clean = async () => {
      await db.query(`DELETE FROM stokvel_request_approvals WHERE request_id IN
                        (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id = $1)`, [G]);
      await db.query(`DELETE FROM stokvel_withdrawal_requests WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM stokvel_proposals WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [G]);
      await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [G]);
      await db.query(`DELETE FROM investment_pools WHERE id = 'POOL-PR-1'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-PR-%'`);
    };
    await clean();

    const people = ['A', 'B', 'C', 'D', 'E', 'OUT'];
    for (const who of people)
      await db.query(`INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
                      VALUES ($1,$2,'Pr',$3,'active',0)`, [P + who, who, `${(P + who).toLowerCase()}@example.test`]);
    await db.query(`INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance,
                                              kyc_status, status, stokvel_quorum)
                    VALUES ($1,$2,'stokvel','Letsema Investment Club',60000,'approved','active',2)`, [G, P + 'A']);
    for (const [who, role, sig] of [['A', 'chairperson', true], ['B', 'treasurer', true],
                                    ['C', 'member', false], ['D', 'member', false], ['E', 'member', false]])
      await db.query(`INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
                      VALUES ($1,$2,$3,$4,$5,'active',NOW())`, ['SM-PR-' + who, G, P + who, role, sig]);
    await db.query(`INSERT INTO investment_pools (id, name, product_type, status, annual_rate, term_months, min_investment)
                    VALUES ('POOL-PR-1','Cattle - twelve months','cattle','open',0.13,12,500)`);

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
    const propose = (who, body) => call('POST', `/api/stokvels/${G}/proposals`, who, body);
    const vote = (pid, who, v) => call('POST', `/api/stokvels/${G}/proposals/${pid}/vote`, who, { vote: v });

    console.log('\nraising one');
    const outsider = await propose('OUT', { title: 'Buy a taxi' });
    ok('somebody outside the group cannot', outsider.status === 404, `${outsider.status}`);
    const blank = await propose('C', { title: '' });
    ok('a proposal must say what is being decided', blank.status === 400, blank.body.error);
    const noAmt = await propose('C', { title: 'Invest', pool_id: 'POOL-PR-1' });
    ok('an investment proposal needs an amount', noAmt.status === 400, noAmt.body.error);
    const inv = await propose('C', { title: 'Put R20 000 into the twelve-month pool',
                                     pool_id: 'POOL-PR-1', amount: 20000 });
    ok('any member can raise one', inv.status === 201, JSON.stringify(inv.body));

    console.log('\na fair count');
    const outVote = await vote(inv.body.data.id, 'OUT', 'yes');
    ok('only members vote', outVote.status === 404, `${outVote.status}`);
    await vote(inv.body.data.id, 'C', 'no');
    const changed = await vote(inv.body.data.id, 'C', 'yes');
    ok('a member can change their vote, and it counts once',
       changed.body.data.tally.yes === 1 && changed.body.data.tally.no === 0, JSON.stringify(changed.body));
    await vote(inv.body.data.id, 'D', 'yes');
    const third = await vote(inv.body.data.id, 'E', 'yes');
    ok('three of five carries it', third.body.data.status === 'carried', JSON.stringify(third.body));
    const late = await vote(inv.body.data.id, 'A', 'no');
    ok('and voting has then closed', late.status === 409, `${late.status}`);

    console.log('\ndefeated, and closed by the clock');
    const nope = await propose('D', { title: 'Lend money to a member' });
    for (const w of ['A', 'B', 'C']) await vote(nope.body.data.id, w, 'no');
    const list1 = await call('GET', `/api/stokvels/${G}/proposals`, 'E');
    ok('three noes of five defeats it early',
       (list1.body.data.find(p => p.id === nope.body.data.id) || {}).status === 'defeated');
    const slow = await propose('E', { title: 'Hold the AGM in March' });
    await vote(slow.body.data.id, 'E', 'yes');
    await db.query(`UPDATE stokvel_proposals SET closes_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
                   [slow.body.data.id]);
    const list2 = await call('GET', `/api/stokvels/${G}/proposals`, 'A');
    ok('at the close, one yes and no noes carries it',
       (list2.body.data.find(p => p.id === slow.body.data.id) || {}).status === 'carried');

    console.log('\nit authorises nothing');
    const ask = (body, who = 'C') => call('POST', `/api/stokvels/${G}/withdrawal-requests`, who,
      Object.assign({ kind: 'investment', pool_id: 'POOL-PR-1' }, body));
    const wrong = await ask({ amount: 25000, proposal_id: inv.body.data.id });
    ok('a request cannot be for more than the members voted for', wrong.status === 400, wrong.body.error);
    const notCarried = await ask({ amount: 1000, proposal_id: nope.body.data.id });
    ok('nor raised from a proposal that did not carry', notCarried.status === 400, notCarried.body.error);
    const put = await ask({ amount: 20000, proposal_id: inv.body.data.id });
    ok('a carried proposal can be put to the signatories', put.status === 201, JSON.stringify(put.body));
    const twice = await ask({ amount: 20000, proposal_id: inv.body.data.id });
    ok('once', twice.status === 409, `${twice.status}`);
    const req = (await db.query(`SELECT status, proposal_id FROM stokvel_withdrawal_requests WHERE id = $1`,
                                [put.body.data.id])).rows[0];
    ok('and the signatories still have to approve it', req.status === 'pending' && req.proposal_id === inv.body.data.id,
       JSON.stringify(req));

    console.log('\nwithdrawing one');
    const open = await propose('D', { title: 'Change the meeting day' });
    const byOther = await call('POST', `/api/stokvels/${G}/proposals/${open.body.data.id}/withdraw`, 'E', {});
    ok('another ordinary member cannot', byOther.status === 403, `${byOther.status}`);
    const byRaiser = await call('POST', `/api/stokvels/${G}/proposals/${open.body.data.id}/withdraw`, 'D', {});
    ok('the person who raised it can', byRaiser.status === 200, JSON.stringify(byRaiser.body));

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
