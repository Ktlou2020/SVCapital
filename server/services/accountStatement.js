/* The account statement, computed once for whoever asks.
 *
 * Two routes serve this document — the admin console for any investor, and the
 * investor portal for themselves. The portal used to assemble its own from
 * whatever the browser had cached, with its own idea of which transaction
 * types move cash, so the same client's statement could open on a different
 * balance depending on who generated it. One computation removes the question.
 *
 * The balances are ANCHORED TO THE WALLET rather than derived from history:
 * closing is the real wallet with everything after the period unwound, and
 * opening is that figure less the period's own movement. Both the derived and
 * the anchored opening are returned, and `reconciles` says whether they agree —
 * a disagreement is a data problem worth seeing rather than hiding behind a
 * plausible-looking number.
 */
'use strict';

/* One definition of what moves cash and what does not, shared with the ledger
   and with every other money view. This document used to carry its own list —
   {investment, reinvestment, withdrawal, fee} as debits, everything else a
   credit — which disagreed with the ledger about platform_fee, gift_sent and
   return, so a platform fee INCREASED the client's balance as the page went
   down. */
const { cashMovementSQL, cashMovement: CASH_MOVEMENT } = require('./ledger');

class NotFound extends Error {
  constructor(msg) { super(msg); this.code = 'NOT_FOUND'; }
}

async function buildAccountStatement(pool, { investorId, from, to }) {
  if (!investorId || !from || !to) {
    const e = new Error('investorId, from and to are required'); e.code = 'BAD_REQUEST'; throw e;
  }

    const fromDt = new Date(from + 'T00:00:00.000Z');
    const toDt   = new Date(to   + 'T23:59:59.999Z');
    if (isNaN(fromDt.getTime()) || isNaN(toDt.getTime())) {
      const e = new Error('Invalid date format. Use YYYY-MM-DD'); e.code = 'BAD_REQUEST'; throw e;
    }

    const [invRes, invstRes, txnRes, openingRes] = await Promise.all([
      pool.query('SELECT * FROM investors WHERE id = $1 LIMIT 1', [investorId]),
      pool.query(
        `SELECT i.id, i.amount, i.status, i.created_at,
                COALESCE(i.start_date, i.created_at::date) AS start_date,
                i.end_date AS maturity_date,
                i.expected_return, i.actual_return,
                -- COALESCE alone fell through only on NULL, so an investment
                -- carrying a stored 0.0000 beat the pool's rate and the
                -- statement quoted 0.00%. NULLIF makes a zero fall through
                -- too, and the pool's *posted* return outranks its target.
                COALESCE(NULLIF(i.annual_rate, 0), NULLIF(p.actual_rate, 0), p.annual_rate) AS annual_rate,
                p.actual_rate AS pool_actual_rate,
                i.payout_option,
                p.name AS pool_name, p.product_type,
                p.start_date AS pool_start_date, p.end_date AS pool_end_date,
                mi.instruction AS maturity_instruction
         FROM investments i
         LEFT JOIN investment_pools p ON p.id = i.pool_id
         LEFT JOIN LATERAL (
           SELECT instruction FROM maturity_instructions
           WHERE investment_id = i.id ORDER BY created_at DESC LIMIT 1
         ) mi ON true
         /* OVERLAP, not "started in the window".
          *
          * This used to require the START DATE to fall inside the period, which
          * silently dropped every investment that MATURED during it but began
          * before it — the ordinary case for anything with a term longer than
          * the statement. A client with a dozen maturities in the period saw
          * only the ones that also happened to start in it, and nothing said
          * any were missing.
          *
          * An investment belongs on a statement if it was live at any point in
          * the period: it began on or before the period ended, and it had not
          * already ended before the period began. An investment with no end
          * date has not ended, so it qualifies on the first test alone. */
         WHERE i.investor_id = $1
           AND COALESCE(i.start_date, i.created_at::date) <= $3
           AND (i.end_date IS NULL OR i.end_date >= $2)
         ORDER BY i.created_at ASC`,
        [investorId, fromDt.toISOString().slice(0,10), toDt.toISOString().slice(0,10)]
      ),
      // All completed transactions in the period, ordered chronologically
      pool.query(
        `SELECT type, amount, description, reference,
                COALESCE(transaction_date, created_at) AS txn_date
         FROM transactions
         WHERE investor_id = $1
           AND status = 'completed'
           AND COALESCE(transaction_date, created_at) >= $2
           AND COALESCE(transaction_date, created_at) <= $3
         ORDER BY COALESCE(transaction_date, created_at) ASC, created_at ASC`,
        [investorId, fromDt, toDt]
      ),
      // Net cash effect of all completed transactions BEFORE the period, and
      // AFTER it, using the shared CASH_MOVEMENT definition. The first is the
      // derived opening balance; the second is what has to be unwound from
      // today's wallet to get back to the period's closing balance.
      pool.query(
        `SELECT
           COALESCE(SUM(${cashMovementSQL()}) FILTER (
             WHERE COALESCE(transaction_date, created_at) < $2), 0) AS before_period,
           COALESCE(SUM(${cashMovementSQL()}) FILTER (
             WHERE COALESCE(transaction_date, created_at) > $3), 0) AS after_period
         FROM transactions
         WHERE investor_id = $1
           AND status = 'completed'`,
        [investorId, fromDt, toDt]
      ),
    ]);

    if (!invRes.rows[0]) throw new NotFound('Investor not found');

    const inv = invRes.rows[0];

    /* THE BALANCES ARE COMPUTED HERE, NOT IN THE BROWSER.
     *
     * The admin console used to run its own credit/debit list over these rows
     * to build the running balance, while the opening balance came from
     * services/ledger.js on this side. The two disagreed about platform_fee,
     * gift_sent, return and every type neither had heard of — so the opening
     * balance and the ledger printed beneath it were computed by different
     * rules, and the document could not tie by construction. A statement has
     * one definition of what moves money or it is not a statement.
     *
     * AND IT IS ANCHORED TO THE WALLET. opening_balance used to be the sum of
     * every prior transaction's cash effect, presented as the client's balance.
     * ledger.js says in its own header that this definition is "for reporting
     * and reconciliation, not for repair" and that the wallet column is
     * authoritative — because almost every write path moves the wallet
     * directly, and a reinvestment whose matching matured_funds row was never
     * written (a known historical gap, with its own backfill) leaves the
     * derived figure short. That is how a client with money on deposit was
     * handed a statement showing R24 010,73 Dr.
     *
     * So the closing balance is the real wallet with everything after the
     * period unwound, and the opening balance is that figure less the period's
     * own movement. Both the derived and the anchored opening are returned, and
     * `reconciles` says whether they agree — a disagreement is a data problem
     * worth seeing rather than hiding behind a plausible-looking number.
     */
    const bal   = openingRes.rows[0] || {};
    const num   = v => parseFloat(v) || 0;
    const r2    = n => Math.round(n * 100) / 100;
    const cash  = CASH_MOVEMENT;

    const wallet       = num(inv.wallet_balance);
    const afterPeriod  = num(bal.after_period);
    const derivedOpen  = r2(num(bal.before_period));
    const closing      = r2(wallet - afterPeriod);

    /* Each row's signed effect and the balance after it, so the client renders
       what the server computed. */
    let running = null;
    const periodMovement = txnRes.rows.reduce((s2, t) => s2 + cash(t), 0);
    const opening = r2(closing - periodMovement);
    running = opening;
    const transactions = txnRes.rows.map(t => {
      const effect = r2(cash(t));
      running = r2(running + effect);
      return { ...t, cash_effect: effect, running_balance: running };
    });

    /* What the client was actually PAID in the period, and what they took out.
     *
     * Computed here beside the balances so a summary figure and the ledger it
     * summarises come from one pass over one set of rows. Returns paid are the
     * cash the fund handed over — maturity payouts and interest credits — and
     * are deliberately NOT the same thing as `return` rows, which are accruals
     * that move no cash and are counted at maturity instead. Counting both
     * would report the same money to the client twice. */
    const sumTypes = (...types) => r2(transactions
      .filter(t => types.includes(t.type))
      .reduce((a, t) => a + Math.abs(num(t.amount)), 0));

    const paid = {
      returns:     sumTypes('payout', 'interest'),
      withdrawn:   sumTypes('withdrawal'),
      deposited:   sumTypes('deposit'),
      invested:    sumTypes('investment', 'reinvestment'),
      fees:        sumTypes('platform_fee', 'fee'),
      /* Accrued but not yet cash — shown separately so the two are never added. */
      accrued:     sumTypes('return'),
    };

    return {
      paid,
      investor: {
        id: inv.id, first_name: inv.first_name, last_name: inv.last_name,
        email: inv.email, id_number: inv.id_number,
        mobile: inv.mobile || inv.phone,
        wallet_balance: inv.wallet_balance,
        street_address: inv.street_address, suburb: inv.suburb,
        address: inv.address, postal_code: inv.postal_code, province: inv.province,
      },
      period: { from: fromDt.toISOString(), to: toDt.toISOString() },
      investments: invstRes.rows,
      transactions,
      opening_balance: opening,
      closing_balance: closing,
      wallet_balance:  r2(wallet),
      /* What the transaction history alone says the opening was. Kept so the
         gap is visible and measurable rather than merely absent. */
      derived_opening_balance: derivedOpen,
      reconciles: Math.round(derivedOpen * 100) === Math.round(opening * 100),
      ledger_gap: r2(opening - derivedOpen),
    };
}

module.exports = { buildAccountStatement, NotFound };
