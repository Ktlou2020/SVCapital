'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ledger — the single definition of which transaction types move money into or
   out of a wallet.

   Extracted so every consumer derives from one place. The wallet reconciliation
   and the statement opening balance each used to carry their own type list and
   disagreed about `investment` and `fee`, which meant one of them was wrong on
   every run.

   `return` is deliberately absent. A return is an ACCRUAL: jobs/interestCron.js
   credits investors.total_returns and leaves wallet_balance alone. The cash
   reaches the wallet later, at maturity, as a `payout`. Counting both would pay
   the same money twice.

   matured_funds and reinvestment are a matched bookkeeping pair written at
   maturity (jobs/maturityCron.js) with no wallet movement — the money goes
   straight into the new investment. Both are listed so they cancel to zero;
   including either one alone invents or destroys money.

   IMPORTANT — this describes what a transaction row *represents*, not a way to
   rebuild a balance. Almost every write path already applies its effect to
   wallet_balance directly, so summing the ledger and overwriting the column
   double-counts. See the wallet audit: the column is authoritative, and this
   definition exists for reporting and reconciliation, not for repair.
   ───────────────────────────────────────────────────────────────────────────── */

const CASH_CREDIT_TYPES = ['deposit', 'payout', 'interest', 'gift_received', 'referral_bonus', 'matured_funds'];
const CASH_DEBIT_TYPES  = ['withdrawal', 'investment', 'reinvestment', 'fee', 'platform_fee', 'gift_sent'];

/* The transaction types that are INVESTMENT INCOME — what a client earned, as
   opposed to what moved.
 *
 * `payout` is deliberately absent, and it is the reason this list exists.
 * maturityCron's creditWallet takes (amount, returnPortion) and writes a
 * payout transaction whose amount is the WHOLE credit — the client's capital
 * coming back plus the return on it — while the return portion alone goes to
 * investors.total_returns. Summing payout amounts as income therefore declares
 * the client's own capital as taxable earnings. On a document headed
 * "Investment Income" that is not a rounding problem.
 *
 * `deposit` is absent for the same reason from the other side: it is the
 * client's own money arriving, reported separately as a contribution.
 *
 * This covers income recorded AS A TRANSACTION. The return realised when an
 * investment matures is recorded on the investment (investments.actual_return),
 * not as a transaction of its own, and has to be read from there. The two must
 * be reported side by side rather than added: a maturity whose return was also
 * accrued monthly appears in both, and adding them declares income twice. */
const INCOME_TYPES = ['return', 'interest'];

const _list = arr => arr.map(t => `'${t}'`).join(',');

/* For SQL IN clauses, so no caller retypes the list. */
const incomeTypesSQL = () => _list(INCOME_TYPES);

/* SQL CASE expression for the signed cash effect of a transaction row.
   `p` prefixes the column names for queries that alias the table. */
const cashMovementSQL = (p = '') => `
  CASE
    WHEN ${p}type IN (${_list(CASH_CREDIT_TYPES)}) THEN  ${p}amount
    WHEN ${p}type IN (${_list(CASH_DEBIT_TYPES)})  THEN -${p}amount
    ELSE 0
  END`;

/* The same rule in JavaScript, for the rows already in hand.
 *
 * The SQL version and a hand-written list in the admin console had drifted:
 * the console's DEBIT_TYPES was {investment, reinvestment, withdrawal, fee} and
 * everything else — platform_fee, gift_sent, return, and any type it had never
 * heard of — counted as a credit. So a statement's opening balance came from
 * the SQL and its running balance from the other list, and the two could not
 * agree. A platform fee INCREASED the client's balance down the page.
 *
 * Exported so the one definition serves both, and returns the signed effect of
 * a single row. A type in neither list moves nothing, exactly as the SQL's
 * ELSE 0 does: `return` is an accrual and must not be counted as cash, and a
 * type nobody has classified is not something to guess about in a balance. */
function cashMovement(txn) {
  const type = String((txn && txn.type) || '');
  const amt  = Math.abs(Number(txn && txn.amount) || 0);
  if (CASH_CREDIT_TYPES.includes(type)) return amt;
  if (CASH_DEBIT_TYPES.includes(type))  return -amt;
  return 0;
}

/* Whether a row moves cash at all — the ledger prints these differently from
   the accruals, which belong on the statement but not in the balance. */
const movesCash = txn =>
  CASH_CREDIT_TYPES.includes(String((txn && txn.type) || '')) ||
  CASH_DEBIT_TYPES.includes(String((txn && txn.type) || ''));

module.exports = { CASH_CREDIT_TYPES, CASH_DEBIT_TYPES, INCOME_TYPES,
                   cashMovementSQL, incomeTypesSQL,
                   cashMovement, movesCash, CASH_MOVEMENT: cashMovement };
