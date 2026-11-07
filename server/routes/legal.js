'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/setup');
const { requireAuth, requireRole } = require('../middleware/auth');

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
    put: [requireAuth, requireRole('admin'), async (req, res) => {
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

/* What of the group resources has been signed off for clients. Public and
   read-only: it says only which translations and templates are released,
   which the public stokvels page and the template pages need without a
   sign-in. Anything not listed is a draft, and the screens say so. */
const LANGS = ['zu', 'st'];
const pgPool = require('../db/pool');
async function groupResources() {
  const { rows } = await pgPool.query(
    `SELECT key, value FROM platform_settings WHERE key IN ('group_languages_live','group_templates_live')`);
  const v = Object.fromEntries(rows.map(r => [r.key, String(r.value || '')]));
  const live = String(v.group_languages_live || '').split(',')
    .map(x => x.trim().toLowerCase()).filter(x => LANGS.includes(x));
  return { languages_live: [...new Set(live)], templates_live: String(v.group_templates_live).trim() === 'true' };
}
router.get('/group-resources', async (req, res) => {
  try { res.json(await groupResources()); }
  catch (_) { res.json({ languages_live: [], templates_live: false }); }
});

module.exports = router;
module.exports.groupResources = groupResources;
