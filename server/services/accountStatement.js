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

/* ── Statements for a SUB-ACCOUNT ──────────────────────────────────
   No sub-account had a statement — not a stokvel, a trust, a business or a
   child's account — because every query here is scoped by investor_id. A
   stokvel's AGM had nothing to table.

   Scoping, not a second builder: one definition of what moves cash, one set
   of balances anchored to a wallet, one document. The column each query
   filters on is the only thing that changes.

   WHEN NO SUB-ACCOUNT IS GIVEN NOTHING CHANGES AT ALL. This service
   produces live client statements, and an investor's statement includes
   their sub-accounts' transactions today — rows carry investor_id as well.
   Narrowing that would silently alter documents clients already have, so
   the predicate for an investor statement is left exactly as it was, and
   the check asserts the output is identical. */
async function buildAccountStatement(pool, { investorId, subAccountId, from, to }) {
  if ((!investorId && !subAccountId) || !from || !to) {
    const e = new Error('investorId or subAccountId, and from and to, are required');
    e.code = 'BAD_REQUEST'; throw e;
  }
  /* The one knob. $1 is the id in every query below; this says which column
     it is matched against. */
  const scopeCol = subAccountId ? 'sub_account_id' : 'investor_id';
  const scopeId  = subAccountId || investorId;

    const fromDt = new Date(from + 'T00:00:00.000Z');
    const toDt   = new Date(to   + 'T23:59:59.999Z');
    if (isNaN(fromDt.getTime()) || isNaN(toDt.getTime())) {
      const e = new Error('Invalid date format. Use YYYY-MM-DD'); e.code = 'BAD_REQUEST'; throw e;
    }

    const [invRes, invstRes, txnRes, openingRes] = await Promise.all([
      subAccountId
        ? pool.query(
            `SELECT a.id, a.name, a.account_type, a.wallet_balance, a.sa_reference,
                    a.stokvel_reg_number, a.parent_investor_id,
                    p.email, p.id_number, p.phone,
                    p.street_address, p.suburb, p.address, p.postal_code, p.province
               FROM sub_accounts a
               LEFT JOIN investors p ON p.id = a.parent_investor_id
              WHERE a.id = $1 LIMIT 1`, [scopeId])
        : pool.query('SELECT * FROM investors WHERE id = $1 LIMIT 1', [scopeId]),
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
                i.term_months,
                p.name AS pool_name, p.product_type,
                /* The pool's OWN maturity, which is a real fallback for an
                   investment missing its end date — everyone in a pool matures
                   when the pool does. investment_pools.end_date is not: that is
                   the day the pool stopped taking money, months or years
                   earlier, and using it as a maturity is the confusion this
                   statement was reporting. Both are sent so the document can
                   tell them apart. */
                p.maturity_date AS pool_maturity_date,
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
         WHERE i.${scopeCol} = $1
           AND COALESCE(i.start_date, i.created_at::date) <= $3
           AND (i.end_date IS NULL OR i.end_date >= $2)
         ORDER BY i.created_at ASC`,
        [scopeId, fromDt.toISOString().slice(0,10), toDt.toISOString().slice(0,10)]
      ),
      // All completed transactions in the period, ordered chronologically
      pool.query(
        `SELECT type, amount, description, reference,
                COALESCE(transaction_date, created_at) AS txn_date
         FROM transactions
         WHERE ${scopeCol} = $1
           AND status = 'completed'
           AND COALESCE(transaction_date, created_at) >= $2
           AND COALESCE(transaction_date, created_at) <= $3
         ORDER BY COALESCE(transaction_date, created_at) ASC, created_at ASC`,
        [scopeId, fromDt, toDt]
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
         WHERE ${scopeCol} = $1
           AND status = 'completed'`,
        [scopeId, fromDt, toDt]
      ),
    ]);

    if (!invRes.rows[0]) throw new NotFound(subAccountId ? 'Account not found' : 'Investor not found');

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

    /* ── What a STOKVEL's statement needs beyond the cash ──────────
       The money view above is the same for every account. A stokvel's AGM
       is asking three further questions, and every one of them is already
       recorded: who contributed what, what each member's share is, and who
       approved the money that moved. Read only when it is a stokvel, so no
       other statement pays for it. */
    let stokvel = null;
    if (subAccountId && inv.account_type === 'stokvel') {
      const shares = require('./stokvelShares');
      const [contribRes, memberRes, voteRes] = await Promise.all([
        pool.query(
          `SELECT c.investor_id, c.period_label, c.amount_due, c.amount_paid,
                  c.status, c.due_date, i.first_name, i.last_name
             FROM stokvel_contributions c
             JOIN investors i ON i.id = c.investor_id
            WHERE c.sub_account_id = $1 AND c.due_date >= $2 AND c.due_date <= $3
            ORDER BY c.due_date ASC, i.first_name ASC`,
          [subAccountId, fromDt.toISOString().slice(0, 10), toDt.toISOString().slice(0, 10)]),
        pool.query(
          `SELECT m.investor_id, m.role, m.is_signatory, i.first_name, i.last_name
             FROM stokvel_members m JOIN investors i ON i.id = m.investor_id
            WHERE m.sub_account_id = $1 AND m.status = 'active'
            ORDER BY i.first_name ASC`, [subAccountId]),
        pool.query(
          `SELECT r.id, r.kind, r.amount, r.status, r.created_at,
                  v.decision, v.decided_at AS voted_at,
                  i.first_name AS voter_first, i.last_name AS voter_last
             FROM stokvel_withdrawal_requests r
             LEFT JOIN stokvel_request_approvals v ON v.request_id = r.id
             LEFT JOIN investors i ON i.id = v.investor_id
            WHERE r.sub_account_id = $1
              AND r.created_at >= $2 AND r.created_at <= $3
            ORDER BY r.created_at ASC, v.decided_at ASC`,
          [subAccountId, fromDt, toDt]),
      ]);

      const byId = new Map(memberRes.rows.map(m =>
        [m.investor_id, [m.first_name, m.last_name].filter(Boolean).join(' ')]));
      const shareOut = await shares.sharesOf(pool, subAccountId).catch(() => null);

      const approvals = [];
      for (const row of voteRes.rows) {
        let entry = approvals.find(a => a.id === row.id);
        if (!entry) {
          entry = { id: row.id, kind: row.kind, amount: row.amount,
                    status: row.status, at: row.created_at, votes: [] };
          approvals.push(entry);
        }
        if (row.decision) {
          entry.votes.push({
            name: [row.voter_first, row.voter_last].filter(Boolean).join(' '),
            decision: row.decision, at: row.voted_at });
        }
      }

      stokvel = {
        name: inv.name,
        registration: inv.stokvel_reg_number || null,
        members: memberRes.rows.map(m => ({
          investor_id: m.investor_id, name: byId.get(m.investor_id),
          role: m.role, is_signatory: m.is_signatory,
        })),
        contributions: contribRes.rows.map(c => ({
          investor_id: c.investor_id, name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          period: c.period_label, due: c.amount_due, paid: c.amount_paid,
          status: c.status, due_date: c.due_date,
        })),
        shares: shareOut ? {
          basis: shareOut.basis,
          net_assets: shareOut.assets.total,
          wallet: shareOut.assets.wallet,
          invested: shareOut.assets.invested,
          owed_to_former_members: shareOut.assets.owed,
          members: shareOut.shares.map(x => ({
            investor_id: x.investor_id, name: byId.get(x.investor_id) || x.investor_id,
            share: x.share, arrears: x.arrears,
          })),
        } : null,
        /* The approvals register. A stokvel answering to its own members at
           an AGM needs to show not that two people agreed but WHICH two. */
        approvals,
      };
    }

    return {
      paid,
      ...(stokvel ? { stokvel } : {}),
      investor: {
        id: inv.id,
        /* A sub-account has a NAME rather than a first and last name. Sent
           in both shapes so a consumer that only knows about people still
           has something to print at the top of the page. */
        first_name: subAccountId ? inv.name : inv.first_name,
        last_name:  subAccountId ? '' : inv.last_name,
        account_name: subAccountId ? inv.name : null,
        account_type: subAccountId ? inv.account_type : null,
        sa_reference: subAccountId ? inv.sa_reference : null,
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
