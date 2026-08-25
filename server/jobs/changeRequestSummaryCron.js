/* ═══════════════════════════════════════════════════════════
   Change Request Daily Summary Cron
   Daily at 08:00 SAST — queries all change_requests and
   sends a formatted summary to kagiso@svcapital.co.za.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

const RECIPIENT = 'kagiso@svcapital.co.za';

async function runChangeRequestSummary() {
  console.log('[change-requests] generating daily summary…');
  try {
    const { rows: requests } = await pool.query(`
      SELECT id, title, category, priority, status, submitted_by, created_at
      FROM   change_requests
      ORDER  BY created_at DESC
    `);

    const stats = {
      total:       requests.length,
      pending:     requests.filter(r => r.status === 'pending').length,
      reviewing:   requests.filter(r => r.status === 'reviewing').length,
      approved:    requests.filter(r => r.status === 'approved').length,
      rejected:    requests.filter(r => r.status === 'rejected').length,
      implemented: requests.filter(r => r.status === 'implemented').length,
    };

    const date = new Date().toLocaleDateString('en-ZA', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Africa/Johannesburg',
    });

    await emailService.sendChangeRequestSummary(RECIPIENT, { date, stats, requests });
    console.log(`[change-requests] summary sent → ${RECIPIENT} (${stats.total} request(s))`);
  } catch (err) {
    console.error('[change-requests] cron error:', err.message);
  }
}

function startChangeRequestSummaryCron() {
  cron.schedule('0 8 * * *', () => {
    // Unguarded, a rejection here is an unhandled rejection, which ends the
    // process on Node 20 — a failed summary e-mail must not restart the app.
    runChangeRequestSummary().catch(e => console.error('[change-requests] cron error:', e.message));
  }, { timezone: 'Africa/Johannesburg' });
  console.log('[change-requests] scheduled: daily at 08:00 SAST — change request summary');
}

module.exports = { startChangeRequestSummaryCron, runChangeRequestSummary };
