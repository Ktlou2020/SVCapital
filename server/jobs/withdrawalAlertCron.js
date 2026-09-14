'use strict';
const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');
const { staffRecipients, warnIfNotUsers } = require('../services/staffRecipients');

/* The recipient list is resolved by the shared service now — this file grew
   its own copy first, and three other sites had the same fault, so keeping a
   private version here would have been the fourth. The reasoning lives in
   server/services/staffRecipients.js. */

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

    const { to: admins, source } = await staffRecipients();

    for (const admin of admins) {
      await emailService.sendWithdrawalAlert(admin, {
        count,
        total: parseFloat(summary.total),
        requests,
      }).catch(e => console.error('[withdrawalAlertCron] email error:', e.message));
    }

    /* An alert that reached nobody must not read like an alert that was sent.
       Production logged "Alerted 0 admin(s) — 3 pending withdrawal(s)." at
       info level, three times a day, while client withdrawals sat unapproved. */
    warnIfNotUsers(source, 'withdrawalAlertCron');
    console.log(`[withdrawalAlertCron] Alerted ${admins.length} recipient(s) from ${source} — ${count} pending withdrawal(s).`);
  } catch (e) {
    console.error('[withdrawalAlertCron] Fatal error:', e.message);
  }
}

function startWithdrawalAlertCron() {
  // 10:00, 13:00, 16:00 SAST (UTC+2) = 08:00, 11:00, 14:00 UTC
  cron.schedule('0 8,11,14 * * *', () => {
    // Passed bare, a rejection from this async fn is an unhandled
    // rejection, which ends the process on Node 20.
    runWithdrawalAlert().catch(e => console.error('[withdrawalAlertCron] cron error:', e.message));
  }, { timezone: 'UTC' });
  console.log('[withdrawalAlertCron] Scheduled: 10:00, 13:00, 16:00 SAST daily');
}

module.exports = { startWithdrawalAlertCron, runWithdrawalAlert };
