'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/setup');
const { requireAuth, requireAdmin } = require('./auth');

const TERMS_KEY = 'terms_of_use_content';

/* GET /api/legal/terms-content — public */
router.get('/terms-content', async (req, res) => {
  try {
    const row = await db.query(
      'SELECT value FROM platform_settings WHERE key = $1',
      [TERMS_KEY]
    );
    res.json({ content: row.rows[0]?.value || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load terms content' });
  }
});

/* PUT /api/legal/terms-content — admin only */
router.put('/terms-content', requireAuth, requireAdmin, async (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }
  try {
    await db.query(
      `INSERT INTO platform_settings (key, value, description, updated_at)
       VALUES ($1, $2, 'Terms of Use page HTML content', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [TERMS_KEY, content.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save terms content' });
  }
});

module.exports = router;
