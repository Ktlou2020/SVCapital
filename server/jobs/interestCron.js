/* ═══════════════════════════════════════════════════════════
   Interest Cron
   Runs on the 1st of each month at 04:00 UTC (06:00 SAST).
   Credits monthly interest to every active investment,
   updates investor total_returns and investment actual_return.
   Idempotent: skips investments already credited this month.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');

async function runInterestCrediting() {
  console.log('[interestCron] Running monthly interest crediting…');

  const now  = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${yyyy}-${mm}`; // e.g. '2026-06'

  // Fetch all active investments
  const { rows: investments } = await pool.query(
    `SELECT * FROM investments WHERE status = 'active'`
  );

  console.log(`[interestCron] ${investments.length} active investment(s) found for ${yearMonth}`);

  let credited = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const investment of investments) {
    const reference = `INT-${investment.id}-${yearMonth}`;

    try {
      // Idempotency check — skip if already credited this month
      const { rows: existing } = await pool.query(
        `SELECT id FROM transactions WHERE reference = $1 AND type = 'return'`,
        [reference]
      );
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // Calculate monthly interest
      const annualRate    = Number(investment.annual_rate) || 0;
      const amount        = Number(investment.amount)      || 0;
      const monthlyInterest = Math.round(amount * annualRate / 12 * 100) / 100;

      if (monthlyInterest <= 0) {
        skipped++;
        continue;
      }

      const poolName    = investment.pool_name || investment.pool_id || 'your investment';
      const description = `Return Earned — ${poolName} (${yearMonth})`;

      // 1. Record the return transaction
      await pool.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, transaction_date, created_at)
         VALUES (gen_random_uuid(), $1, 'return', $2, 'completed', $3, $4, NOW(), NOW())`,
        [investment.investor_id, monthlyInterest, reference, description]
      );

      // 2. Update investor total_returns
      await pool.query(
        `UPDATE investors
            SET total_returns = total_returns + $1, updated_at = NOW()
          WHERE id = $2`,
        [monthlyInterest, investment.investor_id]
      );

      // 3. Update investment actual_return
      await pool.query(
        `UPDATE investments
            SET actual_return = actual_return + $1, updated_at = NOW()
          WHERE id = $2`,
        [monthlyInterest, investment.id]
      );

      console.log(
        `[interestCron] R${monthlyInterest} interest → investor ${investment.investor_id}, investment ${investment.id}`
      );
      credited++;

    } catch (err) {
      console.error(
        `[interestCron] Failed for investment ${investment.id}:`,
        err.message
      );
      errors++;
    }
  }

  console.log(
    `[interestCron] Done — ${credited} credited, ${skipped} skipped, ${errors} errors`
  );
}

function startInterestCron() {
  // 1st of each month at 04:00 UTC (06:00 SAST)
  cron.schedule('0 4 1 * *', runInterestCrediting, { timezone: 'UTC' });
  console.log('[interestCron] Scheduled: 1st of each month at 04:00 UTC (06:00 SAST)');
}

module.exports = { startInterestCron, runInterestCrediting };
