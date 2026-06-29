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

/* GET /api/settings/rbac — public read so staff-auth.js can load it without auth */
router.get('/rbac', async (req, res) => {
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

module.exports = router;
