/* ═══════════════════════════════════════════════════════════
   Pool raise report — where a pool's money CAME FROM.

   The mirror of the maturity report. That one is read before a pool pays out
   and answers "where does this money go". This one is read after a pool has
   closed to new money and answers "where did it come from, and what did it
   cost" — the record of a completed raise.

   Money reaches a pool three ways, and they are not interchangeable:

     NEW MONEY      an investor funded it from their wallet. It carries the 1%
                    platform fee, and it is the only one of the three that grew
                    the book.
     REINVESTED     matured money rolled back into the same product. Fee-free.
     SWITCHED IN    matured money moved from a DIFFERENT product. Also fee-free,
                    and reported per source pool, because "R2.1m switched in" is
                    an aggregate nobody can act on while "R900k out of Cattle
                    August 2025" is a conversation.

   ── Finding the source pool ────────────────────────────────────────────────
   investments carries no source column: reinvestAmount writes the new holding
   with the DESTINATION pool and nothing about where the money came from. What
   it does write is a `reinvestment` transaction whose reference is
   'REINV-' + the SOURCE investment id, optionally suffixed '-S' or '-R' for the
   two legs of a switch_amount. Stripping that reference back to the source
   investment id and joining to investments is how the source pool is
   recovered — from an id, not from the description text, which is prose and
   will be reworded one day.

   A reinvestment whose transaction cannot be matched is counted and reported
   as source-unknown rather than dropped: money with no provenance is exactly
   what someone reading this report needs to be told about.

   ── Switched, precisely ───────────────────────────────────────────────────
   maturityCron calls it a switch when target.product_type !== inv.product_type.
   The same comparison is made here, against the source investment's product
   type, so the two agree by construction rather than by the verb in a string.

   READ ONLY. Every statement is a SELECT.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const { feesFor } = require('./poolFees');

const num    = v => parseFloat(v) || 0;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const SOURCE_LABELS = {
  new:     'New money',
  reinvest:'Reinvested from the same product',
  switch:  'Switched in from another product',
  unknown: 'Reinvested — source pool not recorded',
};

async function buildRaiseReport(db, poolId) {
  const { rows: pools } = await db.query(
    `SELECT id, name, product_type, status, annual_rate, actual_rate, term_months,
            start_date, end_date, investment_start_date, maturity_date,
            target_amount, max_investment, management_fee_pct, raised_amount
       FROM investment_pools WHERE id = $1`, [poolId]);
  if (!pools.length) return { error: 'not_found' };
  const pool = pools[0];

  const { rows: evaRows } = await db.query(
    "SELECT value FROM platform_settings WHERE key = 'eva_rate'");
  const mgmtFeePct = num(pool.management_fee_pct);
  const evaRate    = evaRows.length ? num(evaRows[0].value) : 0.15;

  /* Every investment in the pool, with the source it came from where one can
     be recovered.

     The reference is stripped rather than the description parsed:
     'REINV-<sourceInvestmentId>' with an optional '-S'/'-R' leg suffix. An id
     survives rewording; a sentence does not.

     Cancelled holdings are excluded — they are not money the pool raised. */
  const { rows } = await db.query(`
    WITH reinv AS (
      SELECT t.investment_id AS new_investment_id,
             regexp_replace(regexp_replace(t.reference, '^REINV-', ''), '-(S|R)$', '') AS source_investment_id
        FROM transactions t
       WHERE t.type = 'reinvestment'
         AND t.pool_id = $1
         AND t.reference LIKE 'REINV-%'
    )
    SELECT i.id, i.investor_id, i.sub_account_id, i.amount, i.status,
           i.is_reinvestment, i.product_type, i.start_date, i.created_at,
           COALESCE(sa.name, TRIM(CONCAT(inv.first_name, ' ', inv.last_name))) AS holder_name,
           COALESCE(sa.id, inv.id)  AS holder_id,
           sa.id IS NOT NULL        AS is_sub_account,
           src.id                   AS source_investment_id,
           src.pool_id              AS source_pool_id,
           COALESCE(sp.name, src.pool_name) AS source_pool_name,
           COALESCE(sp.product_type, src.product_type) AS source_product_type,
           /* The fee actually recorded, not a recomputation. "Fees paid" has
              to mean the transactions that exist. */
           COALESCE((SELECT SUM(ABS(f.amount)) FROM transactions f
                      WHERE f.type IN ('fee','platform_fee')
                        AND (f.reference = 'FEE-' || i.id OR f.investment_id = i.id)
                        AND f.status = 'completed'), 0) AS fee_paid
      FROM investments i
      LEFT JOIN investors     inv ON inv.id = i.investor_id
      LEFT JOIN sub_accounts  sa  ON sa.id  = i.sub_account_id
      LEFT JOIN reinv             ON reinv.new_investment_id = i.id
      LEFT JOIN investments   src ON src.id = reinv.source_investment_id
      LEFT JOIN investment_pools sp ON sp.id = src.pool_id
     WHERE i.pool_id = $1
       AND COALESCE(i.status, '') <> 'cancelled'
     ORDER BY i.created_at, i.id`, [poolId]);

  const out = [];
  for (const r of rows) {
    const amount = num(r.amount);
    const fees   = feesFor({ amount, isReinvestment: r.is_reinvestment, mgmtFeePct, evaRate });

    /* Three kinds, decided the way maturityCron decides them: a rollover whose
       source product differs from this pool's is a switch. */
    let kind = 'new';
    if (r.is_reinvestment) {
      if (!r.source_pool_id) kind = 'unknown';
      else kind = (r.source_product_type && r.source_product_type !== pool.product_type)
        ? 'switch' : 'reinvest';
    }

    out.push({
      investmentId: r.id, holderId: r.holder_id, holderName: r.holder_name,
      isSubAccount: r.is_sub_account === true,
      amount: round2(amount), status: r.status,
      startDate: r.start_date, createdAt: r.created_at,
      kind, kindLabel: SOURCE_LABELS[kind],
      sourcePoolId:   r.source_pool_id || null,
      sourcePoolName: r.source_pool_name || null,
      sourceProductType: r.source_product_type || null,
      platformFeePaid:     round2(num(r.fee_paid)),
      platformFeeExpected: fees.platformFee,
      upfrontFee: fees.upfrontFee,
      eva: fees.eva,
      netAmount: fees.netAmount,
    });
  }

  const sum = (list, f) => round2(list.reduce((s, x) => s + f(x), 0));
  const of  = k => out.filter(r => r.kind === k);

  /* Per source pool, for the switched money. Grouped on the pool the money
     left, which is the question this section exists to answer. */
  const bySource = new Map();
  for (const r of out.filter(x => x.kind === 'switch' || x.kind === 'reinvest')) {
    const key = r.sourcePoolId || 'unknown';
    if (!bySource.has(key)) {
      bySource.set(key, {
        poolId: r.sourcePoolId, poolName: r.sourcePoolName,
        productType: r.sourceProductType, isSwitch: r.kind === 'switch',
        count: 0, amount: 0, investors: new Set(),
      });
    }
    const g = bySource.get(key);
    g.count++;
    g.amount = round2(g.amount + r.amount);
    g.investors.add(r.holderId);
    if (r.kind === 'switch') g.isSwitch = true;
  }

  const raised = sum(out, r => r.amount);
  const feesPaid = sum(out, r => r.platformFeePaid);
  const feesExpected = sum(out, r => r.platformFeeExpected);

  return {
    generatedAt: new Date().toISOString(),
    pool: {
      id: pool.id, name: pool.name, productType: pool.product_type, status: pool.status,
      annualRate: pool.annual_rate == null ? null : num(pool.annual_rate),
      termMonths: pool.term_months,
      openedOn: pool.start_date, closedOn: pool.end_date,
      investmentStartDate: pool.investment_start_date, maturityDate: pool.maturity_date,
      targetAmount: pool.target_amount == null ? null : num(pool.target_amount),
      managementFeePct: mgmtFeePct,
      /* What the pool row itself claims, so a divergence from the investments
         is visible rather than silently reconciled away. */
      raisedAmountOnPool: pool.raised_amount == null ? null : num(pool.raised_amount),
    },
    totals: {
      raised,
      investments: out.length,
      investors: new Set(out.map(r => r.holderId)).size,

      newMoney:    sum(of('new'),      r => r.amount),
      reinvested:  sum(of('reinvest'), r => r.amount),
      switchedIn:  sum(of('switch'),   r => r.amount),
      sourceUnknown: sum(of('unknown'), r => r.amount),

      newMoneyCount:   of('new').length,
      reinvestedCount: of('reinvest').length,
      switchedInCount: of('switch').length,
      sourceUnknownCount: of('unknown').length,

      /* Paid is the transactions that exist. Expected is the 1% rule applied to
         what is on the books. They differ when a fee was never recorded, and
         that difference is worth seeing rather than averaging away. */
      platformFeesPaid: feesPaid,
      platformFeesExpected: feesExpected,
      platformFeeShortfall: round2(feesExpected - feesPaid),

      upfrontFees: sum(out, r => r.upfrontFee),
      eva:         sum(out, r => r.eva),
      netRaised:   sum(out, r => r.netAmount),
    },
    /* Largest first: the report is read to find where the money came from. */
    sources: [...bySource.values()]
      .map(g => ({ ...g, investors: g.investors.size }))
      .sort((a, b) => b.amount - a.amount),
    /* Non-reinvestment holdings with no fee transaction. A reinvestment having
       none is correct and is not reported here. */
    missingFeeRows: out.filter(r => r.kind === 'new' && r.platformFeePaid === 0 && r.platformFeeExpected > 0)
                       .map(r => ({ investmentId: r.investmentId, holderName: r.holderName,
                                    amount: r.amount, expected: r.platformFeeExpected })),
    rows: out,
  };
}

module.exports = { buildRaiseReport, SOURCE_LABELS };
