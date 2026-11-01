#!/usr/bin/env node
/* What each member owes, and whether they have paid it.
 *
 * The schedule is the rule; the obligations are the truth. One row per member
 * per period, carrying the amount as it stood when the period opened — so a
 * stokvel that raises its contribution from R500 to R600 in March does not
 * silently restate what February's defaulters owe. Arrears derived from
 * today's rule would do exactly that, and the members in arrears are the ones
 * who check.
 *
 * What this drives, in the order it matters:
 *
 *  · OPENING A PERIOD IS SAFE TO REPEAT. It runs from a daily job, so it is
 *    called about thirty times per period. A second run must insert nothing
 *    rather than double what everybody owes.
 *  · PAST OBLIGATIONS DO NOT MOVE when the schedule changes.
 *  · PAYING IS ONE TRANSACTION. Member's wallet down, stokvel's wallet up,
 *    the obligation settled, and both ledger rows written — together or not
 *    at all.
 *  · AND IT IS A MATCHED PAIR. The contribution is not money entering or
 *    leaving SV Capital; it moves between two wallets on it. Listing one side
 *    in the ledger and not the other would report every contribution as a
 *    deposit or a withdrawal.
 *  · YOU PAY YOUR OWN. Paying somebody else's would move money on one
 *    person's say-so and leave a row saying the other member had paid.
 *  · ARREARS ARE VISIBLE TO EVERY MEMBER. The dispute this ends is "I paid
 *    and you did not", which a private view would reproduce.
 *  · CHASING HAPPENS ONCE. A platform that reminds somebody daily that they
 *    owe R500 is one they mute, and then the message that mattered is muted
 *    too.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-stokvel-contributions.cjs
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

console.log('\nthe books stay balanced');
{
  const LEDGER = read('server/services/ledger.js');
  ok('the member side is a cash debit',
     /CASH_DEBIT_TYPES[\s\S]{0,260}'stokvel_contribution'/.test(LEDGER));
  ok('the stokvel side is a cash credit',
     /CASH_CREDIT_TYPES[\s\S]{0,320}'stokvel_contribution_received'/.test(LEDGER));
  const CRON = read('server/jobs/stokvelContributionCron.js');
  ok('chasing is guarded by a sent-marker, not by hope',
     /reminded_at IS NULL/.test(CRON) && /SET reminded_at = NOW\(\)/.test(CRON));
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
      `SELECT to_regclass('public.stokvel_contributions') IS NOT NULL AS ok`);
    if (!ready[0].ok) { console.log('\n  SKIP  no contribution tables here'); return; }

    const clean = async () => {
      await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id LIKE 'SA-C-%'`);
      await db.query(`DELETE FROM stokvel_contribution_schedules WHERE sub_account_id LIKE 'SA-C-%'`);
      await db.query(`DELETE FROM stokvel_members WHERE sub_account_id LIKE 'SA-C-%'`);
      await db.query(`DELETE FROM transactions WHERE investor_id LIKE 'INV-C-%'`);
      await db.query(`DELETE FROM sub_accounts WHERE id LIKE 'SA-C-%'`);
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-C-%'`);
    };
    await clean();

    for (const [id, wallet] of [['INV-C-CHAIR', 0], ['INV-C-ANN', 2000], ['INV-C-BEN', 100]])
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
         VALUES ($1,$2,'Member',$3,'active',$4)`,
        [id, id.replace('INV-C-',''), `${id.toLowerCase()}@example.test`, wallet]);

    await db.query(
      `INSERT INTO sub_accounts (id, parent_investor_id, account_type, name,
                                 wallet_balance, kyc_status, status)
       VALUES ('SA-C-1','INV-C-CHAIR','stokvel','Sizani Stokvel',0,'approved','active')`);
    for (const inv of ['INV-C-CHAIR','INV-C-ANN','INV-C-BEN'])
      await db.query(
        `INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, status, joined_at)
         VALUES ($1,'SA-C-1',$2,'member','active',NOW())`, [`SMC-${inv}`, inv]);

    await db.query(
      `INSERT INTO stokvel_contribution_schedules (id, sub_account_id, amount, cadence, due_day, starts_on, active)
       VALUES ('SCS-1','SA-C-1',500,'monthly',25, CURRENT_DATE - 400, true)`);

    const svc = require(path.join(ROOT, 'server', 'services', 'stokvelContributions.js'));
    const openFor = async when => {
      const c = await db.connect();
      try { await c.query('BEGIN'); const r = await svc.openPeriod(c, 'SA-C-1', when);
            await c.query('COMMIT'); return r; }
      finally { c.release(); }
    };

    console.log('\nopening a period');
    const first = await openFor(new Date('2026-11-05T00:00:00Z'));
    ok('one obligation per active member', first.created === 3, JSON.stringify(first));
    ok('labelled by the month', first.period === '2026-11', first.period);
    ok('due on the day the schedule says', first.due_date === '2026-11-25', first.due_date);

    const again = await openFor(new Date('2026-11-06T00:00:00Z'));
    ok('running it again creates nothing', again.created === 0, JSON.stringify(again),
       'it runs daily — a second insert would double what everybody owes');

    console.log('\nand the rule changing does not rewrite the past');
    await db.query(`UPDATE stokvel_contribution_schedules SET amount = 600 WHERE id = 'SCS-1'`);
    const { rows: nov } = await db.query(
      `SELECT DISTINCT amount_due::float a FROM stokvel_contributions
        WHERE sub_account_id='SA-C-1' AND period_label='2026-11'`);
    ok('November still owes what November agreed', nov.length === 1 && nov[0].a === 500,
       JSON.stringify(nov));
    const dec = await openFor(new Date('2026-12-02T00:00:00Z'));
    const { rows: decRows } = await db.query(
      `SELECT DISTINCT amount_due::float a FROM stokvel_contributions
        WHERE sub_account_id='SA-C-1' AND period_label='2026-12'`);
    ok('and December owes the new figure', dec.created === 3 && decRows[0].a === 600,
       JSON.stringify(decRows));

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
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
      if (payload) r.write(payload); r.end();
    });
    const idOf = async inv => (await db.query(
      `SELECT id FROM stokvel_contributions WHERE sub_account_id='SA-C-1'
        AND investor_id=$1 AND period_label='2026-11'`, [inv])).rows[0].id;
    const money = async () => {
      const a = await db.query(`SELECT wallet_balance::float b FROM investors WHERE id='INV-C-ANN'`);
      const g = await db.query(`SELECT wallet_balance::float b FROM sub_accounts WHERE id='SA-C-1'`);
      return { ann: a.rows[0].b, group: g.rows[0].b };
    };

    console.log('\npaying one');
    const annId = await idOf('INV-C-ANN');
    const before = await money();
    const paid = await call('POST', `/api/stokvels/SA-C-1/contributions/${annId}/pay`, tok('INV-C-ANN'));
    ok('the payment is accepted', paid.status === 200, JSON.stringify(paid.body));
    const after = await money();
    ok('the member’s wallet went down by the amount', before.ann - after.ann === 500,
       `${before.ann} -> ${after.ann}`);
    ok('and the stokvel’s went up by the same', after.group - before.group === 500,
       `${before.group} -> ${after.group}`);
    const { rows: pairRows } = await db.query(
      `SELECT type, amount::float a FROM transactions
        WHERE reference LIKE 'SCP-%' ORDER BY type`);
    ok('both halves of the pair are on the ledger',
       pairRows.length === 2
       && pairRows.some(r => r.type === 'stokvel_contribution' && r.a === 500)
       && pairRows.some(r => r.type === 'stokvel_contribution_received' && r.a === 500),
       JSON.stringify(pairRows));
    const { rows: [annRow] } = await db.query(
      `SELECT status, amount_paid::float p FROM stokvel_contributions WHERE id=$1`, [annId]);
    ok('and the obligation is settled', annRow.status === 'paid' && annRow.p === 500,
       JSON.stringify(annRow));

    console.log('\nwhat it refuses');
    const twice = await call('POST', `/api/stokvels/SA-C-1/contributions/${annId}/pay`, tok('INV-C-ANN'));
    ok('paying a settled contribution again', twice.status === 400
       && /already settled/i.test(twice.body.error || ''), twice.body.error);
    const benId = await idOf('INV-C-BEN');
    const notMine = await call('POST', `/api/stokvels/SA-C-1/contributions/${benId}/pay`, tok('INV-C-ANN'));
    ok('paying somebody else’s', notMine.status === 403
       && /only pay your own/i.test(notMine.body.error || ''), notMine.body.error);
    const broke = await call('POST', `/api/stokvels/SA-C-1/contributions/${benId}/pay`, tok('INV-C-BEN'));
    ok('paying with an empty wallet', broke.status === 400
       && /Not enough in your wallet/i.test(broke.body.error || ''), broke.body.error);
    const over = await call('POST', `/api/stokvels/SA-C-1/contributions/${benId}/pay`,
                            tok('INV-C-BEN'), { amount: 5000 });
    ok('paying more than is outstanding', over.status === 400
       && /more than is outstanding/i.test(over.body.error || ''), over.body.error);
    const stillOwed = await money();
    ok('and none of those moved a rand', stillOwed.group === after.group,
       `${after.group} -> ${stillOwed.group}`);

    console.log('\nwhat every member sees');
    const list = await call('GET', '/api/stokvels/SA-C-1/contributions', tok('INV-C-BEN'));
    ok('the whole list, not just their own', list.status === 200
       && list.body.data.some(r => r.investor_id === 'INV-C-ANN'),
       'a private view reproduces the dispute it exists to end');
    const ben = (list.body.arrears || []).find(a => a.investor_id === 'INV-C-BEN');
    const ann = (list.body.arrears || []).find(a => a.investor_id === 'INV-C-ANN');
    ok('arrears are totalled per member', !!ben && ben.owed === 1100,
       JSON.stringify(list.body.arrears) + ' — 500 for November, 600 for December');
    ok('and somebody up to date on a period is not listed for it',
       !!ann && ann.owed === 600, JSON.stringify(ann));

    console.log('\nand chasing happens once');
    await db.query(`UPDATE stokvel_contributions SET due_date = CURRENT_DATE - 3
                     WHERE sub_account_id='SA-C-1' AND period_label='2026-11'`);
    const { chaseArrears } = require(path.join(ROOT, 'server', 'jobs', 'stokvelContributionCron.js'));
    const first2 = await chaseArrears();
    ok('the overdue are chased', first2.sent >= 1, JSON.stringify(first2));
    const second = await chaseArrears();
    ok('and not chased again tomorrow', second.sent === 0, JSON.stringify(second),
     'a daily reminder is a muted app, and then the message that mattered is muted too');

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
