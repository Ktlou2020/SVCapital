'use strict';
/* Re-reading a facility's spreadsheet — once, for both callers.
 *
 * Two things trigger this: somebody pressing Re-read in the fund console, and
 * the schedule that keeps the console from being stale by default. They must
 * produce the same report, so the fetch, the plan and the write live here and
 * neither caller has a copy. A second upsert in a cron would drift from the
 * one behind the button, and the drift would be a figure a fund manager reads.
 *
 * WHAT IT WILL NOT DO:
 *
 *   · fetch anything but a published docs.google.com sheet, with a timeout
 *     and a size cap — the URL comes out of a database row, and a request
 *     with no ceiling is one that can hang a worker
 *   · delete a load that has disappeared from the sheet. It is REPORTED. A
 *     row vanishing from somebody else's spreadsheet is not authority to drop
 *     what we have already reported on
 *   · write anything when apply is false
 *   · touch a wallet, a schedule, NAV or a payout. This is a report.
 */

const crypto = require('crypto');
const svc    = require('./grainFacility');
const audit  = require('./audit');

const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES        = 8 * 1024 * 1024;

async function readSheet(url, fetchImpl) {
  if (!/^https:\/\/docs\.google\.com\//.test(String(url || ''))) {
    const e = new Error('A facility sheet must be a published docs.google.com URL.');
    e.status = 400; throw e;
  }
  const doFetch = fetchImpl || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(url, { signal: ctl.signal, redirect: 'follow',
                               headers: { Accept: 'text/html' } });
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

/* ── The whole operation ─────────────────────────────────────────────
   Returns the plan whether or not it was applied, so a preview and a write
   are the same answer with one flag different. */
async function sync(db, facility, { apply = false, actor, fetchImpl } = {}) {
  const f = facility;
  if (!f.loads_url) {
    const e = new Error('This facility has no sheet URL on it.');
    e.status = 400; throw e;
  }

  const warnings = [];
  const parsed = svc.parseLoads(await readSheet(f.loads_url, fetchImpl), {
    ourColumn: f.our_column,
    ourSharePct: f.our_share_pct === null || f.our_share_pct === undefined
      ? null : Number(f.our_share_pct),
    warnings,
  });

  let capital = null, deposits = [];
  if (f.capital_url) {
    const c = svc.parseCapital(await readSheet(f.capital_url, fetchImpl), { ourName: f.our_name });
    capital = c.capital; deposits = c.deposits;
  }

  /* What this sheet would change, against what is already stored — so a
     preview is about the sheet and not just a row count. */
  const { rows: had } = await db.query(
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
  if (!apply) return plan;

  const client = await db.connect();
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
    /* COALESCE so a run without the capital sheet does not wipe a figure an
       earlier one established. */
    await client.query(
      `UPDATE stl_facilities SET last_synced_at = NOW(), last_sync_by = $2,
              last_warnings = $3::jsonb, our_capital = COALESCE($4, our_capital),
              updated_at = NOW() WHERE id = $1`,
      [f.id, (actor && actor.email) || 'schedule', JSON.stringify(warnings), capital]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  /* Audited after the commit, and only when something moved. A schedule that
     logged every quiet run would bury the runs that changed a figure. */
  if (added.length || newlySettled.length || changed.length || warnings.length) {
    await audit.log({
      actorId: (actor && actor.id) || null,
      actorEmail: (actor && actor.email) || 'schedule',
      actorRole: (actor && actor.role) || 'system',
      action: 'facility_synced', entityType: 'facility', entityId: f.id,
      description: `${f.name} re-read from its spreadsheet: ${added.length} new load(s), `
        + `${newlySettled.length} newly settled, ${changed.length} changed. `
        + `Our share earned to date ${summary.our_margin_earned}. `
        + `${warnings.length} arithmetic warning(s).`,
      after: { counts: plan.counts, summary, warnings },
    }).catch(() => {});
  }

  return { ...plan, applied: true };
}

module.exports = { sync, readSheet, FETCH_TIMEOUT_MS, MAX_BYTES };
