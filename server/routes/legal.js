'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/setup');
const { requireAuth, requireAdmin } = require('./auth');

const TERMS_KEY   = 'terms_of_use_content';
const PRIVACY_KEY = 'privacy_policy_content';

function makeRoutes(key) {
  return {
    get: async (req, res) => {
      try {
        const row = await db.query('SELECT value, updated_at FROM platform_settings WHERE key = $1', [key]);
        res.json({ content: row.rows[0]?.value || null, updatedAt: row.rows[0]?.updated_at || null });
      } catch (_) { res.status(500).json({ error: 'Failed to load content' }); }
    },
    put: [requireAuth, requireAdmin, async (req, res) => {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'Content required' });
      try {
        await db.query(
          `INSERT INTO platform_settings (key, value, description, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, content.trim(), key === TERMS_KEY ? 'Terms of Use page HTML content' : 'Privacy Policy & POPIA Notice HTML content']
        );
        res.json({ ok: true });
      } catch (_) { res.status(500).json({ error: 'Failed to save content' }); }
    }],
  };
}

const terms   = makeRoutes(TERMS_KEY);
const privacy = makeRoutes(PRIVACY_KEY);

router.get('/terms-content',   terms.get);
router.put('/terms-content',   ...terms.put);
router.get('/privacy-content', privacy.get);
router.put('/privacy-content', ...privacy.put);

module.exports = router;
