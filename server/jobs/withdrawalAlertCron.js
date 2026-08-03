'use strict';
const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

async function runWithdrawalAlert() {
  console.log('[withdrawalAlertCron] Checking for pending withdrawals…');
  try {
    // Count and total pending withdrawals
    const { rows: [summary] } = await pool.query(`
      SELECT
        COUNT(*)                      AS cnt,
        COALESCE(SUM(ABS(amount)), 0) AS total
      FROM transactions
      WHERE type = 'withdrawal' AND status = 'pending'
    `);

    const count = parseInt(summary.cnt, 10);
    if (count === 0) {
      console.log('[withdrawalAlertCron] No pending withdrawals — skipping.');
      return;
    }

    // Fetch the pending withdrawal rows for the summary table
    const { rows: requests } = await pool.query(`
      SELECT
        t.id,
        t.amount,
        t.created_at,
        i.first_name,
        i.last_name,
        i.email AS investor_email
      FROM transactions t
      LEFT JOIN investors i ON i.id = t.investor_id
      WHERE t.type = 'withdrawal' AND t.status = 'pending'
      ORDER BY t.created_at ASC
      LIMIT 20
    `);

    const { rows: admins } = await pool.query(
      `SELECT email, first_name FROM users
        WHERE role IN ('admin', 'director') AND email IS NOT NULL
        ORDER BY first_name`
    );

    for (const admin of admins) {
      await emailService.sendWithdrawalAlert(admin, {
        count,
        total: parseFloat(summary.total),
        requests,
      }).catch(e => console.error('[withdrawalAlertCron] email error:', e.message));
    }

    console.log(`[withdrawalAlertCron] Alerted ${admins.length} admin(s) — ${count} pending withdrawal(s).`);
  } catch (e) {
    console.error('[withdrawalAlertCron] Fatal error:', e.message);
  }
}

function startWithdrawalAlertCron() {
  // 10:00, 13:00, 16:00 SAST (UTC+2) = 08:00, 11:00, 14:00 UTC
  cron.schedule('0 8,11,14 * * *', runWithdrawalAlert, { timezone: 'UTC' });
  console.log('[withdrawalAlertCron] Scheduled: 10:00, 13:00, 16:00 SAST daily');
}

module.exports = { startWithdrawalAlertCron, runWithdrawalAlert };
