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

const _list = arr => arr.map(t => `'${t}'`).join(',');

/* SQL CASE expression for the signed cash effect of a transaction row.
   `p` prefixes the column names for queries that alias the table. */
const cashMovementSQL = (p = '') => `
  CASE
    WHEN ${p}type IN (${_list(CASH_CREDIT_TYPES)}) THEN  ${p}amount
    WHEN ${p}type IN (${_list(CASH_DEBIT_TYPES)})  THEN -${p}amount
    ELSE 0
  END`;

module.exports = { CASH_CREDIT_TYPES, CASH_DEBIT_TYPES, cashMovementSQL };
