/* ═══════════════════════════════════════════════════════════
   Maturity Cron
   Runs daily at 08:00 SAST.
   1. runMaturityProcessing — marks matured investments as
      'matured', sends email + SMS to the investor.
   2. runMaturityAlerts     — sends 30-day and 7-day advance
      warning emails. Tracks sent alerts via
      investments.maturity_alert_sent_at to avoid duplicates.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');
const smsService   = require('../services/sms');

async function runMaturityProcessing() {
  console.log('[maturityCron] running maturity processing…');

  const { rows: investments } = await pool.query(`
    SELECT i.*, inv.email, inv.first_name, inv.phone
    FROM investments i
    JOIN investors inv ON inv.id = i.investor_id
    WHERE i.status = 'active'
      AND i.end_date IS NOT NULL
      AND i.end_date <= NOW()
      AND i.maturity_processed_at IS NULL
  `);

  let processed = 0;
  for (const inv of investments) {
    try {
      // 1. Mark the investment as matured
      await pool.query(
        `UPDATE investments
            SET status = 'matured', maturity_processed_at = NOW()
          WHERE id = $1`,
        [inv.id]
      );

      // 2. Send maturity email
      await emailService.sendInvestmentMatured(
        { email: inv.email, first_name: inv.first_name },
        {
          poolName:     inv.pool_name || inv.pool_id || 'your investment',
          amount:       inv.amount,
          actualReturn: 0,
        }
      );

      // 3. Send maturity SMS
      await smsService.sendMaturityAlert(
        inv.phone,
        inv.first_name,
        inv.amount,
        inv.pool_name || inv.pool_id || 'your investment'
      );

      console.log(`[maturityCron] processed investment ${inv.id} for ${inv.first_name} (${inv.email})`);
      processed++;
    } catch (err) {
      console.error(`[maturityCron] failed to process investment ${inv.id}:`, err.message);
    }
  }

  console.log(`[maturityCron] processing done — ${processed} investment(s) matured`);
  return processed;
}

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
  // Processing runs first (marks matured investments), then alerts scan.
  cron.schedule('0 6 * * *', async () => {
    await runMaturityProcessing();
    await runMaturityAlerts();
  }, {
    timezone: 'Africa/Johannesburg',
  });
  console.log('[maturityCron] scheduled: daily at 08:00 SAST — maturity processing + alert scan');
}

module.exports = { startMaturityCron, runMaturityProcessing, runMaturityAlerts };
