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

/* investment_id is selected for the settlement guard below: a row that
   names the investment it settles identifies itself, and that is worth
   more than any amount-and-date resemblance. */
const TXN_COLS = `id, COALESCE(transaction_date, created_at) AS txn_date,
                  created_at, type, description, amount, reference, investment_id`;

class NotFound extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; }
}

/* ─── A maturity settlement wearing an income type ──────────────────────

   What this is for, in the words of the client who found it:

     "The statement shows R1 631,18 under Returns realised at maturity and
      R678 under Returns credited. Do these amounts overlap?"

   They did. One ledger row — 30 Apr 2025, description "PAYOUT", R678,00 —
   was typed as income. R678,00 was that client's R600,00 of capital plus
   the R78,00 return on an investment that had matured the day before, and
   the R78,00 was already inside the R1 631,18. Had the two figures been
   added for SARS, R600 of the client's own money would have been declared
   as earnings and the R78 counted twice.

   The current engine cannot produce this: creditWallet writes maturity
   settlements as `payout`, which INCOME_TYPES excludes. The row came in
   with the Firebase import, which is also why its description is the bare
   uppercase type. So this guard is about the ledger we inherited, and
   about any future path that gets the type wrong.

   WHAT IT MATCHES, and why it is drawn this tight. A row is a settlement
   only when its amount equals capital PLUS the realised return of a
   matured investment, to the cent, and it sits within a month of that
   maturity — or when it names that investment outright. Genuine interim
   income is a fraction of capital and can never equal capital plus return,
   so the two cannot be confused. The tight rule is deliberate: the costly
   error here is excluding real income and UNDER-declaring, which is the
   direction that gets a client into trouble rather than merely confused.

   WHAT IT DOES NOT DO is decide quietly. The row is taken out of the
   income total because it demonstrably is not income, and it is then named
   on the face of the document beside the investment it settles, with its
   amount, so a reader can see exactly what was removed and put it back if
   they disagree. A tax figure silently adjusted is worse than a wrong one.
   ─────────────────────────────────────────────────────────────────────── */
const SETTLEMENT_WINDOW_DAYS = 31;

const _dayMs = 24 * 60 * 60 * 1000;
const _at = v => { const d = new Date(v); return isNaN(d.getTime()) ? null : d.getTime(); };

/* The investment this row settles, or null. */
function settlementFor(txn, maturedInvestments) {
  const amount = Math.abs(parseFloat(txn.amount) || 0);
  if (!(amount > 0)) return null;

  for (const m of maturedInvestments) {
    /* A return that has not been posted gives no figure to compare, and
       guessing one would be the under-declaring mistake this guard exists
       to avoid. Such an investment is simply not matched. */
    if (!m.return_posted) continue;
    const gross = (parseFloat(m.amount) || 0) + (parseFloat(m.realised_return) || 0);
    if (Math.abs(amount - gross) > 0.005) continue;

    /* The row naming the investment is conclusive on its own — no date
       test, because an import can carry any date it likes. */
    if (txn.investment_id && txn.investment_id === m.id) return m;

    const tAt = _at(txn.txn_date || txn.created_at);
    const mAt = _at(m.end_date);
    if (tAt === null || mAt === null) continue;
    if (Math.abs(tAt - mAt) <= SETTLEMENT_WINDOW_DAYS * _dayMs) return m;
  }
  return null;
}

/* Splits the income rows into the ones that are income and the ones that
   are a matured investment coming back. Pure, and exported, so a check can
   put rows through the real rule rather than a retyped copy of it. */
function partitionIncome(returns, maturedInvestments) {
  const income = [], settlements = [];
  for (const t of returns) {
    const m = settlementFor(t, maturedInvestments);
    if (m) settlements.push({
      id: t.id, txn_date: t.txn_date, created_at: t.created_at,
      type: t.type, description: t.description, reference: t.reference,
      amount: Math.abs(parseFloat(t.amount) || 0),
      matches_investment_id: m.id,
      matches_pool_name: m.pool_name,
      matches_capital: Math.abs(parseFloat(m.amount) || 0),
      matches_return: Math.abs(parseFloat(m.realised_return) || 0),
      matured_on: m.end_date,
    });
    else income.push(t);
  }
  return { income, settlements };
}

/* Returns the exact payload both documents are rendered from. Throws NotFound
   when the investor does not exist; the caller decides the status code. */
/* The most recent tax year that has ENDED. A South African tax year runs
   1 March to the last day of February and is named for the year it ends in,
   so on any date from 1 March the year named for that calendar year is done. */
function latestCompleteTaxYear(now) {
  const d = now || new Date();
  return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1;
}

async function buildIncomeReference(pool, { investorId, year, now }) {
  const taxYear = parseInt(year, 10);
  if (isNaN(taxYear) || taxYear < 2019 || taxYear > 2040) {
    const e = new Error('Invalid year'); e.code = 'BAD_REQUEST'; throw e;
  }
  /* A year that has not ended cannot be certified. The portal no longer offers
     one, but the endpoint is reachable on its own and a certificate covering
     a part-year under a heading naming the whole of it is worse than an
     error — somebody would file it. */
  const latest = latestCompleteTaxYear(now);
  if (taxYear > latest) {
    const e = new Error(`The ${taxYear} tax year has not ended yet. The most recent certificate available is for the year ending February ${latest}.`);
    e.code = 'BAD_REQUEST'; throw e;
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

  const allIncomeRows = [...returnsRes.rows,  ...saReturns];
  const deposits      = [...depositsRes.rows, ...saDeposits];
  const when = t => new Date(t.txn_date || t.created_at);
  allIncomeRows.sort((a, b) => when(a) - when(b));
  deposits.sort((a, b) => when(a) - when(b));

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

  /* Applied AFTER maturedInvestments is built, because the rule needs each
     matured holding's capital and realised return to compare against. */
  const { income: returns, settlements } = partitionIncome(allIncomeRows, maturedInvestments);
  const totalReturns   = returns.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
  const settlementsTotal = Math.round(
    settlements.reduce((s, t) => s + t.amount, 0) * 100) / 100;

  /* Raised where whoever can correct the ledger is already looking. One
     mis-typed row is a data fault, not a fault of whoever asked for the
     document, and it will go on producing confused clients until somebody
     changes the row's type. Incidents fold by fingerprint, so regenerating
     the same certificate moves a counter rather than filling the page.

     Fire-and-forget and never awaited: a tax document must not fail to
     issue because an alerter is unhappy. */
  if (settlements.length) {
    try {
      require('./incidents').report(
        new Error(`Income reference ${taxYear} for ${investorId}: ${settlements.length} ` +
                  `maturity settlement(s) totalling R${settlementsTotal.toFixed(2)} are typed as ` +
                  `income in the ledger. They are excluded from the income total and named on the ` +
                  `document. Correct the transaction type to 'payout'.`),
        { source: 'income-reference', severity: 'error' })
        .catch(() => {});
    } catch (_) { /* never block the document */ }
  }

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
    /* Named rather than dropped. The document prints them beside the
       investment each one settles, so a reader can see exactly what was
       taken out of the figure above and why. */
    settlements, settlementsTotal,
    deposits, totalDeposits,
    maturedInvestments,
    maturedReturns: Math.round(maturedReturns * 100) / 100,
    maturedUnposted,
  };
}

module.exports = { buildIncomeReference, taxYearWindow, latestCompleteTaxYear,
                   partitionIncome, settlementFor, SETTLEMENT_WINDOW_DAYS, NotFound };
