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
  // rejectUnauthorized defaults to true (M-9 security fix).
  // Set DATABASE_SSL=false to disable SSL entirely (local dev without SSL).
  // Set DATABASE_SSL_REJECT_UNAUTHORIZED=false only if your managed PG host
  // uses self-signed internal certs and you cannot supply DATABASE_SSL_CA.
  const sslConfig = dbUrl
    ? process.env.DATABASE_SSL === 'false' ? false : {
        rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
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
};
