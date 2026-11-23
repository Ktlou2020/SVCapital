'use strict';
/* ═══════════════════════════════════════════════════════════
   What the maize book earned in a month, as a rate for the notice account.

   THE RULE, as the business set it: take the trading facility's return for
   the month; if it is below 1.5% that IS the rate; if it is above, cap it
   at 1.5%. The admin can also declare a rate by hand, and that path is
   untouched — this one only works out a number and offers it.

   WHY THE CAP IS THE POINT. The book can have a very good month. Paying it
   all over would set an expectation the next month cannot meet, and the
   whole promise of a notice account is that the money is there in thirty
   days — which is paid for out of the spread, not out of optimism. The cap
   is what makes a good month fund a bad one.

   NOTHING HERE DECLARES ANYTHING. It reads a facility and returns a
   figure. stl_facilities says in its own header that these rows come from
   a spreadsheet somebody maintains by hand and must not feed investor
   payouts, and that rule is kept: a person reads this, sees the
   arithmetic, and presses the button. The hand-edited document never moves
   a client's money on its own.

   THE MONTH A LOAD BELONGS TO is the day our share actually landed —
   payout_date, falling back to the day the buyer paid when the sheet has
   not recorded a payout yet. A load whose margin has not been split has no
   share at all (our_margin IS NULL) and counts towards nothing.
   ═══════════════════════════════════════════════════════════ */

/* 1.5% a month, the one definition. */
const CAP = 0.015;

const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* The facilities that could stand behind a notice account: open, with
   capital in them. `funded_from` records that Grain Co's capital came from
   the short-term product, which is what makes its margin the money behind
   what short-term investors are paid — so those sort first. */
async function candidates(db) {
  const { rows } = await db.query(
    `SELECT id, name, partner_name, our_capital, funded_from
       FROM stl_facilities
      WHERE status = 'active'
      ORDER BY (funded_from ILIKE '%short%') DESC, created_at ASC`);
  return rows;
}

function monthOf(month) {
  const m = String(month || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(m) ? `${m}-01` : null;
}

/**
 * What one facility earned us in one month, and the rate that follows.
 *
 * Returns { error } rather than throwing for anything a person can fix:
 * a month that is not a month, a facility that is not there, no capital
 * recorded. A rate cannot be offered from a facility whose capital is
 * unknown, and offering one anyway would be inventing the denominator.
 */
async function facilityMonth(db, { facilityId, month } = {}) {
  const first = monthOf(month);
  if (!first) return { error: 'Give the month as YYYY-MM.' };

  let facility = null;
  if (facilityId) {
    const { rows } = await db.query(
      `SELECT id, name, partner_name, our_capital, funded_from
         FROM stl_facilities WHERE id = $1`, [facilityId]);
    facility = rows[0] || null;
    if (!facility) return { error: 'No such facility.' };
  } else {
    const list = await candidates(db);
    if (!list.length) return { error: 'There is no active trading facility to read a rate from.' };
    facility = list[0];
  }

  const capital = Number(facility.our_capital) || 0;

  const { rows: [sum] } = await db.query(
    `SELECT COALESCE(SUM(our_margin), 0) AS realised,
            COUNT(*) FILTER (WHERE our_margin IS NOT NULL) AS loads
       FROM stl_facility_loads
      WHERE facility_id = $1
        AND our_margin IS NOT NULL
        AND COALESCE(payout_date, date_buyer_paid) >= $2::date
        AND COALESCE(payout_date, date_buyer_paid) <  ($2::date + INTERVAL '1 month')`,
    [facility.id, first]);

  const realised = round2(sum.realised);
  const loads = Number(sum.loads) || 0;

  if (!(capital > 0)) {
    return {
      error: `${facility.name} has no capital recorded, so a return cannot be worked out from it. `
           + 'Sync the facility, or declare the rate by hand.',
      facility: { id: facility.id, name: facility.name }, month: first, realised, loads,
    };
  }

  const raw = round6(realised / capital);
  const capped = Math.min(raw, CAP);

  return {
    facility: { id: facility.id, name: facility.name, partner_name: facility.partner_name },
    month: first,
    capital,
    realised,
    loads,
    /* Both figures, always. A screen that showed only the capped one would
       hide the month the book did far better than the rate says, which is
       exactly the month somebody will ask about. */
    raw,
    rate: capped,
    cap: CAP,
    cap_applied: raw > CAP,
    basis: 'our share of each load, by the day it was paid out',
  };
}

module.exports = { CAP, candidates, facilityMonth, monthOf };
