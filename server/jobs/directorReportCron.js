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

    // 2. Compute month stats — use DB clock for month boundaries (FIX 8)
    const { rows: [dateRow] } = await pool.query(
      `SELECT date_trunc('month', NOW() - INTERVAL '1 month') AS month_start,
              date_trunc('month', NOW()) AS month_end`
    );
    const monthStart = dateRow.month_start;
    const monthEnd   = dateRow.month_end;
    const monthLabel = new Date(monthStart).toLocaleString('en-ZA', { month: 'long', year: 'numeric' });

    // Total AUM (all active investments)
    const { rows: [aumRow] } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS aum FROM investments WHERE status = 'active'"
    );

    // New investors this month
    const { rows: [newInvRow] } = await pool.query(
      "SELECT COUNT(*) AS cnt FROM investors WHERE date_joined >= $1 AND date_joined < $2",
      [monthStart, monthEnd]
    );

    // Returns distributed this month (type='return' or 'payout')
    const { rows: [returnsRow] } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type IN ('return','payout') AND status='completed' AND created_at >= $1 AND created_at < $2",
      [monthStart, monthEnd]
    );

    // Deposits this month
    const { rows: [depositsRow] } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='deposit' AND status='completed' AND created_at >= $1 AND created_at < $2",
      [monthStart, monthEnd]
    );

    // Pool breakdown
    const { rows: pools } = await pool.query(
      "SELECT i.pool_id, i.pool_name, i.product_type, SUM(i.amount) AS invested, COUNT(*) AS investors FROM investments i WHERE i.status='active' GROUP BY i.pool_id, i.pool_name, i.product_type ORDER BY invested DESC LIMIT 10"
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
  cron.schedule('0 7 1 * *', runDirectorReport, { timezone: 'UTC' });
  console.log('[directorReportCron] Scheduled: 1st of month at 07:00 UTC (09:00 SAST)');
}

module.exports = { startDirectorReportCron, runDirectorReport };
