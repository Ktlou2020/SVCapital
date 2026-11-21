'use strict';
const pool   = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

/* audit_events.user_id is `UUID REFERENCES users(id)`. Two consequences that
   cost us rows:

   - An actor id that is not a UUID fails the cast, and the whole INSERT with
     it. Staff authenticated by empId rather than a users row are exactly that
     case, so their actions went unrecorded.
   - An id that no longer resolves — a deleted user — fails the foreign key.

   Either way the previous version logged CRITICAL and dropped the event. An
   audit trail that loses a row when the actor cannot be linked is worse than
   one that keeps the row without the link: you cannot tell "nothing happened"
   from "something happened and we failed to write it down".

   So the link is best-effort and the record is not. A non-UUID actor is kept
   verbatim in metadata as actor_ref, and a failed insert is retried once with
   user_id NULL before anything is given up on. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function log({ actorId = null, actorEmail = null, actorRole = null, action, entityType = null, entityId = null, description, before = null, after = null, ip = null, platform = null } = {}) {
  const linkable = actorId && UUID_RE.test(String(actorId)) ? String(actorId) : null;

  const meta = {};
  if (before || after) { meta.before = before; meta.after = after; }
  // Keep the actor even when it cannot be a foreign key.
  if (actorId && !linkable) meta.actor_ref = String(actorId);

  const insert = (userId, metadata) => pool.query(
    `INSERT INTO audit_events (id, event_type, entity_type, entity_id, user_id, user_email, actor_role, description, ip_address, metadata, platform, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
    [uuidv4(), action, entityType, entityId ? String(entityId) : null,
     userId, actorEmail || null, actorRole || null, description, ip || null,
     Object.keys(metadata).length ? JSON.stringify(metadata) : null, platform || null]
  );

  try {
    await insert(linkable, meta);
    return;
  } catch (err) {
    // The link is the most likely thing to have failed. Drop it, keep the row.
    try {
      await insert(null, { ...meta, actor_ref: meta.actor_ref || (actorId ? String(actorId) : undefined), link_error: err.message });
      console.warn(`[audit] recorded "${action}" without an actor link: ${err.message}`);
      return;
    } catch (err2) {
      console.error('[audit] CRITICAL: Failed to write audit event', {
        event: { action, entityType, entityId, actorId, actorEmail }, err: err2.message,
      });

      /* A LOST AUDIT ROW IS ITSELF AN INCIDENT, and it used to end here — at
       * a console line on a log nobody watches, beside a note about routing
       * it to an external SIEM nobody was going to buy. The platform
       * already has the sink that note asked for:
       * services/incidents.js folds repeats by
       * fingerprint, throttles, and tells somebody by webhook or email.
       *
       * AND IT CARRIES THE EVENT, not just the fact of the failure. The
       * whole point of an audit trail is that the row can be reconstructed
       * and re-entered; "an audit write failed" tells you only that
       * something you cannot name has gone unrecorded. So the event is in
       * the incident's context, in full.
       *
       * Both errors are kept: the first says why the actor could not be
       * linked, the second why the row could not be written at all, and
       * they are usually different faults.
       *
       * Required HERE rather than at the top of the file. incidents.js
       * requires the pool, email.js requires the pool and incidents, and a
       * cycle at load time leaves one of them half-built — the same reason
       * incidents.js itself requires email lazily. Nothing in this path is
       * hot: it only runs when an audit write has already failed twice.
       *
       * It cannot throw: report() swallows its own failures to the console
       * by design, and the await is guarded anyway. An audit failure must
       * not become the reason a deposit or a payout fails. */
      try {
        await require('./incidents').report(
          new Error(`audit write failed for "${action}": ${err2.message}`),
          {
            source: 'audit.log', severity: 'critical',
            details: {
              action, entity_type: entityType,
              entity_id: entityId ? String(entityId) : null,
              actor_id: actorId ? String(actorId) : null,
              actor_email: actorEmail || null, actor_role: actorRole || null,
              description, ip, platform,
              metadata: Object.keys(meta).length ? meta : null,
              link_error: err.message,
              write_error: err2.message,
              lost_at: new Date().toISOString(),
            },
          });
      } catch (err3) {
        console.error('[audit] could not even raise an incident for the lost event:',
                      err3 && err3.message);
      }
    }
  }
}

module.exports = { log };
