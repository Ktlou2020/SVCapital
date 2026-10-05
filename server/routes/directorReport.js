'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   The monthly director report.

   Director-only, like the policies report and for the same reason: it names
   the ten largest investors and what each of them holds, which is the most
   concentrated piece of commercial information on the platform. An admin
   console login is not consent to see it.

   One GET. Everything is computed in services/directorReport so the emailed
   report and this one cannot drift apart.
   ═══════════════════════════════════════════════════════════════════════ */

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const report = require('../services/directorReport');
const audit  = require('../services/audit');

const requireDirector = [requireAuth, requireRole('director')];

/* ─── GET /api/director-report?month=YYYY-MM ──────────────────────────
   Omit the month for the one that has just ended. */
router.get('/', requireDirector, async (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    /* A month is a month. Anything else is rejected rather than quietly
       becoming "last month", which would show a director a different period
       from the one they asked for with nothing on screen saying so. */
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM.' });
    }
    const data = await report.buildReport(month || null);

    /* Who read the book's concentration, and for which month. */
    audit.log({
      action:      'director_report.view',
      actorId:     req.user.empId || req.user.id || null,
      actorEmail:  req.user.email || null,
      actorRole:   req.user.role  || null,
      entityType:  'director_report',
      entityId:    data.month,
      description: `Viewed the director report for ${data.monthLabel}`,
      ip:          req.ip || null,
    }).catch(() => {});

    return res.json(data);
  } catch (err) {
    console.error('[director-report]', err.message);
    return res.status(500).json({ error: 'Could not build the report.' });
  }
});

/* The months there is anything to report on, newest first, so the picker
   offers real periods rather than a blank box. */
router.get('/months', requireDirector, async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT DISTINCT to_char(d, 'YYYY-MM') AS month FROM (
         SELECT generate_series(
           date_trunc('month', (SELECT MIN(start_date) FROM investments WHERE start_date IS NOT NULL)),
           date_trunc('month', (now() AT TIME ZONE $1)),
           INTERVAL '1 month') AS d) s
        ORDER BY month DESC LIMIT 36`, [report.BUSINESS_TZ]);
    return res.json({ months: rows.map(r => r.month) });
  } catch (err) {
    console.error('[director-report] months', err.message);
    return res.status(500).json({ error: 'Could not list the months.' });
  }
});

module.exports = router;
