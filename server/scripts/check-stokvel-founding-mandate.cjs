#!/usr/bin/env node
/* The first mandate, set by the committee and consented to by whoever joins.
 *
 * stokvelMandateChange handles every mandate after the first, and says why it
 * is safe: "anything a mandate change makes possible, the signatories who
 * approve it could already do". THAT ARGUMENT COLLAPSES FOR THE FIRST ONE —
 * a new group has no signatories, so no quorum bounds it. Staff used to type
 * it in, which was safe and was also the thing that stopped a committee
 * running its own group.
 *
 * So the check is not a vote, it is CONSENT AT THE POINT OF JOINING: nobody's
 * money is in the group until they accept, and the invitation states the
 * rules in full. What is asserted here is that both halves hold — the
 * founder really can set it, and nobody is ever brought in without being
 * told what they are agreeing to.
 *
 * The dangerous paths, each with its own assertion:
 *
 *   · a mandate of one, or one larger than the group can ever satisfy
 *   · an ordinary member writing the rule book
 *   · setting it twice, or editing it after it is in force
 *   · an invitation APPOINTING a signatory (Terms 26.3 forbids it) rather
 *     than nominating one
 *   · somebody confirming an appointment they were never offered
 *   · THE FOUNDING WINDOW REOPENING. If "founding" meant "fewer signatories
 *     than the quorum", a group that lost one to an exit would be back in it
 *     and the chairperson could nominate a replacement who confirms
 *     themselves in — a signatory appointed with no vote.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-founding-mandate.cjs
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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 4 });

const WHO = {
  CHAIR: { role: 'investor', investorId: 'FM-CHAIR', id: 'FM-CHAIR', email: 'fm-chair@example.test' },
  SEC:   { role: 'investor', investorId: 'FM-SEC',   id: 'FM-SEC',   email: 'fm-sec@example.test' },
  MEM:   { role: 'investor', investorId: 'FM-MEM',   id: 'FM-MEM',   email: 'fm-mem@example.test' },
  OUT:   { role: 'investor', investorId: 'FM-OUT',   id: 'FM-OUT',   email: 'fm-out@example.test' },
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
    const { rows: [col] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'sub_accounts' AND column_name = 'mandate_adopted_at'`);
    if (!col.n) { console.log('  SKIP  schema predates the founding mandate'); process.exit(0); }

    const reset = async (quorum, adopted) => {
      await pool.query(`DELETE FROM stokvel_invites WHERE sub_account_id LIKE 'FM-%'`);
      await pool.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'FM-%'`);
      await pool.query(`DELETE FROM sub_accounts    WHERE id LIKE 'FM-%'`);
      await pool.query(`DELETE FROM investors       WHERE id LIKE 'FM-%'`);
      await pool.query(`INSERT INTO investors (id,first_name,last_name,email,phone,status)
        VALUES ('FM-CHAIR','Thandi','M','fm-chair@example.test','0720000001','active'),
               ('FM-SEC','Sipho','N','fm-sec@example.test','0720000002','active'),
               ('FM-MEM','Naledi','K','fm-mem@example.test','0720000003','active'),
               ('FM-OUT','Out','S','fm-out@example.test','0720000004','active')`);
      await pool.query(`INSERT INTO sub_accounts
        (id,parent_investor_id,name,account_type,status,wallet_balance,stokvel_quorum,
         mandate_adopted_at)
        VALUES ('FM-G1','FM-CHAIR','Ubuntu Club','stokvel','active',0,$1,$2)`,
        [quorum, adopted ? new Date().toISOString() : null]);
      await pool.query(`INSERT INTO stokvel_members
        (id,sub_account_id,investor_id,role,is_signatory,status,joined_at)
        VALUES ('FM-SM-CHAIR','FM-G1','FM-CHAIR','chairperson',false,'active',NOW()),
               ('FM-SM-SEC','FM-G1','FM-SEC','secretary',false,'active',NOW()),
               ('FM-SM-MEM','FM-G1','FM-MEM','member',false,'active',NOW())`);
    };

    const authMod = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
    require.cache[authMod] = { id: authMod, filename: authMod, loaded: true, exports: {
      requireAuth: (req, _r, next) => { req.user = WHO[req.headers['x-who']]; next(); },
      requireRole: (...roles) => (req, res, next) =>
        roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden.' }),
    } };
    const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels')));
    srv = await new Promise(r => { const x = app.listen(0, () => r(x)); });
    const P = srv.address().port;

    const row = async () => (await pool.query(
      `SELECT stokvel_quorum AS quorum, share_basis,
              TO_CHAR(withdrawal_date,'YYYY-MM-DD') AS lock_date,
              mandate_adopted_at IS NOT NULL AS adopted
         FROM sub_accounts WHERE id='FM-G1'`)).rows[0];
    const sigs = async () => (await pool.query(
      `SELECT investor_id, is_signatory, signatory_nominated_at IS NOT NULL AS nominated
         FROM stokvel_members WHERE sub_account_id='FM-G1' ORDER BY investor_id`)).rows;
    const future = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

    /* ── Setting it ──────────────────────────────────────────────── */
    console.log('\nthe committee sets the first mandate, without staff');
    await reset(null, false);
    {
      const r = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 2, share_basis: 'equal', lock_date: future, nominate_me: true }, 'CHAIR');
      ok('the chairperson can set it', r.status === 201,
         `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
      const m = await row();
      ok('and it is stored', m.quorum === 2 && m.share_basis === 'equal'
         && m.lock_date === future, JSON.stringify(m));
      ok('it is NOT yet in force — nobody has confirmed anything',
         m.adopted === false, 'adoption is what shuts the founding window');
      ok('the founder is nominated, not appointed',
         (await sigs()).find(x => x.investor_id === 'FM-CHAIR').is_signatory === false,
         'setting the rules does not make you a signatory of them');
      ok('and the group is told how many confirmations it still needs',
         r.body.data.mandate_state.short_by === 2,
         JSON.stringify(r.body.data.mandate_state));
    }

    console.log('\nand it refuses a mandate that is not one');
    await reset(null, false);
    {
      const one = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 1 }, 'CHAIR');
      ok('a quorum of one is refused', one.status === 400
         && /not a mandate/.test(one.body.error || ''), JSON.stringify(one.body).slice(0, 120));
      const huge = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 40 }, 'CHAIR');
      ok('and so is one the group could never satisfy', huge.status === 400,
         JSON.stringify(huge.body).slice(0, 120));
      const past = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 2, lock_date: '2020-01-01' }, 'CHAIR');
      ok('a lock date in the past is refused', past.status === 400,
         JSON.stringify(past.body).slice(0, 120));
      const basis = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 2, share_basis: 'whatever' }, 'CHAIR');
      ok('and a share basis nobody implements is refused', basis.status === 400,
         JSON.stringify(basis.body).slice(0, 120));
      ok('none of them left a mandate behind', (await row()).quorum === null,
         'a refused mandate that wrote half of itself is worse than either answer');
    }

    console.log('\nand only the committee writes the rule book');
    await reset(null, false);
    {
      const mem = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 2 }, 'MEM');
      ok('an ordinary member cannot set it', mem.status === 403,
         JSON.stringify(mem.body).slice(0, 120));
      const out = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 2 }, 'OUT');
      ok('and somebody outside the group is told nothing at all',
         out.status === 404, `HTTP ${out.status}`);
      ok('the secretary can', (await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 2 }, 'SEC')).status === 201);
    }

    console.log('\nand it can only be set once — after that it is a vote');
    {
      const again = await call(P, 'POST', '/api/stokvels/FM-G1/founding-mandate',
        { quorum: 3 }, 'CHAIR');
      ok('a second attempt is refused', again.status === 409,
         JSON.stringify(again.body).slice(0, 140));
      ok('and it points at the Approvals section',
         /Approvals/.test(again.body.error || ''), again.body.error);
      ok('the first mandate stands', (await row()).quorum === 2);
    }

    /* ── Consent at the point of joining ────────────────────────── */
    console.log('\nand nobody is asked to join without being told the rules');
    await reset(2, false);
    await pool.query(`UPDATE sub_accounts SET share_basis='equal', withdrawal_date=$1
                       WHERE id='FM-G1'`, [future]);
    {
      const inv = await call(P, 'POST', '/api/stokvels/FM-G1/invites',
        { name: 'Zanele', email: 'fm-new@example.test', as_signatory: true }, 'CHAIR');
      ok('an invitation can be sent', inv.status === 201,
         `HTTP ${inv.status} ${JSON.stringify(inv.body).slice(0, 140)}`);
      const { rows: [v] } = await pool.query(
        `SELECT id, as_signatory FROM stokvel_invites WHERE sub_account_id='FM-G1'`);
      ok('and it records that this person was ASKED to sign', v.as_signatory === true);

      /* Read as the invitee would read it. The mandate has to be on the
         invitation itself, because agreeing to it IS the check. */
      const mine = await call(P, 'GET', '/api/stokvels/invites/mine', null, 'OUT');
      ok('somebody else cannot see it', (mine.body.data || []).length === 0,
         JSON.stringify(mine.body).slice(0, 120));

      await pool.query(`UPDATE stokvel_invites SET email='fm-out@example.test',
                          matched_investor_id='FM-OUT' WHERE id=$1`, [v.id]);
      const theirs = await call(P, 'GET', '/api/stokvels/invites/mine', null, 'OUT');
      const got = (theirs.body.data || [])[0];
      ok('the invitee is shown the mandate', !!got && got.mandate
         && got.mandate.quorum === 2 && got.mandate.share_basis === 'equal'
         && got.mandate.lock_date === future, JSON.stringify(got || {}).slice(0, 200));
      ok('in a sentence, not only as numbers',
         !!got && /2 signatories must approve/.test(got.mandate_line || '')
         && /divides equally/.test(got.mandate_line || '')
         && new RegExp(future).test(got.mandate_line || ''), got && got.mandate_line);
      ok('and told they are being asked to sign',
         !!got && got.as_signatory === true
         && /asked to be one of the signatories/.test(got.mandate_line || ''),
         got && got.mandate_line);
    }

    console.log('\nand accepting makes a member, never a signatory');
    {
      const { rows: [v] } = await pool.query(
        `SELECT id FROM stokvel_invites WHERE sub_account_id='FM-G1'`);
      const acc = await call(P, 'POST', `/api/stokvels/invites/${v.id}/accept`, {}, 'OUT');
      ok('the invitation is accepted', acc.status === 200,
         `HTTP ${acc.status} ${JSON.stringify(acc.body).slice(0, 120)}`);
      const them = (await sigs()).find(x => x.investor_id === 'FM-OUT');
      /* Terms 26.3: "An invitation does not confer signatory status or any
         office." The nomination survives; the appointment does not exist. */
      ok('they are NOT a signatory, however the invitation was marked',
         !!them && them.is_signatory === false, JSON.stringify(them || {}));
      ok('but the nomination came across, so they can confirm it themselves',
         !!them && them.nominated === true, JSON.stringify(them || {}));
    }

    console.log('\nand only the nominee confirms the appointment');
    {
      const notAsked = await call(P, 'POST', '/api/stokvels/FM-G1/signatory-confirmation',
        {}, 'MEM');
      ok('somebody who was never asked cannot confirm', notAsked.status === 403,
         JSON.stringify(notAsked.body).slice(0, 130));
      ok('and did not become one', (await sigs())
         .find(x => x.investor_id === 'FM-MEM').is_signatory === false);

      const first = await call(P, 'POST', '/api/stokvels/FM-G1/signatory-confirmation',
        {}, 'OUT');
      ok('the nominee can', first.status === 200 && first.body.data.signatories === 1,
         JSON.stringify(first.body).slice(0, 140));
      ok('one short of the quorum, the mandate is still not in force',
         (await row()).adopted === false && first.body.data.adopted === false);
      const twice = await call(P, 'POST', '/api/stokvels/FM-G1/signatory-confirmation',
        {}, 'OUT');
      ok('and confirming twice is refused rather than counted twice',
         twice.status === 409, JSON.stringify(twice.body).slice(0, 120));
    }

    console.log('\nand reaching the quorum shuts the founding window for good');
    {
      await pool.query(`UPDATE stokvel_members SET signatory_nominated_at = NOW()
                         WHERE sub_account_id='FM-G1' AND investor_id='FM-CHAIR'`);
      const second = await call(P, 'POST', '/api/stokvels/FM-G1/signatory-confirmation',
        {}, 'CHAIR');
      ok('the second confirmation carries it', second.status === 200
         && second.body.data.adopted === true, JSON.stringify(second.body).slice(0, 140));
      ok('and the mandate is in force', (await row()).adopted === true);

      /* THE REOPENING. A count would put this group back in its founding
         window the moment a signatory left, and the chairperson could then
         nominate a replacement who confirms themselves in. */
      await pool.query(`UPDATE stokvel_members SET status='exited', exited_at=NOW()
                         WHERE sub_account_id='FM-G1' AND investor_id='FM-OUT'`);
      const { rows: [c2] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_signatory AND status='active')::int AS n
           FROM stokvel_members WHERE sub_account_id='FM-G1'`);
      ok('a signatory leaving really does drop it below the quorum',
         c2.n === 1, `${c2.n} signatories against a quorum of 2 — the setup for the next one`);
      await pool.query(`UPDATE stokvel_members SET signatory_nominated_at = NOW()
                         WHERE sub_account_id='FM-G1' AND investor_id='FM-MEM'`);
      const sneak = await call(P, 'POST', '/api/stokvels/FM-G1/signatory-confirmation',
        {}, 'MEM');
      ok('but the founding window does NOT reopen', sneak.status === 409,
         `HTTP ${sneak.status} ${JSON.stringify(sneak.body).slice(0, 140)}`);
      ok('and it says the change needs a vote now',
         /Approvals/.test(sneak.body.error || ''), sneak.body.error);
      ok('so no signatory was appointed without one',
         (await sigs()).find(x => x.investor_id === 'FM-MEM').is_signatory === false,
         'this is the hole the stamp exists to close');
    }

    console.log('\nand an invitation cannot promise signing power once the mandate is in force');
    {
      const late = await call(P, 'POST', '/api/stokvels/FM-G1/invites',
        { name: 'Late', email: 'fm-late@example.test', as_signatory: true }, 'CHAIR');
      ok('the invitation is still sent', late.status === 201,
         JSON.stringify(late.body).slice(0, 120));
      const { rows: [v2] } = await pool.query(
        `SELECT as_signatory FROM stokvel_invites WHERE email='fm-late@example.test'`);
      ok('but it does not carry a nomination it could not honour',
         v2.as_signatory === false,
         'offering signing power the platform would then refuse is worse than not offering it');
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (srv) await new Promise(r => srv.close(r));
    for (const q of [
      `DELETE FROM stokvel_invites WHERE sub_account_id LIKE 'FM-%'`,
      `DELETE FROM stokvel_members WHERE sub_account_id LIKE 'FM-%'`,
      `DELETE FROM sub_accounts    WHERE id LIKE 'FM-%'`,
      `DELETE FROM investors       WHERE id LIKE 'FM-%'`,
    ]) await pool.query(q).catch(() => {});
    await pool.end().catch(() => {});
    await require(path.join(ROOT, 'server', 'db', 'pool')).end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
