'use strict';

const router   = require('express').Router();
const pool     = require('../db/pool');
const https    = require('https');
const { requireAuth, requireRole } = require('../middleware/auth');

const ADMIN_OR_DIRECTOR = ['admin', 'director'];

/* ── Lightweight HTTPS ping ── */
function _ping(url, opts = {}) {
  return new Promise(resolve => {
    const t0  = Date.now();
    const req = https.request(url, { method: 'GET', timeout: 5000, ...opts }, res => {
      resolve({ ok: res.statusCode < 500, status: res.statusCode, ms: Date.now() - t0 });
      res.resume();
    });
    req.on('error', () => resolve({ ok: false, status: 0, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - t0 }); });
    req.end();
  });
}

/* ════════════════════════════════════════════════════
   GET /api/opsconsole/health
   Platform service health check
   ════════════════════════════════════════════════════ */
router.get('/health', requireAuth, requireRole(...ADMIN_OR_DIRECTOR), async (req, res) => {
  try {
    const resendKey    = process.env.RESEND_API_KEY;
    const atKey        = process.env.AFRICASTALKING_API_KEY;
    const paystackKey  = process.env.PAYSTACK_SECRET_KEY;
    const smileKey     = process.env.SMILE_IDENTITY_API_KEY || process.env.SMILE_API_KEY;
    const stitchId     = process.env.STITCH_CLIENT_ID;

    const [emailPing, paystackPing, dbPing, pushSubs] = await Promise.all([
      resendKey
        ? _ping('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendKey}` } })
        : { ok: false, status: 0, ms: 0, note: 'No API key configured' },
      paystackKey
        ? _ping('https://api.paystack.co/transaction/totals?from=2024-01-01', { headers: { Authorization: `Bearer ${paystackKey}` } })
        : { ok: false, status: 0, ms: 0, note: 'No API key configured' },
      pool.query('SELECT 1').then(() => ({ ok: true, status: 200, ms: 0 })).catch(() => ({ ok: false, status: 0, ms: 0 })),
      pool.query('SELECT COUNT(*) AS cnt FROM push_subscriptions').then(r => parseInt(r.rows[0].cnt)).catch(() => 0),
    ]);

    res.json({
      services: {
        email:    { name: 'Resend',              configured: !!resendKey,   ...emailPing,    note: resendKey ? undefined : 'No API key' },
        sms:      { name: "Africa's Talking",    configured: !!atKey,       ok: !!atKey,   status: atKey ? 200 : 0, ms: 0, note: atKey ? 'Key configured' : 'No API key' },
        payments: { name: 'Paystack',            configured: !!paystackKey, ...paystackPing, note: paystackKey ? undefined : 'No API key' },
        fica:     { name: 'Smile Identity / SmileFin', configured: !!smileKey, ok: !!smileKey, status: smileKey ? 200 : 0, ms: 0, note: smileKey ? 'Key configured' : 'No API key' },
        banking:  { name: 'Stitch (Bank Data)',  configured: !!stitchId,    ok: !!stitchId,  status: stitchId ? 200 : 0, ms: 0, note: stitchId ? 'Client ID configured' : 'Not configured' },
        database: { name: 'PostgreSQL',          configured: true,           ...dbPing },
        push:     { name: 'Web Push (VAPID)',    configured: true,           ok: true,  status: 200, ms: 0, subscribers: pushSubs },
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[opsconsole/health]', err.message);
    res.status(500).json({ error: 'Health check failed' });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/opsconsole/summary
   Financial + investor snapshot
   ════════════════════════════════════════════════════ */
router.get('/summary', requireAuth, requireRole(...ADMIN_OR_DIRECTOR), async (req, res) => {
  try {
    const now        = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const weekStart  = new Date(now); weekStart.setDate(now.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      aum, walletTotal, pendDep, pendWith,
      newToday, newWeek, newMonth, prevMonthInv,
      totalInv, activeInv, ficaPend, ficaApproved,
      openTickets, amlFlags, pendInvestments,
      investVol7d, monthDep, returnsDist,
      topPools, aumByType,
    ] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount),0) AS v FROM investments WHERE status='active'`),
      pool.query(`SELECT COALESCE(SUM(wallet_balance),0) AS v FROM investors`),
      pool.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(ABS(amount)),0) AS val FROM transactions WHERE type='deposit' AND status='pending'`),
      pool.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(ABS(amount)),0) AS val FROM transactions WHERE type='withdrawal' AND status='pending'`),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE created_at >= $1`, [todayStart]),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE created_at >= $1`, [weekStart]),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE created_at >= $1`, [monthStart]),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE created_at >= $1 AND created_at <= $2`, [prevMonthStart, prevMonthEnd]),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors`),
      pool.query(`SELECT COUNT(DISTINCT investor_id) AS cnt FROM investments WHERE status='active'`),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE COALESCE(NULLIF(fica_status,''), NULLIF(kyc_status,''), 'pending') NOT IN ('approved','verified','active')`),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE COALESCE(fica_status,kyc_status,'') IN ('approved','verified','active')`),
      pool.query(`SELECT COUNT(*) AS cnt FROM support_tickets WHERE status NOT IN ('closed','resolved') AND (is_system IS NULL OR is_system=false)`),
      pool.query(`SELECT COUNT(*) AS cnt FROM support_tickets WHERE status NOT IN ('closed','resolved') AND is_system=true`),
      pool.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS val FROM investments WHERE status='pending'`),
      pool.query(`SELECT COALESCE(SUM(ABS(amount)),0) AS v FROM transactions WHERE type='deposit' AND status='completed' AND created_at >= $1`, [weekStart]),
      pool.query(`SELECT COUNT(*) AS cnt, COALESCE(SUM(ABS(amount)),0) AS val FROM transactions WHERE type='deposit' AND status='completed' AND created_at >= $1`, [monthStart]),
      pool.query(`SELECT COALESCE(SUM(ABS(amount)),0) AS v FROM transactions WHERE type='return' AND status='completed' AND created_at >= $1`, [monthStart]),
      pool.query(`SELECT ip.name, ip.product_type, COUNT(i.id) AS investors, COALESCE(SUM(i.amount),0) AS vol FROM investment_pools ip LEFT JOIN investments i ON i.pool_id=ip.id AND i.status='active' GROUP BY ip.id ORDER BY vol DESC LIMIT 5`),
      pool.query(`SELECT product_type, COALESCE(SUM(amount),0) AS vol FROM investments WHERE status='active' GROUP BY product_type ORDER BY vol DESC`),
    ]);

    res.json({
      aum:               parseFloat(aum.rows[0].v),
      totalWalletBalance: parseFloat(walletTotal.rows[0].v),
      pendingDeposits:   { count: parseInt(pendDep.rows[0].cnt),  value: parseFloat(pendDep.rows[0].val) },
      pendingWithdrawals:{ count: parseInt(pendWith.rows[0].cnt), value: parseFloat(pendWith.rows[0].val) },
      pendingInvestments:{ count: parseInt(pendInvestments.rows[0].cnt), value: parseFloat(pendInvestments.rows[0].val) },
      monthDeposits:     { count: parseInt(monthDep.rows[0].cnt), value: parseFloat(monthDep.rows[0].val) },
      returnsDistributed: parseFloat(returnsDist.rows[0].v),
      investVol7d:       parseFloat(investVol7d.rows[0].v),
      investors: {
        total:       parseInt(totalInv.rows[0].cnt),
        active:      parseInt(activeInv.rows[0].cnt),
        newToday:    parseInt(newToday.rows[0].cnt),
        newWeek:     parseInt(newWeek.rows[0].cnt),
        newMonth:    parseInt(newMonth.rows[0].cnt),
        prevMonth:   parseInt(prevMonthInv.rows[0].cnt),
        ficaPending: parseInt(ficaPend.rows[0].cnt),
        ficaApproved: parseInt(ficaApproved.rows[0].cnt),
      },
      operations: {
        openTickets: parseInt(openTickets.rows[0].cnt),
        amlFlags:    parseInt(amlFlags.rows[0].cnt),
      },
      topPools:   topPools.rows.map(r => ({ name: r.name, type: r.product_type, investors: parseInt(r.investors), volume: parseFloat(r.vol) })),
      aumByType:  aumByType.rows.map(r => ({ type: r.product_type, volume: parseFloat(r.vol) })),
    });
  } catch (err) {
    console.error('[opsconsole/summary]', err.message);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/opsconsole/funnel
   Investor lifecycle conversion funnel
   ════════════════════════════════════════════════════ */
router.get('/funnel', requireAuth, requireRole(...ADMIN_OR_DIRECTOR), async (req, res) => {
  try {
    const [signups, ficaDone, hasDeposit, hasInvestment, active] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM investors`),
      pool.query(`SELECT COUNT(*) AS cnt FROM investors WHERE COALESCE(fica_status, kyc_status,'') IN ('approved','verified','active')`),
      pool.query(`SELECT COUNT(DISTINCT investor_id) AS cnt FROM transactions WHERE type='deposit' AND status='completed'`),
      pool.query(`SELECT COUNT(DISTINCT investor_id) AS cnt FROM investments`),
      pool.query(`SELECT COUNT(DISTINCT investor_id) AS cnt FROM investments WHERE status='active'`),
    ]);
    res.json({
      stages: [
        { label: 'Signed Up',       count: parseInt(signups.rows[0].cnt) },
        { label: 'FICA Verified',   count: parseInt(ficaDone.rows[0].cnt) },
        { label: 'First Deposit',   count: parseInt(hasDeposit.rows[0].cnt) },
        { label: 'First Investment',count: parseInt(hasInvestment.rows[0].cnt) },
        { label: 'Active Investor', count: parseInt(active.rows[0].cnt) },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load funnel' });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/opsconsole/comms
   Communication platform statistics
   ════════════════════════════════════════════════════ */
router.get('/comms', requireAuth, requireRole(...ADMIN_OR_DIRECTOR), async (req, res) => {
  try {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [pushSubs, pushMonth, recentPush] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM push_subscriptions`),
      pool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(recipient_count),0) AS recipients
         FROM push_notifications_log WHERE created_at >= $1`, [monthStart]
      ),
      pool.query(
        `SELECT title, body, recipient_count, notification_type, created_at
         FROM push_notifications_log ORDER BY created_at DESC LIMIT 10`
      ),
    ]);

    res.json({
      push: {
        subscribers:       parseInt(pushSubs.rows[0].cnt),
        sentThisMonth:     parseInt(pushMonth.rows[0].cnt),
        recipientsThisMonth: parseInt(pushMonth.rows[0].recipients),
      },
      recentNotifications: recentPush.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load comms stats' });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/opsconsole/activity
   Recent audit event stream
   ════════════════════════════════════════════════════ */
router.get('/activity', requireAuth, requireRole(...ADMIN_OR_DIRECTOR), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, action, entity_type, actor_email, description, ip_address, created_at
       FROM audit_events ORDER BY created_at DESC LIMIT 30`
    );
    res.json({ events: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/opsconsole/velocity
   7-day deposit + investment velocity (daily breakdown)
   ════════════════════════════════════════════════════ */
router.get('/velocity', requireAuth, requireRole(...ADMIN_OR_DIRECTOR), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        DATE(created_at) AS day,
        type,
        COUNT(*)        AS txns,
        SUM(ABS(amount)) AS volume
      FROM transactions
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND type IN ('deposit','withdrawal','return')
        AND status = 'completed'
      GROUP BY day, type
      ORDER BY day
    `);
    res.json({ velocity: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load velocity' });
  }
});

module.exports = router;
