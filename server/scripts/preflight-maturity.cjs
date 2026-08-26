#!/usr/bin/env node
/* Pre-flight for a month-end maturity run.
 *
 * The maturity engine fires at 23:00 SAST on an investment's maturity day and
 * moves real money without asking anyone. This reports what it is about to do,
 * while there is still time to change it.
 *
 * Each check prints OK, ATTENTION or STOP. STOP means money will move to the
 * wrong place or in the wrong amount if the run happens tonight.
 *
 * READ-ONLY. Every statement is a SELECT.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/preflight-maturity.cjs
 *   …optionally with a horizon in days (default 14):
 *   DATABASE_URL=… node server/scripts/preflight-maturity.cjs 21
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const { Pool } = require('pg');

const HORIZON = Math.max(1, parseInt(process.argv[2], 10) || 14);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const rand = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = r => (Number(r || 0) * 100).toFixed(2) + '%';
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');

let stops = 0, attentions = 0;
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);
const verdict = (level, line) => {
  if (level === 'STOP') stops++;
  if (level === 'ATTENTION') attentions++;
  console.log(`  ${level.padEnd(9)} ${line}`);
};

/* The posted return, by the convention the platform actually uses.
   server/routes/products.js:236: short_term actual_rate is the TOTAL PERIOD
   return; every other product's is PER ANNUM and prorates over the term. */
function postedReturn({ amount, actualReturn, poolActualRate, productType, termMonths }) {
  const amt = Number(amount) || 0;
  const ar  = Number(actualReturn) || 0;
  if (ar > 0) return ar;
  const rate = Number(poolActualRate) || 0;
  if (rate <= 0) return null;                       // nothing posted yet
  const term = Number(termMonths) || 12;
  return productType === 'short_term' ? amt * rate : amt * rate * (term / 12);
}

(async () => {
  try {
    const { rows: [{ now, tz }] } = await pool.query(
      `SELECT NOW() AS now, current_setting('TimeZone') AS tz`);
    console.log(`\nMaturity pre-flight — database time ${new Date(now).toISOString()} (server TZ ${tz})`);
    console.log(`Horizon: investments maturing in the next ${HORIZON} day(s).`);
    console.log('The engine runs at 23:00 Africa/Johannesburg on each maturity day.');

    /* ── 1. What is maturing ─────────────────────────────────────────── */
    const { rows: maturing } = await pool.query(`
      SELECT i.id, i.investor_id, i.pool_id, i.pool_name, i.amount, i.end_date,
             i.expected_return, i.actual_return, i.product_type, i.term_months,
             i.maturity_instruction, i.status, i.maturity_processed_at,
             i.maturity_alert_sent_at, i.maturity_3day_alert_sent_at,
             i.custom_payout_amount, i.switch_product_type,
             p.actual_rate AS pool_actual_rate, p.status AS pool_status,
             p.name AS pool_real_name,
             inv.email, inv.phone, inv.first_name, inv.last_name
        FROM investments i
        JOIN investors inv ON inv.id = i.investor_id
        LEFT JOIN investment_pools p ON p.id = i.pool_id
       WHERE i.status = 'active'
         AND i.end_date IS NOT NULL
         AND i.maturity_processed_at IS NULL
         AND i.end_date <= CURRENT_DATE + $1::int
       ORDER BY i.end_date, i.pool_id`, [HORIZON]);

    H('1. What is due to mature');
    if (!maturing.length) {
      console.log(`  Nothing matures in the next ${HORIZON} days. The rest of this report is moot.`);
      await pool.end();
      return;
    }

    const byPool = new Map();
    for (const m of maturing) {
      const k = m.pool_id || '(no pool)';
      if (!byPool.has(k)) byPool.set(k, []);
      byPool.get(k).push(m);
    }
    for (const [poolId, list] of byPool) {
      const p = list[0];
      const capital = list.reduce((s, x) => s + Number(x.amount), 0);
      console.log(`  ${poolId}  ${p.pool_real_name || p.pool_name || ''}`);
      console.log(`     ${list.length} investment(s), capital ${rand(capital)}, ` +
                  `maturing ${day(list[0].end_date)}, pool status "${p.pool_status || '?'}"`);
    }
    const overdue = maturing.filter(m => new Date(m.end_date) < new Date(now));
    if (overdue.length) {
      verdict('ATTENTION', `${overdue.length} investment(s) are already past their maturity date and ` +
        'still unprocessed — a previous run did not complete. Check the logs before tonight.');
    }

    /* ── 2. Has the actual rate been posted ──────────────────────────── */
    H('2. Has the actual return been posted');
    console.log('  Returns are posted on the pool as actual_rate (the close-out wizard).');
    for (const [poolId, list] of byPool) {
      const p = list[0];
      const rate = Number(p.pool_actual_rate) || 0;
      const capital = list.reduce((s, x) => s + Number(x.amount), 0);
      const projected = list.reduce((s, x) => s + (Number(x.expected_return) || 0), 0);

      if (!p.pool_id) { verdict('ATTENTION', 'investments with no pool attached — cannot check a posted rate'); continue; }
      if (rate <= 0) {
        verdict('STOP', `${poolId}: no actual_rate posted. The engine will pay the PROJECTED ` +
          `${rand(projected)} on ${rand(capital)} of capital.`);
        continue;
      }
      const posted = list.reduce((s, x) => s + (postedReturn({
        amount: x.amount, actualReturn: x.actual_return, poolActualRate: p.pool_actual_rate,
        productType: x.product_type, termMonths: x.term_months }) || 0), 0);
      const basis = p.product_type === 'short_term' ? 'period' : 'p.a., prorated over the term';
      console.log(`  ${poolId}: actual_rate ${pct(rate)} (${basis})`);
      console.log(`     posted return ${rand(posted)}  ·  projected ${rand(projected)}  ` +
                  `·  difference ${rand(posted - projected)}`);
      verdict('STOP',
        `${poolId}: the engine pays expected_return and never reads actual_rate, so it will ` +
        `pay ${rand(projected)}, not the posted ${rand(posted)} (see maturityCron.js:79).`);
    }

    /* ── 3. Where reinvested money will actually go ──────────────────── */
    H('3. Where reinvested money will go');
    const productTypes = [...new Set(maturing.map(m => m.product_type).filter(Boolean))];
    const willReinvest = maturing.filter(m =>
      !['payout_all'].includes(m.maturity_instruction || 'reinvest'));
    console.log(`  ${willReinvest.length} of ${maturing.length} investment(s) will roll over in whole or part.`);

    for (const ptRaw of productTypes) {
      const pt = ptRaw || 'general';
      // The exact query the engine uses to pick a target.
      const { rows: targets } = await pool.query(`
        SELECT id, name, status, end_date, current_invested, max_investment
          FROM investment_pools
         WHERE status = 'open'
           AND product_type = $1
           AND (max_investment IS NULL OR COALESCE(current_invested,0) < max_investment)
         ORDER BY end_date ASC NULLS LAST, created_at ASC
         LIMIT 1`, [pt]);
      const t = targets[0];
      if (!t) {
        verdict('ATTENTION', `${pt}: no open pool — every rollover becomes a wallet payout instead.`);
        continue;
      }
      const stale = t.end_date && new Date(t.end_date) < new Date(now);
      console.log(`  ${pt} → ${t.id} "${t.name}"  closes ${day(t.end_date)}`);
      if (stale) {
        verdict('STOP', `${pt}: the winning target closed on ${day(t.end_date)} and is still "open". ` +
          'Reinvestments will land in a pool that is finished.');
      } else {
        verdict('OK', `${pt}: target pool is open and still current.`);
      }
      if (t.max_investment != null) {
        const room = Number(t.max_investment) - Number(t.current_invested || 0);
        const incoming = willReinvest
          .filter(m => (m.product_type || 'general') === pt)
          .reduce((s, m) => s + Number(m.amount) + (Number(m.expected_return) || 0), 0);
        if (incoming > room) {
          verdict('ATTENTION', `${pt}: about ${rand(incoming)} is heading for a pool with ` +
            `${rand(room)} of room. The excess falls back to wallets.`);
        }
      }
    }

    /* ── 4. Stale pools stuck open ───────────────────────────────────── */
    H('4. Pools left open past their close date');
    const { rows: stalePools } = await pool.query(`
      SELECT id, name, product_type, status, end_date, cycled_at
        FROM investment_pools
       WHERE status = 'open' AND end_date IS NOT NULL AND end_date < CURRENT_DATE
       ORDER BY end_date`);
    if (!stalePools.length) {
      verdict('OK', 'no pool is sitting open past its close date.');
    } else {
      console.log('  A stale open pool WINS the reinvest target query, because that query has no');
      console.log('  end_date filter and orders by end_date ASC — the more stale, the more it wins.');
      for (const s of stalePools) {
        const orphaned = s.end_date && (new Date(now) - new Date(s.end_date)) / 86400000 > 60;
        console.log(`  ${s.id}  ${s.name}  (${s.product_type})  closed ${day(s.end_date)}` +
                    (orphaned ? '  — beyond the cycler\'s 60-day window, it will never self-clear' : ''));
      }
      verdict('STOP', `${stalePools.length} pool(s) open past their close date. ` +
        'Set them to "active" before the run.');
    }

    /* ── 5. Maturity instructions ────────────────────────────────────── */
    H('5. Maturity instructions');
    const noInstruction = maturing.filter(m => !m.maturity_instruction);
    const custom = maturing.filter(m =>
      ['payout_custom', 'custom_switch'].includes(m.maturity_instruction));
    const counts = {};
    for (const m of maturing) {
      const k = m.maturity_instruction || '(none — defaults to reinvest)';
      counts[k] = (counts[k] || 0) + 1;
    }
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
    if (noInstruction.length) {
      verdict('ATTENTION', `${noInstruction.length} investor(s) never chose. Their money is ` +
        'reinvested automatically — correct only if that is the agreed default.');
    }
    const badCustom = custom.filter(m => !(Number(m.custom_payout_amount) > 0));
    if (badCustom.length) {
      verdict('STOP', `${badCustom.length} custom-payout instruction(s) have no amount set — ` +
        'the custom portion computes to zero and the whole balance rolls over.');
    }
    const badSwitch = maturing.filter(m =>
      ['switch_product', 'custom_switch'].includes(m.maturity_instruction) && !m.switch_product_type);
    if (badSwitch.length) {
      verdict('ATTENTION', `${badSwitch.length} switch instruction(s) name no target product — ` +
        'they fall back to the same product.');
    }

    /* ── 6. What blocks the pool from closing cleanly ────────────────── */
    H('6. Anything blocking the pool status flip');
    for (const [poolId] of byPool) {
      if (poolId === '(no pool)') continue;
      const { rows: blockers } = await pool.query(`
        SELECT status, COUNT(*)::int n
          FROM investments
         WHERE pool_id = $1 AND maturity_processed_at IS NULL
         GROUP BY status`, [poolId]);
      const nonActive = blockers.filter(b => b.status !== 'active');
      if (nonActive.length) {
        const detail = nonActive.map(b => `${b.n} ${b.status}`).join(', ');
        verdict('ATTENTION', `${poolId}: ${detail} investment(s) are unprocessed and are not ` +
          'picked up by the run. The pool will not flip to "matured" and no summary is stored.');
      }
      const { rows: [pstat] } = await pool.query(
        `SELECT status FROM investment_pools WHERE id = $1`, [poolId]);
      if (pstat && !['open', 'filling', 'active', 'waitlist'].includes(pstat.status)) {
        verdict('ATTENTION', `${poolId}: pool status is already "${pstat.status}". The engine only ` +
          'flips pools in open/filling/active/waitlist, so the maturity summary will not be stored.');
      }
    }

    /* ── 7. Can investors be told ────────────────────────────────────── */
    H('7. Notifications');
    const noEmail = maturing.filter(m => !m.email);
    const noPhone = maturing.filter(m => !m.phone);
    const noAlert = maturing.filter(m => !m.maturity_alert_sent_at && !m.maturity_3day_alert_sent_at);
    if (noEmail.length) verdict('ATTENTION', `${noEmail.length} investor(s) have no email address.`);
    if (noPhone.length) console.log(`  ${noPhone.length} investor(s) have no phone number (SMS skipped).`);
    if (noAlert.length) {
      verdict('ATTENTION', `${noAlert.length} investment(s) have had no advance maturity alert. ` +
        'They will learn at payout.');
    } else {
      verdict('OK', 'every maturing investment has had an advance alert.');
    }
    if (!process.env.RESEND_API_KEY) {
      console.log('  (RESEND_API_KEY is not set in THIS shell — that says nothing about the server.)');
    }

    /* ── Summary ─────────────────────────────────────────────────────── */
    H('Verdict');
    if (stops) {
      console.log(`  ${stops} STOP(s) and ${attentions} ATTENTION(s).`);
      console.log('  Money will move to the wrong place or in the wrong amount if the run');
      console.log('  happens as things stand.');
    } else if (attentions) {
      console.log(`  No blockers, ${attentions} thing(s) worth a look before tonight.`);
    } else {
      console.log('  Everything this script can check is in place.');
    }
    console.log('');
  } catch (err) {
    console.error('\npre-flight failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
