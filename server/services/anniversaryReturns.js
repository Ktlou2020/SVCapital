'use strict';
/* Solar returns are distributed on the anniversary of the investment.
 *
 * A five-year holding earns five returns, each paid to the client's wallet on
 * the anniversary of the day THEY invested — not the pool's start, not a
 * calendar date. The public site has promised this for as long as the product
 * has existed ("Annual returns distributed every 12 months, full capital
 * returned at end of term"); nothing on the platform did it. Every investment
 * sat until end_date and settled once.
 *
 * TWO RULES, AND THE SECOND IS THE ONE THAT KEEPS THIS HONEST.
 *
 * 1. The date is the investment's own. start_date + k years, k = 1…term years.
 *    Done in SQL so the 29th of February resolves the way Postgres resolves
 *    it (to the 28th) rather than the way JavaScript does (to 1 March).
 *
 * 2. The RATE is posted, never computed. This platform does not pay a
 *    projection: the maturity engine was changed specifically to stop paying
 *    expected_return and to refuse — return null — when nothing has been
 *    posted, because a pool that earned 7% and one that earned 4% were both
 *    paying the contracted figure. The same rule here. A year that nobody has
 *    closed out pays nothing and is reported as waiting, rather than paying a
 *    number no one stands behind. pool_annual_returns is where a director
 *    posts the year's achieved rate, one row per pool per year.
 *
 * Idempotency is the transactions.reference UNIQUE index, not a flag: one
 * anniversary is one reference, ANN-<investment>-Y<k>. It cannot be paid
 * twice even if this runs twice at once.
 *
 * The money is a `payout` row, not a `return` row. On this platform `return`
 * is an accrual — services/ledger.js has it in INCOME_TYPES and out of
 * CASH_CREDIT_TYPES, and the tables API books it to total_returns without
 * moving a wallet. Cash that reaches a wallet and counts as earnings is a
 * payout with a return portion, which is exactly what maturity already writes.
 */

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* Solar is three product types plus the unsuffixed one the migration left.
   Written once, as a SQL predicate, so the job, the report and the maturity
   guard cannot disagree about what counts as solar. */
const SOLAR_PREDICATE = `product_type ~* '^solar'`;

/* Every anniversary an investment has reached, with what it would pay.

   A row per investment per elapsed year, carrying the posted rate for that
   year where there is one and NULL where there is not, and whether it has
   already been paid. One query, so the report and the payer see the same
   thing — a report that is computed differently from the payment is not a
   report of the payment. */
const DUE_SQL = `
  WITH solar AS (
    SELECT i.id, i.investor_id, i.sub_account_id, i.pool_id, i.amount,
           i.start_date, i.status, i.product_type,
           COALESCE(NULLIF(i.term_months, 0), p.term_months, 0) AS term_months,
           p.name AS pool_name
      FROM investments i
      LEFT JOIN investment_pools p ON p.id = i.pool_id
     WHERE i.${SOLAR_PREDICATE}
       AND i.start_date IS NOT NULL
       AND COALESCE(i.status, '') IN ('active', 'matured')
  ),
  years AS (
    SELECT s.*, g.k,
           (s.start_date + make_interval(years => g.k))::date AS due_on
      FROM solar s
      CROSS JOIN LATERAL generate_series(1, GREATEST(s.term_months / 12, 0)) AS g(k)
  )
  SELECT y.id AS investment_id, y.investor_id, y.sub_account_id, y.pool_id,
         y.pool_name, y.product_type, y.amount, y.start_date, y.k AS year_index,
         y.due_on, y.status,
         r.rate   AS posted_rate,
         r.note   AS posted_note,
         t.id     AS paid_txn_id,
         t.amount AS paid_amount,
         t.transaction_date AS paid_on
    FROM years y
    LEFT JOIN pool_annual_returns r ON r.pool_id = y.pool_id AND r.year_index = y.k
    LEFT JOIN transactions t        ON t.reference = 'ANN-' || y.id || '-Y' || y.k
   WHERE y.due_on <= $1::date
   ORDER BY y.due_on, y.investor_id`;

/* asOf lets the report answer "what will have fallen due by month end" and
   lets a check drive a clock without waiting a year. */
async function due(db, { asOf = new Date() } = {}) {
  const { rows } = await db.query(DUE_SQL, [new Date(asOf).toISOString().slice(0, 10)]);
  return rows.map(r => {
    const rate = r.posted_rate == null ? null : Number(r.posted_rate);
    return {
      investmentId: r.investment_id, investorId: r.investor_id,
      subAccountId: r.sub_account_id, poolId: r.pool_id, poolName: r.pool_name,
      productType: r.product_type, amount: Number(r.amount),
      startDate: r.start_date, yearIndex: r.year_index, dueOn: r.due_on,
      investmentStatus: r.status,
      rate, note: r.posted_note,
      wouldPay: rate == null ? null : round2(Number(r.amount) * rate),
      paid: !!r.paid_txn_id,
      paidAmount: r.paid_amount == null ? null : Number(r.paid_amount),
      paidOn: r.paid_on,
      state: r.paid_txn_id ? 'paid' : (rate == null ? 'awaiting-rate' : 'payable'),
    };
  });
}

/* Pay one anniversary, inside the caller's transaction.
 *
 * The INSERT is the guard and it comes FIRST: ON CONFLICT DO NOTHING on the
 * unique reference, and the wallet is only moved when a row was actually
 * written. Crediting first and inserting second would double-pay anything
 * that got this far twice and then fail on the index, which inside one
 * transaction rolls the credit back but inside a batch takes the whole batch
 * with it.
 */
async function payOne(client, item, { description } = {}) {
  if (item.rate == null) return { paid: false, reason: 'no rate posted for that year' };
  const amt = round2(item.amount * item.rate);
  if (!(amt > 0)) return { paid: false, reason: 'the posted rate pays nothing' };

  const reference = `ANN-${item.investmentId}-Y${item.yearIndex}`;
  const note = description ||
    `Year ${item.yearIndex} distribution — ${item.poolName || item.productType}`;

  const { rowCount } = await client.query(
    `INSERT INTO transactions
       (id, investor_id, sub_account_id, type, amount, status, reference,
        description, investment_id, transaction_date, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,'payout',$3,'completed',$4,$5,$6,$7,NOW(),NOW())
     ON CONFLICT (reference) DO NOTHING`,
    [item.investorId, item.subAccountId || null, amt, reference, note,
     item.investmentId, item.dueOn]);

  if (!rowCount) return { paid: false, reason: 'already paid', reference };

  /* Back to the account the money came from — a sub-account has its own
     wallet, and the same split every other money path on this platform
     applies. The whole distribution is earnings, so all of it counts toward
     total_returns. */
  if (item.subAccountId) {
    await client.query(
      `UPDATE sub_accounts
          SET wallet_balance = wallet_balance + $1,
              total_returns  = COALESCE(total_returns, 0) + $1,
              updated_at = NOW()
        WHERE id = $2`, [amt, item.subAccountId]);
  } else {
    await client.query(
      `UPDATE investors
          SET wallet_balance = wallet_balance + $1,
              total_returns  = COALESCE(total_returns, 0) + $1,
              updated_at = NOW()
        WHERE id = $2`, [amt, item.investorId]);
  }
  return { paid: true, amount: amt, reference };
}

/* What this investment has already been paid in anniversary distributions.
   The maturity engine subtracts it, so a term's posted return is not paid
   again at the end on top of the years already distributed. */
const PAID_SO_FAR_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
   WHERE reference LIKE 'ANN-' || $1 || '-Y%'
     AND COALESCE(status, '') = 'completed'`;

async function paidSoFar(db, investmentId) {
  const { rows: [r] } = await db.query(PAID_SO_FAR_SQL, [investmentId]);
  return round2(Number(r.total));
}

module.exports = { due, payOne, paidSoFar, round2,
                   SOLAR_PREDICATE, DUE_SQL, PAID_SO_FAR_SQL };
