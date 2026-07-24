'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const RBAC_KEY = 'rbac_matrix';

const DEFAULT_RBAC = {
  'CEO':                 ['employee','team','fund','admin','ifa','portal','director'],
  'COO':                 ['employee','team','fund','admin','ifa','portal','director'],
  'Operations Manager':  ['employee','team','fund','admin'],
  'Finance Manager':     ['employee','team','fund','admin'],
  'Tech Lead':           ['employee','team','fund','admin'],
  'Investment Analyst':  ['employee','team','fund'],
  'Compliance Officer':  ['employee','admin'],
  'Internal Audit':      ['employee','admin'],
  'Client Relations':    ['employee','portal'],
  'Marketing':           ['employee'],
  'Marketing Associate': ['employee'],
  'Junior Analyst':      ['employee'],
  'Admin':               ['employee','admin','accounting'],
};

/* GET /api/settings/rbac — requires auth */
router.get('/rbac', requireAuth, async (req, res) => {
  try {
    const row = await db.query('SELECT value FROM platform_settings WHERE key = $1', [RBAC_KEY]);
    const matrix = row.rows[0] ? JSON.parse(row.rows[0].value) : DEFAULT_RBAC;
    res.json({ matrix });
  } catch (_) {
    res.json({ matrix: DEFAULT_RBAC });
  }
});

/* PUT /api/settings/rbac — director/admin only */
router.put('/rbac', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  const { matrix } = req.body;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return res.status(400).json({ error: 'matrix must be an object mapping role → app[]' });
  }
  const valid = ['employee','team','fund','admin','ifa','portal','director','accounting'];
  for (const [role, apps] of Object.entries(matrix)) {
    if (!Array.isArray(apps) || apps.some(a => !valid.includes(a))) {
      return res.status(400).json({ error: `Invalid app key for role "${role}"` });
    }
  }
  try {
    await db.query(
      `INSERT INTO platform_settings (key, value, description, updated_at)
       VALUES ($1, $2, 'Role-based access control matrix', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [RBAC_KEY, JSON.stringify(matrix)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save RBAC matrix' });
  }
});

/* GET /api/settings/eva-rate — admin/director only */
router.get('/eva-rate', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const row = await db.query("SELECT value FROM platform_settings WHERE key = 'eva_rate'");
    const rate = row.rows[0] ? parseFloat(row.rows[0].value) : 0.15;
    res.json({ eva_rate: rate });
  } catch (_) {
    res.json({ eva_rate: 0.15 });
  }
});

/* PUT /api/settings/eva-rate — director/admin only */
router.put('/eva-rate', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  const { eva_rate } = req.body;
  const rate = parseFloat(eva_rate);
  if (isNaN(rate) || rate < 0 || rate > 1) {
    return res.status(400).json({ error: 'eva_rate must be a decimal between 0 and 1 (e.g. 0.15 for 15%)' });
  }
  try {
    await db.query(
      `INSERT INTO platform_settings (key, value, description, updated_at)
       VALUES ('eva_rate', $1, 'EVA rate — % of net-VAT upfront fee allocated to the referring employee', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [rate.toString()]
    );
    res.json({ ok: true, eva_rate: rate });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save EVA rate' });
  }
});

/* GET /api/settings/email-toggle — admin/director only */
router.get('/email-toggle', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    // Upsert so the row always exists after the first read
    const { rows } = await db.query(`
      INSERT INTO platform_settings (key, value, description, updated_at)
      VALUES ('resend_emails_enabled', 'true', 'Set to false to suppress all outbound Resend emails', NOW())
      ON CONFLICT (key) DO UPDATE SET updated_at = platform_settings.updated_at
      RETURNING value
    `);
    const enabled = rows[0]?.value !== 'false';
    res.json({ enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* PUT /api/settings/email-toggle — admin/director only */
router.put('/email-toggle', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  try {
    await db.query(`
      INSERT INTO platform_settings (key, value, description, updated_at)
      VALUES ('resend_emails_enabled', $1, 'Set to false to suppress all outbound Resend emails', NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [enabled ? 'true' : 'false']);
    res.json({ ok: true, enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
