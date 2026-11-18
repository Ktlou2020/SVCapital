'use strict';
/* ═══════════════════════════════════════════════════════════
   An amount-goal pool stops raising when its amount is there.

   A pool has one of two targets. A closing-date pool stops on its date, and
   poolCyclerCron has swept those for a long time. An amount-goal pool stops
   when the money is in — and nothing did that. The cycler's sweep is
   `end_date IS NOT NULL`, so a pool left without a close date was never
   swept, and no route caps an investment at target_amount or max_capacity.
   A pool that reached its goal went on taking money until somebody noticed
   and closed it by hand.

   ── 'active', NOT 'closed' ─────────────────────────────────────────────

   The console offers both words and they are not interchangeable. The
   cycler's comment is the authority: "closed is the end of the pool's life,
   after maturity. This is the middle of it." cycleExpiredPools excludes
   status 'closed' outright, so a pool parked there is out of the lifecycle
   for good. Stopping the raise is the same transition the cycler already
   makes for a lapsed pool, and it uses 'active'. So does this.

   ── STRAIGHT SQL, NOT A PATCH ──────────────────────────────────────────

   routes/tables.js emails EVERY WAITLISTED INVESTOR when a pool is PATCHed
   to 'active' or 'open' — the pool they were waiting for has opened. Filling
   a pool is the opposite of that news. The cycler writes its own SQL for
   exactly this reason and says so; this does the same, and the check asserts
   it never routes through the table API.

   ── ONE WAY ────────────────────────────────────────────────────────────

   Closing is not reversed if the target is later raised. A pool that
   reopened itself because somebody edited a figure would start taking money
   again with nobody told. An admin who wants it open sets it open.

   Idempotent by construction: the predicate is status = 'open', so a pool
   this closes cannot be closed twice, and the UPDATE returns no row the
   second time.
   ═══════════════════════════════════════════════════════════ */

const audit = require('./audit');

/* Which pools this rule is about, as one SQL predicate so the single-pool
   call and the sweep cannot disagree about what "full" means.

   COALESCE on target_type because the column was added with a default and
   rows written before it exist with NULL; every other read in the codebase
   treats a missing one as 'amount', and so does this.

   target_amount > 0 excludes a pool with no goal set — raised >= 0 is true
   of every pool on earth, and without this the first sweep would close all
   of them. */
const FULL = `
     COALESCE(status, '') = 'open'
 AND COALESCE(target_type, 'amount') = 'amount'
 AND COALESCE(target_amount, 0) > 0
 AND COALESCE(raised_amount, 0) >= COALESCE(target_amount, 0)`;

/* Close one pool if it is full. Called on the path that just added money, so
   the pool stops being offered in the same request that filled it rather
   than at the next sweep.

   Takes whatever db handle the caller is using — a pool, or a client inside
   a transaction — so a caller that is mid-transaction closes the pool with
   the same money that filled it, or neither happens. */
async function closeIfTargetMet(db, poolId, actor = null) {
  if (!poolId) return { closed: false, reason: 'no pool' };
  const { rows } = await db.query(
    `UPDATE investment_pools
        SET status = 'active', updated_at = NOW()
      WHERE id = $1 AND ${FULL}
      RETURNING id, name, target_amount, raised_amount`, [poolId]);

  if (!rows.length) return { closed: false };
  const p = rows[0];
  console.log(`[poolTarget] ${p.id} (${p.name}) reached its target — `
    + `R${Number(p.raised_amount).toFixed(2)} of R${Number(p.target_amount).toFixed(2)}. Stopped raising.`);

  /* Outside the caller's success path: an audit write that fails must not
     undo the close, and a pool quietly closing is exactly the kind of thing
     somebody will later want a name and a time for. */
  audit.log({
    actorId: (actor && actor.id) || null,
    actorEmail: (actor && actor.email) || 'system',
    actorRole: (actor && actor.role) || 'system',
    action: 'pool.target_reached',
    entityType: 'investment_pool', entityId: p.id,
    description: `${p.name} reached its target of R${Number(p.target_amount).toFixed(2)} `
      + `(raised R${Number(p.raised_amount).toFixed(2)}) and stopped raising.`,
    after: { status: 'active', target_amount: p.target_amount, raised_amount: p.raised_amount },
  }).catch(() => {});

  return { closed: true, pool: p };
}

/* The sweep. Every path that adds money calls closeIfTargetMet, so this
   exists for the ones that do not go through code at all — a figure typed
   into raised_amount in the console, a direct database edit, an import. It
   is the same predicate, so it cannot close something the live path would
   have left open. */
async function sweep(db) {
  const { rows } = await db.query(
    `UPDATE investment_pools
        SET status = 'active', updated_at = NOW()
      WHERE ${FULL}
      RETURNING id, name, target_amount, raised_amount`);
  for (const p of rows) {
    console.log(`[poolTarget] sweep: ${p.id} (${p.name}) was full and still open — `
      + `R${Number(p.raised_amount).toFixed(2)} of R${Number(p.target_amount).toFixed(2)}. Stopped raising.`);
    audit.log({
      actorEmail: 'system', actorRole: 'system',
      action: 'pool.target_reached',
      entityType: 'investment_pool', entityId: p.id,
      description: `${p.name} was already at its target of R${Number(p.target_amount).toFixed(2)} `
        + `(raised R${Number(p.raised_amount).toFixed(2)}) and stopped raising on the nightly sweep.`,
      after: { status: 'active', target_amount: p.target_amount, raised_amount: p.raised_amount },
    }).catch(() => {});
  }
  return { closed: rows.length, pools: rows };
}

module.exports = { closeIfTargetMet, sweep, FULL };
