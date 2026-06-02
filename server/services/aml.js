/* ═══════════════════════════════════════════════════════════
   AML (Anti-Money Laundering) Service
   Checks deposits against risk rules and raises support
   tickets for any flagged transactions.

   Rules:
     1. Large single deposit  ≥ R50,000
     2. Structuring risk      total deposits > R100,000 in 24h
   ═══════════════════════════════════════════════════════════ */
'use strict';

/**
 * Check a deposit against AML rules.
 *
 * @param {object} pool        - pg pool (from ../db/pool)
 * @param {string} investorId  - investor ID being credited
 * @param {number} amount      - deposit amount in ZAR
 * @param {string} reference   - payment reference string
 * @returns {{ flagged: boolean, reason?: string }}
 */
async function checkDeposit(pool, investorId, amount, reference) {
  let flagReason = null;

  // Rule 1 — Large single deposit
  if (amount >= 50000) {
    flagReason = `Large single deposit (R${amount})`;
  }

  // Rule 2 — Structuring risk: cumulative deposits in last 24 hours
  if (!flagReason) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
        WHERE investor_id = $1
          AND type        = 'deposit'
          AND status      = 'completed'
          AND created_at  > NOW() - INTERVAL '24 hours'`,
      [investorId]
    );
    const totalLast24h = Number(rows[0].total) || 0;
    const combinedTotal = totalLast24h + amount;

    if (combinedTotal > 100000) {
      flagReason = `Total deposits exceed R100,000 in 24h (R${combinedTotal})`;
    }
  }

  if (!flagReason) {
    return { flagged: false };
  }

  // Raise AML support ticket
  const timestamp = new Date().toISOString();
  const ticketId  = `AML-${Date.now()}`;
  const subject   = `AML Alert — ${flagReason}`;
  const message   =
    `Automated AML flag triggered.\n\n` +
    `Investor: ${investorId}\n` +
    `Amount: R${amount}\n` +
    `Reference: ${reference}\n` +
    `Reason: ${flagReason}\n` +
    `Timestamp: ${timestamp}`;

  await pool.query(
    `INSERT INTO support_tickets
       (id, investor_id, subject, message, category, priority, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'aml_review', 'high', 'open', NOW(), NOW())`,
    [ticketId, investorId, subject, message]
  );

  console.warn(`[AML] Flag raised for investor ${investorId}: ${flagReason}`);

  return { flagged: true, reason: flagReason };
}

module.exports = { checkDeposit };
