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
  // Railway's internal PG host uses self-signed certs so rejectUnauthorized
  // defaults to false. Set DATABASE_SSL_REJECT_UNAUTHORIZED=true and supply
  // DATABASE_SSL_CA only after configuring a CA-signed cert on the DB host.
  // Set DATABASE_SSL=false to disable SSL entirely (local dev without SSL).
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
};
