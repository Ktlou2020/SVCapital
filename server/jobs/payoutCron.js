/* ═══════════════════════════════════════════════════════════
   Payout Cron
   Runs daily at 05:30 UTC (07:30 SAST).
   Processes matured investments that are ready for payout
   based on the investor's maturity_instruction:
     • payout_all    — credits principal + returns to wallet
     • payout_return — credits returns only; capital stays
                       for manual admin re-investment
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

async function runPayoutProcessing() {
  console.log('[payoutCron] Running payout processing…');

  const { rows: investments } = await pool.query(`
    SELECT i.*, inv.email, inv.first_name, inv.last_name, inv.phone
    FROM investments i
    JOIN investors inv ON inv.id = i.investor_id
    WHERE i.status = 'matured'
      AND i.maturity_instruction IN ('payout_all', 'payout_return')
      AND i.maturity_processed_at IS NULL
  `);

  console.log(`[payoutCron] ${investments.length} investment(s) ready for payout`);

  let processed = 0;
  let errors    = 0;

  for (const investment of investments) {
    try {
      const poolName    = investment.pool_name || investment.pool_id || 'your investment';
      const actualReturn = Number(investment.actual_return) || 0;
      const principal    = Number(investment.amount)        || 0;
      const reference    = `PAY-${investment.id}-${Date.now()}`;
      const description  = `Maturity payout — ${poolName}`;

      let payoutAmount;

      if (investment.maturity_instruction === 'payout_all') {
        payoutAmount = principal + actualReturn;

        // Record payout transaction (principal + returns)
        await pool.query(
          `INSERT INTO transactions
             (id, investor_id, type, amount, status, reference, description, transaction_date, created_at)
           VALUES (gen_random_uuid(), $1, 'payout', $2, 'completed', $3, $4, NOW(), NOW())`,
          [investment.investor_id, payoutAmount, reference, description]
        );

        // Credit full payout to wallet
        await pool.query(
          `UPDATE investors
              SET wallet_balance = wallet_balance + $1, updated_at = NOW()
            WHERE id = $2`,
          [payoutAmount, investment.investor_id]
        );

        // Mark investment as paid out
        await pool.query(
          `UPDATE investments
              SET status = 'paid_out', maturity_processed_at = NOW()
            WHERE id = $1`,
          [investment.id]
        );

      } else {
        // payout_return — returns only, capital stays for admin re-investment
        payoutAmount = actualReturn;

        // Record payout transaction (returns only)
        await pool.query(
          `INSERT INTO transactions
             (id, investor_id, type, amount, status, reference, description, transaction_date, created_at)
           VALUES (gen_random_uuid(), $1, 'payout', $2, 'completed', $3, $4, NOW(), NOW())`,
          [investment.investor_id, payoutAmount, reference, description]
        );

        // Credit returns only to wallet
        await pool.query(
          `UPDATE investors
              SET wallet_balance = wallet_balance + $1, updated_at = NOW()
            WHERE id = $2`,
          [payoutAmount, investment.investor_id]
        );

        // Mark maturity processed but keep status as matured for admin re-investment
        await pool.query(
          `UPDATE investments
              SET maturity_processed_at = NOW()
            WHERE id = $1`,
          [investment.id]
        );
      }

      // Send maturity email (non-blocking)
      const investor = {
        email:      investment.email,
        first_name: investment.first_name,
        last_name:  investment.last_name,
        phone:      investment.phone,
      };
      emailService.sendInvestmentMatured(investor, {
        poolName,
        amount:       principal,
        actualReturn: actualReturn,
      }).catch(e => console.error(`[payoutCron] email error for ${investment.id}:`, e.message));

      console.log(
        `[payoutCron] Processed ${investment.maturity_instruction} for investment ${investment.id}` +
        ` — R${payoutAmount} → investor ${investment.investor_id}`
      );
      processed++;

    } catch (err) {
      console.error(`[payoutCron] Failed for investment ${investment.id}:`, err.message);
      errors++;
    }
  }

  console.log(`[payoutCron] Done — ${processed} processed, ${errors} errors`);
}

function startPayoutCron() {
  // Daily at 05:30 UTC (07:30 SAST)
  cron.schedule('30 5 * * *', runPayoutProcessing, { timezone: 'UTC' });
  console.log('[payoutCron] Scheduled: daily at 05:30 UTC (07:30 SAST)');
}

module.exports = { startPayoutCron, runPayoutProcessing };
