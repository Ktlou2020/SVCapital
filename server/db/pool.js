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

  if (!process.env.DATABASE_URL) {
    console.warn('⚠️  DATABASE_URL is not set — DB queries will fail until it is configured.');
  }

  _pool = new Pool({
    connectionString: process.env.DATABASE_URL || '',
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
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
