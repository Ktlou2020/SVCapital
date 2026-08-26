/* ═══════════════════════════════════════════════════════════
   Maturity pre-flight — what the maturity engine is about to do.

   The engine fires at 23:00 SAST on an investment's maturity day and moves
   real money without asking anyone. This reports what it will do while there
   is still time to change it.

   One implementation, two front ends: the admin endpoint
   (GET /api/admin/maturity-preflight) and the CLI
   (server/scripts/preflight-maturity.cjs). Keeping the logic here is the point
   — two copies of a money-adjacent check drift, and then they disagree at the
   worst moment.

   READ-ONLY. Every statement is a SELECT.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const STOP = 'STOP', ATTENTION = 'ATTENTION', OK = 'OK';

/* The posted return. investment_pools.actual_rate is the achieved return for
   the pool's PERIOD, for every product — not per annum, not prorated over
   term_months. Same rule as Utils.postedReturn in the portal and as
   maturityCron's postedReturnFor, so all three agree by construction. */
function postedReturn({ amount, actualReturn, poolActualRate }) {
  const ar = Number(actualReturn) || 0;
  if (ar > 0) return ar;
  const rate = Number(poolActualRate) || 0;
  if (rate <= 0) return null;                       // nothing posted yet
  return (Number(amount) || 0) * rate;
}

const num = v => Number(v) || 0;

/* The pool a rollover of `productType` would land in — the exact query
   maturityCron's reinvestAmount runs, floor included. Exported so the
   pre-flight and the product-type remap both answer "where would this go?"
   from one definition rather than two that can drift. */
async function resolveRolloverTarget(db, productType) {
  const { rows: [t] } = await db.query(`
    SELECT id, name, end_date, current_invested, max_investment
      FROM investment_pools
     WHERE status = 'open'
       AND product_type = $1
       AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       AND (max_investment IS NULL OR COALESCE(current_invested,0) < max_investment)
     ORDER BY end_date ASC NULLS LAST, created_at ASC
     LIMIT 1`, [productType]);
  return t || null;
}

/* Which pool an investment's rollover will actually look for.
   The engine matches on product_type and nothing else — maturityCron passes
   inv.product_type (or switch_product_type for a switch) into a query whose
   only predicate is `product_type = $1`. Pool NAMES play no part, so a pool
   called "Cattle Investment - August 2026" does not receive a rollover from
   "Cattle Investment - August 2025" unless their product_type values match.
   That is the trap worth naming out loud: the names imply a succession the
   engine cannot see. */
const targetProductType = m =>
  (['switch_product', 'custom_switch'].includes(m.maturity_instruction)
    ? (m.switch_product_type || m.product_type)
    : m.product_type) || 'general';
/* Round every rand figure that leaves this module. 100000 * 0.07 is
   7000.000000000001 in binary floating point, and a report about money should
   never show that. */
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function runMaturityPreflight(db, { horizonDays = 14 } = {}) {
  const horizon = Math.min(365, Math.max(1, parseInt(horizonDays, 10) || 14));
  const findings = [];
  const add = (level, section, message) => findings.push({ level, section, message });

  const { rows: [meta] } = await db.query(
    `SELECT NOW() AS now, current_setting('TimeZone') AS tz`);

  /* ── What is due to mature ───────────────────────────────────────── */
  const { rows: maturing } = await db.query(`
    SELECT i.id, i.investor_id, i.pool_id, i.pool_name, i.amount, i.end_date,
           i.expected_return, i.actual_return, i.product_type, i.term_months,
           i.maturity_instruction, i.custom_payout_amount, i.switch_product_type,
           i.maturity_alert_sent_at, i.maturity_3day_alert_sent_at,
           p.actual_rate AS pool_actual_rate, p.status AS pool_status, p.name AS pool_real_name,
           inv.email, inv.phone
      FROM investments i
      JOIN investors inv ON inv.id = i.investor_id
      LEFT JOIN investment_pools p ON p.id = i.pool_id
     WHERE i.status = 'active'
       AND i.end_date IS NOT NULL
       AND i.maturity_processed_at IS NULL
       AND i.end_date <= CURRENT_DATE + $1::int
     ORDER BY i.end_date, i.pool_id`, [horizon]);

  const result = {
    generatedAt: new Date().toISOString(),
    serverTime: meta.now,
    timeZone: meta.tz,
    horizonDays: horizon,
    nothingDue: maturing.length === 0,
    totals: { investments: maturing.length, capital: round2(maturing.reduce((s, m) => s + num(m.amount), 0)) },
    pools: [], reinvestTargets: [], stalePools: [], instructions: {},
    blockers: [], notifications: {}, findings, summary: {},
  };

  if (!maturing.length) {
    result.summary = { stops: 0, attentions: 0, verdict: 'nothing-due' };
    return result;
  }

  const overdue = maturing.filter(m => new Date(m.end_date) < new Date(meta.now));
  if (overdue.length) {
    add(ATTENTION, 'maturing',
      `${overdue.length} investment(s) are already past their maturity date and still ` +
      'unprocessed — a previous run did not finish, or their pool has no posted rate.');
  }
  result.totals.overdue = overdue.length;

  /* ── Has the actual return been posted ───────────────────────────── */
  const byPool = new Map();
  for (const m of maturing) {
    const k = m.pool_id || '(no pool)';
    if (!byPool.has(k)) byPool.set(k, []);
    byPool.get(k).push(m);
  }

  for (const [poolId, list] of byPool) {
    const p = list[0];
    const rate = num(p.pool_actual_rate);
    const capital = round2(list.reduce((s, x) => s + num(x.amount), 0));
    const projected = round2(list.reduce((s, x) => s + num(x.expected_return), 0));
    const entry = {
      poolId, poolName: p.pool_real_name || p.pool_name || '', poolStatus: p.pool_status || null,
      productType: p.product_type || null, count: list.length, capital,
      maturesOn: list[0].end_date, actualRate: rate, ratePosted: rate > 0,
      projected, postedTotal: null, difference: null,
    };

    if (!p.pool_id) {
      add(ATTENTION, 'posted-rate',
        `${list.length} investment(s) have no pool attached — no rate can be posted for them.`);
    } else if (rate <= 0) {
      add(STOP, 'posted-rate',
        `${poolId}: no actual rate posted. ${list.length} investment(s) holding ` +
        `${money(capital)} will be HELD BACK and paid nothing until it is entered. ` +
        'Post it on the pool close-out; they settle on the next nightly run.');
    } else {
      entry.postedTotal = round2(list.reduce((s, x) => s + (postedReturn({
        amount: x.amount, actualReturn: x.actual_return, poolActualRate: p.pool_actual_rate }) || 0), 0));
      entry.difference = round2(entry.postedTotal - projected);
      add(OK, 'posted-rate',
        `${poolId}: will pay ${money(entry.postedTotal)} in returns on ${money(capital)} of capital.`);
    }
    result.pools.push(entry);
  }

  /* ── Where reinvested money will go ──────────────────────────────── */
  const willRoll = maturing.filter(m => (m.maturity_instruction || 'reinvest') !== 'payout_all');
  result.totals.rollingOver = willRoll.length;

  /* Cached: a pool's investments almost always share one product type. */
  const targetCache = new Map();
  const resolveTarget = async pt => {
    if (!targetCache.has(pt)) targetCache.set(pt, await resolveRolloverTarget(db, pt));
    return targetCache.get(pt);
  };

  /* Per maturing pool, name the pool its rollovers actually land in. The
     aggregate below answers "how much"; this answers "from here, to where",
     which is the question anyone actually asks of a succession. */
  for (const entry of result.pools) {
    const list = byPool.get(entry.poolId) || [];
    const rolling = list.filter(m => (m.maturity_instruction || 'reinvest') !== 'payout_all');
    entry.rollsInto = [];
    for (const pt of [...new Set(rolling.map(targetProductType))]) {
      const t = await resolveTarget(pt);
      entry.rollsInto.push({
        productType: pt,
        poolId: t ? t.id : null,
        poolName: t ? t.name : null,
        endDate: t ? t.end_date : null,
        toWallet: !t,
        count: rolling.filter(m => targetProductType(m) === pt).length,
      });
    }
    if (entry.rollsInto.some(x => x.toWallet)) {
      const types = entry.rollsInto.filter(x => x.toWallet).map(x => x.productType).join(', ');
      add(ATTENTION, 'reinvest-target',
        `${entry.poolId} "${entry.poolName}": its rollovers look for an open pool of ` +
        `product_type "${types}" and find none, so they become wallet payouts. The engine ` +
        'matches on product_type only — a similarly named pool does not receive them.');
    }
  }

  for (const pt of [...new Set(maturing.map(targetProductType))]) {
    const t = await resolveTarget(pt);

    /* Capital plus the POSTED return, which is what actually moves — not
       expected_return, which the engine no longer pays. On the migrated pools
       expected_return is 0 across the board, so using it understated the
       figure by the entire return: R6.07m reported against R6.65m real. The
       number people size a decision on has to be the number that moves. */
    const incoming = round2(willRoll.filter(m => targetProductType(m) === pt)
      .reduce((s, m) => s + num(m.amount) + (postedReturn({
        amount: m.amount, actualReturn: m.actual_return,
        poolActualRate: m.pool_actual_rate }) || 0), 0));

    if (!t) {
      result.reinvestTargets.push({ productType: pt, poolId: null, incoming });
      add(ATTENTION, 'reinvest-target',
        `${pt}: no open pool is still accepting funds — every rollover becomes a wallet ` +
        `payout instead (about ${money(incoming)}).`);
      continue;
    }
    const room = t.max_investment != null ? round2(num(t.max_investment) - num(t.current_invested)) : null;
    result.reinvestTargets.push({
      productType: pt, poolId: t.id, poolName: t.name, endDate: t.end_date, room, incoming });
    add(OK, 'reinvest-target', `${pt}: rollovers go to ${t.id} "${t.name}", closing ${dateOnly(t.end_date)}.`);
    if (room != null && incoming > room) {
      add(ATTENTION, 'reinvest-target',
        `${pt}: about ${money(incoming)} is heading for a pool with ${money(room)} of room. ` +
        'The excess falls back to wallets.');
    }
  }

  /* ── Pools left open past their close date ───────────────────────── */
  const { rows: stale } = await db.query(`
    SELECT id, name, product_type, status, end_date,
           (CURRENT_DATE - end_date) AS days_closed
      FROM investment_pools
     WHERE status = 'open' AND end_date IS NOT NULL AND end_date < CURRENT_DATE
     ORDER BY end_date`);
  result.stalePools = stale.map(s => ({
    poolId: s.id, name: s.name, productType: s.product_type, endDate: s.end_date,
    daysClosed: Number(s.days_closed), beyondCyclerWindow: Number(s.days_closed) > 60 }));

  if (!stale.length) {
    add(OK, 'stale-pools', 'No pool is sitting open past its close date.');
  } else {
    const stuck = result.stalePools.filter(s => s.beyondCyclerWindow).length;
    add(ATTENTION, 'stale-pools',
      `${stale.length} pool(s) are still "open" past their close date. They no longer capture ` +
      'rollovers, but they show as open in the console' +
      (stuck ? ` and ${stuck} of them are beyond the cycler's 60-day window, so they will never ` +
               'clear themselves. Set them to "active".' : '.'));
  }

  /* ── Maturity instructions ───────────────────────────────────────── */
  const counts = {};
  for (const m of maturing) {
    const k = m.maturity_instruction || 'none';
    counts[k] = (counts[k] || 0) + 1;
  }
  const missing   = maturing.filter(m => !m.maturity_instruction);
  const badCustom = maturing.filter(m =>
    ['payout_custom', 'custom_switch'].includes(m.maturity_instruction) && !(num(m.custom_payout_amount) > 0));
  const badSwitch = maturing.filter(m =>
    ['switch_product', 'custom_switch'].includes(m.maturity_instruction) && !m.switch_product_type);
  result.instructions = { counts, missing: missing.length, badCustom: badCustom.length, badSwitch: badSwitch.length };

  if (missing.length) {
    add(ATTENTION, 'instructions',
      `${missing.length} investor(s) never chose an instruction. Their money is reinvested ` +
      'automatically — right only if that is the agreed default.');
  }
  if (badCustom.length) {
    add(STOP, 'instructions',
      `${badCustom.length} custom-payout instruction(s) have no amount set. The custom portion ` +
      'computes to zero, so the whole balance rolls over instead of paying out.');
  }
  if (badSwitch.length) {
    add(ATTENTION, 'instructions',
      `${badSwitch.length} switch instruction(s) name no target product — they fall back to the same product.`);
  }

  /* ── Anything blocking the pool status flip ──────────────────────── */
  for (const [poolId] of byPool) {
    if (poolId === '(no pool)') continue;
    const { rows: blockers } = await db.query(`
      SELECT status, COUNT(*)::int n
        FROM investments
       /* COALESCE, because NULL <> 'active' is NULL, not true. An investment
          with no status still blocks the pool flip — the engine's NOT EXISTS
          counts every unprocessed row regardless of status — so missing it
          here would hide the very thing this check is for. */
       WHERE pool_id = $1 AND maturity_processed_at IS NULL AND COALESCE(status, '') <> 'active'
       GROUP BY status`, [poolId]);
    if (blockers.length) {
      const detail = blockers.map(b => `${b.n} ${b.status}`).join(', ');
      result.blockers.push({ poolId, detail });
      add(ATTENTION, 'pool-flip',
        `${poolId}: ${detail} investment(s) are unprocessed and are not picked up by the run, ` +
        'so the pool will not flip to "matured" and no summary is stored.');
    }
    const { rows: [ps] } = await db.query(`SELECT status FROM investment_pools WHERE id = $1`, [poolId]);
    if (ps && !['open', 'filling', 'active', 'waitlist'].includes(ps.status)) {
      add(ATTENTION, 'pool-flip',
        `${poolId}: pool status is already "${ps.status}". The engine only flips pools in ` +
        'open/filling/active/waitlist, so the maturity summary will not be stored.');
    }
  }

  /* ── Can investors be told ───────────────────────────────────────── */
  const noEmail = maturing.filter(m => !m.email).length;
  const noPhone = maturing.filter(m => !m.phone).length;
  const noAlert = maturing.filter(m => !m.maturity_alert_sent_at && !m.maturity_3day_alert_sent_at).length;
  result.notifications = { noEmail, noPhone, noAlert };
  if (noEmail) add(ATTENTION, 'notifications', `${noEmail} investor(s) have no email address.`);
  if (noAlert) {
    add(ATTENTION, 'notifications',
      `${noAlert} investment(s) have had no advance maturity alert — they will learn at payout.`);
  } else {
    add(OK, 'notifications', 'Every maturing investment has had an advance alert.');
  }

  const stops = findings.filter(f => f.level === STOP).length;
  const attentions = findings.filter(f => f.level === ATTENTION).length;
  result.summary = {
    stops, attentions,
    verdict: stops ? 'blocked' : attentions ? 'review' : 'clear',
  };
  return result;
}

function money(n) {
  return 'R' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dateOnly(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : '—';
}

module.exports = {
  runMaturityPreflight, postedReturn, resolveRolloverTarget, targetProductType,
  LEVELS: { STOP, ATTENTION, OK },
};
