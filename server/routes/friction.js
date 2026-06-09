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

module.exports = router;
