/* ═══════════════════════════════════════════════════════════
   PE Review Reminder Cron
   Daily at 08:00 SAST — finds PE company reviews whose
   next_review_date is exactly 14 days away and sends a
   reminder email to all admin/director/fund_manager users.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');
const BASE_URL     = process.env.BASE_URL || 'https://platform.svcapital.co.za';

async function runReviewReminders() {
  console.log('[pe-reviews] checking upcoming reviews…');
  try {
    // Find reviews with next_review_date 14 days from today
    const { rows: upcoming } = await pool.query(`
      SELECT r.*, c.name AS company_name
      FROM   pe_reviews r
      JOIN   pe_companies c ON c.id = r.company_id
      WHERE  r.next_review_date = CURRENT_DATE + INTERVAL '14 days'
    `);

    if (!upcoming.length) {
      console.log('[pe-reviews] no reminders to send today');
      return;
    }

    // Get all PE app recipients
    const { rows: recipients } = await pool.query(`
      SELECT email, first_name, last_name
      FROM   users
      WHERE  role IN ('admin','director','fund_manager')
        AND  is_active = true
        AND  email IS NOT NULL
    `);

    if (!recipients.length) {
      console.log('[pe-reviews] no recipients found');
      return;
    }

    for (const review of upcoming) {
      const dateStr = new Date(review.next_review_date).toLocaleDateString('en-ZA', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });

      for (const user of recipients) {
        const first = user.first_name || 'there';
        try {
          await emailService.sendAlert(
            { email: user.email, first_name: first },
            {
              subject: `Upcoming Portfolio Review — ${review.company_name} — ${dateStr}`,
              message: `A quarterly portfolio review for ${review.company_name} is scheduled in 14 days.\n\nDate: ${dateStr}\n\nPlease log in to the PE Monitor to view the company's latest updates and prepare for the meeting.\n\n${BASE_URL}/team/pe-monitor.html`,
            }
          );
        } catch (e) {
          console.error('[pe-reviews] email error for', user.email, e.message);
        }
      }

      console.log(`[pe-reviews] sent ${recipients.length} reminders for ${review.company_name} (${dateStr})`);
    }
  } catch (err) {
    console.error('[pe-reviews] cron error:', err.message);
  }
}

function startReviewReminderCron() {
  cron.schedule('0 8 * * *', async () => {
    await runReviewReminders();
  }, { timezone: 'Africa/Johannesburg' });
  console.log('[pe-reviews] scheduled: daily at 08:00 SAST — review reminders');
}

module.exports = { startReviewReminderCron, runReviewReminders };
