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

  // Railway PostgreSQL always requires SSL — enable it regardless of NODE_ENV
  // rejectUnauthorized: false is required because Railway uses self-signed certs
  const sslConfig = dbUrl
    ? { rejectUnauthorized: false }
    : false;

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
