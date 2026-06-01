/* ═══════════════════════════════════════════════════════════
   Maturity Alert Cron
   Runs daily at 08:00 SAST. Sends email alerts at 30-day
   and 7-day milestones. Tracks sent alerts via
   investments.maturity_alert_sent_at to avoid duplicates.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

async function runMaturityAlerts() {
  console.log('[maturityCron] running maturity alert scan…');
  try {
    const now = new Date();

    // Find active investments where end_date is within 31 days
    // AND we haven't sent an alert in the last 6 days (to avoid duplicate daily sends)
    const { rows: investments } = await pool.query(`
      SELECT i.*, inv.email, inv.first_name
      FROM investments i
      JOIN investors inv ON inv.id = i.investor_id
      WHERE i.status = 'active'
        AND i.end_date IS NOT NULL
        AND i.end_date > NOW()
        AND i.end_date <= NOW() + INTERVAL '31 days'
        AND (i.maturity_alert_sent_at IS NULL
             OR i.maturity_alert_sent_at < NOW() - INTERVAL '6 days')
    `);

    let sent = 0;
    for (const inv of investments) {
      const daysLeft = Math.ceil((new Date(inv.end_date) - now) / 86400000);
      // Only send at the 30-day or 7-day milestone (±1 day tolerance)
      if (!(daysLeft <= 31 && daysLeft >= 29) && !(daysLeft <= 8 && daysLeft >= 6)) continue;

      await emailService.sendMaturityAlert(
        { email: inv.email, first_name: inv.first_name },
        {
          poolName:       inv.pool_name || inv.pool_id || 'your investment',
          amount:         inv.amount,
          expectedReturn: inv.expected_return || 0,
          endDate:        inv.end_date,
          daysLeft,
        }
      );

      // Mark alert sent
      await pool.query(
        'UPDATE investments SET maturity_alert_sent_at = NOW() WHERE id = $1',
        [inv.id]
      );
      sent++;
    }

    console.log(`[maturityCron] done — ${sent} alert(s) sent`);
  } catch (err) {
    console.error('[maturityCron] error:', err.message);
  }
}

function startMaturityCron() {
  // 08:00 SAST daily (UTC+2 → 06:00 UTC)
  cron.schedule('0 6 * * *', runMaturityAlerts, {
    timezone: 'Africa/Johannesburg',
  });
  console.log('⏰ Maturity alert cron scheduled: daily at 08:00 SAST');
}

module.exports = { startMaturityCron, runMaturityAlerts };
