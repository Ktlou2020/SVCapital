/* ═══════════════════════════════════════════════════════
   SV Capital — Express Backend Server
   Serves:
   • /api/auth/*    — Authentication (login, register, me)
   • /api/users/*   — User management (admin only)
   • /api/tables/*  — Generic CRUD for all data tables
   • Static files   — All frontend HTML/CSS/JS
   ═══════════════════════════════════════════════════════ */
'use strict';

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── Trust Railway/proxy headers ─── */
app.set('trust proxy', 1);

/* ─── Security & Compression ─── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', '*.googleapis.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'cdnjs.cloudflare.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
      imgSrc:      ["'self'", 'data:', 'blob:', '*'],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
}));
app.use(compression());

/* ─── CORS ─── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

/* ─── Body & Cookie parsers ─── */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ─── Rate Limiting ─── */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again in 15 minutes.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please try again in 15 minutes.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

/* ─── API Routes ─── */
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/users',  require('./routes/users'));
app.use('/api/tables', require('./routes/tables'));

/* ─── One-time Provision Endpoint ───────────────────────────────────────────
   GET /api/provision?secret=<PROVISION_SECRET>
   Forces a wipe of the users table and re-seeds the COO account.
   Protected by PROVISION_SECRET env var (defaults to 'svc-provision-2026').
   Remove or disable this route once the platform is fully set up.
   ──────────────────────────────────────────────────────────────────────── */
app.get('/api/provision', async (req, res) => {
  const secret = process.env.PROVISION_SECRET || 'svc-provision-2026';
  if (req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  try {
    const pool   = require('./db/pool');
    const bcrypt = require('bcryptjs');

    const cooPassword = process.env.COO_PASSWORD || 'SvCap!C00#2026';
    const cooHash     = await bcrypt.hash(cooPassword, 12);

    await pool.query('DELETE FROM users');
    await pool.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name)
      VALUES ('coo@svcapital.co.za', $1, 'director', 'COO', 'SV Capital')
    `, [cooHash]);

    const { rows } = await pool.query('SELECT id, email, role, created_at FROM users');
    console.log('✅ Provision endpoint: COO account created.');
    res.json({
      success:  true,
      message:  'Users table wiped. COO account created.',
      users:    rows,
      password: cooPassword,
    });
  } catch (err) {
    console.error('Provision error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── Health Check ─────────────────────────────────────────────────────────
   Always returns HTTP 200 so Railway knows the process is alive.
   DB connectivity is reported in the body but does NOT affect the status code.
   (Railway healthcheck kills the container on any non-2xx response.)
   ──────────────────────────────────────────────────────────────────────── */
app.get('/api/health', async (req, res) => {
  let dbStatus = 'unknown';
  let dbError  = null;
  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (err) {
    dbError  = err.message || String(err);
    dbStatus = 'disconnected';
    console.warn('Health check — DB not reachable:', dbError);
  }
  // Always 200 — the server is up regardless of DB state
  res.status(200).json({
    status:   'ok',
    db:       dbStatus,
    dbError:  dbError,
    dbUrl:    process.env.DATABASE_URL ? '✅ set' : '❌ not set',
    ts:       new Date().toISOString(),
    env:      process.env.NODE_ENV || 'development',
  });
});

/* ─── Static Frontend Files ─── */
const STATIC_DIR = path.join(__dirname, '..');
app.use(express.static(STATIC_DIR, {
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

/* ─── SPA Fallback ─── */
app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

/* ─── Global Error Handler ─── */
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

/* ─── Start ─── */
app.listen(PORT, '0.0.0.0', async () => {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  console.log('');
  console.log('🚀 SV Capital server started');
  console.log(`   Port:        ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Database:    ${dbUrl ? `✅ DATABASE_URL set (${dbUrl.split('@').pop()?.split('/')[0] || 'host hidden'})` : '⚠️  DATABASE_URL NOT SET'}`);
  console.log(`   SSL:         ${dbUrl ? '✅ enabled (rejectUnauthorized: false)' : '⚠️  no URL — SSL inactive'}`);
  console.log(`   JWT Secret:  ${process.env.JWT_SECRET ? '✅ set' : '⚠️  using default (insecure)'}`);
  console.log('');

  // Auto-create tables and seed demo data on first boot
  const autoSetup = require('./db/setup');
  await autoSetup();
});

module.exports = app;
