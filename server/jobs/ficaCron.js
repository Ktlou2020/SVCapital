/* ═══════════════════════════════════════════════════════
   FICA Re-Check Cron Job
   Runs daily at 02:00 SAST (Africa/Johannesburg)

   Three sweeps per run:
   1. Annual re-check — investors whose last_auto_fica_check
      is ≥ 12 months old
   2. First-investment check — investors who have placed an
      investment of R2 000 or more and never been checked
   3. Sanctions backfill — approved clients who have never
      been past a sanctions or PEP list, screened on their own

   WHAT IS DUE IS services/ficaPolicy.js's to say, not these
   queries'. The queries narrow the field cheaply; runFicaCheck
   asks the policy for each client and is the one that decides.
   So every SELECT here must carry the columns the policy reads
   — kyc_status, fica_status, last_auto_fica_check AND
   last_sanctions_check. Leave the last one out and an approved
   client due for a full re-check reads as never screened, and
   gets a screen instead of the check they were queued for.
   ═══════════════════════════════════════════════════════ */
'use strict';

const cron           = require('./_watched');
const pool           = require('../db/pool');
const { runFicaCheck } = require('../services/ficaService');
const POLICY         = require('../services/ficaPolicy');
const emailService   = require('../services/email');

/* ONE COLUMN LIST FOR ALL THREE BATCHES. runFicaCheck destructures some of
   these and ficaPolicy reads others; a batch that selects its own shorter
   list is how a client ends up judged on a column that arrived undefined.
   The last two are the ones that decide WHICH check a client gets. */
const COLS = `id, email, first_name, last_name, id_number, nationality, notes,
              date_of_birth, residency_status, kyc_status, fica_status,
              fica_resubmit_requested_at,
              last_auto_fica_check, last_sanctions_check`;

const BATCH_LIMIT  = 50;   // max investors per cron run
/* The backfill's own slots, so a backlog of thousands cannot crowd out the
   checks that are due today. It drains a night at a time until it is empty. */
const BACKFILL_LIMIT = 25;
const INTER_DELAY  = 800;  // ms between API calls (rate-limit courtesy)

async function runFicaSweep() {
  const startedAt = new Date().toISOString();
  console.log(`[FICA Cron] Sweep started at ${startedAt}`);

  /* Both SELECTs below named two columns that do not exist — nationality,
     which has now been created, and fica_last_checked_at, which never has and
     is not what the rest of the codebase calls this. The timestamp is
     last_auto_fica_check: ficaService writes it, routes/fica.js reads it, and
     the WHERE clause four lines down filters on it. Nothing ever read the
     value under the wrong name, so the wrong name is simply gone.

     notes and date_of_birth are new to these lists and are not cosmetic.
     runFicaCheck destructures both, and it uses notes to decide whether it is
     verifying a passport or an SA ID. Selecting them was the difference
     between this job verifying a foreign passport correctly and submitting the
     passport number as a national ID — which nobody could have noticed,
     because the job had never got past its first statement. */
  let annualCount = 0, firstInvestmentCount = 0, sanctionsCount = 0, errorCount = 0;

  try {
    /* ── Batch 1: Annual re-checks ── */
    const { rows: annualDue } = await pool.query(`
      SELECT ${COLS}
      FROM investors
      WHERE last_auto_fica_check IS NOT NULL
        AND last_auto_fica_check < NOW() - ${POLICY.RECHECK_INTERVAL_SQL}
        AND COALESCE(status, '') <> 'suspended'
        /* A non-resident is reviewed by hand. runFicaCheck refuses them
           anyway — this keeps them out of the batch so the limited slots
           go to clients the check can actually answer for. */
        AND COALESCE(residency_status, 'resident') <> 'non_resident'
      ORDER BY last_auto_fica_check ASC
      LIMIT $1
    `, [BATCH_LIMIT]);

    /* ── Batch 2: Invested R2 000 or more and never been checked ──
     *
     * THIS BATCH USED TO BE EVERY DEPOSITOR. A deposit is not a purchase —
     * a client can top up and sit on it — and the automated check is paid
     * provider calls per client, so it belongs where they commit. The
     * amount is the one that reached the POOL: the 1% platform fee rides
     * on top and is not the client's investment.
     *
     * The threshold is read from ficaPolicy, not written here, because the
     * investment hook and the console trigger test the same number and
     * three copies of it is two that go stale. The policy still decides
     * per client; this only narrows who is worth asking about. */
    const remainingSlots = BATCH_LIMIT - annualDue.length;
    let firstInvestment = [];
    if (remainingSlots > 0) {
      const { rows } = await pool.query(`
        SELECT ${COLS}
        FROM investors i
        WHERE i.last_auto_fica_check IS NULL
          AND COALESCE(i.status, '') <> 'suspended'
          AND COALESCE(i.residency_status, 'resident') <> 'non_resident'
          AND EXISTS (
            SELECT 1 FROM investments v
            WHERE v.investor_id = i.id
              AND COALESCE(v.amount, 0) >= $2
              AND COALESCE(v.status, '') NOT IN ('cancelled', 'rejected')
          )
        LIMIT $1
      `, [remainingSlots, POLICY.AUTO_MIN_INVESTMENT]);
      firstInvestment = rows;
    }

    /* ── Batch 3: Approved, and never screened ──
     *
     * sanctions_check_status defaults to 'skipped' and every fica_checks
     * row written before that column existed carries it, so there is a
     * population of clients who went through ID and bank and never past a
     * sanctions or PEP list — approved, and never screened. ficaReview
     * will not approve a review whose screen did not run; these clients
     * were approved before it held that line.
     *
     * They get the SCREEN and not the whole check again: one provider call
     * answers the one open question, and re-running ID and bank risks
     * moving a client who is already approved. last_sanctions_check is
     * backfilled at setup from the screens that did run, so this queue is
     * the genuine gap and not everybody.
     *
     * Its own slots, after the other two. A backlog of thousands must not
     * crowd out the checks that are actually due today — it drains at
     * BACKFILL_LIMIT a night until it is empty. */
    let neverScreened = [];
    {
      const { rows } = await pool.query(`
        SELECT ${COLS}
        FROM investors i
        WHERE i.last_sanctions_check IS NULL
          AND COALESCE(i.status, '') <> 'suspended'
          AND COALESCE(i.residency_status, 'resident') <> 'non_resident'
          AND (i.kyc_status IN ('approved','verified') OR i.fica_status = 'approved')
        ORDER BY i.last_auto_fica_check ASC NULLS LAST
        LIMIT $1
      `, [BACKFILL_LIMIT]);
      neverScreened = rows;
    }

    console.log(
      `[FICA Cron] Queued: ${annualDue.length} annual re-checks, ` +
      `${firstInvestment.length} first-investment checks, ` +
      `${neverScreened.length} sanctions backfills.`
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

    /* ── Process first-investment clients ── */
    for (const investor of firstInvestment) {
      try {
        await runFicaCheck(investor, 'first_investment');
        firstInvestmentCount++;
      } catch (err) {
        errorCount++;
        console.error(`[FICA Cron] first_investment error ${investor.id}:`, err.message);
      }
      await _delay(INTER_DELAY);
    }

    /* ── Process the sanctions backfill ──
       The trigger says what this run is for; the policy decides the scope
       and will answer 'sanctions_only' for every client in this queue. */
    for (const investor of neverScreened) {
      try {
        await runFicaCheck(investor, 'sanctions_backfill');
        sanctionsCount++;
      } catch (err) {
        errorCount++;
        console.error(`[FICA Cron] sanctions_backfill error ${investor.id}:`, err.message);
      }
      await _delay(INTER_DELAY);
    }

  } catch (err) {
    console.error('[FICA Cron] Fatal sweep error:', err.message);
  }

  console.log(
    `[FICA Cron] Sweep complete — ` +
    `annual:${annualCount} firstInvestment:${firstInvestmentCount} ` +
    `sanctionsBackfill:${sanctionsCount} errors:${errorCount}`
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
      await pool.query('UPDATE investors SET fica_resubmit_requested_at=NOW() WHERE id=$1', [inv.id]);
      await emailService.sendFicaResubmitReminder(inv);
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
    try {
      await runFicaSweep();
      await runFicaExpiryAlerts();
    } catch (err) {
      console.error('[ficaCron] cron error:', err.message);
    }
  }, {
    timezone: 'Africa/Johannesburg',
    scheduled: true,
  });

  console.log('⏰ FICA re-check cron scheduled: daily at 02:00 SAST (Africa/Johannesburg)');
}

/* COLS is exported for check-nationality.cjs, which lifts each batch's SQL
   out of this file and RUNS it against the real schema — that is how a
   column named here but absent from the database gets caught before a
   deploy costs a night of no FICA checks. Sharing one column list made the
   statements templates, so the check needs the value to interpolate. */
module.exports = { startFicaCron, runFicaSweep, runFicaExpiryAlerts, COLS };
