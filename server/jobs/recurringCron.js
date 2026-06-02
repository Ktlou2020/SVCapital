/* ═══════════════════════════════════════════════════════════
   Recurring Investment Cron
   Runs on the 1st of each month at 03:00 UTC (05:00 SAST).
   For each investor with recurring_enabled=true, a positive
   recurring_amount, and a recurring_pool_id set:
     • Check wallet_balance >= recurring_amount
     • If yes: deduct wallet, create investment + transaction
     • If no:  log skip
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

async function runRecurringInvestments() {
  console.log('[recurringCron] Running recurring investment processing…');

  // Fetch all eligible investors
  const { rows: investors } = await pool.query(
    `SELECT i.id, i.first_name, i.last_name, i.email,
            i.wallet_balance, i.recurring_amount, i.recurring_pool_id
     FROM investors i
     WHERE i.recurring_enabled = true
       AND i.recurring_amount  > 0
       AND i.recurring_pool_id IS NOT NULL
       AND i.status = 'active'`
  );

  console.log(`[recurringCron] ${investors.length} investor(s) eligible for recurring investment`);

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const investor of investors) {
    try {
      const amount    = parseFloat(investor.recurring_amount);
      const balance   = parseFloat(investor.wallet_balance);
      const poolId    = investor.recurring_pool_id;

      if (balance < amount) {
        console.log(
          `[recurringCron] Skipping ${investor.id} — insufficient funds (balance: ${balance}, required: ${amount})`
        );
        skipped++;
        continue;
      }

      // Fetch pool details for rate, name, term
      const { rows: [pool_row] } = await pool.query(
        `SELECT id, name, annual_rate, term_months, product_type
         FROM investment_pools WHERE id = $1`,
        [poolId]
      );
      if (!pool_row) {
        console.log(`[recurringCron] Skipping ${investor.id} — pool ${poolId} not found`);
        skipped++;
        continue;
      }

      const annualRate  = parseFloat(pool_row.annual_rate) || 0;
      const termMonths  = parseInt(pool_row.term_months, 10) || 6;
      const startDate   = new Date();
      const endDate     = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + termMonths);

      const expectedReturn = Math.round(amount * annualRate * (termMonths / 12) * 100) / 100;
      const investmentId   = 'INV-RC-' + Date.now() + '-' + investor.id.replace(/[^A-Z0-9]/g, '');
      const txRef          = 'RC-' + Date.now();

      // Deduct wallet
      await pool.query(
        'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
        [amount, investor.id]
      );

      // Insert investment
      await pool.query(
        `INSERT INTO investments
           (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
            annual_rate, term_months, expected_return, actual_return, product_type, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, 0, $11, NOW(), NOW())`,
        [
          investmentId, investor.id, poolId, pool_row.name,
          amount, startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10),
          annualRate, termMonths, expectedReturn, pool_row.product_type,
        ]
      );

      // Insert transaction
      await pool.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, investment_id, pool_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'investment', $2, 'completed', $3, $4, $5, $6, NOW(), NOW())`,
        [
          investor.id, amount, txRef,
          `Recurring investment — ${pool_row.name}`,
          investmentId, poolId,
        ]
      );

      // Update investor total_invested
      await pool.query(
        'UPDATE investors SET total_invested = total_invested + $1, updated_at = NOW() WHERE id = $2',
        [amount, investor.id]
      );

      // Fire-and-forget email
      setImmediate(() => emailService.sendInvestmentCreated(investor, {
        poolName:       pool_row.name,
        amount,
        annualRate,
        termMonths,
        expectedReturn,
        endDate:        endDate.toISOString(),
      }).catch(err => console.error('[email] sendInvestmentCreated (recurring) failed:', err.message)));

      console.log(
        `[recurringCron] R${amount} recurring investment created for investor ${investor.id} in pool ${poolId}`
      );
      processed++;

    } catch (err) {
      console.error(
        `[recurringCron] Error processing investor ${investor.id}:`, err.message
      );
      errors++;
    }
  }

  console.log(
    `[recurringCron] Done — ${processed} processed, ${skipped} skipped (insufficient funds), ${errors} errors`
  );
}

function startRecurringCron() {
  // 1st of each month at 03:00 UTC (05:00 SAST)
  cron.schedule('0 3 1 * *', runRecurringInvestments, { timezone: 'UTC' });
  console.log('[recurringCron] Scheduled: 1st of each month at 03:00 UTC (05:00 SAST)');
}

module.exports = { startRecurringCron, runRecurringInvestments };
