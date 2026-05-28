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
const fs           = require('fs');

const app     = express();
const PORT    = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ─── Trust Railway/proxy headers ─── */
app.set('trust proxy', 1);

/* ─── Security & Compression ─── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', '*.googleapis.com', 'js.paystack.co'],
      // Allow inline onclick=/onkeydown= event handler attributes.
      // helmet sets this to 'none' by default, overriding unsafe-inline in scriptSrc.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'cdnjs.cloudflare.com'],
      fontSrc:       ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
      imgSrc:        ["'self'", 'data:', 'blob:', '*'],
      connectSrc:    ["'self'", 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'api.paystack.co', '*.paystack.co'],
      frameSrc:      ["'self'", 'checkout.paystack.com'],
      objectSrc:     ["'none'"],
    },
  },
}));
app.use(compression());

/* ─── CORS ─── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Same-origin requests (no Origin header) are always allowed
    if (!origin) return cb(null, true);
    // If no whitelist is configured, allow all origins (dev/unconfig'd deployments)
    if (ALLOWED_ORIGINS.length === 0) {
      if (IS_PROD) console.warn('⚠️  CORS: ALLOWED_ORIGINS not set — all origins permitted. Set this env var in production.');
      return cb(null, true);
    }
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
  max: 2000,
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

    // 1. Wipe and re-create the main login user (JWT auth)
    await pool.query('DELETE FROM users');
    await pool.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name)
      VALUES ('coo@svcapital.co.za', $1, 'director', 'COO', 'SV Capital')
    `, [cooHash]);

    // 2. Ensure employees table has required columns
    await pool.query(`
      DO $$ BEGIN
        BEGIN ALTER TABLE employees ADD COLUMN level TEXT DEFAULT 'junior'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employees ADD COLUMN id_number TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employees ADD COLUMN avatar_initials TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employees ADD COLUMN avatar_color TEXT DEFAULT '#7c5cfc'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employees ADD COLUMN xp_points INT DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
      END $$
    `);

    // 3. Upsert COO employee record (for team/login.html — PIN = last 4 of id_number = 9001)
    await pool.query(`
      INSERT INTO employees
        (id, first_name, last_name, email, role, level, department,
         status, id_number, avatar_initials, avatar_color, xp_points, hire_date)
      VALUES
        ('EMP-COO-001', 'COO', 'SV Capital', 'coo@svcapital.co.za',
         'CEO', 'executive', 'Executive',
         'active', '0000000009001', 'CO', '#7c5cfc', 0, NOW())
      ON CONFLICT (email) DO UPDATE SET
        role = 'CEO', level = 'executive', department = 'Executive',
        status = 'active', id_number = '0000000009001',
        avatar_initials = 'CO', avatar_color = '#7c5cfc'
    `);

    const { rows: users }     = await pool.query('SELECT id, email, role, created_at FROM users');
    const { rows: employees } = await pool.query('SELECT id, email, role, level, id_number FROM employees WHERE email = $1', ['coo@svcapital.co.za']);
    console.log('✅ Provision endpoint: COO user + employee created.');
    res.json({
      success:        true,
      message:        'Users wiped. COO login user + employee record created.',
      loginUser:      users,
      employeeRecord: employees,
      loginDetails: {
        mainLogin:    { url: '/login.html',       email: 'coo@svcapital.co.za', password: cooPassword, redirectsTo: '/admin/index.html' },
        teamLogin:    { url: '/team/login.html',  email: 'coo@svcapital.co.za', pin: '9001 (last 4 digits of ID number)', redirectsTo: '/team/hub.html' },
      },
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

/* ─── Redirect legacy .html URLs to clean equivalents ─── */
// /login.html → /login  |  /fund/index.html → /fund  |  /team/director.html → /team/director
app.use((req, res, next) => {
  if (!req.path.endsWith('.html')) return next();
  let clean = req.path.slice(0, -5); // strip .html
  if (clean.endsWith('/index')) clean = clean.slice(0, -6); // /x/index → /x
  if (!clean) clean = '/';
  return res.redirect(301, clean + req.url.slice(req.path.length)); // preserve query string
});

/* ─── Static Frontend Files ─── */
const STATIC_DIR = path.join(__dirname, '..');
app.use(express.static(STATIC_DIR, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // HTML files: always revalidate
    if (/\.html$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    // JS and CSS files: revalidate (etag-based, no long cache)
    } else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    // Static assets (images, fonts): cache for 1 day
    } else if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

/* ─── Fallback: serve .html file for clean URLs, 404 for unknown assets ─── */
app.get('*', (req, res) => {
  const ext = path.extname(req.path);
  if (ext) return res.status(404).send('Not found');

  // /login → login.html  |  /team/director → team/director.html
  const htmlFile = path.join(STATIC_DIR, req.path + '.html');
  if (fs.existsSync(htmlFile)) return res.sendFile(htmlFile);

  // /fund or /fund/ → fund/index.html  (express.static handles /fund/ already,
  // this catches /fund without trailing slash when static doesn't redirect it)
  const indexFile = path.join(STATIC_DIR, req.path, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);

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
