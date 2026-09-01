'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   poolFees — what an investment into a pool costs, in one place.

   Extracted because two surfaces now report these numbers to the same people:
   the pool's investor list (/api/tables/investment_pools/:id/investors) and the
   raise report. Fee arithmetic restated in two places is fee arithmetic that
   will eventually disagree, and the disagreement surfaces as an admin querying
   which of two screens is lying.

   PLATFORM FEE — 1% of the amount that reached the pool.

   The investor is charged fee-INCLUSIVE: they enter what leaves their wallet,
   and tables.js splits it as poolAmount = spend / 1.01, fee = spend −
   poolAmount. Since investments.amount stores the POOL amount, the fee is
   exactly poolAmount × 0.01 — the same number from either direction, which is
   why this can be recomputed from the stored amount without drifting from what
   was actually taken.

   Reinvestments are fee-free. That is not a rounding convenience: reinvestAmount
   moves matured money straight into the new investment without it passing
   through the wallet, and charging 1% on it is the thing switch_amount exists to
   avoid.

   UPFRONT FEE — the pool's management_fee_pct, taken once against the amount.
   It has no transaction of its own; it is a deduction expressed in the net
   figure, which is why it can only ever be computed and never counted.

   EVA — the referring employee's share, evaRate% of the upfront fee net of 15%
   VAT. Taken FROM the upfront fee, not added to it.
   ───────────────────────────────────────────────────────────────────────────── */

const PLATFORM_FEE_PCT = 0.01;
const VAT_MULTIPLIER   = 1.15;

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function feesFor({ amount, isReinvestment, mgmtFeePct = 0, evaRate = 0.15 }) {
  const amt         = Number(amount) || 0;
  const platformFee = isReinvestment ? 0 : round2(amt * PLATFORM_FEE_PCT);
  const upfrontFee  = round2(amt * (Number(mgmtFeePct) || 0));
  const eva         = round2((upfrontFee / VAT_MULTIPLIER) * (Number(evaRate) || 0));
  return {
    platformFee,
    upfrontFee,
    eva,
    totalFees: round2(platformFee + upfrontFee),
    netAmount: round2(amt - upfrontFee),
  };
}

module.exports = { feesFor, PLATFORM_FEE_PCT, VAT_MULTIPLIER };
