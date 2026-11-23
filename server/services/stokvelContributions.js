'use strict';
/* ═══════════════════════════════════════════════════════════
   Contributions — turning the rule into obligations, and taking payment.

   The schedule says what everybody pays. It does not say what anybody owes:
   that is an obligation, one row per member per period, carrying the amount
   as it stood when the period opened.

   The distinction is the whole design. Derive arrears from today's schedule
   and a stokvel that raises its contribution in March silently restates what
   February's defaulters owe — and the people in arrears are precisely the
   ones who will check. Snapshot it and February stays February.
   ═══════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { recordTransaction, systemActor } = require('./ledger');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ─── Which period a date falls in ────────────────────────────────────
   THE LABEL IS THE IDENTITY OF A PERIOD. The unique index is on
   (stokvel, member, period_label), so it is the label — not the due date —
   that stops a daily job from raising the same obligation thirty times.
   Each cadence therefore needs a label that is unique to one of its
   periods and to no other:

     monthly      2026-11      the calendar month
     weekly       2026-W47     the ISO week, which is unique within its own
                               week-numbering year even when that year is
                               not the calendar one
     fortnightly  2026-11-27   the date the fortnight starts, counted from
                               the schedule's start date

   It was monthly only, and threw on the other two — so a stokvel that
   collects on payday could not be set up at all. The cadence column and its
   CHECK already allowed all three; only this function and the form did not.

   DUE_DAY MEANS DIFFERENT THINGS BY CADENCE: day of the month when monthly,
   ISO day of the week when weekly (1 = Monday), and nothing when
   fortnightly, where the day is fixed by the start date. */

/* A DATE column arrives from node-postgres as a Date object, so schedule
   .starts_on is sometimes a Date and sometimes the string a caller passed.
   One normaliser: String(aDate).slice(0, 10) is "Fri Nov 2", which parses
   as an invalid date and throws. */
const _iso   = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const _isoOf = v => (v instanceof Date ? v.toISOString().slice(0, 10)
                                       : String(v == null ? '' : v).slice(0, 10));
const _dow   = iso => (new Date(iso + 'T00:00:00Z').getUTCDay() || 7);
const _addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/* The ISO week-numbering year and week of a date, taken from the Thursday
   of its week — which is the definition: week 1 is the week containing the
   year's first Thursday. Taking it from the Monday or from the date itself
   is how 29 December lands in week 1 of the wrong year. */
function _isoWeekLabel(anyDayOfTheWeek) {
  const monday = _addDays(anyDayOfTheWeek, 1 - _dow(anyDayOfTheWeek));
  const thu    = _addDays(monday, 3);
  const year   = Number(thu.slice(0, 4));
  const dayOfYear = Math.round(
    (Date.parse(thu + 'T00:00:00Z') - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const week = Math.floor((dayOfYear - 1) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function periodFor(schedule, when) {
  const cadence = String(schedule.cadence || 'monthly');
  const today = _iso(when);

  if (cadence === 'weekly') {
    /* A day of the week, 1..7. A schedule changed over from monthly can
       carry a day of the month, so it is wrapped rather than throwing:
       refusing here would stop the job for the whole group, and the route
       will not accept one above 7 in the first place. */
    const day = ((Math.max(1, Number(schedule.due_day) || 1) - 1) % 7) + 1;
    const monday = _addDays(today, 1 - _dow(today));
    return { label: _isoWeekLabel(today), dueDate: _addDays(monday, day - 1) };
  }

  if (cadence === 'fortnightly') {
    /* COUNTED FROM THE START DATE, which is the anchor every fortnight this
       group will ever pay on is measured from. openPeriod refuses a date
       before the start, so the index cannot go negative; it is floored all
       the same, because a service that reads a column must not depend on
       its one caller to keep it in range. */
    const anchor = _isoOf(schedule.starts_on) || today;
    const days = Math.round(
      (Date.parse(today + 'T00:00:00Z') - Date.parse(anchor + 'T00:00:00Z')) / 86400000);
    const dueDate = _addDays(anchor, 14 * Math.max(0, Math.floor(days / 14)));
    return { label: dueDate, dueDate };
  }

  const d = new Date(when);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();                    // 0-based
  /* A due day past the end of a short month settles on its last day rather
     than rolling into the next one — a February obligation is due in
     February. */
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Number(schedule.due_day) || 1, lastDay);
  const label = `${year}-${String(month + 1).padStart(2, '0')}`;
  const dueDate = `${label}-${String(day).padStart(2, '0')}`;
  return { label, dueDate };
}

/**
 * Open a period for one stokvel: one obligation per ACTIVE member.
 *
 * Safe to run again. The unique index on (stokvel, member, period) means a
 * second run inserts nothing rather than doubling what everybody owes, which
 * matters because this runs from a daily job — it will be called about thirty
 * times for every period it opens.
 *
 * Somebody who joins mid-period gets an obligation the next time it runs;
 * somebody who leaves keeps the obligations they already have, because a
 * debt is not cancelled by walking away from the group.
 */
async function openPeriod(client, subAccountId, when = new Date()) {
  const { rows: [schedule] } = await client.query(
    `SELECT * FROM stokvel_contribution_schedules
      WHERE sub_account_id = $1 AND active = true`,
    [subAccountId]
  );
  if (!schedule) return { created: 0, skipped: 'no active schedule' };
  if (new Date(schedule.starts_on) > new Date(when)) {
    return { created: 0, skipped: 'schedule has not started' };
  }

  const { label, dueDate } = periodFor(schedule, when);

  /* What each member pays. A group whose constitution sets one amount for
     everybody — which is most of them — leaves contribution_amount null and
     gets the schedule's figure; a group with members on different amounts
     sets it per member. */
  const { rows: members } = await client.query(
    `SELECT investor_id, contribution_amount FROM stokvel_members
      WHERE sub_account_id = $1 AND status = 'active'`,
    [subAccountId]
  );

  let created = 0;
  for (const m of members) {
    const { rowCount } = await client.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, schedule_id, period_label,
          amount_due, due_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'due')
       ON CONFLICT (sub_account_id, investor_id, period_label) DO NOTHING`,
      ['SC-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase(),
       subAccountId, m.investor_id, schedule.id, label,
       round2(m.contribution_amount != null ? m.contribution_amount : schedule.amount), dueDate]
    );
    created += rowCount;
  }
  return { created, period: label, due_date: dueDate };
}

/**
 * Pay a contribution from the member's own wallet into the stokvel's.
 *
 * Everything here happens in the caller's transaction, and the caller is
 * expected to have opened one: the member's wallet, the stokvel's wallet,
 * the obligation and both ledger rows have to move together or not at all.
 *
 * Returns { paid, outstanding } or throws a message meant for a person.
 */
async function pay(client, { contribution, investorId, subAccount, amount, actor }) {
  /* NUMERIC arrives from node-postgres as a STRING, and the first draft of
     this added one to a number: round2(contribution.amount_paid + want) with
     amount_paid "0.00" and want 500 concatenated to "0.00500", which is
     0.005, which rounds to a cent. The obligation then never settled, so the
     member could pay it again — and did, in the check that caught this.
     Subtraction coerces and looked fine, which is exactly why it survived
     being read. Every figure off the row is parsed here, once. */
  const dueAmt  = round2(Number(contribution.amount_due));
  const paidAmt = round2(Number(contribution.amount_paid));
  const outstanding = round2(dueAmt - paidAmt);
  const want = round2(amount);

  if (contribution.status !== 'due') throw new Error('That contribution is already settled.');
  if (!(want > 0))                   throw new Error('An amount is required.');
  /* Refused rather than accepted and held as credit. A stokvel's books are
     per period; money arriving against a period that is already covered has
     nowhere correct to sit, and guessing is how a surplus becomes a dispute. */
  if (want > outstanding) {
    throw new Error(`That is more than is outstanding on this contribution (R${outstanding.toFixed(2)}).`);
  }

  const { rows: [me] } = await client.query(
    'SELECT wallet_balance FROM investors WHERE id = $1 FOR UPDATE', [investorId]);
  if (!me) throw new Error('No such member.');
  const walletHas = round2(Number(me.wallet_balance));
  if (walletHas < want) {
    throw new Error(`Not enough in your wallet. Available: R${walletHas.toFixed(2)}.`);
  }

  const ref = 'SCP-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

  await client.query(
    'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
    [want, investorId]);
  await client.query(
    'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
    [want, subAccount.id]);

  /* Both sides of the pair. See services/ledger.js: listing one without the
     other would report a contribution as money entering or leaving the
     platform, which it never is. */
  /* The same actor on both legs: one member's decision, seen from the
     member's wallet and from the group's. */
  const who = actor || systemActor('stokvelContributions');
  await recordTransaction(client, {
    investorId, type: 'stokvel_contribution', amount: want, reference: ref,
    description: `Contribution to ${subAccount.name} — ${contribution.period_label}`,
  }, who);
  await recordTransaction(client, {
    investorId: subAccount.parent_investor_id, subAccountId: subAccount.id,
    type: 'stokvel_contribution_received', amount: want, reference: ref + '-R',
    description: `Contribution received — ${contribution.period_label}`,
  }, who);

  /* The share ledger's one hooked event. A contribution is the only movement
     on a stokvel wallet that names a member, so it is the only one written
     where it happens; everything else is placed by stokvelShares.reconcile.
     Inside this transaction, because money that moved and a share that did
     not are the same bug seen from either side. */
  const shares = require('./stokvelShares');
  await shares.allocateContribution(client, {
    subAccountId: subAccount.id, investorId, amount: want,
    reference: ref, periodLabel: contribution.period_label,
  });

  const nowPaid = round2(paidAmt + want);
  const settled = nowPaid >= dueAmt;
  await client.query(
    `UPDATE stokvel_contributions
        SET amount_paid = $2, status = $3, paid_at = CASE WHEN $3 = 'paid' THEN NOW() ELSE paid_at END,
            updated_at = NOW()
      WHERE id = $1`,
    [contribution.id, nowPaid, settled ? 'paid' : 'due']);

  return { paid: want, outstanding: round2(dueAmt - nowPaid), reference: ref };
}

/* ─── Money into the pot that is not a scheduled contribution ──────
   A member putting extra in: settling arrears in one go, a late joiner
   catching up, cash they have decided to add.

   IT MOVES FROM THEIR OWN WALLET, exactly as a contribution does, and for
   the same reason. The alternative — topping the group wallet up directly
   through the ordinary deposit flow — credits sub_accounts.wallet_balance
   with nothing recording whose money it was, and stokvelShares.reconcile
   then does what it is built to do and shares the increase across every
   member pro-rata. So a treasurer who banked R5 000 of their own would get
   back their share of it and no more. The contribution path already solves
   this; this is the same path without a schedule.

   Written as a contribution allocation, in the same transaction as the
   money, so there is never a moment when the wallet has moved and the
   ledger has not. */
async function payIn(client, { subAccount, investorId, amount, note, actor }) {
  const want = round2(amount);
  if (!(want > 0)) throw new Error('An amount is required.');

  const { rows: [me] } = await client.query(
    'SELECT wallet_balance FROM investors WHERE id = $1 FOR UPDATE', [investorId]);
  if (!me) throw new Error('No such member.');
  const walletHas = round2(Number(me.wallet_balance));
  if (walletHas < want) {
    throw new Error(`Not enough in your wallet. Available: R${walletHas.toFixed(2)}.`);
  }

  const ref = 'SPI-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

  await client.query(
    'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
    [want, investorId]);
  await client.query(
    'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
    [want, subAccount.id]);

  /* Both sides of the pair, as services/ledger.js requires: listing one
     without the other reports money entering or leaving the platform, which
     this never does. */
  const who = actor || systemActor('stokvelContributions');
  await recordTransaction(client, {
    investorId, type: 'stokvel_contribution', amount: want, reference: ref,
    description: `Paid into ${subAccount.name}${note ? ' \u2014 ' + String(note).slice(0, 80) : ''}`,
  }, who);
  await recordTransaction(client, {
    investorId: subAccount.parent_investor_id, subAccountId: subAccount.id,
    type: 'stokvel_contribution_received', amount: want, reference: ref + '-R',
    description: 'Paid in by a member' + (note ? ' \u2014 ' + String(note).slice(0, 80) : ''),
  }, who);

  const shares = require('./stokvelShares');
  await shares.allocateContribution(client, {
    subAccountId: subAccount.id, investorId, amount: want,
    reference: ref, periodLabel: null,
  });

  const { settled } = await settleDue(client, subAccount.id, investorId, want);
  return { paid: want, settled, reference: ref };
}

/* ─── What this money clears, oldest first ─────────────────────────
 *
 * Money arriving for a member settles what they actually owe, starting with
 * the oldest, rather than sitting beside their arrears as a credit. A fine
 * rides on the same table as a contribution, so it settles in its turn.
 *
 * ONE DEFINITION, two front doors. A member paying in from their wallet and
 * a treasurer's cash receipt being matched to a deposit both arrive here.
 * Two copies of "oldest first" is how one screen comes to disagree with
 * another about what somebody owes.
 *
 * Returns how much of the amount found something to settle: the rest is
 * money in hand against nothing owed, which is not an error — a member who
 * pays ahead is a member paying ahead.
 */
async function settleDue(client, subAccountId, investorId, amount) {
  let left = round2(amount);
  if (!(left > 0)) return { settled: 0 };
  const { rows: due } = await client.query(
    `SELECT id, amount_due, amount_paid FROM stokvel_contributions
      WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'due'
        AND (amount_due - amount_paid) > 0
      ORDER BY due_date ASC FOR UPDATE`, [subAccountId, investorId]);
  for (const c of due) {
    if (round2(left) <= 0) break;
    const outstanding = round2(Number(c.amount_due) - Number(c.amount_paid));
    const put = round2(Math.min(outstanding, left));
    const nowPaid = round2(Number(c.amount_paid) + put);
    await client.query(
      `UPDATE stokvel_contributions
          SET amount_paid = $2, status = $3,
              paid_at = CASE WHEN $3 = 'paid' THEN NOW() ELSE paid_at END,
              updated_at = NOW()
        WHERE id = $1`,
      [c.id, nowPaid, nowPaid >= round2(Number(c.amount_due)) ? 'paid' : 'due']);
    left = round2(left - put);
  }
  return { settled: round2(round2(amount) - left) };
}

module.exports = { periodFor, openPeriod, pay, payIn, settleDue };
