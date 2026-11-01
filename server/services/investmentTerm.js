'use strict';
/* When an investment matures.
 *
 * A pool is a single contract with a single end: it is closed out as a unit,
 * its achieved rate is posted on the POOL, and every rand in it earned that
 * same rate over that same period. So every investment in a pool matures on
 * the day the pool does.
 *
 * Three places create investments — the maturity engine's rollover, the
 * wallet-fallback reinvestment and the recurring-order job — and all three
 * worked it out the same wrong way:
 *
 *     const end = new Date(start); end.setMonth(end.getMonth() + termMonths);
 *
 * the investment's OWN start plus its term. Roll over on 1 November into a
 * pool that matures on 31 October and the investment is dated 1 November the
 * following year: one day past the pool it belongs to, holding a date no
 * close-out will ever land on.
 *
 * It is not cosmetic. maturityCron selects work by investments.end_date, so a
 * pool closed out as one unit matures in dribs across several nights, each
 * investment waiting for a nightly run its pool has already had. The pool
 * reads matured while investments inside it are still active.
 *
 * There is a one-off script that realigns existing rows
 * (server/scripts/backfill-maturity-dates.js, which previews before it
 * writes). It exists because this kept happening. This is the rule it was
 * patching up after, in the one place all three creators now read it from.
 */

/* A DATE column arrives from node-postgres as a JS Date; a string stays a
   string. Either way the answer is the day it names, in the form the INSERTs
   bind. */
const asDay = v => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/**
 * The day an investment into `poolRow` should mature.
 *
 * The pool's own maturity_date when it has one — which is the answer for
 * every pool the console creates. Start plus term only as a fallback, for a
 * pool old enough or odd enough to carry no maturity date at all; that is the
 * previous behaviour, kept so a missing column cannot leave an investment
 * with no end date rather than an imperfect one.
 */
function investmentEndDate(poolRow, startDate, termMonths) {
  const fromPool = asDay(poolRow && poolRow.maturity_date);
  if (fromPool) return fromPool;
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + (Number(termMonths) || 6));
  return d.toISOString().slice(0, 10);
}

module.exports = { investmentEndDate };
