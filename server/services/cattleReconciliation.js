'use strict';
/* Do the cycle headers agree with the animals?
 *
 * A cattle cycle is described twice. The cycle row carries no_purchased,
 * mortalities, no_sold and no_live — typed in by hand, or imported from a
 * spreadsheet that was typed in by hand. The animal rows carry the same facts
 * one tag at a time. Nothing has ever compared them.
 *
 * That matters more here than it looks, because NAV is built on the HEADER:
 * herd value is no_live × estimated mass × price. If no_live says 100 and
 * ninety-seven animals are on file, the fund is reporting three head it cannot
 * point at — and the error lands in a valuation, not in a count. The reverse is
 * just as bad: a mortality captured against the animal but never deducted from
 * the header keeps a dead animal in the NAV until the cycle closes.
 *
 * So this reports, per cycle, every place the two disagree, plus the two ways
 * an animal goes missing from its cycle entirely:
 *
 *   ORPHANS    animals with no cycle_id at all.
 *   UNLINKED   animals with no cycle_id whose batch_name matches a cycle. These
 *              are the recoverable ones — the link can be restored from the
 *              name, which is exactly what the importer does — and they are
 *              reported separately because they are fixable in one action
 *              rather than needing a person to work out where each belongs.
 *
 * It reports. It never writes. Deciding whether the header or the animals are
 * right is a question about the actual herd, and the answer is not in the
 * database.
 */

/* One row per cycle, with the animals counted alongside the header's own
   numbers. The counts come from a FILTERed aggregate rather than four
   subqueries so a cycle is scanned once. */
const RECONCILE = `
  SELECT c.id, c.batch_name, c.company, c.status, c.cycle_start_date,
         COALESCE(c.no_purchased, 0) AS h_purchased,
         COALESCE(c.mortalities,  0) AS h_mortalities,
         COALESCE(c.no_sold,      0) AS h_sold,
         COALESCE(c.no_live,      0) AS h_live,
         c.purchase_value,
         COALESCE(a.n_total,      0) AS a_total,
         COALESCE(a.n_mortalities,0) AS a_mortalities,
         COALESCE(a.n_sold,       0) AS a_sold,
         COALESCE(a.n_live,       0) AS a_live
    FROM cattle_cycles c
    LEFT JOIN (
      SELECT cycle_id,
             COUNT(*)::int                                                          AS n_total,
             COUNT(*) FILTER (WHERE status = 'mortality' OR mortality = true)::int  AS n_mortalities,
             COUNT(*) FILTER (WHERE status = 'sold'      OR sold      = true)::int  AS n_sold,
             COUNT(*) FILTER (WHERE COALESCE(status, 'active') NOT IN ('sold','mortality')
                                AND COALESCE(sold, false)      = false
                                AND COALESCE(mortality, false) = false)::int        AS n_live
        FROM cattle_animals
       WHERE cycle_id IS NOT NULL
       GROUP BY cycle_id
    ) a ON a.cycle_id = c.id
   ORDER BY c.cycle_start_date DESC NULLS LAST, c.batch_name`;

/* Animals adrift. `matched_cycle` is non-null when the batch name still names a
   real cycle, which is what makes the row recoverable. */
const ORPHANS = `
  SELECT x.id, x.tag_number, x.batch_name, x.batch_no, x.status,
         c.id AS matched_cycle, c.batch_name AS matched_batch
    FROM cattle_animals x
    LEFT JOIN cattle_cycles c
      ON x.batch_name IS NOT NULL
     AND LOWER(c.batch_name) = LOWER(x.batch_name)
   WHERE x.cycle_id IS NULL
   ORDER BY c.id NULLS LAST, x.batch_name, x.tag_number`;

const num = v => Number(v || 0);

/* A cycle with no animals on file at all is NOT a mismatch of four numbers —
   it is one fact, "nothing captured", and reporting it as four separate
   discrepancies buries the cycles that have a genuine off-by-three. Cycles
   imported header-only are common and legitimate, so they get their own
   bucket. */
function checksFor(r) {
  const out = [];
  const add = (key, label, header, counted) => {
    if (header !== counted) out.push({ key, label, header, counted, delta: counted - header });
  };
  add('purchased',   'Purchased',   num(r.h_purchased),   num(r.a_total));
  add('live',        'Live',        num(r.h_live),        num(r.a_live));
  add('sold',        'Sold',        num(r.h_sold),        num(r.a_sold));
  add('mortalities', 'Mortalities', num(r.h_mortalities), num(r.a_mortalities));
  return out;
}

/* Does the header balance against ITSELF? purchased should equal what is still
   alive plus what left the herd. This needs no animal records at all, so it
   catches bad headers on the header-only cycles too — where nothing else can. */
function headerImbalance(r) {
  const purchased = num(r.h_purchased);
  const accounted = num(r.h_live) + num(r.h_sold) + num(r.h_mortalities);
  if (!purchased && !accounted) return null;
  if (purchased === accounted) return null;
  return { purchased, accounted, delta: accounted - purchased };
}

async function reconcileCattle(db) {
  const [{ rows: cycleRows }, { rows: orphanRows }] = await Promise.all([
    db.query(RECONCILE),
    db.query(ORPHANS),
  ]);

  const mismatched = [], headerOnly = [], imbalanced = [];

  for (const r of cycleRows) {
    const base = {
      id: r.id, batchName: r.batch_name || r.id, company: r.company || null,
      status: r.status || null, startDate: r.cycle_start_date,
      header:  { purchased: num(r.h_purchased), live: num(r.h_live), sold: num(r.h_sold), mortalities: num(r.h_mortalities) },
      counted: { purchased: num(r.a_total),     live: num(r.a_live), sold: num(r.a_sold), mortalities: num(r.a_mortalities) },
      purchaseValue: num(r.purchase_value),
    };

    const imbalance = headerImbalance(r);
    if (imbalance) imbalanced.push({ ...base, imbalance });

    if (num(r.a_total) === 0) {
      /* Only worth listing if the header claims animals exist. */
      if (num(r.h_purchased) > 0) headerOnly.push(base);
      continue;
    }

    const checks = checksFor(r);
    if (checks.length) {
      /* The live count is the one NAV multiplies by, so a cycle whose live
         count is wrong is ranked above one that only miscounts history. */
      const liveOff = checks.find(c => c.key === 'live');
      mismatched.push({ ...base, checks, liveDelta: liveOff ? liveOff.delta : 0,
                        severity: liveOff && r.status === 'active' ? 'high' : 'normal' });
    }
  }

  mismatched.sort((a, b) =>
    (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) ||
    Math.abs(b.liveDelta) - Math.abs(a.liveDelta));

  const orphans  = orphanRows.map(o => ({
    id: o.id, tagNumber: o.tag_number, batchName: o.batch_name || null,
    batchNo: o.batch_no || null, status: o.status || null,
    matchedCycle: o.matched_cycle || null, matchedBatch: o.matched_batch || null,
  }));
  const relinkable = orphans.filter(o => o.matchedCycle);

  return {
    mismatched, headerOnly, imbalanced,
    orphans, relinkable,
    totals: {
      cycles:      cycleRows.length,
      mismatched:  mismatched.length,
      headerOnly:  headerOnly.length,
      imbalanced:  imbalanced.length,
      orphans:     orphans.length,
      relinkable:  relinkable.length,
      /* Head the NAV counts but cannot point at. Signed: positive means the
         header claims more live animals than exist on file. */
      liveOverstated: mismatched.reduce((s, c) => s - Math.min(0, c.liveDelta), 0),
      liveUnderstated: mismatched.reduce((s, c) => s + Math.max(0, c.liveDelta), 0),
    },
    verdict: (mismatched.length || orphans.length || imbalanced.length) ? 'found' : 'clean',
  };
}

/* Restores cycle_id on orphaned animals whose batch_name names exactly one
   cycle. The ids are re-derived here rather than accepted from the caller, for
   the same reason the EFT backfill does it: a stale page must not be able to
   move an animal into a cycle this query would not have chosen.
   `AND cycle_id IS NULL` repeats the condition the SELECT already applied, so
   an animal linked in the meantime is left where it is. */
async function relinkOrphanAnimals(db) {
  const { rowCount } = await db.query(`
    UPDATE cattle_animals x
       SET cycle_id = c.id, updated_at = NOW()
      FROM cattle_cycles c
     WHERE x.cycle_id IS NULL
       AND x.batch_name IS NOT NULL
       AND LOWER(c.batch_name) = LOWER(x.batch_name)
       AND (SELECT COUNT(*) FROM cattle_cycles d
             WHERE LOWER(d.batch_name) = LOWER(x.batch_name)) = 1`);
  return { relinked: rowCount };
}

module.exports = { reconcileCattle, relinkOrphanAnimals, RECONCILE, ORPHANS };
