#!/usr/bin/env node
/* A pool is deployed on its INVESTMENT START DATE, and its successor opens in
 * the same breath.
 *
 * The rule, in the words it was given in:
 *
 *   When the pool reaches the investment start date it changes status from
 *   open to active. When that happens a successor pool must open, at the same
 *   time, at 00:01 (GMT+2) on the investment start date.
 *
 * The cycler used to trigger on the close date instead. For a pool using the
 * console's auto value — investment start = close + 1 day — those two rules
 * pick the same night, which is why the old one looked correct for years. The
 * difference only shows on a pool whose investment start date was set by hand,
 * and then it is total: a round deliberately deployed a fortnight after it
 * stopped raising was deployed the morning after instead, taking its successor
 * with it.
 *
 * So the cases that matter here are the ones where the two dates disagree.
 *
 * Needs a database:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-pool-cycle-trigger.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function isScratchDatabase(url) {
  const name = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(name) || /^svctest/.test(name);
}

async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT to_regclass('public.investment_pools') IS NOT NULL AS ready`);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const quiet = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = quiet; }
  return true;
}

/* A short_term round raises until the end of a month — the first month end
   that is strictly after the day it opens. On any day but a month end that is
   the end of the month it opens in; on a month end it is the next one,
   because a pool cannot close on the day it opens (end_date > start_date). */
function closesOnFirstMonthEndAfterOpen(s) {
  const open  = new Date(s.start_date);
  const close = new Date(s.end_date);
  const isMonthEnd = d =>
    new Date(d.getTime() + 86400000).getUTCMonth() !== d.getUTCMonth();
  if (!isMonthEnd(close)) return false;
  if (!(close > open)) return false;
  // Nothing earlier would have done: the month end before this one is not
  // after the open date.
  const previousMonthEnd = new Date(Date.UTC(close.getUTCFullYear(), close.getUTCMonth(), 0));
  return !(previousMonthEnd > open);
}

const wipe = async () => {
  await pool.query(`DELETE FROM investments     WHERE id LIKE 'PC-%' OR investor_id LIKE 'PC-%'`);
  await pool.query(`DELETE FROM investors       WHERE id LIKE 'PC-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'PC-%'`);
  /* The seeded demo pools sit 'open' years past their close date and would be
     cycled by every run below, burying the pools under test in noise. Each
     case creates exactly what it needs. */
  await pool.query(
    `UPDATE investment_pools SET status='active', cycled_at = NOW()
      WHERE product_type IN ('cattle','short_term') AND id NOT LIKE 'PC-%'`);
};

/* `investStart` null means "leave the column empty" — the pre-existing shape,
   which must keep falling back to close + 1. */
async function makePool(id, { product = 'cattle', status = 'open', close, investStart = null,
                              term = 12, cycled = false } = {}) {
  await pool.query(`
    INSERT INTO investment_pools (id,name,product_type,status,annual_rate,actual_rate,term_months,
        start_date,end_date,investment_start_date,maturity_date,min_investment,
        target_amount,max_investment,risk_level,partner_name,
        management_fee_pct,management_fee_frequency,
        operational_fee_pct,operational_fee_frequency,
        raised_amount,current_invested,investor_count,cycled_at)
    /* The open date is anchored to the close, not to today. It was
       CURRENT_DATE - 60 regardless, so a fixture closing 200 days ago (below)
       described a pool that opened 60 days ago and shut 140 days before it
       opened — the exact shape investment_pools_window_ck now refuses, and the
       one that reached a client statement. Sixty days before its own close is
       a window that could really have existed. */
    VALUES ($1,$2,$3,$4,0.16,0.09,$5,
            CURRENT_DATE + $6::int - 60, CURRENT_DATE + $6::int, NULL,
            CURRENT_DATE + 400, 500,
            9000000, 12000000, 'medium', 'Beefcor',
            0.02,'once',
            0.01,'annual',
            750000, 750000, 9, ${cycled ? 'NOW()' : 'NULL'})`,
    [id, `${product} under test — ${id}`, product, status, term, close]);
  /* Set separately: the offsets above are day counts, and CURRENT_DATE + $n
     needs the cast in a place where it cannot be confused for the DATE the
     column actually holds. Leaving it NULL is a case in its own right — that
     is the shape every pool created before this column existed still has. */
  if (investStart !== null) {
    await pool.query(
      `UPDATE investment_pools SET investment_start_date = CURRENT_DATE + $2::int WHERE id = $1`,
      [id, investStart]);
  }
}

const rowOf = async id =>
  (await pool.query(`SELECT * FROM investment_pools WHERE id = $1`, [id])).rows[0] || null;
const successorOf = async id =>
  (await pool.query(`SELECT * FROM investment_pools WHERE id LIKE $1 ORDER BY created_at`,
                    [`${id}-CYC-%`])).rows[0] || null;
const successorCount = async id =>
  Number((await pool.query(`SELECT COUNT(*) c FROM investment_pools WHERE id LIKE $1`,
                           [`${id}-CYC-%`])).rows[0].c);

const iso = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

(async () => {
  let cycleExpiredPools;
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    ({ cycleExpiredPools } = require(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js')));
    const quiet = () => {};
    const run = async () => {
      const log = console.log; console.log = quiet;
      try { await cycleExpiredPools(); } finally { console.log = log; }
    };

    /* ── The date the rule turns on ──────────────────────────────────── */
    console.log('\nthe trigger is the investment start date, not the close date');

    await wipe();
    /* Closed nine days ago; deployment deliberately set five days out. Under
       the old rule this was cycled eight mornings ago. */
    await makePool('PC-LATER', { close: -9, investStart: 5 });
    await run();
    {
      const p = await rowOf('PC-LATER');
      ok('a pool closed but not yet at its investment start date stays open',
         p.status === 'open',
         `status is "${p.status}" — the close date must not deploy it`);
      ok('and no successor was opened for it', await successorCount('PC-LATER') === 0);
      ok('nor was it marked cycled', p.cycled_at === null);
    }

    await wipe();
    /* The same pool, on the day it was always meant to deploy. */
    await makePool('PC-DUE', { close: -9, investStart: 0 });
    await run();
    {
      const p = await rowOf('PC-DUE');
      const s = await successorOf('PC-DUE');
      ok('on the investment start date it goes open → active', p.status === 'active',
         `status is "${p.status}"`);
      ok('and it is stamped cycled so tomorrow does not repeat it', p.cycled_at !== null);
      ok('a successor opened at the same time', !!s && s.status === 'open',
         s ? `successor status "${s.status}"` : 'no successor');
      ok('the successor starts raising on that same date',
         !!s && iso(s.start_date) === iso(p.investment_start_date),
         s ? `successor opens ${iso(s.start_date)}, deployment date ${iso(p.investment_start_date)}` : '');
    }

    await wipe();
    /* Deployment brought FORWARD, onto the close date itself. */
    await makePool('PC-EARLY', { close: 0, investStart: 0 });
    await run();
    ok('an investment start date set to the close date deploys that same day',
       (await rowOf('PC-EARLY')).status === 'active' && !!(await successorOf('PC-EARLY')));

    /* ── The shape almost every real pool has ────────────────────────── */
    console.log('\na pool with no investment start date falls back to close + 1');

    await wipe();
    await makePool('PC-TODAY', { close: 0, investStart: null });
    await run();
    ok('closing today, it is left alone — deployment is tomorrow',
       (await rowOf('PC-TODAY')).status === 'open' && await successorCount('PC-TODAY') === 0,
       `status "${(await rowOf('PC-TODAY')).status}"`);

    await wipe();
    await makePool('PC-YESTERDAY', { close: -1, investStart: null });
    await run();
    ok('closed yesterday, it deploys today',
       (await rowOf('PC-YESTERDAY')).status === 'active' && !!(await successorOf('PC-YESTERDAY')));

    /* ── The successor is a working pool, not a stub ─────────────────── */
    console.log('\nthe successor it opens');

    await wipe();
    await makePool('PC-SUCC', { product: 'cattle', close: -1, investStart: null, term: 12 });
    const before = await rowOf('PC-SUCC');
    await run();
    {
      const s = await successorOf('PC-SUCC');
      ok('exists and is open', !!s && s.status === 'open');
      ok('carries its own investment start date, rather than leaving it blank',
         !!s && s.investment_start_date !== null,
         'the next cycle reads this column; a NULL here means the chain runs on a fallback');
      ok('and that date is the day after it closes — the console\'s own auto rule',
         !!s && (new Date(s.investment_start_date) - new Date(s.end_date)) === 86400000,
         s ? `closes ${iso(s.end_date)}, deploys ${iso(s.investment_start_date)}` : '');
      ok('it opens on the day its predecessor deployed, leaving no gap',
         !!s && (new Date(s.start_date) - new Date(before.end_date)) === 86400000,
         s ? `predecessor closed ${iso(before.end_date)}, successor opens ${iso(s.start_date)}` : '');
      ok('a cattle round still raises across two whole months',
         !!s && new Date(s.end_date).getUTCMonth() ===
                (new Date(before.end_date).getUTCMonth() + 2) % 12,
         s ? `predecessor closed ${iso(before.end_date)}, successor closes ${iso(s.end_date)}` : '');
      ok('it closes after it opens', !!s && new Date(s.end_date) > new Date(s.start_date),
         s ? `${iso(s.start_date)} → ${iso(s.end_date)}` : '');

      console.log('\n  and it carries the commercial terms forward');
      ok('rate, term, minimum and capacity', !!s &&
         Number(s.annual_rate) === Number(before.annual_rate) &&
         Number(s.term_months) === Number(before.term_months) &&
         Number(s.min_investment) === Number(before.min_investment) &&
         Number(s.max_investment) === Number(before.max_investment));
      ok('fees, partner and risk level', !!s &&
         Number(s.management_fee_pct) === Number(before.management_fee_pct) &&
         s.management_fee_frequency === before.management_fee_frequency &&
         Number(s.operational_fee_pct) === Number(before.operational_fee_pct) &&
         s.partner_name === before.partner_name && s.risk_level === before.risk_level);
      ok('but starts empty — a successor inherits terms, never money', !!s &&
         Number(s.raised_amount) === 0 && Number(s.current_invested) === 0 &&
         Number(s.investor_count) === 0,
         s ? `raised ${s.raised_amount}, invested ${s.current_invested}, investors ${s.investor_count}` : '');
    }

    await wipe();
    await makePool('PC-ST', { product: 'short_term', close: -1, investStart: null, term: 1 });
    const stBefore = await rowOf('PC-ST');
    await run();
    {
      const s = await successorOf('PC-ST');
      ok('a short_term successor closes on the first month end after it opens',
         !!s && closesOnFirstMonthEndAfterOpen(s),
         s ? `opens ${iso(s.start_date)}, closes ${iso(s.end_date)}` : '');
      ok('and it is a short_term pool, like its predecessor',
         !!s && s.product_type === stBefore.product_type);
    }

    /* ── The month end a successor opens on ──────────────────────────
       This assertion used to read "closes at the end of the month it OPENS
       in", which is the rule for every day of the month but one. A successor
       that opens on the last day of a month would have to close the same day
       to satisfy it, and investment_pools_window_ck is CHECK (end_date >
       start_date) — so that INSERT is refused, the cycler's transaction rolls
       back, and the product is left with no pool taking money at all. Which is
       the one thing the whole cycle-in-one-transaction design exists to stop.

       The cycler already handles it: closeDate is pushed out by whole months
       while it is not strictly after the open. The rule is therefore "the
       first month end AFTER it opens", and that is what is asserted above.

       The bug in the old assertion could only fail on the 28th to 31st, so it
       went unseen for as long as nobody ran the suite on a month end. These
       two cases pin both sides of the boundary explicitly, on any day of the
       year, by choosing the open date rather than inheriting today's. */
    console.log('\nand the boundary is the same on every day of the month');
    /* The cycler picks up any pool whose investment start date fell within the
       last 60 days, and that date is also the successor's open date — so the
       open date can be CHOSEN here rather than inherited from today. Both
       sides of the month-end boundary are then exercised on any day of the
       year, which is what the old assertion could not do: it could only fail
       between the 28th and the 31st, and so it did not, for years. */
    const DAY   = 86400000;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const monthEnd = d => new Date(d.getTime() + DAY).getUTCMonth() !== d.getUTCMonth();

    /* The last day of the previous month: strictly before today, and never
       more than 31 days ago, so always inside the 60-day window. */
    const opensOnMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    /* Ten days ago, or eleven if that happened to be a month end. */
    const opensMidMonth = (() => {
      const d = new Date(today.getTime() - 10 * DAY);
      return monthEnd(d) ? new Date(d.getTime() - DAY) : d;
    })();

    for (const [label, openOn, wantMonthEnd] of [
      ['mid-month',   opensMidMonth,   false],
      ['a month end', opensOnMonthEnd, true],
    ]) {
      await wipe();
      const offset = Math.round((openOn - today) / DAY);
      await makePool('PC-ST-EDGE', { product: 'short_term', close: offset - 1,
                                     investStart: offset, term: 1 });
      await run();
      const s = await successorOf('PC-ST-EDGE');

      /* Asserted, not assumed: a fixture that quietly opened on some other day
         would make both cases the same case and both would pass. */
      ok(`opening ${label}: the successor really does open on ${iso(openOn)}`,
         !!s && iso(s.start_date) === iso(openOn),
         s ? `opened ${iso(s.start_date)}` : 'no successor');
      ok(`opening ${label}: and that day ${wantMonthEnd ? 'is' : 'is not'} a month end`,
         !!s && monthEnd(new Date(s.start_date)) === wantMonthEnd);
      ok(`opening ${label}: it closes on the first month end after it opens`,
         !!s && closesOnFirstMonthEndAfterOpen(s),
         s ? `opens ${iso(s.start_date)}, closes ${iso(s.end_date)}` : 'no successor');
      ok(`opening ${label}: in a window the schema will accept`,
         !!s && new Date(s.end_date) > new Date(s.start_date),
         s ? `${iso(s.start_date)} → ${iso(s.end_date)}` : 'no successor');
    }

    /* ── Running twice must not open two successors ──────────────────── */
    console.log('\nrunning it again changes nothing');
    await wipe();
    await makePool('PC-IDEM', { close: -1, investStart: null });
    await run();
    await run();
    await run();
    ok('three runs, one successor', await successorCount('PC-IDEM') === 1,
       `${await successorCount('PC-IDEM')} successors`);
    ok('and the successor was not itself cycled on the same night',
       await successorCount((await successorOf('PC-IDEM')).id) === 0,
       'its investment start date is months away');

    /* ── The window ─────────────────────────────────────────────────── */
    console.log('\nthe 60-day window is measured on the same date as the trigger');
    await wipe();
    await makePool('PC-EDGE', { close: -50, investStart: null });
    await run();
    ok('a pool inside the window cycles', !!(await successorOf('PC-EDGE')));

    await wipe();
    await makePool('PC-ANCIENT', { close: -200, investStart: null });
    await run();
    ok('one long outside it gets no successor', await successorCount('PC-ANCIENT') === 0,
       'a round that ended half a year ago does not get a fresh one minted tonight');
    ok('and it is left sitting open, for the pre-flight to report',
       (await rowOf('PC-ANCIENT')).status === 'open',
       'beyondCyclerWindow in stalePools is what surfaces these — nothing here clears them');

    /* ── The sweep ──────────────────────────────────────────────────── */
    console.log('\nthe sweep that deploys older open pools uses the same date');
    await wipe();
    await makePool('PC-SWEEP-TRIGGER', { close: -3, investStart: null, status: 'active' });
    await makePool('PC-SWEEP-WAITING', { close: -3, investStart: 10 });
    await makePool('PC-SWEEP-RAISING', { close: 20, investStart: null });
    await makePool('PC-SWEEP-PAST',    { close: -4, investStart: null, cycled: true });
    await run();
    ok('an open pool past its investment start date is deployed',
       (await rowOf('PC-SWEEP-PAST')).status === 'active',
       `PC-SWEEP-PAST is "${(await rowOf('PC-SWEEP-PAST')).status}"`);
    ok('one still raising is left open',
       (await rowOf('PC-SWEEP-RAISING')).status === 'open',
       `PC-SWEEP-RAISING is "${(await rowOf('PC-SWEEP-RAISING')).status}"`);
    ok('and one closed but awaiting its investment start date is left open too',
       (await rowOf('PC-SWEEP-WAITING')).status === 'open',
       'the sweep must respect a deployment date an admin set by hand');

    /* ── The schedule ───────────────────────────────────────────────── */
    console.log('\nthe time it runs, and the day it thinks it is');
    {
      const src  = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const job  = require(path.join(ROOT, 'server', 'jobs', 'poolCyclerCron.js'));

      ok('00:01, daily', /cron\.schedule\('1 0 \* \* \*'/.test(code));
      ok('in SAST, not the server\'s UTC', job.BUSINESS_TZ === 'Africa/Johannesburg', String(job.BUSINESS_TZ));

      /* The schedule and the query have to take their timezone from the SAME
         place. Pinning the cron and leaving the SQL on CURRENT_DATE is the
         bug this section exists for: the job woke at the right local time and
         then asked the database a question in the wrong timezone. */
      ok('the schedule takes the timezone from the shared constant',
         /timezone: BUSINESS_TZ/.test(code) && !/timezone: 'Africa\/Johannesburg'/.test(code),
         'a second literal is a second thing to forget');
      ok('and so does the date the queries compare against',
         /const TODAY = `\(now\(\) AT TIME ZONE '\$\{BUSINESS_TZ\}'\)::date`/.test(code),
         String(job.TODAY));
      ok('no query in the job still asks for CURRENT_DATE',
         !/CURRENT_DATE/.test(code),
         'Postgres evaluates CURRENT_DATE in the DATABASE timezone, which is UTC');
      ok('every date comparison in the job uses it',
         (code.match(/\$\{TODAY\}/g) || []).length >= 5,
         `found ${(code.match(/\$\{TODAY\}/g) || []).length}`);

      /* The boundary, tested against the real expression at the real firing
         moment rather than whenever this check happens to run.

         00:01 SAST on the 1st IS 22:01 UTC on the 30th. A pool due to deploy
         on the 1st has to be visible to that run; under CURRENT_DATE it was
         not, and the pool sat open until 23:00 SAST the same evening. */
      const at = t => job.TODAY.replace('now()', `TIMESTAMPTZ '${t}'`);
      const FIRES   = '2026-09-30 22:01:00+00';   // 00:01 SAST, 1 October
      const DAY_BEF = '2026-09-29 22:01:00+00';   // 00:01 SAST, 30 September

      const { rows: [b] } = await pool.query(
        `SELECT ${at(FIRES)}                                   AS today_now,
                (TIMESTAMPTZ '${FIRES}' AT TIME ZONE 'UTC')::date AS today_before,
                DATE '2026-10-01' <= ${at(FIRES)}              AS due_pool_selected,
                DATE '2026-10-01' <= (TIMESTAMPTZ '${FIRES}' AT TIME ZONE 'UTC')::date AS was_selected_before,
                DATE '2026-10-01' <= ${at(DAY_BEF)}            AS selected_a_day_early`);

      ok('at 00:01 SAST on the 1st the job knows it is the 1st',
         iso(b.today_now) === '2026-10-01', iso(b.today_now));
      ok('and a pool due that day is picked up', b.due_pool_selected === true);
      ok('which is exactly what CURRENT_DATE got wrong',
         iso(b.today_before) === '2026-09-30' && b.was_selected_before === false,
         'if this ever passes, the database timezone changed and this fix is moot');
      ok('and it still does not run a day early',
         b.selected_a_day_early === false,
         'a pool must not deploy before its investment start date');

      /* The pre-flight exists to predict what the job will do. It imported
         INVESTMENT_START to avoid a second definition of the trigger and then
         kept its own notion of today, which would disagree with the job in
         the 00:00–02:00 SAST window the job actually runs in. */
      const pf = fs.readFileSync(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      ok('the pre-flight takes its date from the job too',
         /require\('\.\.\/jobs\/poolCyclerCron'\)/.test(pf) && /TODAY/.test(pf));
      ok('and keeps no second notion of today', !/CURRENT_DATE/.test(pf),
         'it would predict a different set from the job at 00:01 SAST');
    }

    /* ── The pre-flight agrees with the job ─────────────────────────── */
    console.log('\nthe pre-flight predicts the same pools');
    await wipe();
    await makePool('PC-PF-DUE',     { close: -9, investStart: 0 });
    await makePool('PC-PF-WAITING', { close: -9, investStart: 5 });
    {
      /* The pre-flight returns early when nothing is maturing — it is a report
         about tonight's money movement, and pendingCycle is one section of it.
         So there has to be something maturing for the section to be reached. */
      await pool.query(`
        INSERT INTO investors (id,first_name,last_name,email,status,wallet_balance)
        VALUES ('PC-INV','Pre','Flight','pc@example.test','active',0)`);
      await pool.query(`
        INSERT INTO investments (id,investor_id,pool_id,pool_name,amount,status,
            start_date,end_date,annual_rate,term_months,expected_return,actual_return,
            product_type,maturity_instruction)
        VALUES ('PC-INV-1','PC-INV','PC-PF-DUE','cattle under test — PC-PF-DUE',
                50000,'active',CURRENT_DATE-365,CURRENT_DATE,0.16,12,0,0,'cattle','payout')`);

      const { runMaturityPreflight } =
        require(path.join(ROOT, 'server', 'services', 'maturityPreflight.js'));
      const r = await runMaturityPreflight(pool, { horizonDays: 14 });
      const due = (r.pendingCycle || []).map(p => p.poolId);
      ok('it names the pool that will cycle tonight', due.includes('PC-PF-DUE'), JSON.stringify(due));
      ok('and not the one waiting on a later date', !due.includes('PC-PF-WAITING'), JSON.stringify(due));

      await run();
      const actuallyCycled = (await pool.query(
        `SELECT id FROM investment_pools WHERE id LIKE 'PC-PF-%' AND cycled_at IS NOT NULL`
      )).rows.map(x => x.id);
      ok('and the job did exactly what it predicted',
         JSON.stringify(actuallyCycled.sort()) === JSON.stringify(due.filter(d => d.startsWith('PC-PF-')).sort()),
         `predicted ${JSON.stringify(due)}, cycled ${JSON.stringify(actuallyCycled)}`);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query(`DELETE FROM investments     WHERE id LIKE 'PC-%' OR investor_id LIKE 'PC-%'`).catch(() => {});
    await pool.query(`DELETE FROM transactions    WHERE investor_id LIKE 'PC-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors       WHERE id LIKE 'PC-%'`).catch(() => {});
    await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'PC-%'`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
