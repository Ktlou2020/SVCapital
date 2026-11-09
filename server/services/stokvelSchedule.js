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
   · MONTHLY ONLY, because that is all openPeriod generates; anything else
     is refused rather than stored and silently never raised.
   · WHO SET IT is recorded, and every member is told (stokvelNotify).
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const MAX_AMOUNT = 100000;   // per member per month — a sanity bound, not a product rule

function _sastToday() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}
function _firstOfNextMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}
/* This month, unless its due day has already passed. */
function defaultStart(dueDay, today = _sastToday()) {
  return Number(today.slice(8, 10)) > Number(dueDay) ? 'next_month' : 'this_month';
}

function parse(body) {
  const b = body || {};
  const amount = Math.round((parseFloat(b.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return { error: 'Say how much each member pays.' };
  if (amount > MAX_AMOUNT) return { error: `That is more than R${MAX_AMOUNT.toLocaleString('en-ZA')} a month each. Talk to us if that is right.` };
  const dueDay = parseInt(b.due_day, 10);
  if (!(dueDay >= 1 && dueDay <= 31)) return { error: 'The due day must be between 1 and 31.' };
  const cadence = String(b.cadence || 'monthly');
  if (cadence !== 'monthly') return { error: 'Contributions are monthly for now.' };
  const start = String(b.start || defaultStart(dueDay));
  if (!['this_month', 'next_month'].includes(start)) return { error: 'Start this month or next month.' };
  return { schedule: { amount, dueDay, cadence, start } };
}

/* The month a schedule starting on a date first applies to, as "November 2026". */
function monthLabel(isoDate) {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                 'August', 'September', 'October', 'November', 'December'];
  const d = String(isoDate).slice(0, 10);
  return `${names[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
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
  const startsOn = s.start === 'next_month' ? _firstOfNextMonth(today) : today;
  if (previous && Math.round(Number(previous.amount) * 100) === Math.round(s.amount * 100)
      && Number(previous.due_day) === s.dueDay) {
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
     VALUES ($1,$2,$3,'monthly',$4,$5,true,$6) RETURNING *`,
    [id, group.id, s.amount, s.dueDay, startsOn, actorId]);
  return { schedule, previous: previous || null };
}

module.exports = { MAX_AMOUNT, parse, set, defaultStart, monthLabel };
