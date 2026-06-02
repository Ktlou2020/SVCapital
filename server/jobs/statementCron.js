'use strict';
const cron = require('node-cron');
const pool = require('../db/pool');
const emailService = require('../services/email');

async function runMonthlyStatements() {
  console.log('[statementCron] Running monthly statement job…');
  try {
    const investorsRes = await pool.query(
      `SELECT id, email, first_name, last_name, wallet_balance, total_invested, total_returns
       FROM investors
       WHERE status = 'active' AND email IS NOT NULL`
    );
    const investors = investorsRes.rows;
    console.log(`[statementCron] Sending statements to ${investors.length} investors`);

    for (const inv of investors) {
      try {
        const invstRes = await pool.query(
          `SELECT pool_name, product_type, amount, annual_rate, start_date, end_date, status, expected_return
           FROM investments
           WHERE investor_id = $1
           ORDER BY created_at DESC
           LIMIT 20`,
          [inv.id]
        );

        const txnRes = await pool.query(
          `SELECT type, amount, status, created_at
           FROM transactions
           WHERE investor_id = $1
             AND created_at >= NOW() - INTERVAL '30 days'
           ORDER BY created_at DESC
           LIMIT 20`,
          [inv.id]
        );

        await emailService.sendMonthlyStatement(inv, {
          investments: invstRes.rows,
          recentTransactions: txnRes.rows,
        });
      } catch (e) {
        console.error(`[statementCron] Failed for investor ${inv.id}:`, e.message);
      }
    }
    console.log('[statementCron] Monthly statements complete');
  } catch (e) {
    console.error('[statementCron] Fatal error:', e.message);
  }
}

function startStatementCron() {
  // Run on the 1st of every month at 07:00 SAST (05:00 UTC)
  cron.schedule('0 5 1 * *', runMonthlyStatements, { timezone: 'UTC' });
  console.log('[statementCron] Monthly statement cron scheduled (1st of month, 07:00 SAST)');
}

module.exports = { startStatementCron, runMonthlyStatements };
