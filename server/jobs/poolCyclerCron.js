/* ═══════════════════════════════════════════════════════════
   Pool Cycler Cron
   Runs daily at 00:01 SAST (Africa/Johannesburg).

   The trigger is the pool's INVESTMENT START DATE — the day the
   money starts working. On that day, at 00:01, two things happen
   together, in one transaction:

     · the pool stops raising:  status 'open' → 'active'
     · its successor opens for the next round of fundraising

   Not the close date. Close is the last day money can come IN;
   the day after that (or whatever date an admin set in the
   console's "Investment Start Date (auto)" field) is when the
   pool is deployed. Those are usually one day apart, which is
   why triggering on the close date looked right for years — but
   only the auto value made them agree, and an admin who moved
   the investment start date was quietly ignored.

   Successor dates, by product type:

   cattle      → open on the investment start date,
                 close = last day of the month that is
                 2 calendar months after the previous close
   short_term  → open on the investment start date,
                 close = last day of the month it opens in

   In both cases the successor's own investment start date is
   set to its close date + 1, which is the same rule the admin
   console auto-fills — so the chain keeps cycling on its own.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');

/* The trigger date, as SQL. A pool without an explicit investment start date
   falls back to the day after it closes, which is exactly what
   _autoCalcInvStartDate fills into the console form — so a pool created before
   the column existed behaves as it always has.

   Exported because the maturity pre-flight reports which pools are due to
   cycle tonight, and a second copy of this expression is a second definition
   waiting to drift from this one. Unqualified: every query using it has
   investment_pools as its only table. */
const INVESTMENT_START = `COALESCE(investment_start_date, end_date + 1)`;

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
  console.log('[poolCycler] scanning for pools reaching their investment start date…');

  /* Trigger on the investment start date arriving, regardless of maturity
     status. cycled_at prevents re-opening a successor every night. Pools
     already closed or already cycled are excluded.

     end_date is still required: the successor's close date is derived from it,
     and a pool that has never had a close date has never been part of this
     succession. The 60-day window is measured on the same date as the trigger,
     so a pool cannot be picked up by one and rejected by the other. */
  const { rows: expired } = await pool.query(`
    SELECT *, ${INVESTMENT_START} AS effective_investment_start
    FROM investment_pools
    WHERE end_date IS NOT NULL
      AND ${INVESTMENT_START} <= CURRENT_DATE
      AND ${INVESTMENT_START} >= CURRENT_DATE - INTERVAL '60 days'
      AND cycled_at IS NULL
      AND product_type IN ('cattle','short_term')
      AND status NOT IN ('closed')
  `);

  if (!expired.length) {
    console.log('[poolCycler] no pools have reached their investment start date');
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
      if (!locked || locked.cycled_at) {
        await client.query('ROLLBACK');
        continue;
      }

      /* The pool stops raising. Investments are locked in and start working
         today; payout happens at maturity_date via maturityCron.

         'active', not 'closed' — closed is the end of the pool's life, after
         maturity. This is the middle of it. */
      await client.query(
        `UPDATE investment_pools
            SET cycled_at = NOW(), updated_at = NOW(),
                status = CASE WHEN status = 'open' THEN 'active' ELSE status END
          WHERE id = $1`,
        [p.id]
      );

      /* Successor dates.

         Open date = the day this pool's money started working. Fundraising for
         the next round begins the moment it ends for this one, which is the
         whole point of doing both in one transaction: there is never an hour
         in which no pool of this product type is taking money. */
      const prevClose = new Date(p.end_date);
      const openDate  = new Date(p.effective_investment_start || (() => {
        const d = new Date(prevClose); d.setDate(d.getDate() + 1); return d;
      })());

      /* Close date stays anchored to the previous close, not to the open date.
         It is a commercial term — a cattle round raises across two whole
         months — and an admin moving the investment start date by a week is
         saying when the money is deployed, not asking for a longer round. */
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

      /* An investment start date set far enough past the close date can put
         the successor's close before its open — a pool that shut before it
         opened, invisible to every query that looks for one still raising.
         Push it out by whole months until it is a real window. */
      let guard = 0;
      while (closeDate <= openDate && guard++ < 24) {
        closeDate = lastDayOfMonth(closeDate.getFullYear(), closeDate.getMonth() + 1);
      }

      /* The successor's own trigger, by the same rule the console auto-fills:
         the day after it closes. Stored rather than left to the fallback so
         the date an investor is shown is the date the cron will act on. */
      const invStartDate = new Date(closeDate);
      invStartDate.setDate(invStartDate.getDate() + 1);

      // Pool name = "Product name - Month and year of the closing date"
      const closeLabel   = `${MONTH_NAMES[closeDate.getMonth()]} ${closeDate.getFullYear()}`;
      const productLabel = PRODUCT_LABELS[p.product_type] || baseName(p.name);
      const newId   = `${p.id}-CYC-${Date.now()}`;
      const newName = `${productLabel} - ${closeLabel}`;

      // Maturity date = closeDate + term_months (same convention as the original pool)
      const maturityDate = new Date(closeDate);
      maturityDate.setMonth(maturityDate.getMonth() + (p.term_months || 1));

      await client.query(
        `INSERT INTO investment_pools
           (id, name, product_type, status,
            target_amount, raised_amount, current_invested,
            min_investment, max_investment,
            annual_rate, actual_rate, term_months,
            start_date, end_date, investment_start_date, maturity_date, description,
            risk_level, partner_name,
            management_fee_pct, management_fee_frequency,
            operational_fee_pct, operational_fee_frequency,
            investor_count, created_at, updated_at)
         VALUES
           ($1,$2,$3,'open',
            $4,0,0,
            $5,$6,
            $7,$8,$9,
            $10,$11,$12,$13,$14,
            $15,$16,
            $17,$18,
            $19,$20,
            0,NOW(),NOW())`,
        [
          newId, newName, p.product_type,
          p.target_amount  || 0,
          p.min_investment || 1000, p.max_investment || null,
          p.annual_rate    || 0, p.actual_rate || 0, p.term_months || 6,
          toISO(openDate), toISO(closeDate), toISO(invStartDate), toISO(maturityDate),
          p.description    || null,
          p.risk_level     || 'medium', p.partner_name || null,
          p.management_fee_pct       || 0, p.management_fee_frequency       || 'once',
          p.operational_fee_pct      || 0, p.operational_fee_frequency      || 'annual',
        ]
      );

      /* Once a pool closes, the PREVIOUS fundraising pool of this product is
         deployed → status 'active'. Only the newly-opened successor stays
         'open'.

         "Previous" means one that has reached its own investment start date.
         Without that qualification this closed every open pool of the product
         type, and a pool still inside its fundraising window is not previous
         to anything — it is the one currently taking money, and the one
         maturing investments are about to roll into.

         That is not hypothetical. Cycling a pool that closed a fortnight ago
         would, at 23:00 and before any payout ran, close the current
         month-end pool and leave a freshly minted successor as the only open
         one. R3.9m of cattle rollovers would have landed in a pool nobody
         chose, on a different close date and term.

         A NULL end_date is left alone deliberately: it has not demonstrably
         ended, so closing it would be a guess. It sorts last in the rollover
         target query anyway (`end_date ASC NULLS LAST`), so it only wins when
         nothing dated qualifies. */
      await client.query(
        `UPDATE investment_pools
            SET status = 'active', updated_at = NOW()
          WHERE product_type = $1
            AND status = 'open'
            AND id <> $2
            AND end_date IS NOT NULL
            AND ${INVESTMENT_START} <= CURRENT_DATE`,
        [p.product_type, newId]
      );

      await client.query('COMMIT');
      console.log(`[poolCycler] ${p.id} reached its investment start date (${toISO(openDate)}) — ` +
                  `deployed, and opened successor ${newId} (raises ${toISO(openDate)} – ${toISO(closeDate)}, ` +
                  `deploys ${toISO(invStartDate)}, matures ${toISO(maturityDate)})`);
      cycled++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[poolCycler] failed to cycle pool ${p.id}:`, err.message);
    } finally {
      client.release();
    }
  }

  console.log(`[poolCycler] done — ${cycled} pool(s) deployed, ${cycled} successor(s) opened`);
  // NB: reinvestment happens at 23:00 in the maturity engine (into the pool
  // closing that month-end), not here — the successor opened here is the NEXT
  // month's fundraising pool.
  return cycled;
}

/* ── Scheduler ────────────────────────────────────────────── */

function startPoolCyclerCron() {
  // Run once immediately so anything missed while the server was down is caught
  cycleExpiredPools().catch(err => console.error('[poolCycler] startup run failed:', err.message));

  /* 00:01 SAST daily. The time is the requirement, not an implementation
     detail: a pool is deployed on its investment start date, at one minute
     past midnight local time, and its successor opens in the same
     transaction. node-cron is given the timezone explicitly so this does not
     drift onto the server's UTC midnight — two hours early, on the wrong day. */
  cron.schedule('1 0 * * *', async () => {
    try {
      await cycleExpiredPools();
    } catch (err) {
      console.error('[poolCycler] cron error:', err.message);
    }
  }, {
    timezone: 'Africa/Johannesburg',
  });
  console.log('[poolCycler] scheduled: daily at 00:01 SAST — deploy pools reaching their investment start date, open successors');
}

module.exports = {
  startPoolCyclerCron, cycleExpiredPools, INVESTMENT_START,
};
