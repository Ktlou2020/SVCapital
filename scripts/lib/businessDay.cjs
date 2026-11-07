/* What day it is, for a fixture that will be judged by the engine.
 *
 * Every schedule on this platform is pinned to the South African business
 * day. The pool cycler runs at 00:01 SAST, the maturity engine at 23:00
 * SAST, and both ask `(now() AT TIME ZONE 'Africa/Johannesburg')::date` what
 * day that is — exported as TODAY from jobs/poolCyclerCron, so there is one
 * definition. check-pool-cycle-trigger goes further and FORBIDS the job a
 * second notion of today: it asserts that no query in it still says
 * CURRENT_DATE, because Postgres evaluates that in the database's timezone,
 * which is UTC.
 *
 * The fixtures of those same checks then seeded their rows with
 * CURRENT_DATE, and one of them with `new Date().toISOString()`.
 *
 * Between 22:00 and 00:00 UTC — which is 00:00 to 02:00 SAST, and so covers
 * the cycler's own 00:01 run — UTC and SAST are on different dates. For those
 * two hours a row seeded as "maturing today" is YESTERDAY's to the engine,
 * which correctly treats it as overdue, and the check fails. Four of them
 * did, every single night, for two hours:
 *
 *   check-maturity-catchup          check-pool-cycle-trigger
 *   check-maturity-pool-handover    check-rollover-timing
 *
 * and run-checks failed with them, so for two hours a night the suite could
 * not go green and the assertion floor could not be raised. None of it was a
 * fault in the product. The engine was right every time.
 *
 * So: a fixture that means "today" uses the SAME expression the engine does,
 * and one that needs the date in JavaScript reads it back through that
 * expression rather than computing a second answer. Not a reimplementation of
 * Africa/Johannesburg in JS — a reimplementation is how you get a third
 * notion of today.
 *
 * Use TODAY directly inside SQL:
 *
 *   const { TODAY } = require('../../server/jobs/poolCyclerCron');
 *   await db.query(`... VALUES (${TODAY} - 29, ${TODAY}, ${TODAY} + 1)`);
 *
 * and businessToday(db) when JavaScript has to hold it:
 *
 *   const today = await businessToday(db);          // '2026-11-08'
 *   const t     = await businessTodayUTC(db);       // Date, midnight UTC
 */
'use strict';

const { TODAY } = require('../../server/jobs/poolCyclerCron');

/* The business day as 'YYYY-MM-DD'. Selected ::text on purpose: a DATE column
   arrives from node-postgres as a Date at LOCAL midnight, and reading a day
   number back off that is the same mistake one layer down. */
async function businessToday(db) {
  const { rows } = await db.query(`SELECT ${TODAY}::text AS d`);
  return rows[0].d;
}

/* The same day as a JS Date at midnight UTC, for fixtures that do date
   arithmetic with getUTC*. The calendar day is the business day; the UTC
   midnight is only a carrier for it, so day counts come out whole. */
async function businessTodayUTC(db) {
  return new Date((await businessToday(db)) + 'T00:00:00Z');
}

module.exports = { businessToday, businessTodayUTC, TODAY };
