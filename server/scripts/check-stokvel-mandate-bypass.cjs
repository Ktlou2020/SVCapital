#!/usr/bin/env node
/* The mandate has one door, and the generic table writer was a second one.
 *
 * A stokvel's mandate is four things: who may sign, how many of them must
 * approve before money moves, how long the money is locked, and how the pot
 * divides. services/stokvelMandateChange exists so that changing any of them
 * needs the signatories' quorum — it says a lock date may be "set, moved or
 * cleared, but only this way", because bringing one forward "releases money
 * earlier than the group agreed, which is exactly the kind of thing one
 * person must not do alone".
 *
 * It was not the only way. Three of those four live as columns on
 * sub_accounts; sub_accounts is in INVESTOR_COLS keyed on
 * parent_investor_id; and a stokvel's parent_investor_id is whoever created
 * it. So the chairperson could PATCH /api/tables/sub_accounts/<group> and
 * set the quorum, move the lock date and change the share basis — one
 * request each, no vote, no disclosure to the members, no audit row. Run
 * against the live route before the fix, all three returned 200.
 *
 * What was never reachable: WHO MAY SIGN. stokvel_members is not in
 * ALLOWED_TABLES at all, so is_signatory answers "Unknown table". That is
 * asserted below too — it is the half of the mandate that held, and a later
 * change that adds the table to that list would open it.
 *
 * REFUSED RATHER THAN DROPPED, which is the other half of the fix. The
 * protected-column list deletes a field and returns 200; right for a stray
 * fica_status, wrong for a mandate, because a committee would be told it
 * saved while nothing had changed. A silent no-op on the rules that govern a
 * group's money is worse than an error: nobody goes looking for it.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-mandate-bypass.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 3 });

/* Who is calling, chosen per request by a header the stub reads. The role is
   part of it so the staff path can be exercised in the same harness. */
const WHO = {
  CHAIR: { role: 'investor', investorId: 'MB-CHAIR', id: 'MB-CHAIR' },
  MEM:   { role: 'investor', investorId: 'MB-MEM',   id: 'MB-MEM' },
  OUT:   { role: 'investor', investorId: 'MB-OUT',   id: 'MB-OUT' },
  STAFF: { role: 'admin',    id: 'MB-STAFF', email: 'staff@check.test' },
};

const call = (port, method, p, body, who) => new Promise(resolve => {
  const data = body ? JSON.stringify(body) : null;
  const rq = http.request({ port, path: p, method, headers: Object.assign(
    { 'Content-Type': 'application/json', 'X-Who': who },
    data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
    let o = ''; res.on('data', c => o += c);
    res.on('end', () => { let j = {}; try { j = JSON.parse(o); } catch (_) {}
                          resolve({ status: res.statusCode, body: j }); });
  });
  rq.on('error', e => resolve({ status: 0, body: { error: e.message } }));
  if (data) rq.write(data);
  rq.end();
});

(async () => {
  let srv;
  try {
    const { rows: [has] } = await pool.query(
      `SELECT to_regclass('public.stokvel_members') IS NOT NULL AS ok`);
    if (!has.ok) { console.log('  SKIP  no stokvel tables here'); process.exit(0); }

    const wipe = async () => {
      await pool.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'MB-%'`);
      await pool.query(`DELETE FROM sub_accounts    WHERE id LIKE 'MB-%'`);
      await pool.query(`DELETE FROM investors       WHERE id LIKE 'MB-%'`);
    };
    await wipe();
    await pool.query(`INSERT INTO investors (id,first_name,last_name,email,status)
      VALUES ('MB-CHAIR','Chair','P','mb-chair@example.test','active'),
             ('MB-MEM','Mem','B','mb-mem@example.test','active'),
             ('MB-OUT','Out','S','mb-out@example.test','active')`);
    await pool.query(`INSERT INTO sub_accounts
      (id,parent_investor_id,name,account_type,status,wallet_balance,stokvel_quorum,
       withdrawal_date,share_basis)
      VALUES ('MB-G1','MB-CHAIR','Ubuntu Club','stokvel','active',100000,3,
              '2027-12-01','contribution')`);
    await pool.query(`INSERT INTO stokvel_members
      (id,sub_account_id,investor_id,role,is_signatory,status,joined_at)
      VALUES ('MB-SM-CHAIR','MB-G1','MB-CHAIR','chairperson',true,'active',NOW()),
             ('MB-SM-MEM','MB-G1','MB-MEM','member',false,'active',NOW())`);

    const authMod = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
    require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
      requireAuth: (req, _r, next) => { req.user = WHO[req.headers['x-who']]; next(); },
      requireRole: (...roles) => (req, res, next) =>
        roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden.' }),
    } };
    const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
    const app = express();
    app.use(express.json());
    app.use('/api/tables', require(path.join(ROOT, 'server', 'routes', 'tables')));
    srv = await new Promise(r => { const x = app.listen(0, () => r(x)); });
    const P = srv.address().port;

    const mandate = async () => (await pool.query(
      `SELECT stokvel_quorum AS quorum,
              TO_CHAR(withdrawal_date,'YYYY-MM-DD') AS lock_date, share_basis
         FROM sub_accounts WHERE id = 'MB-G1'`)).rows[0];

    const before = await mandate();
    ok('the fixture starts with a real mandate, so the assertions below mean something',
       before.quorum === 3 && before.lock_date === '2027-12-01'
       && before.share_basis === 'contribution', JSON.stringify(before));

    console.log('\nthe group’s own owner cannot set the mandate here');
    /* The chairperson IS parent_investor_id, so the ownership check passes
       and only the mandate guard stands between them and the quorum. */
    for (const [what, body] of [
      ['lower the quorum',               { stokvel_quorum: 2 }],
      ['bring the lock date forward',     { withdrawal_date: '2026-01-02' }],
      ['change how the pot divides',      { share_basis: 'equal' }],
    ]) {
      const r = await call(P, 'PATCH', '/api/tables/sub_accounts/MB-G1', body, 'CHAIR');
      ok(`they cannot ${what}`, r.status === 403,
         `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
      /* Refused AND unchanged are two different claims. A 403 that wrote
         anyway, or a 200 that dropped the field, both pass one and fail the
         other. */
      const now = await mandate();
      ok(`and it is unchanged after trying to ${what}`,
         JSON.stringify(now) === JSON.stringify(before), JSON.stringify(now));
    }

    const r403 = await call(P, 'PATCH', '/api/tables/sub_accounts/MB-G1',
                            { stokvel_quorum: 2 }, 'CHAIR');
    ok('the refusal says where it CAN be done',
       /Approvals/.test(r403.body.error || '') && /signatories/.test(r403.body.error || ''),
       r403.body.error);
    /* The silent-200 failure mode has its own assertion because it is the one
       that looks like success to whoever pressed the button. */
    ok('and it is a refusal, not a save that quietly did nothing',
       r403.status !== 200, `HTTP ${r403.status}`);

    console.log('\nand a mandate cannot be smuggled in when the group is created');
    const made = await call(P, 'POST', '/api/tables/sub_accounts', {
      id: 'MB-G2', parent_investor_id: 'MB-CHAIR', name: 'Second Club',
      account_type: 'stokvel', status: 'active', stokvel_quorum: 2,
    }, 'CHAIR');
    ok('creating one with a quorum attached is refused', made.status === 403,
       `HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 90)}`);
    ok('and no group was created by it',
       (await pool.query(`SELECT 1 FROM sub_accounts WHERE id='MB-G2'`)).rowCount === 0,
       'a refused create that still wrote the row is worse than either outcome');

    console.log('\nand who may SIGN was never reachable here at all');
    const sig = await call(P, 'PATCH', '/api/tables/stokvel_members/MB-SM-MEM',
                           { is_signatory: true }, 'MEM');
    ok('stokvel_members is not a table this endpoint knows',
       sig.status === 404 && /Unknown table/.test(sig.body.error || ''),
       `HTTP ${sig.status} ${JSON.stringify(sig.body).slice(0, 90)}`);
    ok('so an ordinary member did not become a signatory',
       (await pool.query(
         `SELECT is_signatory FROM stokvel_members WHERE id='MB-SM-MEM'`)).rows[0].is_signatory === false);

    console.log('\nand somebody outside the group gets no further than before');
    const out = await call(P, 'PATCH', '/api/tables/sub_accounts/MB-G1',
                           { stokvel_quorum: 9 }, 'OUT');
    ok('a non-owner is refused', out.status !== 200, `HTTP ${out.status}`);
    ok('and the mandate is untouched',
       JSON.stringify(await mandate()) === JSON.stringify(before));

    console.log('\nbut staff can still correct one, and the vote still applies it');
    const staff = await call(P, 'PATCH', '/api/tables/sub_accounts/MB-G1',
                             { stokvel_quorum: 2 }, 'STAFF');
    ok('the console is not blocked by this', staff.status === 200,
       `HTTP ${staff.status} ${JSON.stringify(staff.body).slice(0, 110)}`);
    ok('and the correction took', (await mandate()).quorum === 2);

    /* The vote path writes with its own SQL rather than through this
       endpoint, which is why closing this door does not close that one. */
    const svc = require('fs').readFileSync(
      path.join(ROOT, 'server', 'services', 'stokvelMandateChange.js'), 'utf8');
    ok('the vote service writes the mandate itself, not through /api/tables',
       /UPDATE sub_accounts SET stokvel_quorum/.test(svc)
       && /UPDATE sub_accounts SET withdrawal_date/.test(svc)
       && !/api\/tables/.test(svc),
       'if it went through the generic writer, this guard would have broken it');
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) await new Promise(r => srv.close(r));
    await pool.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'MB-%'`).catch(() => {});
    await pool.query(`DELETE FROM sub_accounts    WHERE id LIKE 'MB-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors       WHERE id LIKE 'MB-%'`).catch(() => {});
    await pool.end().catch(() => {});
    await require(path.join(ROOT, 'server', 'db', 'pool')).end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
