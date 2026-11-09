#!/usr/bin/env node
/* The committee sets the group's contribution — and nobody's debt moves.
 *
 * What each member pays was typed in by SV Capital staff, and the setup
 * checklist sent the committee to WhatsApp to ask. The committee now sets
 * it in the app. Checked:
 *   · only the chairperson, secretary or treasurer sets it
 *   · it is monthly, between R0 and a sanity bound, on a day from 1 to 31
 *   · CHANGING IT DOES NOT RESTATE WHAT IS OWED: a period already opened
 *     keeps the amount it opened at; the new amount applies from the month
 *     the committee chose
 *   · one live schedule, ever; a change ends the old one
 *   · a start month that avoids raising an obligation overdue on arrival
 *   · every member except whoever set it is told
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-group-schedule.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nwithout a database');
{
  const S = require(path.join(ROOT, 'server', 'services', 'stokvelSchedule.js'));
  ok('a due day already passed this month defaults to starting next month',
     S.defaultStart(1, '2026-11-09') === 'next_month' && S.defaultStart(25, '2026-11-09') === 'this_month');
  ok('weekly is refused rather than stored and never raised', !!S.parse({ amount: 500, due_day: 1, cadence: 'weekly' }).error);
  ok('so is nothing, and so is an absurd amount',
     !!S.parse({ amount: 0, due_day: 1 }).error && !!S.parse({ amount: 250000, due_day: 1 }).error);
  ok('and a day that is not a day of the month', !!S.parse({ amount: 500, due_day: 32 }).error);

  const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  const ctx = { window: {}, location: { search: '' }, localStorage: { getItem: () => null },
                sessionStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null },
                Utils: { rand: n => 'R' + Number(n).toFixed(2) }, encodeURIComponent };
  vm.createContext(ctx); vm.runInContext(CORE, ctx);
  ctx._esc = s => String(s == null ? '' : s);
  const chair = { my_role: 'chairperson', setup: { schedule: { amount: 500, due_day: 1, set_by_name: 'Thandi' } } };
  ok('Contributions shows the schedule, and who set it',
     /R500\.00 a month, due on day 1/.test(ctx._svScheduleBlock(chair, 'G')) && /Set by Thandi/.test(ctx._svScheduleBlock(chair, 'G')));
  ok('with the committee’s button to change it', /raiseStokvelSchedule\('G'\)/.test(ctx._svScheduleBlock(chair, 'G')));
  ok('and no button for an ordinary member',
     !/raiseStokvelSchedule/.test(ctx._svScheduleBlock({ my_role: 'member', setup: chair.setup }, 'G')));
  ok('a group with none says nothing is owed until it is set',
     /Nothing is owed until/.test(ctx._svScheduleBlock({ my_role: 'treasurer', setup: { schedule: null } }, 'G')));
  ok('and the checklist no longer sends the committee to WhatsApp for it',
     !/Please set the contribution for/.test(CORE));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const http = require('http');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  let srv;
  const G = 'SA-SC-1', P = 'INV-SC-';
  const clean = async () => {
    await db.query(`DELETE FROM stokvel_contributions WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM stokvel_contribution_schedules WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM stokvel_members WHERE sub_account_id = $1`, [G]);
    await db.query(`DELETE FROM sub_accounts WHERE id = $1`, [G]);
    await db.query(`DELETE FROM investors WHERE id LIKE 'INV-SC-%'`);
  };
  try {
    await clean();
    for (const who of ['CHAIR', 'TREAS', 'PLAIN'])
      await db.query(`INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
                      VALUES ($1,$2,'Sc',$3,'active',0)`, [P + who, who.charAt(0) + who.slice(1).toLowerCase(), `${(P + who).toLowerCase()}@example.test`]);
    await db.query(`INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, kyc_status, status, stokvel_quorum)
                    VALUES ($1,$2,'stokvel','Soweto Savings Club','approved','active',2)`, [G, P + 'CHAIR']);
    for (const [who, role] of [['CHAIR', 'chairperson'], ['TREAS', 'treasurer'], ['PLAIN', 'member']])
      await db.query(`INSERT INTO stokvel_members (id, sub_account_id, investor_id, role, is_signatory, status, joined_at)
                      VALUES ($1,$2,$3,$4,false,'active',NOW())`, ['SM-SC-' + who, G, P + who, role]);

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api/stokvels', require(path.join(ROOT, 'server', 'routes', 'stokvels.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
    const call = (method, p, who, body) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const tok = jwt.sign({ id: 'u-' + who, role: 'investor', investorId: P + who }, process.env.JWT_SECRET);
      const r = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign({ Authorization: `Bearer ${tok}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s2 = ''; x.on('data', c => s2 += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s2 || '{}') })); });
      if (payload) r.write(payload);
      r.end();
    });
    const setIt = (who, body) => call('PUT', `/api/stokvels/${G}/schedule`, who, body);
    const contributions = require(path.join(ROOT, 'server', 'services', 'stokvelContributions.js'));
    const owed = async label => (await db.query(
      `SELECT amount_due::float a FROM stokvel_contributions WHERE sub_account_id = $1 AND period_label = $2`, [G, label])).rows.map(r => r.a);
    const live = async () => (await db.query(
      `SELECT amount::float a, due_day, set_by FROM stokvel_contribution_schedules WHERE sub_account_id = $1 AND active`, [G])).rows;

    console.log('\nwho sets it');
    ok('an ordinary member cannot', (await setIt('PLAIN', { amount: 500, due_day: 1 })).status === 403);
    const first = await setIt('CHAIR', { amount: 500, due_day: 1, start: 'this_month' });
    ok('the chairperson can', first.status === 200 && Number(first.body.data.amount) === 500, JSON.stringify(first.body));
    const rows1 = await live();
    ok('and it is recorded who did', rows1.length === 1 && rows1[0].set_by === P + 'CHAIR', JSON.stringify(rows1));
    const detail = await call('GET', `/api/stokvels/${G}`, 'PLAIN');
    ok('every member sees it, with the name of who set it',
       Number(detail.body.data.setup.schedule.amount) === 500 && detail.body.data.setup.schedule.set_by_name === 'Chair');

    console.log('\nwhat is owed stays owed at its own amount');
    /* South African time, which is what a start date is written in: at
       23:00 UTC the schedule's start date is already "tomorrow" in UTC. */
    const now = new Date(Date.now() + 2 * 3600 * 1000);
    const thisLabel = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await contributions.openPeriod(db, G, now);
    ok('this month opens at R500 for every member', JSON.stringify(await owed(thisLabel)) === '[500,500,500]',
       JSON.stringify(await owed(thisLabel)));
    const change = await setIt('TREAS', { amount: 600, due_day: 5, start: 'next_month' });
    ok('the treasurer changes it to R600 from next month', change.status === 200 && change.body.data.replaced === true,
       JSON.stringify(change.body));
    const rows2 = await live();
    ok('there is still exactly one live schedule, the new one', rows2.length === 1 && rows2[0].a === 600);
    ok('and this month’s contributions still read R500', JSON.stringify(await owed(thisLabel)) === '[500,500,500]');
    await contributions.openPeriod(db, G, now);
    ok('running this month again raises nothing new at the new amount',
       (await owed(thisLabel)).length === 3 && (await owed(thisLabel)).every(a => a === 500));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2, 12));
    const nextLabel = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    await contributions.openPeriod(db, G, next);
    ok('next month opens at R600', JSON.stringify(await owed(nextLabel)) === '[600,600,600]', JSON.stringify(await owed(nextLabel)));
    const same = await setIt('CHAIR', { amount: 600, due_day: 5 });
    ok('setting what it already is is refused, not a silent new schedule', same.status === 409);

    console.log('\nthe members are told');
    const n = require(path.join(ROOT, 'server', 'services', 'stokvelNotify.js'));
    const told = await n.scheduleChanged({ groupId: G, actorId: P + 'TREAS',
      schedule: { amount: 600, due_day: 5, starts_on: next.toISOString() }, previous: { amount: 500 }, db });
    ok('everybody except whoever changed it',
       JSON.stringify((told.notified || []).sort()) === JSON.stringify([P + 'CHAIR', P + 'PLAIN'].sort()), JSON.stringify(told));
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
