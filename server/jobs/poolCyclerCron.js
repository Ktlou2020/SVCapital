/* ═══════════════════════════════════════════════════════════
   Pool Cycler Cron
   Runs daily at 00:30 SAST.
   When an investment pool expires it is automatically closed
   and a successor pool is opened according to the product type:

   cattle      → open today, close = last day of the month
                 that is 2 calendar months from today
   short_term  → open = 1st of next month,
                 close = last day of that same next month
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

// Human-readable product name used in auto-generated pool names.
const PRODUCT_LABELS = {
  cattle:     'Cattle Investment',
  short_term: 'Short Term Investment',
};

/* ── Core logic ───────────────────────────────────────────── */

async function cycleExpiredPools() {
  console.log('[poolCycler] scanning for expired pools…');

  // Pools are set to 'matured' at 23:00 by the maturity engine. At 00:01 we open
  // their successors. cycled_at prevents re-opening a successor every night.
  const { rows: expired } = await pool.query(`
    SELECT *
    FROM investment_pools
    WHERE status = 'matured'
      AND end_date <= NOW()
      AND cycled_at IS NULL
      AND product_type IN ('cattle','short_term')
  `);

  if (!expired.length) {
    console.log('[poolCycler] no matured pools awaiting a successor');
    return 0;
  }

  let cycled = 0;

  for (const p of expired) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-check with lock to prevent a race with concurrent runs
      const { rows: [locked] } = await client.query(
        `SELECT id, status, cycled_at FROM investment_pools WHERE id = $1 FOR UPDATE`,
        [p.id]
      );
      if (!locked || locked.status !== 'matured' || locked.cycled_at) {
        await client.query('ROLLBACK');
        continue;
      }

      // Mark the matured pool as cycled (keeps status 'matured'; the maturity
      // engine already set it). This prevents re-opening a successor nightly.
      await client.query(
        `UPDATE investment_pools SET cycled_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [p.id]
      );

      // Calculate successor dates.
      // Open date = day after the previous pool's close (end_date).
      // Close date is calculated relative to the previous pool's end_date.
      const prevClose = new Date(p.end_date);
      const openDate  = new Date(prevClose);
      openDate.setDate(openDate.getDate() + 1);

      let closeDate;
      if (p.product_type === 'cattle') {
        // Close = last day of the month 2 calendar months after the previous close
        const cm = prevClose.getMonth() + 2;
        const cy = prevClose.getFullYear() + Math.floor(cm / 12);
        closeDate = lastDayOfMonth(cy, ((cm % 12) + 12) % 12);
      } else {
        // short_term: close = last day of the month in which the new pool opens
        closeDate = lastDayOfMonth(openDate.getFullYear(), openDate.getMonth());
      }

      // Pool name = "Product name - Month and year of the closing date"
      const closeLabel   = `${MONTH_NAMES[closeDate.getMonth()]} ${closeDate.getFullYear()}`;
      const productLabel = PRODUCT_LABELS[p.product_type] || baseName(p.name);
      const newId   = `${p.id}-CYC-${Date.now()}`;
      const newName = `${productLabel} - ${closeLabel}`;

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

      // Requirement: once a pool "closes" (a newer pool opens for fundraising),
      // the previously-open pool of this product is deployed → status 'active'.
      // Only the newly-opened successor stays 'open'.
      await client.query(
        `UPDATE investment_pools
            SET status = 'active', updated_at = NOW()
          WHERE product_type = $1 AND status = 'open' AND id <> $2`,
        [p.product_type, newId]
      );

      await client.query('COMMIT');
      console.log(`[poolCycler] matured ${p.id} → opened successor ${newId} (${toISO(openDate)} – ${toISO(closeDate)})`);
      cycled++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[poolCycler] failed to cycle pool ${p.id}:`, err.message);
    } finally {
      client.release();
    }
  }

  console.log(`[poolCycler] done — ${cycled} pool(s) cycled`);
  // NB: reinvestment happens at 23:00 in the maturity engine (into the pool
  // closing that month-end), not here — the successor opened here is the NEXT
  // month's fundraising pool.
  return cycled;
}

/* ── Scheduler ────────────────────────────────────────────── */

function startPoolCyclerCron() {
  // Run once immediately so any already-matured pools are cycled on startup
  cycleExpiredPools().catch(err => console.error('[poolCycler] startup run failed:', err.message));

  // Daily at 00:01 SAST — open successor pools + reinvest matured funds.
  cron.schedule('1 0 * * *', async () => {
    await cycleExpiredPools();
  }, {
    timezone: 'Africa/Johannesburg',
  });
  console.log('[poolCycler] scheduled: daily at 00:01 SAST');
}

module.exports = { startPoolCyclerCron, cycleExpiredPools };
