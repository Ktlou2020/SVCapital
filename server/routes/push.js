/* ═══════════════════════════════════════════════════════════
   Push Notification Routes — /api/push/*
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router      = require('express').Router();
const pool        = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const pushService = require('../services/pushService');

/* ══════════════════════════════════════════════════════════════
   GET /api/push/vapid-public-key
   Public — no auth required
══════════════════════════════════════════════════════════════ */
router.get('/vapid-public-key', async (req, res) => {
  try {
    const publicKey = await pushService.getVapidPublicKey();
    res.json({ publicKey });
  } catch (err) {
    console.error('[push] vapid-public-key error:', err.message);
    res.status(500).json({ error: 'Could not retrieve VAPID public key' });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /api/push/subscribe
   Body: { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }
   Upserts push subscription for authenticated investor
══════════════════════════════════════════════════════════════ */
router.post('/subscribe', requireAuth, async (req, res) => {
  const { subscription, userAgent } = req.body || {};

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'subscription.endpoint is required' });
  }
  if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return res.status(400).json({ error: 'subscription.keys.p256dh and auth are required' });
  }

  const investorId = req.user.investorId || req.user.id;
  if (!investorId) {
    return res.status(400).json({ error: 'No investor ID found on session' });
  }

  try {
    // Upsert: insert if endpoint not present, otherwise update
    await pool.query(
      `INSERT INTO push_subscriptions (investor_id, subscription, user_agent)
       VALUES ($1, $2, $3)
       ON CONFLICT ((subscription->>'endpoint')) DO UPDATE
         SET investor_id = EXCLUDED.investor_id,
             user_agent  = EXCLUDED.user_agent,
             updated_at  = NOW()`,
      [investorId, JSON.stringify(subscription), userAgent || null]
    );
    res.json({ ok: true });
  } catch (err) {
    // Fallback if unique index doesn't exist yet
    if (err.code === '42P10' || err.code === '42703' || err.message.includes('conflict')) {
      try {
        const { rows: existing } = await pool.query(
          `SELECT id FROM push_subscriptions WHERE subscription->>'endpoint' = $1`,
          [subscription.endpoint]
        );
        if (!existing.length) {
          await pool.query(
            `INSERT INTO push_subscriptions (investor_id, subscription, user_agent)
             VALUES ($1, $2, $3)`,
            [investorId, JSON.stringify(subscription), userAgent || null]
          );
        }
        return res.json({ ok: true });
      } catch (e2) {
        console.error('[push] subscribe fallback error:', e2.message);
        return res.status(500).json({ error: 'Failed to save subscription' });
      }
    }
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

/* ══════════════════════════════════════════════════════════════
   DELETE /api/push/unsubscribe
   Body: { endpoint }
   Removes the matching push subscription
══════════════════════════════════════════════════════════════ */
router.delete('/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint is required' });
  }

  const investorId = req.user.investorId || req.user.id;

  try {
    await pool.query(
      `DELETE FROM push_subscriptions
       WHERE investor_id = $1 AND subscription->>'endpoint' = $2`,
      [investorId, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

/* ══════════════════════════════════════════════════════════════
   GET /api/push/analytics
   Admin / director only
══════════════════════════════════════════════════════════════ */
router.get('/analytics', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const [subsCount, logCount, recentNotifs, subsByDay] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM push_subscriptions'),
      pool.query(`
        SELECT COUNT(*) AS total FROM push_notifications_log
      `).catch(() => ({ rows: [{ total: 0 }] })),
      pool.query(`
        SELECT * FROM push_notifications_log
        ORDER BY created_at DESC
        LIMIT 20
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT DATE(created_at) AS day, COUNT(*) AS count
        FROM push_subscriptions
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `),
    ]);

    res.json({
      total_subscribers:    parseInt(subsCount.rows[0]?.total || 0),
      notifications_sent:   parseInt(logCount.rows[0]?.total || 0),
      recent_notifications: recentNotifs.rows,
      subscribers_by_day:   subsByDay.rows,
    });
  } catch (err) {
    console.error('[push] analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics', detail: err.message });
  }
});

module.exports = router;
