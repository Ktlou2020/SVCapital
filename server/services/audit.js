'use strict';
const pool   = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

async function log({ actorId = null, actorEmail = null, actorRole = null, action, entityType = null, entityId = null, description, before = null, after = null, ip = null, platform = null } = {}) {
  try {
    const metadata = (before || after) ? JSON.stringify({ before, after }) : null;
    await pool.query(
      `INSERT INTO audit_events (id, event_type, entity_type, entity_id, user_id, user_email, actor_role, description, ip_address, metadata, platform, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [uuidv4(), action, entityType, entityId ? String(entityId) : null,
       actorId || null, actorEmail || null, actorRole || null, description, ip || null, metadata, platform || null]
    );
  } catch (err) {
    console.error('[audit] CRITICAL: Failed to write audit event', { event: { action, entityType, entityId, actorId }, err: err.message });
    // TODO: Route to external SIEM/logging sink — audit failures must not be silent in production
  }
}

module.exports = { log };
