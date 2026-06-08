/* ═══════════════════════════════════════════════════════
   FICA Re-Check Cron Job
   Runs daily at 02:00 SAST (Africa/Johannesburg)

   Two sweeps per run:
   1. Annual re-check — investors whose last_auto_fica_check
      is ≥ 1 year old
   2. First-deposit check — investors who deposited but have
      never had an automated FICA check
   ═══════════════════════════════════════════════════════ */
'use strict';

const cron           = require('node-cron');
const pool           = require('../db/pool');
const { runFicaCheck } = require('../services/ficaService');
const emailService   = require('../services/email');

const BATCH_LIMIT  = 50;   // max investors per cron run
const INTER_DELAY  = 800;  // ms between API calls (rate-limit courtesy)

async function runFicaSweep() {
  const startedAt = new Date().toISOString();
  console.log(`[FICA Cron] Sweep started at ${startedAt}`);

  let annualCount = 0, firstDepositCount = 0, errorCount = 0;

  try {
    /* ── Batch 1: Annual re-checks ── */
    const { rows: annualDue } = await pool.query(`
      SELECT * FROM investors
      WHERE last_auto_fica_check IS NOT NULL
        AND last_auto_fica_check < NOW() - INTERVAL '1 year'
        AND status != 'suspended'
      ORDER BY last_auto_fica_check ASC
      LIMIT $1
    `, [BATCH_LIMIT]);

    /* ── Batch 2: First-deposit investors (deposited but never checked) ── */
    const remainingSlots = BATCH_LIMIT - annualDue.length;
    let firstDeposit = [];
    if (remainingSlots > 0) {
      const { rows } = await pool.query(`
        SELECT i.* FROM investors i
        WHERE i.last_auto_fica_check IS NULL
          AND i.status != 'suspended'
          AND EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.investor_id = i.id
              AND t.type = 'deposit'
              AND t.status = 'completed'
          )
        LIMIT $1
      `, [remainingSlots]);
      firstDeposit = rows;
    }

    console.log(
      `[FICA Cron] Queued: ${annualDue.length} annual re-checks, ` +
      `${firstDeposit.length} first-deposit checks.`
    );

    /* ── Process annual re-checks ── */
    for (const investor of annualDue) {
      try {
        await runFicaCheck(investor, 'annual_recheck');
        annualCount++;
      } catch (err) {
        errorCount++;
        console.error(`[FICA Cron] annual_recheck error ${investor.id}:`, err.message);
      }
      await _delay(INTER_DELAY);
    }

    /* ── Process first-deposit investors ── */
    for (const investor of firstDeposit) {
      try {
        await runFicaCheck(investor, 'first_deposit');
        firstDepositCount++;
      } catch (err) {
        errorCount++;
        console.error(`[FICA Cron] first_deposit error ${investor.id}:`, err.message);
      }
      await _delay(INTER_DELAY);
    }

  } catch (err) {
    console.error('[FICA Cron] Fatal sweep error:', err.message);
  }

  console.log(
    `[FICA Cron] Sweep complete — ` +
    `annual:${annualCount} firstDeposit:${firstDepositCount} errors:${errorCount}`
  );
}

function _delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runFicaExpiryAlerts() {
  // Alert investors whose FICA approval is approaching 3 years old
  const { rows } = await pool.query(`
    SELECT id, first_name, last_name, email
    FROM investors
    WHERE fica_approved_at < NOW() - INTERVAL '2 years 9 months'
      AND fica_resubmit_requested_at IS NULL
      AND status = 'active'
      AND fica_status = 'approved'
  `);
  for (const inv of rows) {
    try {
      await emailService.sendFicaResubmitReminder(inv);
      await pool.query('UPDATE investors SET fica_resubmit_requested_at=NOW() WHERE id=$1', [inv.id]);
      console.log(`[ficaCron] FICA expiry reminder sent to ${inv.id}`);
    } catch (e) { console.error('[ficaCron] expiry alert error:', e.message); }
  }
}

/* ─── Start the cron (called from server/index.js) ────────────────────── */
function startFicaCron() {
  if (!process.env.DATABASE_URL) {
    console.log('[FICA Cron] No DATABASE_URL — cron not started.');
    return;
  }

  /* Daily at 02:00 SAST — cron expression uses Africa/Johannesburg TZ */
  cron.schedule('0 2 * * *', async () => {
    await runFicaSweep();
    await runFicaExpiryAlerts();
  }, {
    timezone: 'Africa/Johannesburg',
    scheduled: true,
  });

  console.log('⏰ FICA re-check cron scheduled: daily at 02:00 SAST (Africa/Johannesburg)');
}

module.exports = { startFicaCron, runFicaSweep, runFicaExpiryAlerts };
