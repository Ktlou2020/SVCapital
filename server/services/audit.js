'use strict';
const pool   = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

async function log({ actorId = null, actorEmail = null, action, entityType = null, entityId = null, description, before = null, after = null, ip = null } = {}) {
  try {
    const metadata = (before || after) ? JSON.stringify({ before, after }) : null;
    await pool.query(
      `INSERT INTO audit_events (id, event_type, entity_type, entity_id, user_id, user_email, description, ip_address, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [uuidv4(), action, entityType, entityId ? String(entityId) : null,
       actorId || null, actorEmail || null, description, ip || null, metadata]
    );
  } catch (e) {
    console.error('[audit] write error:', e.message);
  }
}

module.exports = { log };
