'use strict';
const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

/* Where the alert is sent, in order of preference.

   This job used to ask for `users WHERE role IN ('admin','director')` and send
   to whatever came back — which in production is nothing. Three pending
   withdrawals were reported as "Alerted 0 admin(s)" on an info line, three
   times a day, and nobody was told about any of them.

   Two changes. The net is wider: fund_manager is a staff role everywhere else
   in this codebase (see STAFF_ROLES in routes/agreements.js and ADMIN_ROLES in
   routes/tables.js) and was the only one missing here, and senior staff in
   `employees` are asked next, because the staff portal keeps its people there
   rather than in `users`. And the list is never allowed to be empty: a
   withdrawal alert with no recipient is the one outcome this job must not have,
   so it falls back to a configured address and says so loudly.

   Only the first source that yields anybody is used. Mailing all three would
   send senior staff the same alert two or three times a day. */
const OPS_FALLBACK = process.env.OPS_ALERT_EMAIL || 'kagiso@svcapital.co.za';

async function alertRecipients() {
  const { rows: users } = await pool.query(
    `SELECT email, first_name FROM users
      WHERE role IN ('admin', 'director', 'fund_manager')
        AND email IS NOT NULL AND btrim(email) <> ''
      ORDER BY first_name`
  );
  if (users.length) return { to: users, source: 'users' };

  const { rows: staff } = await pool.query(
    `SELECT email, first_name FROM employees
      WHERE level IN ('executive', 'lead')
        AND COALESCE(status, '') = 'active'
        AND email IS NOT NULL AND btrim(email) <> ''
      ORDER BY first_name`
  );
  if (staff.length) return { to: staff, source: 'employees' };

  return { to: [{ email: OPS_FALLBACK, first_name: null }], source: 'fallback' };
}

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

    const { to: admins, source } = await alertRecipients();

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
    if (source !== 'users') {
      console.error(
        `[withdrawalAlertCron] No user has role admin, director or fund_manager — ` +
        `fell back to ${source}. Check the role values in the users table.`);
    }
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

module.exports = { startWithdrawalAlertCron, runWithdrawalAlert, alertRecipients };
