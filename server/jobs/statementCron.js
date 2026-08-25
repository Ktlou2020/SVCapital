'use strict';
const cron = require('node-cron');
const pool = require('../db/pool');
const { enqueue } = require('../services/emailQueue');

async function runMonthlyStatements() {
  console.log('[statementCron] Running monthly statement job…');
  try {
    // FIX 3: Get calendar-month boundaries from DB clock (avoids JS Date drift)
    const { rows: [{ start_date, end_date }] } = await pool.query(
      `SELECT date_trunc('month', NOW() - INTERVAL '1 month') AS start_date,
              date_trunc('month', NOW()) AS end_date`
    );

    // FIX 4: Period year/month = previous calendar month
    const prevMonth = new Date(); prevMonth.setMonth(prevMonth.getMonth() - 1);
    const period_year = prevMonth.getFullYear();
    const period_month = prevMonth.getMonth() + 1;

    // Batch-load all active investors + their investments + last-month transactions — 3 queries total
    const [investorsRes, invstRes, txnRes] = await Promise.all([
      pool.query(
        `SELECT id, email, first_name, last_name, wallet_balance, total_invested, total_returns
         FROM investors WHERE status = 'active' AND email IS NOT NULL`
      ),
      pool.query(
        `SELECT i.investor_id, i.pool_name, i.product_type, i.amount, i.annual_rate,
                i.start_date, i.end_date, i.status, i.expected_return,
                ip.actual_rate AS pool_actual_rate
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY investor_id ORDER BY created_at DESC) rn
           FROM investments
           WHERE investor_id IN (SELECT id FROM investors WHERE status='active' AND email IS NOT NULL)
         ) i
         LEFT JOIN investment_pools ip ON ip.id = i.pool_id
         WHERE i.rn <= 20`
      ),
      pool.query(
        `SELECT investor_id, type, amount, status, created_at
         FROM transactions
         WHERE created_at >= $1 AND created_at < $2
           AND investor_id IN (SELECT id FROM investors WHERE status='active' AND email IS NOT NULL)
         ORDER BY investor_id, created_at DESC`,
        [start_date, end_date]
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
        // Store a record so the investor can see it in their archive
        // (PDF content is generated client-side; server stores a placeholder)
        // INSERT first — only enqueue email if this record was newly inserted (rowCount > 0)
        let inserted = false;
        try {
          const insertRes = await pool.query(
            `INSERT INTO investor_statements (investor_id, period_year, period_month, pdf_data)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (investor_id, period_year, period_month) DO NOTHING`,
            [inv.id, period_year, period_month, '']
          );
          inserted = insertRes.rowCount > 0;
        } catch (archErr) { console.error('[statementCron] archive error:', archErr.message); }

        if (inserted) {
          await enqueue(inv.email, 'sendMonthlyStatement', { args: [inv, {
            investments:        (invsByInvestor[inv.id] || []).slice(0, 20),
            recentTransactions: (txnsByInvestor[inv.id] || []).slice(0, 20),
          }] });
        }

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

/* Disabled. Client statements were removed from the portal and both apps, so this
   email was the only remaining delivery path and it fired on a schedule nobody was
   choosing. Guarded here as well as at the call site in server/index.js, so
   re-adding that call alone does not silently resume sending.

   Set STATEMENT_EMAILS_ENABLED=true to arm it again. runMonthlyStatements is
   exported unchanged and can still be invoked directly for a one-off run. */
function startStatementCron() {
  if (process.env.STATEMENT_EMAILS_ENABLED !== 'true') {
    console.log('[statementCron] disabled — set STATEMENT_EMAILS_ENABLED=true to schedule it');
    return;
  }
  // Run on the 1st of every month at 07:00 SAST (05:00 UTC)
  cron.schedule('0 5 1 * *', runMonthlyStatements, { timezone: 'UTC' });
  console.log('[statementCron] Monthly statement cron scheduled (1st of month, 07:00 SAST)');
}

module.exports = { startStatementCron, runMonthlyStatements };
