'use strict';
/* Whose cattle are whose.
 *
 * A batch (cattle_cycles) carries ONE company. Some batches hold cattle
 * belonging to more than one, and there was nowhere to say so — the header
 * said one thing and the herd was two, so "how many head does this company
 * own" could not be answered from the platform at all.
 *
 * ONE DEFINITION OF OWNERSHIP, and it is COALESCE(animal, batch): an animal
 * belongs to its batch's company unless it has been allocated away. That is
 * what is already true of every row in the table, so nothing needed
 * backfilling and the totals are right the moment the column exists. It also
 * means a batch with a single owner stays a batch with a single owner and
 * nobody has to allocate anything.
 *
 * ALLOCATION IS BY COUNT, not by tag. "120 head to Company A" is how the
 * split is actually known, and the tags are not: which 120 is arbitrary. So
 * the system picks them — deterministically, in tag order, so the same
 * request twice chooses the same animals — and every allocated tag can be
 * listed afterwards, because an ownership claim you cannot enumerate is not
 * worth much.
 *
 * AND IT SETS A TOTAL RATHER THAN ADDING. setAllocation(cycle, company, 120)
 * means "this company owns 120 head of this batch", whatever it owned
 * before. Asking for 120 twice leaves 120. An "allocate 120 more" button
 * pressed twice by somebody unsure whether the first press worked is how a
 * batch ends up over-allocated, and this one cannot be.
 */

/* Whose animal is this? Used wherever ownership is counted, so the rollup,
   the batch detail and any report that follows cannot disagree. */
const OWNER_SQL = (a = 'a', c = 'c') => `COALESCE(NULLIF(${a}.company, ''), ${c}.company)`;

function ownerOf(animal, cycle) {
  const own = animal && typeof animal.company === 'string' ? animal.company.trim() : '';
  if (own) return own;
  return (cycle && cycle.company) || null;
}

/* The states an animal can be in, as one expression, because "live" is
   three columns disagreeing and every count here has to read it the same
   way the reconciliation service does. */
const LIVE_SQL = `(COALESCE(a.status, 'active') NOT IN ('sold','mortality')
                   AND COALESCE(a.sold, false) = false
                   AND COALESCE(a.mortality, false) = false)`;
const SOLD_SQL = `(a.status = 'sold' OR a.sold = true)`;
const DEAD_SQL = `(a.status = 'mortality' OR a.mortality = true)`;

/* ── The split of one batch ──────────────────────────────────────────── */

async function splitFor(db, cycleId) {
  const { rows } = await db.query(
    `SELECT ${OWNER_SQL()} AS company,
            COUNT(*)::int                          AS head,
            COUNT(*) FILTER (WHERE ${LIVE_SQL})::int AS live,
            COUNT(*) FILTER (WHERE ${SOLD_SQL})::int AS sold,
            COUNT(*) FILTER (WHERE ${DEAD_SQL})::int AS mortalities,
            COUNT(*) FILTER (WHERE a.company IS NOT NULL
                               AND a.company <> '')::int AS allocated
       FROM cattle_animals a
       JOIN cattle_cycles  c ON c.id = a.cycle_id
      WHERE a.cycle_id = $1
      GROUP BY 1
      ORDER BY 2 DESC, 1`, [cycleId]);
  return rows.map(r => ({
    company: r.company, head: r.head, live: r.live,
    sold: r.sold, mortalities: r.mortalities, allocated: r.allocated,
  }));
}

/* Is this batch owned by more than one company? The cycles list says
   "Mixed" on the strength of this rather than on the header, which by
   definition only ever names one. */
function isMixed(split) {
  return (split || []).filter(s => s.company).length > 1;
}

/* ── Setting a company's share of one batch ──────────────────────────── */

/* Returns { company, requested, now, moved, released } or { error, status }.
 *
 * Every refusal is a sentence somebody can act on, and every one of them
 * happens before a single row is written. */
async function setAllocation(db, cycleId, companyRaw, headCount) {
  const company = String(companyRaw || '').trim();
  const want    = Number(headCount);

  if (!company) return { status: 400, error: 'Name the company the cattle belong to.' };
  if (!Number.isInteger(want) || want < 0) {
    return { status: 400, error: 'The number of head must be a whole number, zero or more.' };
  }

  const { rows: [cycle] } = await db.query(
    'SELECT id, batch_name, company FROM cattle_cycles WHERE id = $1 FOR UPDATE', [cycleId]);
  if (!cycle) return { status: 404, error: 'No such batch.' };

  /* Allocating to the batch's OWN company is releasing, not allocating:
     those animals belong to it by default and stamping them would make the
     column say something the batch already says. */
  const isOwnCompany = String(cycle.company || '').trim().toLowerCase() === company.toLowerCase();

  const { rows: all } = await db.query(
    `SELECT id, company FROM cattle_animals
      WHERE cycle_id = $1
      ORDER BY NULLIF(REGEXP_REPLACE(COALESCE(tag_number, ''), '\\D', '', 'g'), '')::bigint
                 NULLS LAST,
               tag_number NULLS LAST, id`, [cycleId]);

  if (!all.length) {
    return { status: 409,
      error: 'That batch has no individual animals recorded, so there is nothing to allocate. '
           + 'Import the animals first.' };
  }

  const mine   = all.filter(a => String(a.company || '').trim().toLowerCase() === company.toLowerCase());
  /* Takeable: the batch's own default pool. Never another company's — moving
     cattle from one company to another is two decisions and has to be made
     as two. */
  const takeable = isOwnCompany
    ? all.filter(a => a.company)                      // releasing: anything stamped
    : all.filter(a => !a.company);

  if (isOwnCompany) {
    return { status: 400,
      error: `${company} is the batch's own company, so its cattle are already counted against `
           + 'it. Allocate the OTHER company\'s head instead, and the rest stay here.' };
  }

  if (want > mine.length + takeable.length) {
    return { status: 409,
      error: `There are only ${mine.length + takeable.length} head available to give ${company} `
           + `in this batch — ${mine.length} already allocated to them and ${takeable.length} `
           + `still with ${cycle.company || 'the batch'}. The rest belong to another company.` };
  }

  let moved = 0, released = 0;
  if (want > mine.length) {
    const take = takeable.slice(0, want - mine.length).map(a => a.id);
    if (take.length) {
      await db.query(
        `UPDATE cattle_animals SET company = $1, company_set_at = NOW(), updated_at = NOW()
          WHERE id = ANY($2::text[])`, [company, take]);
      moved = take.length;
    }
  } else if (want < mine.length) {
    /* Released LAST IN FIRST OUT, so releasing what you just allocated
       returns exactly those animals rather than a different set. */
    const give = mine.slice(want).map(a => a.id);
    if (give.length) {
      await db.query(
        `UPDATE cattle_animals SET company = NULL, company_set_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::text[])`, [give]);
      released = give.length;
    }
  }

  return { company, requested: want, now: want, moved, released,
           batchCompany: cycle.company || null, batchName: cycle.batch_name || cycleId };
}

/* ── Across every batch ──────────────────────────────────────────────── */

/* What each company owns, platform-wide.
 *
 * PURCHASE VALUE IS PER BATCH, because cost per head is: a company holding
 * 50 head of a cheap batch and 50 of an expensive one has not bought 100
 * average animals. So it is summed per animal from its own batch's
 * avg_cattle_cost rather than from a blended figure.
 *
 * There is deliberately no projected market value here. There is one
 * projected-per-head figure on the platform, it belongs to the board pack,
 * and splitting a single constant across companies tells nobody anything
 * the live head count does not already say.
 */
async function rollup(db) {
  const { rows } = await db.query(
    `SELECT ${OWNER_SQL()} AS company,
            COUNT(DISTINCT c.id)::int                 AS batches,
            COUNT(*)::int                             AS head,
            COUNT(*) FILTER (WHERE ${LIVE_SQL})::int  AS live,
            COUNT(*) FILTER (WHERE ${SOLD_SQL})::int  AS sold,
            COUNT(*) FILTER (WHERE ${DEAD_SQL})::int  AS mortalities,
            COALESCE(SUM(COALESCE(c.avg_cattle_cost, 0)), 0)                      AS purchase_value,
            COALESCE(SUM(CASE WHEN ${SOLD_SQL} THEN COALESCE(a.sale_value, 0) ELSE 0 END), 0) AS realised_value
       FROM cattle_animals a
       JOIN cattle_cycles  c ON c.id = a.cycle_id
      WHERE ${OWNER_SQL()} IS NOT NULL
      GROUP BY 1
      ORDER BY 3 DESC, 1`);
  return rows.map(r => ({
    company: r.company,
    batches: r.batches, head: r.head, live: r.live, sold: r.sold, mortalities: r.mortalities,
    purchaseValue: Number(r.purchase_value) || 0,
    realisedValue: Number(r.realised_value) || 0,
  }));
}

/* The batches whose animals do not all answer to one company.
 *
 * The cycles list says "Mixed" on the strength of this. It cannot say it
 * from the header, which carries exactly one company by construction and
 * is therefore never the thing that is mixed. One query for the whole
 * list, because a card asking per batch is a query per card. */
async function mixedCycleIds(db) {
  const { rows } = await db.query(
    `SELECT a.cycle_id
       FROM cattle_animals a
       JOIN cattle_cycles  c ON c.id = a.cycle_id
      GROUP BY a.cycle_id
     HAVING COUNT(DISTINCT ${OWNER_SQL()}) > 1`);
  return rows.map(r => r.cycle_id);
}

/* The companies already in use, so the console offers them rather than
   asking somebody to type a name that has to match exactly. */
async function known(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT company FROM (
         SELECT company FROM cattle_cycles  WHERE company IS NOT NULL AND company <> ''
          UNION ALL
         SELECT company FROM cattle_animals WHERE company IS NOT NULL AND company <> ''
       ) t
      ORDER BY company`);
  return rows.map(r => r.company);
}

module.exports = { OWNER_SQL, ownerOf, LIVE_SQL, SOLD_SQL, DEAD_SQL,
                   splitFor, isMixed, setAllocation, rollup, known, mixedCycleIds };
