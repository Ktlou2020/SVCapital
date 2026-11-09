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
const crypto  = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const pool    = require('../db/pool');
const svc     = require('../services/grainFacility');

const router = express.Router();
const STAFF  = ['admin', 'director', 'fund_manager'];

/* The sheet is fetched with a timeout and a size cap. It is a public URL on
   somebody else's service: a request with no ceiling is a request that can
   hang a worker, and a response with no cap is one that can exhaust it. */
const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES        = 8 * 1024 * 1024;

async function readSheet(url) {
  if (!/^https:\/\/docs\.google\.com\//.test(String(url || ''))) {
    const e = new Error('A facility sheet must be a published docs.google.com URL.');
    e.status = 400; throw e;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal, redirect: 'follow',
                             headers: { 'Accept': 'text/html' } });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(err.name === 'AbortError'
      ? 'The spreadsheet did not answer in time.'
      : `Could not reach the spreadsheet: ${err.message}`);
    e.status = 502; throw e;
  }
  clearTimeout(timer);
  if (!res.ok) {
    const e = new Error(`The spreadsheet answered ${res.status}. If it was unpublished, `
      + 'republish it to the web and try again.');
    e.status = 502; throw e;
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) {
    const e = new Error('That spreadsheet page is too large to read.');
    e.status = 413; throw e;
  }
  return text;
}

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
    if (!f.loads_url) return res.status(400).json({ error: 'This facility has no sheet URL on it.' });

    const warnings = [];
    const parsed = svc.parseLoads(await readSheet(f.loads_url), {
      ourColumn: f.our_column,
      ourSharePct: f.our_share_pct === null ? null : Number(f.our_share_pct),
      warnings,
    });

    let capital = null, deposits = [];
    if (f.capital_url) {
      const c = svc.parseCapital(await readSheet(f.capital_url), { ourName: f.our_name });
      capital = c.capital; deposits = c.deposits;
    }

    /* What a sync would change, counted against what is already stored, so
       the preview is about THIS sheet and not just a row count. */
    const { rows: had } = await pool.query(
      `SELECT load_ref, our_margin FROM stl_facility_loads WHERE facility_id = $1`, [f.id]);
    const have = new Map(had.map(r => [r.load_ref, r.our_margin === null ? null : Number(r.our_margin)]));
    const added = [], newlySettled = [], changed = [], unchanged = [];
    for (const l of parsed.loads) {
      if (!have.has(l.load_ref)) { added.push(l); continue; }
      const was = have.get(l.load_ref);
      if (was === null && l.our_margin !== null) { newlySettled.push(l); continue; }
      if (Number(was) !== Number(l.our_margin)) { changed.push({ ...l, was }); continue; }
      unchanged.push(l);
    }
    /* A load that is in the database and no longer in the sheet is REPORTED,
       never deleted: a row vanishing from somebody else's spreadsheet is not
       authority to drop what we already reported on. */
    const gone = [...have.keys()].filter(k => !parsed.loads.some(l => l.load_ref === k));

    const summary = svc.summarise(parsed.loads, capital);
    const plan = {
      applied: false,
      summary,
      counts: { added: added.length, newly_settled: newlySettled.length,
                changed: changed.length, unchanged: unchanged.length,
                skipped_blank: parsed.skipped, no_longer_in_sheet: gone.length },
      added: added.slice(0, 50), newly_settled: newlySettled.slice(0, 50),
      changed: changed.slice(0, 50), no_longer_in_sheet: gone.slice(0, 50),
      deposits, warnings,
    };
    if (!apply) return res.json(plan);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const l of parsed.loads) {
        await client.query(`
          INSERT INTO stl_facility_loads
            (id, facility_id, load_ref, date_bought, tons, safax, buy_price, sell_price,
             date_buyer_paid, payout_date, load_cost, margin_total, pool_pct, pool_margin,
             our_margin, status, synced_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
          ON CONFLICT (facility_id, load_ref) DO UPDATE SET
            date_bought = EXCLUDED.date_bought, tons = EXCLUDED.tons,
            safax = EXCLUDED.safax, buy_price = EXCLUDED.buy_price,
            sell_price = EXCLUDED.sell_price, date_buyer_paid = EXCLUDED.date_buyer_paid,
            payout_date = EXCLUDED.payout_date, load_cost = EXCLUDED.load_cost,
            margin_total = EXCLUDED.margin_total, pool_pct = EXCLUDED.pool_pct,
            pool_margin = EXCLUDED.pool_margin, our_margin = EXCLUDED.our_margin,
            status = EXCLUDED.status, synced_at = NOW(), updated_at = NOW()`,
          ['SFL-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase(),
           f.id, l.load_ref, l.date_bought, l.tons, l.safax, l.buy_price, l.sell_price,
           l.date_buyer_paid, l.payout_date, l.load_cost, l.margin_total, l.pool_pct,
           l.pool_margin, l.our_margin, l.status]);
      }
      /* COALESCE so a sync run without the capital sheet does not wipe a
         capital figure an earlier one established. */
      await client.query(
        `UPDATE stl_facilities SET last_synced_at = NOW(), last_sync_by = $2,
                last_warnings = $3::jsonb, our_capital = COALESCE($4, our_capital),
                updated_at = NOW() WHERE id = $1`,
        [f.id, (req.user && req.user.email) || 'staff', JSON.stringify(warnings), capital]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
    client.release();

    require('../services/audit').log({
      actorId: (req.user && req.user.empId) || (req.user && req.user.id) || null,
      actorEmail: (req.user && req.user.email) || 'staff',
      actorRole: (req.user && req.user.role) || 'admin',
      action: 'facility_synced', entityType: 'facility', entityId: f.id,
      description: `${f.name} re-read from its spreadsheet: ${added.length} new load(s), `
        + `${newlySettled.length} newly settled, ${changed.length} changed. `
        + `Our share earned to date ${summary.our_margin_earned}. `
        + `${warnings.length} arithmetic warning(s).`,
      after: { counts: plan.counts, summary, warnings },
    }).catch(() => {});

    res.json({ ...plan, applied: true });
  } catch (err) {
    if (!err.status) console.error('[facilities] sync failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
