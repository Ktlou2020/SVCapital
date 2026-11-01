#!/usr/bin/env node
/* A stokvel is seen by its members, and by nobody else.
 *
 * Until now a stokvel was a sub_accounts row owned by one investor — the
 * chairperson who opened it — and member_count was a bare integer. Nobody
 * else could log in and see it, which is the whole reason a stokvel banks
 * somewhere that lets three signatories hold the account together.
 *
 * stokvel_members makes the group the account holder. The interesting part is
 * not that members can now see it; it is everything that must stay invisible
 * while they can:
 *
 *  · A STRANGER SEES NOTHING, and is not told the stokvel exists. 404, not
 *    403 — a 403 confirms the id.
 *  · AN INVITED MEMBER IS NOT YET A MEMBER. Added to the roster, not
 *    accepted, sees nothing.
 *  · AN EXITED MEMBER STOPS SEEING IT. That is what the status is for.
 *  · THE ROSTER IS NAMES AND ROLES. Being in a stokvel with somebody does not
 *    hand you their investor record.
 *  · THE GENERIC TABLE READER CANNOT SERVE IT. A table with no INVESTOR_COLS
 *    entry is readable by every signed-in investor, so a new table is open by
 *    default — every stokvel's roster on the platform, one request away.
 *    That is why stokvel_members is admin-only there and the membership check
 *    lives in a route that does the join.
 *
 * And one that is about honesty rather than access: is_signatory records what
 * the constitution says and authorises NOTHING yet. The approval that makes it
 * bite is the next phase. A flag that looks like permission and is not is
 * worse than no flag, so this refuses to let one appear quietly.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-membership.cjs
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

const ROUTE  = read('server/routes/stokvels.js');
const TABLES = read('server/routes/tables.js');
const SETUP  = read('server/db/setup.js');

console.log('\nthe table cannot be read the easy way');
{
  ok('stokvel_members is admin-only in the generic reader',
     /ADMIN_ONLY_TABLES[\s\S]{0,900}'stokvel_members'/.test(TABLES),
     'a table with no INVESTOR_COLS entry is readable by every signed-in investor');
  /* The object literal, not the identifier. The first draft of this searched
     forward from any mention of INVESTOR_COLS and matched the comment beside
     the admin-only entry, which names it — an assertion failing on the
     sentence that explains it. */
  const investorCols = (TABLES.match(/const INVESTOR_COLS = \{[\s\S]*?\n\};/) || [''])[0];
  ok('and it is not scoped there instead',
     investorCols.length > 0 && !/stokvel_members/.test(investorCols),
     'scoping by one column cannot express "the group I am a member of"');
}

console.log('\nthe route resolves membership before it answers');
{
  ok('there is one guard', /async function groupForCaller/.test(ROUTE));
  ok('it requires an ACTIVE membership or having opened it',
     /m\.status\s*=\s*'active'/.test(ROUTE)
     && /m\.id IS NOT NULL OR s\.parent_investor_id/.test(ROUTE));
  ok('and every :id endpoint goes through it',
     (ROUTE.match(/await groupForCaller\(/g) || []).length ===
     (ROUTE.match(/router\.get\('\/:id/g) || []).length,
     'an endpoint that takes an id and does not ask is the hole');
  ok('a stranger is told nothing, not refused',
     !/status\(403\)/.test(ROUTE) && /status\(404\)[\s\S]{0,60}No such stokvel/.test(ROUTE));
  ok('the whole router needs a login', /router\.use\(requireAuth\)/.test(ROUTE));
}

console.log('\nand it grants nothing it has not earned');
{
  ok('nothing here writes', !/\b(INSERT|UPDATE|DELETE)\b/.test(ROUTE),
     'seeing the group is this phase; moving its money needs the mandate');
  ok('is_signatory is recorded but authorises nothing',
     /is_signatory/.test(ROUTE)
     && !/if\s*\([^)]*is_signatory/.test(ROUTE)
     && !/is_signatory\s*(===|==)\s*true/.test(ROUTE),
     'a flag that looks like permission and is not is worse than no flag');
  ok('the schema says so too',
     /ENFORCE NOTHING YET|enforce nothing yet/i.test(SETUP));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Driven for real ────────────────────────────────────────────── */
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
      `SELECT to_regclass('public.stokvel_members') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no stokvel_members table here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-SV-%'`);
      await db.query(`DELETE FROM sub_accounts    WHERE id LIKE 'SA-SV-%'`);
      await db.query(`DELETE FROM investors       WHERE id LIKE 'INV-SV-%'`);
    };
    await clean();

    const investor = async id => db.query(
      `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance, total_returns)
       VALUES ($1,$2,'Member',$3,'active',0,0)`,
      [id, id.replace('INV-SV-', ''), `${id.toLowerCase()}@example.test`]);

    for (const id of ['INV-SV-CHAIR','INV-SV-ACTIVE','INV-SV-INVITED',
                      'INV-SV-EXITED','INV-SV-STRANGER']) await investor(id);

    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, stokvel_reg_number, member_count, status)
       VALUES ('SA-SV-1','INV-SV-CHAIR','stokvel','Ubuntu Savings Club',
               25000,'NAS-12345',4,'active')`);
    /* A second stokvel the first one's members have nothing to do with. */
    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, status)
       VALUES ('SA-SV-2','INV-SV-STRANGER','stokvel','Somebody Else''s Club',9000,'active')`);

    const member = (inv, role, status, sig) => db.query(
      `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
       VALUES ($1,'SA-SV-1',$2,$3,$4,$5, CASE WHEN $5='active' THEN NOW() ELSE NULL END)`,
      [`SM-${inv}`, inv, role, sig, status]);
    await member('INV-SV-ACTIVE',  'treasurer', 'active',  true);
    await member('INV-SV-INVITED', 'member',    'invited', false);
    await member('INV-SV-EXITED',  'member',    'exited',  false);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const asInvestor = id => jwt.sign(
      { id: 'u-' + id, role: 'investor', investor_id: id }, process.env.JWT_SECRET,
      { expiresIn: '1h' });

    const get = (p, token) => new Promise(res => {
      http.get({ port: srv.address().port, path: p,
                 headers: { Authorization: `Bearer ${token}` } },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
    });

    console.log('\nwhat a member sees');
    const mine = await get('/api/stokvels', asInvestor('INV-SV-ACTIVE'));
    ok('their stokvel is listed', mine.status === 200 && mine.body.data.length === 1,
       JSON.stringify(mine.body));
    ok('and only theirs', (mine.body.data[0] || {}).id === 'SA-SV-1',
       JSON.stringify(mine.body.data));
    ok('with their own role on it', (mine.body.data[0] || {}).my_role === 'treasurer');
    ok('and the group balance, which is the point',
       Number((mine.body.data[0] || {}).wallet_balance) === 25000);

    const detail = await get('/api/stokvels/SA-SV-1', asInvestor('INV-SV-ACTIVE'));
    ok('they can open it', detail.status === 200, String(detail.status));

    const roster = await get('/api/stokvels/SA-SV-1/members', asInvestor('INV-SV-ACTIVE'));
    ok('and read the roster', roster.status === 200 && roster.body.data.length === 2,
       JSON.stringify(roster.body.data));
    ok('which excludes whoever has left',
       !roster.body.data.some(r => r.investor_id === 'INV-SV-EXITED'));
    ok('and carries names and roles, not investor records',
       roster.body.data.every(r => r.first_name && r.role &&
         !('wallet_balance' in r) && !('id_number' in r) && !('email' in r)),
       JSON.stringify(roster.body.data[0]));

    console.log('\nand what everybody else sees');
    const cases = [
      ['INV-SV-STRANGER', 'a stranger'],
      ['INV-SV-INVITED',  'somebody invited but not yet accepted'],
      ['INV-SV-EXITED',   'somebody who has left'],
    ];
    for (const [id, who] of cases) {
      const t = asInvestor(id);
      const list = await get('/api/stokvels', t);
      const inIt = (list.body.data || []).some(g => g.id === 'SA-SV-1');
      ok(`${who} does not see it listed`, !inIt, JSON.stringify(list.body.data));
      const d = await get('/api/stokvels/SA-SV-1', t);
      ok(`${who} cannot open it`, d.status === 404, `${d.status}`);
      const m = await get('/api/stokvels/SA-SV-1/members', t);
      ok(`${who} cannot read the roster`, m.status === 404, `${m.status}`);
    }

    console.log('\nand the chairperson keeps what they had');
    const chair = await get('/api/stokvels/SA-SV-1', asInvestor('INV-SV-CHAIR'));
    ok('the investor who opened it can still see it', chair.status === 200,
       'membership is additional to opening it, not a replacement');

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
