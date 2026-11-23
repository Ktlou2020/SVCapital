'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const RBAC_KEY = 'rbac_matrix';

const DEFAULT_RBAC = {
  'CEO':                 ['employee','team','fund','admin','ifa','portal','director','accounting','pe_monitor','staging','staging_admin'],
  'COO':                 ['employee','team','fund','admin','ifa','portal','director','accounting','pe_monitor','staging','staging_admin'],
  'Operations Manager':  ['employee','team','fund','admin','accounting','staging','staging_admin'],
  'Finance Manager':     ['employee','team','fund','admin','accounting','pe_monitor','staging','staging_admin'],
  'Tech Lead':           ['employee','team','fund','admin','accounting','staging','staging_admin'],
  'Investment Analyst':  ['employee','team','fund','pe_monitor'],
  'Compliance Officer':  ['employee','admin','staging','staging_admin'],
  'Internal Audit':      ['employee','admin','staging','staging_admin'],
  'Client Relations':    ['employee','portal'],
  'Marketing':           ['employee'],
  'Marketing Associate': ['employee'],
  'Junior Analyst':      ['employee'],
  'Admin':               ['employee','admin','accounting','staging','staging_admin'],
};

/* GET /api/settings/rbac — requires auth */
router.get('/rbac', requireAuth, async (req, res) => {
  try {
    const row = await db.query('SELECT value FROM platform_settings WHERE key = $1', [RBAC_KEY]);
    if (!row.rows[0]) return res.json({ matrix: DEFAULT_RBAC });

    let matrix = JSON.parse(row.rows[0].value);

    // When a new app is added to DEFAULT_RBAC it won't be in previously-saved
    // matrices. Detect "brand-new" apps (absent from every stored role entry) and
    // add them to each role that should have them per DEFAULT_RBAC, so a code
    // update doesn't require a manual Director Panel re-save.
    for (const [role, defaultApps] of Object.entries(DEFAULT_RBAC)) {
      if (!matrix[role]) continue;
      for (const app of defaultApps) {
        if (!matrix[role].includes(app)) {
          const presentAnywhere = Object.values(matrix).some(apps => Array.isArray(apps) && apps.includes(app));
          if (!presentAnywhere) {
            matrix[role] = [...matrix[role], app];
          }
        }
      }
    }

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
  const valid = ['employee','team','fund','admin','ifa','portal','director','accounting','pe_monitor'];
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

/* ─── Whether the notice account is offered to groups ────────────────
 *
 * noticeFund.isLive reads platform_settings.notice_fund_live, and every
 * notice-fund route for a group is gated on it. The console's own panel
 * has told staff for months that the switch is in "Settings →
 * notice_fund_live" — and there was no such screen. The flag could only be
 * changed by writing to the database by hand, which meant the product had
 * a kill switch nobody present could reach, in either direction.
 *
 * OFF IS THE DEFAULT AND STAYS THE DEFAULT. The read upserts 'false', so
 * an environment that has never been asked does not start offering a
 * financial product because somebody opened a settings page. Turning it on
 * is a deliberate act by an admin or a director, and it is audited, because
 * it is the moment the account becomes something a group can be sold.
 */
const NOTICE_KEY  = 'notice_fund_live';
const NOTICE_DESC = 'true offers the 30-day notice account to groups. Off by default.';

router.get('/notice-fund-live', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      INSERT INTO platform_settings (key, value, description, updated_at)
      VALUES ($1, 'false', $2, NOW())
      ON CONFLICT (key) DO UPDATE SET updated_at = platform_settings.updated_at
      RETURNING value
    `, [NOTICE_KEY, NOTICE_DESC]);
    res.json({ enabled: String(rows[0] && rows[0].value).trim() === 'true' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/notice-fund-live', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  try {
    await db.query(`
      INSERT INTO platform_settings (key, value, description, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [NOTICE_KEY, enabled ? 'true' : 'false', NOTICE_DESC]);
    /* Audited by name: this is the switch that makes a financial product
       available to clients, and "who turned it on, and when" is the first
       question anybody will ask about it afterwards. */
    require('../services/audit').log({
      actorId: req.user && req.user.id, actorEmail: req.user && req.user.email,
      actorRole: req.user && req.user.role,
      action: enabled ? 'notice_fund.offered' : 'notice_fund.withdrawn',
      entityType: 'platform_settings', entityId: NOTICE_KEY,
      description: enabled
        ? 'The 30-day notice account is now offered to groups'
        : 'The 30-day notice account is no longer offered to groups',
    }).catch(() => {});
    res.json({ ok: true, enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
