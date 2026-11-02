/* ═══════════════════════════════════════════
   Database connection pool — PostgreSQL via pg
   Lazy-initialised: server starts even when
   DATABASE_URL is not yet set.
   ═══════════════════════════════════════════ */
'use strict';

const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (_pool) return _pool;

  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

  if (!dbUrl) {
    console.warn('⚠️  DATABASE_URL is not set — DB queries will fail until it is configured.');
  }

  // SSL configuration: SSL is enabled by default in production.
  // Railway (and most managed PG hosts) use self-signed internal certs, so
  // rejectUnauthorized defaults to false. The connection is still encrypted.
  // Set DATABASE_SSL=false to disable SSL entirely (local dev without SSL).
  // Set DATABASE_SSL_REJECT_UNAUTHORIZED=true to enforce CA-signed certs.
  const sslConfig = dbUrl
    ? process.env.DATABASE_SSL === 'false' ? false : {
        rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
        ca: process.env.DATABASE_SSL_CA || undefined,
      }
    : false;
  if (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL !== 'false') console.log('[db] SSL enabled');

  _pool = new Pool({
    connectionString: dbUrl,
    ssl: sslConfig,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  _pool.on('error', (err) => {
    console.error('DB pool error:', err.message);
  });

  return _pool;
}

module.exports = {
  query:   (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
  end:     (...args) => getPool().end(...args),

  /* How many connections exist and how many are sitting idle.
     pg exposes these; this wrapper did not pass them on, which meant a
     client borrowed and never released was invisible — and a leak like
     that drains the pool one request at a time until the whole server
     stops being able to reach the database, with no error anywhere saying
     so. A collection path leaked one per successful card charge and the
     only symptom was a check that hung instead of finishing. */
  get totalCount() { return getPool().totalCount; },
  get idleCount()  { return getPool().idleCount; },
  get waitingCount() { return getPool().waitingCount; },
  /* Borrowed and not yet given back. Zero, between requests. */
  get checkedOut() { const p = getPool(); return p.totalCount - p.idleCount; },
};
