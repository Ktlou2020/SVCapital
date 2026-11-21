/* ═══════════════════════════════════════════════════════════
   AML (Anti-Money Laundering) — assessing a deposit, and HOLDING it.

   Rules:
     1. Large single deposit  ≥ R50,000
     2. Structuring risk      total deposits > R100,000 in 24h

   WHAT WAS WRONG WITH IT. checkDeposit was called fire-and-forget from
   payments.js and its result discarded. The rules fired, a high-priority
   ticket was raised — and the money was credited to the wallet in the same
   breath, immediately spendable. A client could deposit, invest and
   withdraw before anybody opened the ticket. An alert that arrives after
   the money has moved is a record of a decision nobody got to make.

   SO A FLAGGED CLIENT DEPOSIT IS NOT CREDITED. The deposit is recorded as
   `pending_aml`: the row exists, so the client can see their payment landed
   and is being looked at, and the reference is taken, so neither the
   browser's return nor Paystack's webhook can credit it twice. Every
   balance on this platform counts completed rows only — ninety-one places
   filter on it — so a held deposit moves no balance anywhere until a human
   releases it, and no spend path had to be taught about holds.

   WHICH DEPOSITS. Client-initiated card payments, where the client chooses
   the amount and the timing. NOT a manual credit: that is a staff member
   crediting an EFT they have already verified, a human is in the loop by
   definition, and holding it would only mean the same person releasing it a
   moment later. Those are assessed and ticketed — which they were not at
   all before, so the biggest deposits on the platform never met the rules.

   THE ASSESSMENT IS SEPARATE FROM THE TICKET. assess() reads and decides;
   raiseTicket() writes. They were one function, which is why the decision
   could only be made after the money had already moved.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const LARGE_DEPOSIT = 50000;    // one payment
const DAY_TOTAL     = 100000;   // in any 24 hours

/* The status a held deposit's transaction carries. Not a CHECK constraint
   on transactions.status — that column is free text — but the one spelling,
   exported, so the route that releases and the route that lists are looking
   for what creditWallet wrote. */
const HELD_STATUS = 'pending_aml';

/**
 * Decide whether a deposit is flagged. Reads; writes nothing.
 *
 * @param {object} db            pg pool or client — a CLIENT when the
 *                               decision is part of the same transaction
 *                               as the credit, which is the point.
 * @param {object} o
 * @param {string} o.investorId
 * @param {number} o.amount
 * @param {string} [o.excludeReference]  a deposit already written, so it is
 *                                       not counted twice against itself
 * @returns {{ flagged: boolean, reason: string|null, total24h: number }}
 */
async function assess(db, { investorId, amount, excludeReference = null } = {}) {
  const amt = Number(amount) || 0;

  if (amt >= LARGE_DEPOSIT) {
    return { flagged: true, reason: `Large single deposit (R${amt})`, total24h: amt };
  }

  /* THE ROW BEING ASSESSED MUST NOT BE COUNTED TWICE. The old caller ran
     this AFTER the deposit was written, so the sum already included it and
     then added `amount` again: two R40 000 deposits in a day totalled
     R120 000 against a R100 000 rule when the real total was R80 000, and
     the second one was flagged for a threshold it had not crossed.

     Called before the insert, excludeReference is null and there is nothing
     to exclude; called after one, the reference names it. */
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM transactions
      WHERE investor_id = $1
        AND type        = 'deposit'
        AND status      IN ('completed', 'pending', '${HELD_STATUS}')
        AND created_at  > NOW() - INTERVAL '24 hours'
        AND ($2::text IS NULL OR reference IS DISTINCT FROM $2)`,
    [investorId, excludeReference]
  );
  const combined = Math.round(((Number(rows[0].total) || 0) + amt) * 100) / 100;

  if (combined > DAY_TOTAL) {
    return { flagged: true,
             reason: `Total deposits exceed R${DAY_TOTAL} in 24h (R${combined})`,
             total24h: combined };
  }
  return { flagged: false, reason: null, total24h: combined };
}

/**
 * Raise the AML review ticket for a flagged deposit.
 *
 * `held` changes what the ticket SAYS, because it changes what the person
 * reading it has to do: release the money, or review a payment that has
 * already been credited.
 */
async function raiseTicket(db, { investorId, amount, reference, reason, held = false } = {}) {
  const ticketId = require('crypto').randomUUID();
  const subject  = `AML Alert — ${reason}`;
  const message  =
    `Automated AML flag triggered.\n\n` +
    `Investor: ${investorId}\n` +
    `Amount: R${amount}\n` +
    `Reference: ${reference}\n` +
    `Reason: ${reason}\n` +
    `Timestamp: ${new Date().toISOString()}\n\n` +
    (held
      ? 'THE FUNDS ARE HELD. They are not in the client\'s wallet and cannot be '
      + 'invested or withdrawn. Review it, then release or reject it under '
      + 'Compliance → Funds held for AML review. The client has been told their '
      + 'payment is being checked.'
      : 'THE FUNDS ARE NOT HELD — this credit was made by a staff member against '
      + 'a payment they had already verified, so it has been applied. Review it '
      + 'and act if anything is wrong.');

  await db.query(
    `INSERT INTO support_tickets
       (id, investor_id, subject, message, category, priority, status, is_system, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'aml_review', 'high', 'open', true, NOW(), NOW())`,
    [ticketId, investorId, subject, message]
  );
  console.warn(`[AML] Flag raised for investor ${investorId}: ${reason}`
               + (held ? ' — FUNDS HELD' : ''));
  return { ticketId };
}

/**
 * Assess and ticket in one call, for a path where the money is NOT held:
 * a staff manual credit. Kept as the name the old callers used.
 */
async function checkDeposit(db, investorId, amount, reference) {
  const verdict = await assess(db, { investorId, amount, excludeReference: reference });
  if (!verdict.flagged) return { flagged: false };
  await raiseTicket(db, { investorId, amount, reference, reason: verdict.reason, held: false });
  return { flagged: true, reason: verdict.reason };
}

module.exports = { assess, raiseTicket, checkDeposit,
                   HELD_STATUS, LARGE_DEPOSIT, DAY_TOTAL };
