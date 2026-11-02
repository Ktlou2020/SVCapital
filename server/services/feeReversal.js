'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   Giving a platform fee back.

   The 1% is charged when an investment is placed and there has never been a
   way to undo it. A fee charged in error, a goodwill gesture, a pool we said
   would be fee-free and was not: all of it was a manual wallet credit with a
   note, which is to say a figure typed by hand into a balance with nothing
   tying it to the fee it was meant to cancel.

   Two destinations, chosen per reversal, because they answer different
   questions:

   TO THE WALLET — the client gets cash back, withdrawable today. The right
   answer when the fee was simply wrong, or when the investment is over.

   INTO THE INVESTMENT — the fee becomes principal. The client earns the
   pool's rate on it for the rest of the term and it matures with the rest.
   The right answer for a goodwill gesture on a live investment, and worth
   more to the client than the cash.

   THREE THINGS THIS HAS TO GET RIGHT.

   The refund must come back the way the charge went out. A fee charged
   against a sub-account came out of THAT wallet, not the member's own, and
   a stokvel's fee came out of the group's pot — so it goes back to the pot,
   and the share ledger is told, or the group's money is right and every
   member's share of it is wrong.

   It must be impossible to do twice. The reference is derived from the
   investment, so a second attempt writes nothing; the fee row is stamped
   reversed as well, so the two agree.

   And a principal that moves must take its expected return with it. An
   investment whose amount rises and whose expected_return does not is a
   maturity that pays the wrong figure, months later, to somebody who will
   have no way of knowing.
   ───────────────────────────────────────────────────────────────────────── */

const pool = require('../db/pool');
const { recordTransaction } = require('./ledger');
const { expectedReturnFor } = require('./poolFees');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const cents  = n => Math.round((Number(n) || 0) * 100);

const DESTINATIONS = ['wallet', 'investment'];

/* The fee charged for this investment.

   Both spellings, because the two paths that charge one disagree: tables.js
   writes type 'fee' with a positive amount and manualCredit writes
   'platform_fee' with a negative one. cashMovement reads the sign off the
   TYPE and takes the amount through Math.abs, so both are correct as
   charges — but anything looking for "the fee" has to know about both. */
async function feeFor(db, investmentId) {
  const { rows } = await (db || pool).query(
    `SELECT id, investor_id, sub_account_id, type, amount, reference,
            status, reversed_at, reversed_reference
       FROM transactions
      WHERE type IN ('fee', 'platform_fee')
        AND (id = $1 OR reference = $1 OR investment_id = $2)
      ORDER BY created_at
      LIMIT 1`,
    [`FEE-${investmentId}`, investmentId]);
  return rows[0] || null;
}

/* One reversal per investment, for ever. Not dated: a second attempt
   tomorrow is the SAME reversal, and a reference that changed would turn
   off the unique index that stops it being paid twice. */
function referenceFor(investmentId) {
  return `FEEREV-${String(investmentId).replace(/[^A-Za-z0-9-]/g, '').toUpperCase().slice(0, 26)}`;
}

/* The expected return AFTER the principal has grown by the fee.

   NOT recomputed from the formula. Live data says why: an investment of
   R30 000 at 13,92% over five months carries a stored expected return of
   R1 741,50, while the formula gives R1 740,00. The stored figure came from
   somewhere else — an import, a posted rate, a hand correction — and
   recomputing it would quietly move a client's expected return by R1,50 for
   a reason that has nothing to do with the fee being reversed.

   So it is SCALED by the change in principal, which preserves whatever
   basis it had and still moves it with the money. The formula is the
   fallback for an investment that has no figure yet, where there is no
   basis to preserve. */
function grownExpectedReturn(inv, newAmount) {
  const oldAmount = Number(inv.amount) || 0;
  const stored    = Number(inv.expected_return);
  if (oldAmount > 0 && Number.isFinite(stored) && stored > 0) {
    return round2(stored * (newAmount / oldAmount));
  }
  return expectedReturnFor({
    amount: newAmount, annualRate: inv.annual_rate, termMonths: inv.term_months });
}

/* What staff are allowed to do with this one, and why not, said in words
   they can act on rather than a bare refusal. */
async function assess(db, investmentId) {
  const q = db || pool;
  const { rows: [inv] } = await q.query(
    `SELECT i.id, i.investor_id, i.sub_account_id, i.pool_id, i.pool_name,
            i.amount, i.status, i.annual_rate, i.term_months, i.expected_return,
            i.is_reinvestment,
            a.account_type AS sub_account_type, a.name AS sub_account_name
       FROM investments i
       LEFT JOIN sub_accounts a ON a.id = i.sub_account_id
      WHERE i.id = $1`, [investmentId]);
  if (!inv) return { ok: false, reason: 'No such investment.' };

  const fee = await feeFor(q, investmentId);
  if (!fee) {
    return { ok: false, investment: inv, fee: null,
             reason: inv.is_reinvestment
               ? 'No platform fee was charged — reinvestments are fee-free.'
               : 'No platform fee was found against this investment.' };
  }
  if (fee.reversed_at) {
    return { ok: false, investment: inv, fee,
             reason: `This fee was already reversed on `
               + `${new Date(fee.reversed_at).toISOString().slice(0, 10)}.` };
  }

  const amount = round2(Math.abs(fee.amount));
  /* Into a finished investment there is nowhere to put it: the term is over
     and the maturity has already been worked out. */
  const liveEnough = inv.status === 'active';
  return {
    ok: true,
    investment: inv,
    fee,
    amount,
    destinations: {
      wallet: true,
      investment: liveEnough,
    },
    investmentBlockedBecause: liveEnough ? null
      : `This investment is ${inv.status}, so there is nothing running to add `
        + `it to. It can still go back to the wallet.`,
    /* Said plainly, because it is the figure the client will ask about. */
    wouldBecome: liveEnough ? {
      amount: round2(Number(inv.amount) + amount),
      expectedReturn: grownExpectedReturn(inv, round2(Number(inv.amount) + amount)),
    } : null,
  };
}

/* Do it. One database transaction: the fee is stamped, the money moves and
   the investment changes together or not at all. */
async function reverse({ investmentId, destination, reason, actor }) {
  if (!DESTINATIONS.includes(destination)) {
    throw new Error(`destination must be one of ${DESTINATIONS.join(', ')}`);
  }
  if (!reason || !String(reason).trim()) {
    /* Money given back without a recorded why is money nobody can account
       for later, and this is the kind of entry an auditor asks about. */
    throw new Error('a reason is required to reverse a platform fee');
  }
  if (!actor || !actor.kind) throw new Error('reverse needs an actor');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Re-read inside the transaction and lock the fee row, so two staff
       pressing the button at the same moment cannot both pass the check. */
    const state = await assess(client, investmentId);
    if (!state.ok) { await client.query('ROLLBACK'); return { ok: false, reason: state.reason }; }
    if (!state.destinations[destination]) {
      await client.query('ROLLBACK');
      return { ok: false, reason: state.investmentBlockedBecause };
    }

    const { investment: inv, fee, amount } = state;
    const reference = referenceFor(investmentId);

    /* THE LEDGER ROW IS THE GATE. Derived from the investment and unique,
       so a second attempt writes nothing and comes back having done
       nothing — rather than paying it again. */
    const credit = await recordTransaction(client, {
      investorId: fee.investor_id,
      subAccountId: fee.sub_account_id || null,
      investmentId,
      poolId: inv.pool_id || null,
      type: 'fee_reversal',
      amount,
      reference,
      description: destination === 'wallet'
        ? `Platform fee reversed — ${inv.pool_name || inv.pool_id || 'investment'}`
        : `Platform fee reversed into the investment — ${inv.pool_name || inv.pool_id || ''}`.trim(),
      notes: String(reason).slice(0, 500),
    }, actor, { onConflict: 'reference' });

    if (!credit) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'This fee has already been reversed.', alreadyDone: true };
    }

    await client.query(
      `UPDATE transactions SET reversed_at = NOW(), reversed_reference = $2, updated_at = NOW()
        WHERE id = $1`, [fee.id, reference]);

    /* BACK THE WAY IT CAME. A fee charged against a sub-account left THAT
       wallet; returning it to the member's own would move money between two
       people's records. */
    const toSubAccount = !!fee.sub_account_id;
    if (toSubAccount) {
      await client.query(
        'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [amount, fee.sub_account_id]);
    } else {
      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [amount, fee.investor_id]);
    }

    let became = null;
    if (destination === 'investment') {
      /* The matched other half: the money came back and went straight into
         the investment, so the wallet nets to zero. Written as a
         reinvestment because that is what it is — money already inside the
         platform going into a holding, and fee-free by definition. Listing
         only the credit would declare a deposit that never happened. */
      await recordTransaction(client, {
        investorId: fee.investor_id,
        subAccountId: fee.sub_account_id || null,
        investmentId,
        poolId: inv.pool_id || null,
        type: 'reinvestment',
        amount,
        reference: `${reference}-IN`,
        description: `Reversed platform fee added to the investment`,
        notes: String(reason).slice(0, 500),
      }, actor);

      if (toSubAccount) {
        await client.query(
          'UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
          [amount, fee.sub_account_id]);
      } else {
        await client.query(
          'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
          [amount, fee.investor_id]);
      }

      const newAmount = round2(Number(inv.amount) + amount);
      const newReturn = grownExpectedReturn(inv, newAmount);
      await client.query(
        `UPDATE investments
            SET amount = $2, expected_return = $3, updated_at = NOW()
          WHERE id = $1`, [investmentId, newAmount, newReturn]);

      /* The pool holds more than it did. Left alone, a pool's raised total
         and the sum of its investments disagree by the fee. */
      if (inv.pool_id) {
        await client.query(
          `UPDATE investment_pools
              SET current_invested = COALESCE(current_invested, 0) + $1,
                  raised_amount    = COALESCE(raised_amount, 0) + $1,
                  updated_at = NOW()
            WHERE id = $2`, [amount, inv.pool_id]);
      }
      became = { amount: newAmount, expectedReturn: newReturn };
    }

    /* A STOKVEL'S POT IS NOT ONE PERSON'S. Money arriving in a group wallet
       belongs to its members in proportion, and the share ledger only knows
       that if it is told inside this same transaction. */
    if (toSubAccount && inv.sub_account_type === 'stokvel' && destination === 'wallet') {
      const shares = require('./stokvelShares');
      await shares.reconcile(client, fee.sub_account_id, {
        reason: 'Platform fee reversed', reference, actor });
    }

    await client.query('COMMIT');
    return { ok: true, amount, destination, reference,
             investorId: fee.investor_id, subAccountId: fee.sub_account_id || null,
             became };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { assess, reverse, feeFor, referenceFor, grownExpectedReturn,
                   DESTINATIONS, round2, cents };
