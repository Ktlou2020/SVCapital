/* ═══════════════════════════════════════════════════════════
   Signup Friction Analytics — /api/analytics/*
   POST /signup-friction          — public, receives batched events
   GET  /signup-friction/summary  — admin only, returns aggregated stats
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const ALLOWED_TYPES = new Set([
  'step_view', 'step_advance', 'step_back', 'validation_error', 'field_error',
  'fica_upload', 'submit_attempt', 'submit_success', 'submit_error',
  'skip_fica', 'page_abandon',
]);

/* ── POST /api/analytics/signup-friction ─────────────────── */
router.post('/signup-friction', async (req, res) => {
  try {
    const { events } = req.body || {};
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }

    const toInsert = events.slice(0, 50).filter(e => {
      if (!e || typeof e !== 'object') return false;
      if (!e.session_id || !/^[a-z0-9]{6,64}$/i.test(String(e.session_id))) return false;
      if (!ALLOWED_TYPES.has(e.event_type)) return false;
      return true;
    });

    if (toInsert.length === 0) return res.json({ ok: true, inserted: 0 });

    const placeholders = toInsert.map((_, i) => {
      const b = i * 8;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},NOW())`;
    }).join(',');

    const params = [];
    toInsert.forEach(e => {
      params.push(
        String(e.session_id).slice(0, 64),
        String(e.event_type),
        e.step != null ? (parseInt(e.step, 10) || null) : null,
        e.field_name ? String(e.field_name).slice(0, 100) : null,
        e.error_message ? String(e.error_message).slice(0, 300) : null,
        e.time_on_step_ms != null ? (parseInt(e.time_on_step_ms, 10) || null) : null,
        e.device_type ? String(e.device_type).slice(0, 20) : null,
        e.client_type ? String(e.client_type).slice(0, 10) : null,
      );
    });

    await pool.query(
      `INSERT INTO signup_friction_events
         (session_id, event_type, step, field_name, error_message,
          time_on_step_ms, device_type, client_type, created_at)
       VALUES ${placeholders}`,
      params,
    );

    res.json({ ok: true, inserted: toInsert.length });
  } catch (err) {
    console.error('[friction] insert error:', err.message);
    res.status(500).json({ error: 'Failed to record events' });
  }
});

/* ── GET /api/analytics/signup-friction/summary ─────────── */
router.get('/signup-friction/summary', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);

    const [funnelRows, errRows, fieldRows, timeRows, deviceRows, clientRows, trendRows] =
      await Promise.all([
        pool.query(`
          SELECT step, COUNT(DISTINCT session_id) AS sessions
          FROM signup_friction_events
          WHERE event_type = 'step_view' AND step IS NOT NULL
            AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY step ORDER BY step
        `, [days]),

        pool.query(`
          SELECT step, error_message, COUNT(*) AS cnt
          FROM signup_friction_events
          WHERE event_type = 'validation_error' AND error_message IS NOT NULL
            AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY step, error_message
          ORDER BY cnt DESC
          LIMIT 12
        `, [days]),

        pool.query(`
          SELECT field_name, step, COUNT(*) AS cnt
          FROM signup_friction_events
          WHERE event_type IN ('validation_error','field_error') AND field_name IS NOT NULL
            AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY field_name, step
          ORDER BY cnt DESC
          LIMIT 10
        `, [days]),

        pool.query(`
          SELECT step,
                 ROUND(AVG(time_on_step_ms)) AS avg_ms,
                 COUNT(*) AS cnt
          FROM signup_friction_events
          WHERE event_type = 'step_advance'
            AND time_on_step_ms IS NOT NULL AND time_on_step_ms > 500
            AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY step ORDER BY step
        `, [days]),

        pool.query(`
          SELECT device_type, COUNT(DISTINCT session_id) AS cnt
          FROM signup_friction_events
          WHERE device_type IS NOT NULL
            AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY device_type ORDER BY cnt DESC
        `, [days]),

        pool.query(`
          SELECT client_type, COUNT(DISTINCT session_id) AS cnt
          FROM signup_friction_events
          WHERE client_type IS NOT NULL AND event_type = 'step_advance' AND step = 1
            AND created_at >= NOW() - ($1 || ' days')::INTERVAL
          GROUP BY client_type ORDER BY cnt DESC
        `, [days]),

        pool.query(`
          SELECT DATE(created_at) AS day, COUNT(DISTINCT session_id) AS completions
          FROM signup_friction_events
          WHERE event_type = 'submit_success'
            AND created_at >= NOW() - INTERVAL '14 days'
          GROUP BY day ORDER BY day
        `),
      ]);

    const byStep = {};
    funnelRows.rows.forEach(r => { byStep[r.step] = parseInt(r.sessions); });
    const totalSessions = Math.max(...Object.values(byStep), 0) || 0;
    const completions   = byStep[4] || 0;

    res.json({
      days,
      total_sessions:    totalSessions,
      completion_rate:   totalSessions > 0 ? parseFloat((completions / totalSessions).toFixed(3)) : 0,
      step_funnel:       funnelRows.rows.map(r => ({ step: parseInt(r.step), sessions: parseInt(r.sessions) })),
      top_errors:        errRows.rows.map(r => ({ step: r.step, error_message: r.error_message, count: parseInt(r.cnt) })),
      top_error_fields:  fieldRows.rows.map(r => ({ field_name: r.field_name, step: r.step, count: parseInt(r.cnt) })),
      avg_time_per_step: timeRows.rows.map(r => ({ step: parseInt(r.step), avg_ms: parseInt(r.avg_ms), count: parseInt(r.cnt) })),
      device_breakdown:  deviceRows.rows.map(r => ({ device_type: r.device_type, count: parseInt(r.cnt) })),
      client_type_breakdown: clientRows.rows.map(r => ({ client_type: r.client_type, count: parseInt(r.cnt) })),
      daily_completions: trendRows.rows.map(r => ({ day: r.day, completions: parseInt(r.completions) })),
    });
  } catch (err) {
    console.error('[friction] summary error:', err.message);
    res.status(500).json({ error: 'Failed to load friction summary' });
  }
});

/* ────────────────────────────────────────────────────────
   GET /api/analytics/personas
   Aggregates investor_profile JSONB survey answers into
   persona archetypes and distribution charts for the admin.
   ──────────────────────────────────────────────────────── */
router.get('/personas', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const { rows } = await require('../db/pool').query(`
      SELECT
        i.id,
        i.name,
        i.email,
        i.xp_points,
        i.xp_level,
        i.date_joined,
        i.investor_profile
      FROM investors i
      WHERE i.investor_profile IS NOT NULL
        AND i.investor_profile != '{}'::jsonb
      ORDER BY i.date_joined DESC
    `);

    // ── Distribution counters ──
    const dist = {
      employment_status:    {},
      income_bracket:       {},
      investment_experience:{},
      investment_goal:      {},
      risk_reaction:        {},
      time_horizon:         {},
      saving_for:           {},
      dependents:           {},
      heard_via:            {},
    };

    const investors = rows.map(r => {
      const p = r.investor_profile || {};
      Object.keys(dist).forEach(k => {
        const v = p[k];
        if (v) dist[k][v] = (dist[k][v] || 0) + 1;
      });

      // Derive persona archetype
      let persona = 'Explorer';
      const goal = p.investment_goal || '';
      const risk = p.risk_reaction  || '';
      const exp  = p.investment_experience || '';
      if (goal.includes('preservation') || risk.includes('Sell everything')) {
        persona = 'Conservative Saver';
      } else if (goal.includes('growth') && (risk.includes('Buy more') || exp.includes('Experienced') || exp.includes('Expert'))) {
        persona = 'Growth Seeker';
      } else if (goal.includes('income') || p.income_need?.includes('R')) {
        persona = 'Income Investor';
      } else if (risk.includes('Buy more') && (exp.includes('Expert') || exp.includes('Experienced'))) {
        persona = 'Risk Taker';
      } else if (p.saving_for?.includes('Retirement') || p.saving_for?.includes("Children")) {
        persona = 'Long-Term Planner';
      }

      return {
        id: r.id,
        name: r.name,
        email: r.email,
        xp: r.xp_points,
        level: r.xp_level,
        joined: r.date_joined,
        persona,
        profile: p,
      };
    });

    // Persona archetype counts
    const personaCounts = {};
    investors.forEach(i => { personaCounts[i.persona] = (personaCounts[i.persona] || 0) + 1; });

    res.json({ investors, distributions: dist, personaCounts, total: investors.length });
  } catch (err) {
    console.error('[personas] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ═══════════════════════════════════════════════════════════
   Investment Funnel Analytics
   POST /invest-funnel          — authenticated, records one event
   GET  /invest-funnel/summary  — admin only, returns aggregated stats
   ═══════════════════════════════════════════════════════════ */

const INVEST_FUNNEL_TYPES = new Set([
  'modal_opened', 'fee_shown', 'insufficient_funds', 'over_budget',
  'abandoned', 'confirmed', 'topup_cancelled',
]);

/* ── POST /api/analytics/invest-funnel ───────────────────── */
router.post('/invest-funnel', requireAuth, async (req, res) => {
  try {
    const e = req.body || {};
    if (!INVEST_FUNNEL_TYPES.has(e.event_type)) {
      return res.status(400).json({ error: 'Invalid event_type' });
    }
    const investorId = req.user?.investor_id || req.user?.id || null;
    await pool.query(
      `INSERT INTO invest_funnel_events
         (investor_id, event_type, pool_id, product_type, stage,
          fee_seen, amount_entered, amount_bucket, wallet_bucket,
          shortfall_bucket, gateway, platform, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
      [
        investorId,
        String(e.event_type),
        e.pool_id    ? String(e.pool_id).slice(0, 100)    : null,
        e.product_type ? String(e.product_type).slice(0, 50) : null,
        e.stage      ? String(e.stage).slice(0, 50)      : null,
        e.fee_seen    != null ? Boolean(e.fee_seen)    : null,
        e.amount_entered != null ? Boolean(e.amount_entered) : null,
        e.amount_bucket   ? String(e.amount_bucket).slice(0, 20)   : null,
        e.wallet_bucket   ? String(e.wallet_bucket).slice(0, 20)   : null,
        e.shortfall_bucket ? String(e.shortfall_bucket).slice(0, 20) : null,
        e.gateway    ? String(e.gateway).slice(0, 20)    : null,
        e.platform   ? String(e.platform).slice(0, 20)   : null,
      ],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[invest-funnel] insert error:', err.message);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

/* ── GET /api/analytics/invest-funnel/summary ───────────── */
router.get('/invest-funnel/summary', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);

    const [funnelRows, abandonRows, insuffRows, topupRows, productRows, trendRows, poolRows] = await Promise.all([
      // Core invest funnel counts
      pool.query(`
        SELECT event_type, COUNT(*) AS cnt
        FROM invest_funnel_events
        WHERE event_type IN ('modal_opened','fee_shown','confirmed','abandoned')
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY event_type
      `, [days]),

      // Abandoned breakdown: fee seen vs not
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE fee_seen = true)  AS with_fee,
          COUNT(*) FILTER (WHERE fee_seen = false OR fee_seen IS NULL) AS without_fee
        FROM invest_funnel_events
        WHERE event_type = 'abandoned'
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [days]),

      // Insufficient funds: at modal open vs during amount entry
      pool.query(`
        SELECT stage, COUNT(*) AS cnt
        FROM invest_funnel_events
        WHERE event_type IN ('insufficient_funds','over_budget')
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY stage
      `, [days]),

      // Top-up cancelled
      pool.query(`
        SELECT COUNT(*) AS cancelled
        FROM invest_funnel_events
        WHERE event_type = 'topup_cancelled'
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [days]),

      // Breakdown by product type (for confirmed investments)
      pool.query(`
        SELECT product_type,
          COUNT(*) FILTER (WHERE event_type = 'modal_opened') AS opened,
          COUNT(*) FILTER (WHERE event_type = 'confirmed')    AS confirmed
        FROM invest_funnel_events
        WHERE event_type IN ('modal_opened','confirmed')
          AND product_type IS NOT NULL
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY product_type
        ORDER BY opened DESC
        LIMIT 10
      `, [days]),

      // Daily trend (last 14 days)
      pool.query(`
        SELECT DATE(created_at) AS day,
          COUNT(*) FILTER (WHERE event_type = 'modal_opened') AS opened,
          COUNT(*) FILTER (WHERE event_type = 'confirmed')    AS confirmed,
          COUNT(*) FILTER (WHERE event_type = 'abandoned')    AS abandoned
        FROM invest_funnel_events
        WHERE created_at >= NOW() - INTERVAL '14 days'
        GROUP BY day ORDER BY day
      `),

      // Per-pool drop-off — join to investment_pools for name
      pool.query(`
        SELECT
          e.pool_id,
          COALESCE(p.name, e.pool_id) AS pool_name,
          p.product_type AS pool_product_type,
          COUNT(*) FILTER (WHERE e.event_type = 'modal_opened') AS opened,
          COUNT(*) FILTER (WHERE e.event_type = 'fee_shown')    AS fee_shown,
          COUNT(*) FILTER (WHERE e.event_type = 'confirmed')    AS confirmed,
          COUNT(*) FILTER (WHERE e.event_type = 'abandoned')    AS abandoned
        FROM invest_funnel_events e
        LEFT JOIN investment_pools p ON p.id = e.pool_id
        WHERE e.pool_id IS NOT NULL
          AND e.event_type IN ('modal_opened','fee_shown','confirmed','abandoned')
          AND e.created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY e.pool_id, p.name, p.product_type
        ORDER BY opened DESC
        LIMIT 20
      `, [days]),
    ]);

    const byType = {};
    funnelRows.rows.forEach(r => { byType[r.event_type] = parseInt(r.cnt); });

    const opened    = byType.modal_opened || 0;
    const feeShown  = byType.fee_shown    || 0;
    const confirmed = byType.confirmed    || 0;
    const abandoned = byType.abandoned    || 0;

    res.json({
      days,
      funnel: { opened, fee_shown: feeShown, confirmed, abandoned },
      conversion_rate:   opened > 0 ? parseFloat((confirmed / opened).toFixed(3)) : 0,
      fee_aversion_rate: feeShown > 0 ? parseFloat(((abandonRows.rows[0]?.with_fee || 0) / feeShown).toFixed(3)) : 0,
      abandoned_breakdown: {
        fee_seen:     parseInt(abandonRows.rows[0]?.with_fee    || 0),
        no_fee_seen:  parseInt(abandonRows.rows[0]?.without_fee || 0),
      },
      insufficient_funds: insuffRows.rows.map(r => ({ stage: r.stage, count: parseInt(r.cnt) })),
      topup_cancelled:    parseInt(topupRows.rows[0]?.cancelled || 0),
      by_product:         productRows.rows.map(r => ({ product_type: r.product_type, opened: parseInt(r.opened), confirmed: parseInt(r.confirmed) })),
      daily_trend:        trendRows.rows.map(r => ({ day: r.day, opened: parseInt(r.opened), confirmed: parseInt(r.confirmed), abandoned: parseInt(r.abandoned) })),
      by_pool:            poolRows.rows.map(r => ({ pool_id: r.pool_id, pool_name: r.pool_name, product_type: r.pool_product_type, opened: parseInt(r.opened), fee_shown: parseInt(r.fee_shown), confirmed: parseInt(r.confirmed), abandoned: parseInt(r.abandoned) })),
    });
  } catch (err) {
    console.error('[invest-funnel] summary error:', err.message);
    res.status(500).json({ error: 'Failed to load invest funnel summary' });
  }
});

module.exports = router;
