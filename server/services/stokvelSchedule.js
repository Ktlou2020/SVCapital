'use strict';
/* ═══════════════════════════════════════════════════════════
   The committee sets the group's contribution.

   What every member pays, and on what day, was typed into the console by
   SV Capital staff: the group's setup checklist sent the committee to
   WhatsApp to ask. It is now the committee's own setting, as it is in the
   group's constitution.

   WHY THE COMMITTEE AND NOT THE SIGNATORIES. The signatories guard money
   LEAVING the group. A contribution is money members put IN; setting it
   moves nothing and authorises nothing, so it belongs with the other
   administrative powers the committee already holds (inviting members,
   levying a fine, planning a payout). What protects the members is that
   they can all see it and are all told when it changes.

   THE RULES THAT MATTER:

   · WHAT IS OWED STAYS OWED AT ITS OWN AMOUNT. A schedule is a rule; each
     period's obligation snapshots the amount when the period opens
     (stokvelContributions). Changing the rule from R500 to R600 in March
     does not restate February for anybody — the person behind is exactly
     the person who will check. So a change ends the old schedule and
     starts a new one, which is also how the console has always done it.
   · ONE LIVE SCHEDULE PER GROUP, enforced by a partial unique index, and
     the end and the start happen in one transaction.
   · A START MONTH, so a schedule set on the 20th with a due day of the 1st
     does not raise an obligation that is overdue the moment it exists. It
     defaults to next month whenever this month's due day has passed.
   · MONTHLY, FORTNIGHTLY OR WEEKLY. Monthly was all openPeriod generated,
     so the other two were refused rather than stored and silently never
     raised — which was right, and is why a stokvel that collects on payday
     could not be set up here at all. All three are generated now, and
     DUE_DAY MEANS DIFFERENT THINGS: the day of the month when monthly, the
     day of the WEEK when weekly (1 = Monday), and nothing at all when
     fortnightly, where the fortnight is counted from the start date and
     falls on that same weekday for ever.
   · ONE SENTENCE SAYS WHAT THE RULE IS, here — describe(). The portal, the
     console and the member's email all print it. Three places writing
     "a month" after an amount is how a weekly group gets told it pays
     monthly.
   · WHO SET IT is recorded, and every member is told (stokvelNotify).
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const MAX_AMOUNT = 100000;   // per member per period — a sanity bound, not a product rule

const CADENCES = ['monthly', 'fortnightly', 'weekly'];

/* What due_day means, what the amount is "per", and how far one period is
   from the next. One table rather than a switch in five places. */
const CADENCE = {
  monthly:     { every: 'a month',          dueDayIs: 'day_of_month' },
  fortnightly: { every: 'every second week', dueDayIs: 'from_the_start_date' },
  weekly:      { every: 'a week',           dueDayIs: 'day_of_week' },
};

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];

/* "R 500,00" — the platform's one notation, as js/api.js Utils.rand writes
   it and as every generated document has always written it. In South Africa
   the comma is the decimal separator, so "R500.00" is genuinely ambiguous
   to the person reading it; and this sentence is printed on a screen beside
   amounts that came through Utils.rand, so it has to match them. */
const fmtR = v => 'R ' + Number(v || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function _sastToday() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}
function _firstOfNextMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}
/* A DATE COLUMN COMES BACK FROM node-postgres AS A Date OBJECT, and
   String(someDate).slice(0, 10) is "Fri Nov 2" — which then parses as an
   invalid date and throws on .toISOString(). Setting a weekly schedule
   answered 500 for exactly that reason, after the row had already been
   committed. Everything here goes through one normaliser instead. */
function _isoOf(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v == null ? '' : v).slice(0, 10);
}
/* ISO weekday, Monday = 1 ... Sunday = 7. Dates here are plain YYYY-MM-DD
   and are read as UTC, so a local midnight cannot shift one by a day. */
function _dow(iso) {
  const d = new Date(_isoOf(iso) + 'T00:00:00Z');
  return d.getUTCDay() || 7;
}
function _addDays(iso, n) {
  const d = new Date(_isoOf(iso) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/* A weekly due day is a day of the WEEK. A schedule changed from monthly to
   weekly arrives carrying a day of the month, so it is wrapped onto 1..7
   rather than refused in the service — the route refuses it, and a stored
   row that predates the route must still produce a date. */
const asWeekday = n => ((Math.max(1, Number(n) || 1) - 1) % 7) + 1;

/* This period, unless its due day has already gone by — a schedule that
   starts with an obligation already overdue is the one thing the start
   option exists to avoid. Fortnightly has no such hazard: the fortnight is
   counted from the start date, so the first one falls ON it. */
function defaultStart(dueDay, today = _sastToday(), cadence = 'monthly') {
  if (cadence === 'fortnightly') return 'now';
  if (cadence === 'weekly') return _dow(today) > asWeekday(dueDay) ? 'next' : 'now';
  return Number(today.slice(8, 10)) > Number(dueDay) ? 'next' : 'now';
}

/* THE WIRE STILL CARRIES this_month / next_month. The app that is installed
   on members' phones sends those two strings, and it cannot be updated
   until the next release, so they are accepted as the two the portal sends
   now. Everything inside works in 'now' and 'next', which is what they mean
   once a period is not always a month. */
const START_ALIASES = { this_month: 'now', next_month: 'next', now: 'now', next: 'next' };

function parse(body) {
  const b = body || {};
  const amount = Math.round((parseFloat(b.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { error: 'Say how much each member pays.' };
  const cadence = String(b.cadence || 'monthly');
  if (!CADENCES.includes(cadence)) {
    return { error: 'Contributions are monthly, fortnightly or weekly.' };
  }
  if (amount > MAX_AMOUNT) {
    return { error: `That is more than R${MAX_AMOUNT.toLocaleString('en-ZA')} `
                  + `${CADENCE[cadence].every} each. Talk to us if that is right.` };
  }
  const dueDay = parseInt(b.due_day, 10);
  if (cadence === 'weekly') {
    if (!(dueDay >= 1 && dueDay <= 7)) {
      return { error: 'For a weekly contribution the due day is a day of the week, 1 (Monday) to 7 (Sunday).' };
    }
  } else if (cadence === 'monthly') {
    if (!(dueDay >= 1 && dueDay <= 31)) return { error: 'The due day must be between 1 and 31.' };
  }
  /* Fortnightly takes no due day: the day it lands on is the day the
     schedule starts, and asking for a second answer is asking for two that
     can disagree. The column is NOT NULL, so the start date's own weekday
     is stored in it — the same answer, recorded rather than left at 1. */
  const start = START_ALIASES[String(b.start || defaultStart(dueDay, undefined, cadence))];
  if (!start) return { error: 'Start this period or the next one.' };
  return {
    schedule: {
      amount, cadence, start,
      dueDay: cadence === 'fortnightly' ? null
            : cadence === 'weekly' ? asWeekday(dueDay) : dueDay,
    },
  };
}

/* The month a schedule starting on a date first applies to, as "November 2026". */
function monthLabel(isoDate) {
  const d = _isoOf(isoDate);
  return `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
/* "21 November 2026" — a date a person can read back. */
function dateLabel(isoDate) {
  const d = _isoOf(isoDate);
  return `${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

/* WHEN IT FIRST APPLIES, in the words the cadence calls for. A monthly
   schedule applies to a month, a fortnightly one starts on a date, and a
   weekly one starts in a week. */
function firstPeriodLabel(schedule) {
  const starts = _isoOf((schedule && schedule.starts_on) || (schedule && schedule.startsOn) || '');
  if (!starts) return '';
  const cadence = String((schedule && schedule.cadence) || 'monthly');
  if (cadence === 'monthly') return monthLabel(starts);
  if (cadence === 'fortnightly') return dateLabel(starts);
  return `the week of ${dateLabel(_addDays(starts, 1 - _dow(starts)))}`;
}

/* WHEN IT FALLS DUE, in one phrase: "day 1 of the month", "every Friday",
   "every second Friday". */
function dueLabel(schedule) {
  const cadence = String((schedule && schedule.cadence) || 'monthly');
  if (cadence === 'monthly') {
    return `day ${Number((schedule && schedule.due_day) || (schedule && schedule.dueDay) || 1)} of the month`;
  }
  const weekday = cadence === 'fortnightly'
    /* The fortnight lands on the weekday the schedule started on, which is
       the only answer that cannot disagree with the dates generated. */
    ? _dow((schedule && schedule.starts_on) || (schedule && schedule.startsOn) || _sastToday())
    : asWeekday((schedule && schedule.due_day) || (schedule && schedule.dueDay) || 1);
  return `every ${cadence === 'fortnightly' ? 'second ' : ''}${DAY_NAMES[weekday - 1]}`;
}

/* The same phrase with its preposition. "due on day 1 of the month" and
   "due every Friday" both read; "due on every Friday" does not, and a
   single template produces one of them. */
function duePhrase(schedule) {
  const monthly = String((schedule && schedule.cadence) || 'monthly') === 'monthly';
  return `${monthly ? 'on ' : ''}${dueLabel(schedule)}`;
}

/* THE ONE SENTENCE. The portal prints it, the console prints it, and the
   email that tells every member prints it. */
function describe(schedule) {
  const cadence = String((schedule && schedule.cadence) || 'monthly');
  const every = (CADENCE[cadence] || CADENCE.monthly).every;
  return `${fmtR(schedule && schedule.amount)} ${every}, due ${duePhrase(schedule)}`;
}

/**
 * End the group's live schedule (if any) and start the new one, in the
 * caller's transaction. Returns { schedule, previous } or { error }.
 */
async function set(client, group, actorId, s) {
  const { rows: [previous] } = await client.query(
    `SELECT * FROM stokvel_contribution_schedules
      WHERE sub_account_id = $1 AND active FOR UPDATE`, [group.id]);
  const today = _sastToday();

  /* WHERE THE NEXT PERIOD STARTS DEPENDS ON HOW LONG A PERIOD IS.
     Monthly steps to the 1st of next month, as it always has. Weekly steps
     to next Monday, so the week the schedule applies from is a whole one.
     Fortnightly steps a fortnight, because the start date IS the anchor
     every later fortnight is counted from — move it by anything else and
     every date the group ever pays on moves with it. */
  const startsOn = s.start !== 'next' ? today
    : s.cadence === 'monthly'     ? _firstOfNextMonth(today)
    : s.cadence === 'fortnightly' ? _addDays(today, 14)
    :                               _addDays(today, 8 - _dow(today));

  /* Fortnightly has no due day of its own: it falls on the weekday it
     starts on. Stored rather than left at the column default, so the row
     says the same thing the generated dates do. */
  const dueDay = s.cadence === 'fortnightly' ? _dow(startsOn) : s.dueDay;

  /* THE CADENCE IS PART OF "ALREADY THE GROUP'S CONTRIBUTION". R500 a month
     and R500 a week are not the same rule, and comparing only the amount
     and the day refused the change to the one that matters most. */
  if (previous && Math.round(Number(previous.amount) * 100) === Math.round(s.amount * 100)
      && Number(previous.due_day) === Number(dueDay)
      && String(previous.cadence) === s.cadence) {
    return { error: 'That is already the group’s contribution.' };
  }
  if (previous) {
    await client.query(
      `UPDATE stokvel_contribution_schedules SET active = false, updated_at = NOW() WHERE id = $1`,
      [previous.id]);
  }
  const id = 'SCS-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
  const { rows: [schedule] } = await client.query(
    `INSERT INTO stokvel_contribution_schedules
       (id, sub_account_id, amount, cadence, due_day, starts_on, active, set_by)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING *`,
    [id, group.id, s.amount, s.cadence, dueDay, startsOn, actorId]);
  return { schedule, previous: previous || null };
}

module.exports = { MAX_AMOUNT, CADENCES, CADENCE, parse, set, defaultStart,
                   monthLabel, dateLabel, firstPeriodLabel, dueLabel, duePhrase,
                   describe };
