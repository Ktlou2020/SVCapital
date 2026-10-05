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

/* ─── Beef market prices ──────────────────────────────────────────────
   The published weekly price, kept beside our own realised price so a
   director can see where the market went as well as what we got.

   Entered by hand today. There is no fetch from the RPO report yet: writing a
   parser against a page nobody has read would put prices on a board pack that
   nobody has checked, and a wrong price there is worse than an empty section.
   Every row records who captured it and when, so the report can say so.
   ──────────────────────────────────────────────────────────────────── */
const CATEGORIES = { class_a: 'carcass', class_c: 'carcass', weaner: 'live' };

router.get('/beef-prices', requireDirector, async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT id, week_ending, category, basis, rand_per_kg, source, source_url,
              captured_by, captured_at, notes
         FROM beef_market_prices ORDER BY week_ending DESC, category LIMIT 120`);
    return res.json({ categories: Object.keys(CATEGORIES), prices: rows });
  } catch (err) {
    console.error('[director-report] beef-prices', err.message);
    return res.status(500).json({ error: 'Could not load the prices.' });
  }
});

router.post('/beef-prices', requireDirector, async (req, res) => {
  try {
    const pool = require('../db/pool');
    const { week_ending, category, rand_per_kg, notes } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week_ending || ''))) {
      return res.status(400).json({ error: 'week_ending must be a date, as YYYY-MM-DD.' });
    }
    if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) {
      return res.status(400).json({ error: `category must be one of ${Object.keys(CATEGORIES).join(', ')}.` });
    }
    const price = Number(rand_per_kg);
    /* A rand-per-kilogram figure. The guard is deliberately wide but closed at
       both ends: somebody keying a price per HEAD — about R19 000 — must not
       land it in a column the report multiplies by 475 kilograms. */
    if (!isFinite(price) || price <= 0 || price > 500) {
      return res.status(400).json({ error: 'rand_per_kg must be a price per kilogram, between 0 and 500.' });
    }
    if (new Date(week_ending) > new Date()) {
      return res.status(400).json({ error: 'That week has not happened yet.' });
    }

    /* The basis belongs to the category, not to the person entering it. Class A
       is a carcass price and a weaner is quoted live; letting the form choose
       is letting it be wrong, and the projection multiplies by it. */
    const basis = CATEGORIES[category];
    const who = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ')
                || req.user?.email || req.user?.empId || null;

    const { rows: [row] } = await pool.query(
      `INSERT INTO beef_market_prices
         (week_ending, category, basis, rand_per_kg, source, source_url, captured_by, notes)
       VALUES ($1,$2,$3,$4,'RPO weekly report','https://rpo.co.za/weeklikse-bees-en-skaap-markverslag/',$5,$6)
       ON CONFLICT (week_ending, category) DO UPDATE
         SET rand_per_kg = EXCLUDED.rand_per_kg, basis = EXCLUDED.basis,
             captured_by = EXCLUDED.captured_by, captured_at = NOW(),
             notes = EXCLUDED.notes
       RETURNING *`,
      [week_ending, category, basis, price, who, notes || null]);

    audit.log({
      action:      'beef_price.capture',
      actorId:     req.user.empId || req.user.id || null,
      actorEmail:  req.user.email || null,
      actorRole:   req.user.role || null,
      entityType:  'beef_market_prices',
      entityId:    row.id,
      description: `Captured ${category} at R${price}/kg for the week ending ${week_ending}`,
      ip:          req.ip || null,
    }).catch(() => {});

    return res.json({ ok: true, price: row });
  } catch (err) {
    console.error('[director-report] beef-prices save', err.message);
    return res.status(500).json({ error: 'Could not save that price.' });
  }
});

/* Run the fetch now. The schedule does this weekly; this exists so the
   extractor can be proved against the live page the moment the network policy
   allows the host, and so a director can pull a correction the same day the
   report is republished. Directors only, and the run is logged like any other. */
router.post('/beef-prices/fetch', requireDirector, async (req, res) => {
  try {
    const { runBeefPriceFetch } = require('../services/beefPriceFetch');
    const who = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ')
                || req.user?.email || req.user?.empId || 'a director';
    const result = await runBeefPriceFetch({ triggeredBy: who });
    /* Always 200: "I read the page and would not trust what I found" is an
       answer, not a server fault, and the body says which it was. */
    return res.json(result);
  } catch (err) {
    console.error('[director-report] beef fetch', err.message);
    return res.status(500).json({ error: 'The fetch could not be run.' });
  }
});

module.exports = router;
