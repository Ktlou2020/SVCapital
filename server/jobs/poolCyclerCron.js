/* ═══════════════════════════════════════════════════════════
   Pool Cycler Cron
   Runs daily at 00:30 SAST.
   When an investment pool expires it is automatically closed
   and a successor pool is opened according to the product type:

   cattle      → open today, close = last day of the month
                 that is 2 calendar months from today
   short_term  → open = 1st of next month,
   smme           close = last day of that same next month
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');

/* ── Date helpers ─────────────────────────────────────────── */

function lastDayOfMonth(year, month) {
  // month is 0-based (JS Date convention)
  return new Date(year, month + 1, 0);
}

function firstDayOfMonth(year, month) {
  return new Date(year, month, 1);
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

// Strip any trailing "(Month YYYY)" suffix so successive cycles don't stack up
function baseName(name) {
  return (name || '').replace(/\s*\(\w+ \d{4}\)\s*$/, '').trim();
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

/* ── Core logic ───────────────────────────────────────────── */

async function cycleExpiredPools() {
  console.log('[poolCycler] scanning for expired pools…');

  const { rows: expired } = await pool.query(`
    SELECT *
    FROM investment_pools
    WHERE end_date < CURRENT_DATE
      AND status IN ('open','filling','active','waitlist')
      AND product_type IN ('cattle','short_term','smme')
  `);

  if (!expired.length) {
    console.log('[poolCycler] no expired pools to cycle');
    return 0;
  }

  let cycled = 0;
  const today = new Date();

  for (const p of expired) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-check status with lock to prevent race with concurrent runs
      const { rows: [locked] } = await client.query(
        `SELECT id, status FROM investment_pools WHERE id = $1 FOR UPDATE`,
        [p.id]
      );
      if (!locked || !['open','filling','active','waitlist'].includes(locked.status)) {
        await client.query('ROLLBACK');
        continue;
      }

      // Close the expired pool
      await client.query(
        `UPDATE investment_pools SET status = 'closed', updated_at = NOW() WHERE id = $1`,
        [p.id]
      );

      // Calculate successor dates
      let openDate, closeDate;

      if (p.product_type === 'cattle') {
        // Open today, close last day of month 2 months from now
        const closeMonth = today.getMonth() + 2;  // may exceed 11 — Date handles rollover
        const closeYear  = today.getFullYear() + Math.floor(closeMonth / 12);
        closeDate = lastDayOfMonth(closeYear, ((closeMonth % 12) + 12) % 12);
        openDate  = today;
      } else {
        // short_term / smme: open 1st of next month, close last day of next month
        const nextMonth = today.getMonth() + 1;
        const nextYear  = today.getFullYear() + (nextMonth > 11 ? 1 : 0);
        const nm        = nextMonth % 12;
        openDate  = firstDayOfMonth(nextYear, nm);
        closeDate = lastDayOfMonth(nextYear, nm);
      }

      const closeLabel = `${MONTH_NAMES[closeDate.getMonth()]} ${closeDate.getFullYear()}`;
      const newId   = `${p.id}-CYC-${Date.now()}`;
      const newName = `${baseName(p.name)} (${closeLabel})`;

      await client.query(
        `INSERT INTO investment_pools
           (id, name, product_type, status,
            target_amount, raised_amount, current_invested,
            min_investment, max_investment,
            annual_rate, actual_rate, term_months,
            start_date, end_date, description,
            risk_level, partner_name,
            management_fee_pct, management_fee_frequency,
            operational_fee_pct, operational_fee_frequency,
            investor_count, created_at, updated_at)
         VALUES
           ($1,$2,$3,'open',
            $4,0,0,
            $5,$6,
            $7,$8,$9,
            $10,$11,$12,
            $13,$14,
            $15,$16,
            $17,$18,
            0,NOW(),NOW())`,
        [
          newId, newName, p.product_type,
          p.target_amount  || 0,
          p.min_investment || 1000, p.max_investment || null,
          p.annual_rate    || 0, p.actual_rate || 0, p.term_months || 6,
          toISO(openDate), toISO(closeDate), p.description || null,
          p.risk_level     || 'medium', p.partner_name || null,
          p.management_fee_pct       || 0, p.management_fee_frequency       || 'once',
          p.operational_fee_pct      || 0, p.operational_fee_frequency      || 'annual',
        ]
      );

      await client.query('COMMIT');
      console.log(`[poolCycler] closed ${p.id} → opened successor ${newId} (${toISO(openDate)} – ${toISO(closeDate)})`);
      cycled++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[poolCycler] failed to cycle pool ${p.id}:`, err.message);
    } finally {
      client.release();
    }
  }

  console.log(`[poolCycler] done — ${cycled} pool(s) cycled`);
  return cycled;
}

/* ── Scheduler ────────────────────────────────────────────── */

function startPoolCyclerCron() {
  // Run once immediately so any already-expired pools are cycled on startup
  cycleExpiredPools().catch(err => console.error('[poolCycler] startup run failed:', err.message));

  // Then daily at 00:30 SAST (Africa/Johannesburg = UTC+2, so 22:30 UTC previous day)
  cron.schedule('30 22 * * *', async () => {
    await cycleExpiredPools();
  }, {
    timezone: 'UTC',
  });
  console.log('[poolCycler] scheduled: daily at 00:30 SAST (22:30 UTC)');
}

module.exports = { startPoolCyclerCron, cycleExpiredPools };
