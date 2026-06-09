'use strict';
const cron = require('node-cron');
const pool = require('../db/pool');
const { enqueue } = require('../services/emailQueue');

async function runMonthlyStatements() {
  console.log('[statementCron] Running monthly statement job…');
  try {
    // Batch-load all active investors + their investments + last-30-day transactions — 3 queries total
    const [investorsRes, invstRes, txnRes] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, wallet_balance, total_invested, total_returns
         FROM investors WHERE status = 'active' AND email IS NOT NULL`
      ),
      pool.query(
        `SELECT investor_id, pool_name, product_type, amount, annual_rate, start_date, end_date, status, expected_return
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY investor_id ORDER BY created_at DESC) rn
           FROM investments
           WHERE investor_id IN (SELECT id FROM investors WHERE status='active' AND email IS NOT NULL)
         ) ranked WHERE rn <= 20`
      ),
      pool.query(
        `SELECT investor_id, type, amount, status, created_at
         FROM transactions
         WHERE created_at >= NOW() - INTERVAL '30 days'
           AND investor_id IN (SELECT id FROM investors WHERE status='active' AND email IS NOT NULL)
         ORDER BY investor_id, created_at DESC`
      ),
    ]);

    const investors = investorsRes.rows;
    console.log(`[statementCron] Sending statements to ${investors.length} investors`);

    // Group by investor_id to avoid per-investor queries
    const invsByInvestor = {};
    for (const row of invstRes.rows) {
      (invsByInvestor[row.investor_id] = invsByInvestor[row.investor_id] || []).push(row);
    }
    const txnsByInvestor = {};
    for (const row of txnRes.rows) {
      (txnsByInvestor[row.investor_id] = txnsByInvestor[row.investor_id] || []).push(row);
    }

    let sent = 0, failed = 0;
    for (const inv of investors) {
      try {
        await enqueue(inv.email, 'sendMonthlyStatement', { args: [inv, {
          investments:        (invsByInvestor[inv.id] || []).slice(0, 20),
          recentTransactions: (txnsByInvestor[inv.id] || []).slice(0, 20),
        }] });

        try {
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth() + 1;
          // Store a record so the investor can see it in their archive
          // (PDF content is generated client-side; server stores a placeholder)
          await pool.query(
            `INSERT INTO investor_statements (investor_id, period_year, period_month, pdf_data)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (investor_id, period_year, period_month) DO NOTHING`,
            [inv.id, year, month, '']
          );
        } catch (archErr) { console.error('[statementCron] archive error:', archErr.message); }

        sent++;
      } catch (e) {
        failed++;
        console.error(`[statementCron] Failed for investor ${inv.id}:`, e.message);
      }
    }
    console.log(`[statementCron] Monthly statements complete — sent: ${sent}, failed: ${failed}`);
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
