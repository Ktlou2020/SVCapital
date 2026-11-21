#!/usr/bin/env node
/* The committee sets the group's contribution — and nobody's debt moves.
 *
 * What each member pays was typed in by SV Capital staff, and the setup
 * checklist sent the committee to WhatsApp to ask. The committee now sets
 * it in the app. Checked:
 *   · only the chairperson, secretary or treasurer sets it
 *   · MONTHLY, FORTNIGHTLY OR WEEKLY, between R0 and a sanity bound, on a
 *     day the cadence actually asks for — a day of the month when monthly,
 *     a day of the week when weekly, and neither when fortnightly. Only
 *     monthly was generated, so the other two were refused and a stokvel
 *     that collects on payday could not be set up here at all.
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
  /* 'now' / 'next', because a period is not always a month. The WIRE still
     carries this_month / next_month: the installed app sends those and
     cannot be updated until the next release. */
  ok('a due day already passed this period defaults to starting the next one',
     S.defaultStart(1, '2026-11-09') === 'next' && S.defaultStart(25, '2026-11-09') === 'now');
  ok('AND THE OLD APP’S WORDS ARE STILL ACCEPTED',
     S.parse({ amount: 500, due_day: 1, start: 'this_month' }).schedule.start === 'now'
     && S.parse({ amount: 500, due_day: 1, start: 'next_month' }).schedule.start === 'next',
     'the app on members’ phones sends these two strings and cannot be '
     + 'updated until the next release; refusing them would break setting a '
     + 'contribution from the app at all');

  /* THIS ASSERTED THE OPPOSITE, and it was right to: openPeriod generated
     monthly only, so storing a weekly schedule would have meant a rule that
     never raised an obligation — worse than a refusal. All three are
     generated now. */
  ok('WEEKLY IS ACCEPTED NOW', !S.parse({ amount: 500, due_day: 5, cadence: 'weekly' }).error,
     JSON.stringify(S.parse({ amount: 500, due_day: 5, cadence: 'weekly' })));
  ok('and fortnightly, which asks for no day at all',
     S.parse({ amount: 500, cadence: 'fortnightly' }).schedule.dueDay === null,
     JSON.stringify(S.parse({ amount: 500, cadence: 'fortnightly' })));
  ok('but a weekly day of the month is refused, not wrapped onto a weekday',
     !!S.parse({ amount: 500, due_day: 9, cadence: 'weekly' }).error,
     'day 9 of the week is somebody meaning the 9th, and storing it as '
     + 'Tuesday would collect on a day nobody chose');
  ok('and a cadence that is not one of the three',
     !!S.parse({ amount: 500, due_day: 1, cadence: 'daily' }).error);
  ok('so is nothing, and so is an absurd amount',
     !!S.parse({ amount: 0, due_day: 1 }).error && !!S.parse({ amount: 250000, due_day: 1 }).error);
  ok('and a day that is not a day of the month', !!S.parse({ amount: 500, due_day: 32 }).error);

  /* ONE SENTENCE, SERVED BY THE SERVER. Three places were building it from
     the amount and the day, so all three said "a month" about a weekly
     contribution. */
  console.log('\nand one sentence says what the rule is');
  ok('monthly reads as it always did',
     S.describe({ amount: 500, cadence: 'monthly', due_day: 1 })
       === 'R 500,00 a month, due on day 1 of the month',
     S.describe({ amount: 500, cadence: 'monthly', due_day: 1 }));
  ok('WEEKLY DOES NOT SAY MONTH',
     S.describe({ amount: 500, cadence: 'weekly', due_day: 5 })
       === 'R 500,00 a week, due every Friday',
     S.describe({ amount: 500, cadence: 'weekly', due_day: 5 }));
  ok('and fortnightly says every second week, on the day it starts',
     S.describe({ amount: 500, cadence: 'fortnightly', starts_on: '2026-11-27' })
       === 'R 500,00 every second week, due every second Friday',
     S.describe({ amount: 500, cadence: 'fortnightly', starts_on: '2026-11-27' }));
  ok('in the platform’s own notation, comma for the decimal',
     /^R 500,00 /.test(S.describe({ amount: 500, cadence: 'weekly', due_day: 5 })),
     'the sentence is printed on a screen beside amounts from Utils.rand, '
     + 'and in South Africa the comma is the decimal separator');
  /* A DATE COLUMN COMES BACK AS A Date OBJECT. Setting a weekly schedule
     answered 500 because of it — after the row had been committed, so the
     group had a new contribution and was told the opposite. */
  ok('AND IT TAKES THE Date A DATE COLUMN ACTUALLY RETURNS',
     S.firstPeriodLabel({ cadence: 'weekly', starts_on: new Date('2026-11-21T00:00:00Z') })
       === 'the week of 16 November 2026'
     && S.describe({ amount: 500, cadence: 'fortnightly', starts_on: new Date('2026-11-27T00:00:00Z') })
       === 'R 500,00 every second week, due every second Friday',
     JSON.stringify([S.firstPeriodLabel({ cadence: 'weekly', starts_on: new Date('2026-11-21T00:00:00Z') })]));
  ok('and it says which period it starts in, in that cadence’s words',
     S.firstPeriodLabel({ cadence: 'monthly', starts_on: '2026-11-21' }) === 'November 2026'
     && S.firstPeriodLabel({ cadence: 'fortnightly', starts_on: '2026-11-27' }) === '27 November 2026'
     && /^the week of 16 November 2026$/.test(S.firstPeriodLabel({ cadence: 'weekly', starts_on: '2026-11-21' })),
     JSON.stringify([S.firstPeriodLabel({ cadence: 'weekly', starts_on: '2026-11-21' })]));

  /* ─── Which period a date falls in ─────────────────────────────── */
  console.log('\nand each cadence knows its own periods');
  {
    const C = require(path.join(ROOT, 'server', 'services', 'stokvelContributions.js'));
    const at = (cadence, due_day, starts_on, when) =>
      C.periodFor({ cadence, due_day, starts_on }, when);

    ok('a monthly period is its calendar month',
       at('monthly', 1, null, '2026-11-21T10:00:00Z').label === '2026-11');
    ok('and a due day past the end of a short month settles inside it',
       at('monthly', 31, null, '2026-02-10T10:00:00Z').dueDate === '2026-02-28');

    /* THE LABEL IS THE IDENTITY OF A PERIOD: the unique index is on it, so
       it is what stops a daily job raising the same obligation thirty
       times. */
    ok('A WEEKLY PERIOD IS ONE WEEK, and every day in it agrees which',
       at('weekly', 5, null, '2026-11-16T10:00:00Z').label === '2026-W47'
       && at('weekly', 5, null, '2026-11-22T23:00:00Z').label === '2026-W47',
       JSON.stringify([at('weekly', 5, null, '2026-11-16T10:00:00Z'),
                       at('weekly', 5, null, '2026-11-22T23:00:00Z')]));
    ok('and the next week is a different one',
       at('weekly', 5, null, '2026-11-23T10:00:00Z').label === '2026-W48');
    ok('and it falls on the weekday chosen',
       at('weekly', 5, null, '2026-11-18T10:00:00Z').dueDate === '2026-11-20'
       && at('weekly', 1, null, '2026-11-18T10:00:00Z').dueDate === '2026-11-16',
       JSON.stringify([at('weekly', 5, null, '2026-11-18T10:00:00Z'),
                       at('weekly', 1, null, '2026-11-18T10:00:00Z')]));
    /* A WEEK THAT SPANS NEW YEAR is one period, not two, and it belongs to
       the ISO week-numbering year rather than the calendar one. Taking the
       year from the date instead of from its Thursday is how 1 January
       lands in week 1 of the wrong year and a group is billed twice. */
    ok('A WEEK ACROSS NEW YEAR IS STILL ONE WEEK',
       at('weekly', 1, null, '2026-12-31T10:00:00Z').label
         === at('weekly', 1, null, '2027-01-01T10:00:00Z').label,
       JSON.stringify([at('weekly', 1, null, '2026-12-31T10:00:00Z').label,
                       at('weekly', 1, null, '2027-01-01T10:00:00Z').label]));
    ok('and it is numbered in the week-numbering year, not the calendar one',
       at('weekly', 1, null, '2027-01-01T10:00:00Z').label === '2026-W53',
       at('weekly', 1, null, '2027-01-01T10:00:00Z').label);

    ok('A FORTNIGHT IS COUNTED FROM THE START DATE',
       at('fortnightly', 5, '2026-11-27', '2026-11-27T10:00:00Z').dueDate === '2026-11-27'
       && at('fortnightly', 5, '2026-11-27', '2026-12-10T23:00:00Z').dueDate === '2026-11-27'
       && at('fortnightly', 5, '2026-11-27', '2026-12-11T00:00:00Z').dueDate === '2026-12-11',
       JSON.stringify([at('fortnightly', 5, '2026-11-27', '2026-12-10T23:00:00Z'),
                       at('fortnightly', 5, '2026-11-27', '2026-12-11T00:00:00Z')]));
    ok('and thirteen days in is still the same fortnight, not the next one',
       at('fortnightly', 5, '2026-11-27', '2026-12-09T10:00:00Z').label === '2026-11-27');
    ok('and a date before the start cannot count backwards',
       at('fortnightly', 5, '2026-11-27', '2026-11-24T10:00:00Z').dueDate === '2026-11-27',
       'openPeriod refuses one, but a service that reads a column must not '
       + 'depend on its one caller to keep it in range');
    ok('and no cadence throws any more',
       ['monthly', 'weekly', 'fortnightly'].every(c => !!at(c, 1, '2026-11-01', '2026-11-21T10:00:00Z').label),
       'openPeriod runs from a daily job over every group, and a throw took '
       + 'that group’s whole run with it');
  }

  const CORE = fs.readFileSync(path.join(ROOT, 'js', 'portal-core.js'), 'utf8');
  const ctx = { window: {}, location: { search: '' }, localStorage: { getItem: () => null },
                sessionStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null },
                Utils: { rand: n => 'R' + Number(n).toFixed(2) }, encodeURIComponent };
  vm.createContext(ctx); vm.runInContext(CORE, ctx);
  ctx._esc = s => String(s == null ? '' : s);
  /* THE PORTAL PRINTS THE SENTENCE IT IS SERVED. It used to build
     `${amount} a month, due on day ${due_day}` itself, which says "a month"
     about a weekly contribution — and asserting that string here is what
     made the wrong wording look correct. */
  const chair = { my_role: 'chairperson', setup: { schedule: {
    amount: 500, due_day: 5, cadence: 'weekly',
    label: 'R 500,00 a week, due every Friday', set_by_name: 'Thandi' } } };
  ok('Contributions shows the schedule, and who set it',
     /R 500,00 a week, due every Friday/.test(ctx._svScheduleBlock(chair, 'G'))
     && /Set by Thandi/.test(ctx._svScheduleBlock(chair, 'G')),
     ctx._svScheduleBlock(chair, 'G').slice(0, 400));
  ok('AND IT DOES NOT SAY "A MONTH" ABOUT A WEEKLY ONE',
     !/a month/.test(ctx._svScheduleBlock(chair, 'G')),
     'the screen had one definition of the sentence and the email had '
     + 'another, and both said month');
  ok('and a payload with no sentence claims no cadence at all',
     !/a month|a week/.test(ctx._svScheduleBlock(
       { my_role: 'member', setup: { schedule: { amount: 500, due_day: 1 } } }, 'G')),
     'a fallback that guesses "a month" is worse than one that says only the amount');
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
    const _dowOf = d => (new Date(d).getUTCDay() || 7);
    const _plusDays = (iso, n) => {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
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

    /* ── And a group that collects on payday ────────────────────────
       The point of the whole change: a weekly rule set through the route
       really does raise one obligation per week. */
    console.log('\nand a group can collect weekly');
    {
      const wk = await setIt('CHAIR', { amount: 100, cadence: 'weekly', due_day: _dowOf(now), start: 'now' });
      ok('the committee can set a weekly contribution',
         wk.status === 200 && wk.body.data.cadence === 'weekly', JSON.stringify(wk.body));
      ok('and is told what it now is, in weeks',
         /a week/.test((wk.body.data || {}).label || ''), (wk.body.data || {}).label);

      const label = iso => {
        const monday = _plusDays(iso, 1 - _dowOf(new Date(iso)));
        const thu = _plusDays(monday, 3);
        const y = Number(thu.slice(0, 4));
        const doy = Math.round((Date.parse(thu + 'T00:00:00Z') - Date.UTC(y, 0, 1)) / 86400000) + 1;
        return `${y}-W${String(Math.floor((doy - 1) / 7) + 1).padStart(2, '0')}`;
      };
      const thisWeek = label(now.toISOString().slice(0, 10));
      const nextWeek = label(_plusDays(now.toISOString().slice(0, 10), 7));

      await contributions.openPeriod(db, G, now);
      ok('THIS WEEK OPENS AT R100 FOR EVERY MEMBER',
         JSON.stringify(await owed(thisWeek)) === '[100,100,100]',
         `${thisWeek}: ${JSON.stringify(await owed(thisWeek))}`);
      await contributions.openPeriod(db, G, now);
      ok('and running it again the same week raises nothing',
         (await owed(thisWeek)).length === 3,
         'the daily job calls this seven times a week, one of which must insert');
      await contributions.openPeriod(db, G, new Date(now.getTime() + 7 * 86400000));
      ok('AND NEXT WEEK IS A NEW PERIOD, not the same one',
         JSON.stringify(await owed(nextWeek)) === '[100,100,100]',
         `${nextWeek}: ${JSON.stringify(await owed(nextWeek))}`);
      ok('so the two weeks are two obligations each, not one',
         thisWeek !== nextWeek, `${thisWeek} vs ${nextWeek}`);
      ok('and the monthly obligations raised before are untouched',
         JSON.stringify(await owed(thisLabel)) === '[500,500,500]',
         'changing the rule does not restate what is owed, whatever the '
         + 'cadence of the new rule');
    }

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
