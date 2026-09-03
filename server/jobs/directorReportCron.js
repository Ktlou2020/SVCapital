'use strict';
const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

async function runDirectorReport() {
  console.log('[directorReportCron] Running monthly director report job…');
  try {
    // 1. Fetch all directors/admins from users table
    const { rows: directors } = await pool.query(
      "SELECT id, email, first_name, last_name, role FROM users WHERE role IN ('director', 'admin') AND email IS NOT NULL"
    );
    if (!directors.length) {
      console.log('[directorReportCron] No directors/admins found — skipping.');
      return;
    }

    // 2. Compute month stats — derive boundary timestamps from DB to avoid server-local-time drift
    const { rows: [dateRow] } = await pool.query(
      "SELECT date_trunc('month', NOW() - INTERVAL '1 month') AS month_start, date_trunc('month', NOW()) AS month_end"
    );
    const monthStart = dateRow.month_start;
    const monthEnd   = dateRow.month_end;
    const monthLabel = new Date(monthStart).toLocaleString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });

    // Total AUM (all active investments)
    const { rows: [aumRow] } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS aum FROM investments WHERE status = 'active'"
    );

    // New investors this month
    const { rows: [newInvRow] } = await pool.query(
      "SELECT COUNT(*) AS cnt FROM investors WHERE date_joined >= $1 AND date_joined < $2",
      [monthStart, monthEnd]
    );

    /* Returns distributed this month.
     *
     * This summed `payout` as well, and a payout's amount is the client's
     * CAPITAL COMING BACK plus the return on it — maturityCron credits the
     * whole sum and books only the return portion to total_returns. So in any
     * month with maturities the directors were told the firm had distributed
     * far more in returns than it had, by exactly the capital it handed back.
     *
     * Income is `return` and `interest`, from services/ledger — the same
     * definition both tax documents and the statements now use.
     *
     * The window is on the date the money MOVED, not on when the row was
     * written: a migrated or back-dated transaction lands in the wrong month
     * otherwise. */
    const { incomeTypesSQL } = require('../services/ledger');
    const { rows: [returnsRow] } = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
        WHERE type IN (${incomeTypesSQL()}) AND status = 'completed'
          AND COALESCE(transaction_date, created_at) >= $1
          AND COALESCE(transaction_date, created_at) <  $2`,
      [monthStart, monthEnd]
    );

    // Deposits this month
    const { rows: [depositsRow] } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='deposit' AND status='completed' AND created_at >= $1 AND created_at < $2",
      [monthStart, monthEnd]
    );

    // Pool breakdown
    const { rows: pools } = await pool.query(
      "SELECT pool_id, pool_name, product_type, SUM(amount) AS invested, COUNT(*) AS investors FROM investments WHERE status='active' GROUP BY pool_id, product_type, pool_name ORDER BY invested DESC LIMIT 10"
    );

    // Total investors
    const { rows: [totalInvRow] } = await pool.query("SELECT COUNT(*) AS cnt FROM investors WHERE status='active'");

    // 3. Build HTML email report and send to each director
    for (const director of directors) {
      await emailService.sendDirectorReport(director, {
        monthLabel,
        aum:            Number(aumRow.aum),
        newInvestors:   Number(newInvRow.cnt),
        returnsTotal:   Number(returnsRow.total),
        depositsTotal:  Number(depositsRow.total),
        totalInvestors: Number(totalInvRow.cnt),
        pools,
      }).catch(e => console.error('[directorReportCron] email error:', e.message));
    }

    console.log(`[directorReportCron] Sent report for ${monthLabel} to ${directors.length} director(s)`);
  } catch (e) {
    console.error('[directorReportCron] Fatal error:', e.message);
  }
}

function startDirectorReportCron() {
  cron.schedule('0 7 1 * *', () => {
    // Passed bare, a rejection from this async fn is an unhandled
    // rejection, which ends the process on Node 20.
    runDirectorReport().catch(e => console.error('[directorReport] cron error:', e.message));
  }, { timezone: 'UTC' });
  console.log('[directorReportCron] Scheduled: 1st of month at 07:00 UTC (09:00 SAST)');
}

module.exports = { startDirectorReportCron, runDirectorReport };
