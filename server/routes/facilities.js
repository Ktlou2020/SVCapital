'use strict';
/* External trading facilities, reported under Short-Term Loans.
 *
 * SV Capital's money in somebody else's operation, where the return is a
 * share of what that operation makes. The figures come from a document the
 * operator maintains — a published Google Sheet — so these endpoints READ
 * that document, record what it said and when, and show our own share of it.
 *
 * Nothing here moves money, credits a wallet or feeds investor returns.
 *
 * The parsing and the arithmetic are in services/grainFacility, so a report
 * drawn here and one drawn by a script are the same report.
 */

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const pool    = require('../db/pool');
const svc     = require('../services/grainFacility');
const sync    = require('../services/facilitySync');

const router = express.Router();
const STAFF  = ['admin', 'director', 'fund_manager'];

/* ── GET /api/fund/facilities ──────────────────────────────────────── */
router.get('/facilities', requireAuth, requireRole(...STAFF), async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*,
             (SELECT COUNT(*)::int FROM stl_facility_loads l WHERE l.facility_id = f.id) AS loads,
             (SELECT COUNT(*)::int FROM stl_facility_loads l WHERE l.facility_id = f.id
                AND l.our_margin IS NOT NULL) AS settled,
             (SELECT COALESCE(SUM(l.our_margin), 0) FROM stl_facility_loads l
               WHERE l.facility_id = f.id) AS our_margin_earned
        FROM stl_facilities f ORDER BY f.created_at`);
    res.json({ data: rows });
  } catch (err) {
    console.error('[facilities] list failed:', err.message);
    res.status(500).json({ error: 'Could not load the facilities.' });
  }
});

/* ── GET /api/fund/facilities/:id/loads ────────────────────────────────
   The loads, with OUR share. The facility's own gross margin rides along as
   context and is labelled as such on screen; it is not our money. */
router.get('/facilities/:id/loads', requireAuth, requireRole(...STAFF), async (req, res) => {
  try {
    const { rows: [f] } = await pool.query(
      `SELECT * FROM stl_facilities WHERE id = $1`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'No such facility.' });
    const { rows } = await pool.query(
      `SELECT * FROM stl_facility_loads WHERE facility_id = $1
        ORDER BY date_bought DESC NULLS LAST, load_ref::bigint DESC`, [req.params.id]);
    const loads = rows.map(r => ({
      load_ref: r.load_ref,
      date_bought: r.date_bought ? r.date_bought.toISOString().slice(0, 10) : null,
      date_buyer_paid: r.date_buyer_paid ? r.date_buyer_paid.toISOString().slice(0, 10) : null,
      tons: r.tons === null ? null : Number(r.tons),
      load_cost: r.load_cost === null ? null : Number(r.load_cost),
      margin_total: r.margin_total === null ? null : Number(r.margin_total),
      pool_pct: r.pool_pct === null ? null : Number(r.pool_pct),
      our_margin: r.our_margin === null ? null : Number(r.our_margin),
      settled: r.our_margin !== null,
      status: r.status,
    }));
    res.json({
      data: loads,
      facility: { id: f.id, name: f.name, partner_name: f.partner_name,
                  our_name: f.our_name, funded_from: f.funded_from,
                  our_share_pct: f.our_share_pct === null
                    ? null : Number(f.our_share_pct),
                  last_synced_at: f.last_synced_at, warnings: f.last_warnings || [] },
      summary: svc.summarise(loads, f.our_capital === null ? null : Number(f.our_capital)),
    });
  } catch (err) {
    console.error('[facilities] loads failed:', err.message);
    res.status(500).json({ error: 'Could not load that facility.' });
  }
});

/* ── POST /api/fund/facilities/:id/sync ────────────────────────────────
   Re-read the spreadsheet. PREVIEWS unless apply is 'true', because what it
   writes is what the fund console then reports.
   ──────────────────────────────────────────────────────────────────── */
router.post('/facilities/:id/sync', requireAuth, requireRole(...STAFF), async (req, res) => {
  const apply = String((req.body || {}).apply) === 'true';
  try {
    const { rows: [f] } = await pool.query(
      `SELECT * FROM stl_facilities WHERE id = $1`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'No such facility.' });
    /* The fetch, the plan and the write are in services/facilitySync, which
       the schedule calls too. A copy here would drift from the one that runs
       unattended, and the drift would be a figure a fund manager reads. */
    const out = await sync.sync(pool, f, { apply, actor: {
      id: (req.user && req.user.empId) || (req.user && req.user.id) || null,
      email: (req.user && req.user.email) || 'staff',
      role: (req.user && req.user.role) || 'admin',
    } });
    res.json(out);
  } catch (err) {
    if (!err.status) console.error('[facilities] sync failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
