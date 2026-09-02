/* The Investment Income Reference, computed once for whoever asks.
 *
 * Two routes serve this document — the admin console for any investor, and the
 * investor portal for themselves — and until this existed only the admin one
 * was right. The portal's copy summed `payout` as income and filtered the tax
 * year on created_at, both of which this had already been corrected for. Two
 * implementations of a tax document is two answers to "what did I earn", and
 * the client can hold both.
 *
 * So: one computation, and the routes decide only WHOSE it is.
 */
'use strict';

const { incomeTypesSQL } = require('./ledger');
const { postedReturn }   = require('./maturityPreflight');

/* SA tax year: 1 March (year-1) → the last day of February (year), as plain
   dates. They used to be built as local Date objects at 00:00:00 and 23:59:59
   and sent as ISO instants, so a console rendering an instant in the reader's
   timezone printed the end of a UTC day as the following morning in SAST — the
   document's header read "28 February 2026" while the card beside it read
   "1 March 2026". A date has no timezone; treating it as one created the
   disagreement. */
function taxYearWindow(taxYear) {
  const pad     = n => String(n).padStart(2, '0');
  const lastFeb = new Date(Date.UTC(taxYear, 2, 0));   // day 0 of March = last Feb day
  return {
    from: `${taxYear - 1}-03-01`,
    to:   `${lastFeb.getUTCFullYear()}-${pad(lastFeb.getUTCMonth() + 1)}-${pad(lastFeb.getUTCDate())}`,
  };
}

/* COALESCE(transaction_date, created_at), not created_at.

   created_at is when the ROW was written; transaction_date is when the money
   moved. For anything migrated or captured after the fact the two are months
   apart, which is how a client with a full ledger could be handed an income
   reference reading R 0,00 and "No returns recorded".

   The end of the window is expressed as < (to + 1 day) so a transaction at any
   time on the last day of February is inside it, whatever time it carries. */
const WINDOW = `COALESCE(transaction_date, created_at) >= $2::date
            AND COALESCE(transaction_date, created_at) <  ($3::date + INTERVAL '1 day')`;

const TXN_COLS = `id, COALESCE(transaction_date, created_at) AS txn_date,
                  created_at, type, description, amount, reference`;

class NotFound extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; }
}

/* Returns the exact payload both documents are rendered from. Throws NotFound
   when the investor does not exist; the caller decides the status code. */
async function buildIncomeReference(pool, { investorId, year }) {
  const taxYear = parseInt(year, 10);
  if (isNaN(taxYear) || taxYear < 2019 || taxYear > 2040) {
    const e = new Error('Invalid year'); e.code = 'BAD_REQUEST'; throw e;
  }
  const { from, to } = taxYearWindow(taxYear);

  /* Income is `return` and `interest` — see services/ledger. `payout` is NOT
     income: its amount is the client's capital coming back plus the return on
     it, so summing payouts declares capital as taxable earnings. */
  const [invRes, returnsRes, depositsRes, subAccRes] = await Promise.all([
    pool.query('SELECT * FROM investors WHERE id = $1 LIMIT 1', [investorId]),
    pool.query(
      `SELECT ${TXN_COLS} FROM transactions
        WHERE investor_id = $1 AND type IN (${incomeTypesSQL()})
          AND status = 'completed' AND ${WINDOW}
        ORDER BY COALESCE(transaction_date, created_at)`, [investorId, from, to]),
    pool.query(
      `SELECT ${TXN_COLS} FROM transactions
        WHERE investor_id = $1 AND type = 'deposit'
          AND status = 'completed' AND ${WINDOW}
        ORDER BY COALESCE(transaction_date, created_at)`, [investorId, from, to]),
    pool.query('SELECT id FROM sub_accounts WHERE parent_investor_id = $1', [investorId]),
  ]);

  if (!invRes.rows[0]) throw new NotFound('Investor not found');

  /* A minor's sub-account is the client's money too, and its income belongs on
     the client's certificate. */
  const subIds = subAccRes.rows.map(r => r.id);
  let saReturns = [], saDeposits = [];
  if (subIds.length) {
    const [saR, saD] = await Promise.all([
      pool.query(
        `SELECT ${TXN_COLS} FROM transactions
          WHERE sub_account_id = ANY($1::text[]) AND type IN (${incomeTypesSQL()})
            AND status = 'completed' AND ${WINDOW}
          ORDER BY COALESCE(transaction_date, created_at)`, [subIds, from, to]),
      pool.query(
        `SELECT ${TXN_COLS} FROM transactions
          WHERE sub_account_id = ANY($1::text[]) AND type = 'deposit'
            AND status = 'completed' AND ${WINDOW}
          ORDER BY COALESCE(transaction_date, created_at)`, [subIds, from, to]),
    ]);
    saReturns = saR.rows; saDeposits = saD.rows;
  }

  /* Investments that MATURED inside the year. The return realised at maturity
     is not a transaction of its own — creditWallet writes only the payout,
     whose amount is capital and return together — so without this the realised
     return has no representation on the certificate at all.

     Reported beside the credited income rather than added to it: a holding
     whose return was also accrued month by month appears in both, and adding
     them would declare the same earnings twice. */
  const maturedRes = await pool.query(
    `SELECT i.id, i.pool_name, i.amount, i.end_date,
            i.actual_return, p.actual_rate AS pool_actual_rate
       FROM investments i
       LEFT JOIN investment_pools p ON p.id = i.pool_id
      WHERE (i.investor_id = $1 OR i.sub_account_id = ANY($4::text[]))
        AND i.status IN ('matured', 'paid_out')
        AND i.end_date >= $2::date AND i.end_date <= $3::date
      ORDER BY i.end_date`,
    [investorId, from, to, subIds]);

  const returns  = [...returnsRes.rows,  ...saReturns];
  const deposits = [...depositsRes.rows, ...saDeposits];
  const when = t => new Date(t.txn_date || t.created_at);
  returns.sort((a, b)  => when(a) - when(b));
  deposits.sort((a, b) => when(a) - when(b));

  const totalReturns  = returns.reduce((s, t)  => s + Math.abs(parseFloat(t.amount) || 0), 0);
  const totalDeposits = deposits.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);

  /* The platform's one rule for what a matured investment earned, imported
     rather than rewritten. It returns null when nothing has been posted, and
     null is carried all the way to the page: "R 0,00" on a tax document states
     that a client earned nothing, which is a different claim from "the pool has
     not been closed out yet" and must not be printed in its place.

     NOT COALESCE(actual_return, expected_return): returns are posted on the
     POOL as investment_pools.actual_rate, and actual_return defaults to 0
     rather than NULL, so that COALESCE short-circuits on the zero and prints
     R 0,00 against every matured holding a client has. */
  const maturedInvestments = maturedRes.rows.map(r => {
    const realised = postedReturn({
      amount: r.amount, actualReturn: r.actual_return, poolActualRate: r.pool_actual_rate });
    return {
      id: r.id, pool_name: r.pool_name, amount: r.amount, end_date: r.end_date,
      realised_return: realised,          // null when nothing is posted
      return_posted: realised !== null,
    };
  });

  const maturedReturns = maturedInvestments.reduce(
    (s, r) => s + (Number(r.realised_return) || 0), 0);
  /* How many have no posted return. The total above sums the posted ones only,
     so a reader has to be told the rest exist — otherwise the figure silently
     understates and looks authoritative. */
  const maturedUnposted = maturedInvestments.filter(r => !r.return_posted).length;

  const inv = invRes.rows[0];
  return {
    investor: {
      id: inv.id, first_name: inv.first_name, last_name: inv.last_name,
      email: inv.email, id_number: inv.id_number,
      street_address: inv.street_address, suburb: inv.suburb,
      address: inv.address, postal_code: inv.postal_code, province: inv.province,
    },
    taxYear,
    /* Plain YYYY-MM-DD, rendered verbatim, so no reader's timezone can move the
       end of the tax year onto the following morning. */
    from, to,
    returns, totalReturns,
    deposits, totalDeposits,
    maturedInvestments,
    maturedReturns: Math.round(maturedReturns * 100) / 100,
    maturedUnposted,
  };
}

module.exports = { buildIncomeReference, taxYearWindow, NotFound };
