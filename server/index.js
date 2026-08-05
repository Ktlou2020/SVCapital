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
      // Narrowed from '*' — external images only allowed from trusted chart/QR sources
      imgSrc:        ["'self'", 'data:', 'blob:', 'api.qrserver.com', 'chart.googleapis.com', 'img.youtube.com', 'i.ytimg.com'],
      connectSrc:    ["'self'", 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'api.paystack.co', '*.paystack.co', 'pay.ozow.com'],
      frameSrc:      ["'self'", 'checkout.paystack.com'],
      objectSrc:     ["'none'"],
    },
  },
  // Disable browser features not used by this financial platform
  permissionsPolicy: {
    features: {
      camera:             [],
      microphone:         [],
      geolocation:        [],
      usb:                [],
      payment:            ["'self'", 'checkout.paystack.com'],
      fullscreen:         ["'self'"],
      displayCapture:     [],
    },
  },
}));
app.use(compression());

/* ─── CORS ─── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Native-app origins are always allowed regardless of ALLOWED_ORIGINS env var.
// Capacitor iOS uses capacitor://localhost; Capacitor Android uses http://localhost.
// These must never be dropped when ALLOWED_ORIGINS overrides the web origins.
const NATIVE_ORIGINS  = ['capacitor://localhost', 'ionic://localhost', 'http://localhost', 'https://localhost'];
const STAGING_ORIGINS = ['https://svcapital-staging.up.railway.app'];
const DEFAULT_PROD_ORIGINS = ['https://platform.svcapital.co.za', 'https://svcapital.co.za', 'https://www.svcapital.co.za', ...STAGING_ORIGINS, ...NATIVE_ORIGINS];
const DEFAULT_DEV_ORIGINS  = ['http://localhost:3000', 'http://localhost:8080', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:8080', ...NATIVE_ORIGINS];
// Merge env-var list with native + staging origins so ALLOWED_ORIGINS only needs to list production web domains.
const EFFECTIVE_ORIGINS = ALLOWED_ORIGINS.length > 0
  ? [...new Set([...ALLOWED_ORIGINS, ...NATIVE_ORIGINS, ...STAGING_ORIGINS])]
  : (IS_PROD ? DEFAULT_PROD_ORIGINS : DEFAULT_DEV_ORIGINS);
if (IS_PROD && ALLOWED_ORIGINS.length === 0) {
  console.info(`[cors] ALLOWED_ORIGINS env var not set — defaulting to: ${DEFAULT_PROD_ORIGINS.join(', ')}. Set ALLOWED_ORIGINS to override.`);
}

app.use(cors({
  origin: (origin, cb) => {
    // Same-origin requests (no Origin header) are always allowed
    if (!origin) return cb(null, true);
    if (EFFECTIVE_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Platform'],
}));

/* ─── Body & Cookie parsers ─── */
// Raw body capture for Paystack webhook HMAC verification (must come before express.json)
app.use('/api/payments/paystack/webhook', (req, res, next) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    req.rawBody = raw;
    try { req.body = JSON.parse(raw || '{}'); } catch (_) { req.body = {}; }
    next();
  });
});
// Routes that embed base64 file data — raised body limit
app.use('/api/tables/kyc_documents', express.json({ limit: '15mb' }));
app.use('/api/tables/kyc_documents', express.urlencoded({ extended: true, limit: '15mb' }));
app.use('/api/tables/support_tickets', express.json({ limit: '15mb' }));
app.use('/api/tables/support_tickets', express.urlencoded({ extended: true, limit: '15mb' }));
// Conservative limit for all other routes
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
const staffPinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many PIN attempts from this device — please try again in 15 minutes.' },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many write requests. Please slow down.' },
  skip: (req) => req.user && (req.user.role === 'admin' || req.user.role === 'director'),
});

app.use('/api/', apiLimiter);
app.use(['/api/tables'], (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return writeLimiter(req, res, next);
  next();
});
app.use('/api/auth/', authLimiter);
app.use('/api/auth/staff-token', staffPinLimiter);
app.use('/api/auth/staff-lookup', staffPinLimiter);

/* Prevent caching of all API responses */
app.use('/api/', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ─── API Routes ─── */
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/tables',      require('./routes/tables'));
app.use('/api/fica',        require('./routes/fica'));
app.use('/api/payments',    require('./routes/payments'));
app.use('/api/admin',       require('./routes/broadcast'));
app.use('/api/admin',       require('./routes/bankVerify'));
app.use('/api/admin',       require('./routes/manualCredit'));
app.use('/api/push',        require('./routes/push'));
// Mobile app push-token shortcut (Capacitor bridge calls /api/investors/push-token)
app.post('/api/investors/push-token', require('./middleware/auth').requireAuth, (req, res, next) => {
  req.url = '/mobile-token';
  require('./routes/push')(req, res, next);
});
app.use('/api/privacy',     require('./routes/privacy'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/analytics',  require('./routes/friction'));
app.use('/api/statements', require('./routes/statements'));
app.use('/api/waitlist',   require('./routes/waitlist'));
app.use('/api/migrate',   require('./routes/migrate'));
app.use('/api/address',   require('./routes/address'));
app.use('/api/events',    require('./routes/events').router);
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/legal',     require('./routes/legal'));
app.use('/api/quests',        require('./routes/quests'));
app.use('/api/testimonials',  require('./routes/testimonials'));
app.use('/api/email-logs',    require('./routes/emailLogs'));
app.use('/api/investments', require('./routes/investments'));
app.use('/api/gifts',        require('./routes/gifts'));
app.use('/api/factsheets',   require('./routes/factsheets'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/opsconsole',  require('./routes/opsconsole'));
app.use('/api/cattle',      require('./routes/cattle'));
app.use('/api/pe',          require('./routes/pe-extract'));
app.use('/api/pe/documents', require('./routes/pe-documents'));


/* ─── Health Check ─────────────────────────────────────────────────────────
   Always returns HTTP 200 so Railway knows the process is alive.
   DB connectivity is reported in the body but does NOT affect the status code.
   (Railway healthcheck kills the container on any non-2xx response.)
   ──────────────────────────────────────────────────────────────────────── */
app.get('/api/health', async (req, res) => {
  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'ok',
      db:     true,
      ts:     new Date().toISOString(),
      env:    process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
    return res.status(503).json({ status: 'error', db: false });
  }
});

/* ─── SEO Files — must be before the .html redirect middleware ─── */
app.get('/sitemap.xml', (_req, res) => res.sendFile(path.join(__dirname, '..', 'sitemap.xml'), { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' } }));
app.get('/robots.txt',  (_req, res) => res.sendFile(path.join(__dirname, '..', 'robots.txt'),  { headers: { 'Content-Type': 'text/plain',       'Cache-Control': 'public, max-age=86400' } }));

/* ─── Legal Pages — served directly at both /page and /page.html ─── */
// These must come BEFORE the .html redirect so they are never intercepted.
['terms', 'popia', 'paia', 'complaints'].forEach(page => {
  const file = path.join(__dirname, '..', `${page}.html`);
  const handler = (_req, res) => res.sendFile(file, {
    headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' },
  });
  app.get(`/${page}`, handler);
  app.get(`/${page}.html`, handler);
});

/* ─── Password reset page — must be before the .html redirect middleware ─── */
// The email link contains /reset-password.html?token=... which the redirect
// middleware would strip to /reset-password, then fall back to index.html.
// Register it explicitly here so the token query string is preserved.
{
  const resetFile = path.join(__dirname, '..', 'portal', 'reset-password.html');
  const resetHandler = (_req, res) => res.sendFile(resetFile, {
    headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' },
  });
  app.get('/reset-password', resetHandler);
  app.get('/reset-password.html', resetHandler);
}

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
const server = app.listen(PORT, '0.0.0.0', async () => {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  console.log('');
  console.log('🚀 SV Capital server started');
  console.log(`   Port:        ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Database:    ${dbUrl ? `✅ DATABASE_URL set (${dbUrl.split('@').pop()?.split('/')[0] || 'host hidden'})` : '⚠️  DATABASE_URL NOT SET'}`);
  console.log(`   SSL:         ${dbUrl ? '✅ enabled (rejectUnauthorized: false)' : '⚠️  no URL — SSL inactive'}`);
  console.log(`   JWT Secret:  ${process.env.JWT_SECRET ? '✅ set' : '❌ NOT SET — all authentication will fail'}`);
  console.log('');

  // Auto-create tables and seed demo data on first boot
  const autoSetup = require('./db/setup');
  await autoSetup();

  // Start FICA annual re-check cron (requires DATABASE_URL)
  const { startFicaCron } = require('./jobs/ficaCron');
  startFicaCron();

  // Start maturity alert cron (daily 08:00 SAST)
  const { startMaturityCron } = require('./jobs/maturityCron');
  startMaturityCron();

  // Interest is credited at maturity only (maturityCron) — monthly accrual disabled.
  // const { startInterestCron } = require('./jobs/interestCron');
  // startInterestCron();

  // Payout processing is now consolidated into the maturity engine (maturityCron).
  // The standalone payoutCron has been retired.

  // Start monthly statement cron (1st of month, 07:00 SAST)
  const { startStatementCron } = require('./jobs/statementCron');
  startStatementCron();

  // Start monthly director report cron (1st of month, 07:00 UTC / 09:00 SAST)
  const { startDirectorReportCron } = require('./jobs/directorReportCron');
  startDirectorReportCron();

  // Start recurring investment cron (1st of month, 03:00 UTC / 05:00 SAST)
  const { startRecurringCron } = require('./jobs/recurringCron');
  startRecurringCron();

  // Start pool auto-cycling cron (daily 00:30 SAST)
  const { startPoolCyclerCron } = require('./jobs/poolCyclerCron');
  startPoolCyclerCron();

  // Archive dormant investors (no investments after 6 months) — daily 00:00 UTC
  const { startArchiveCron } = require('./jobs/archiveCron');
  startArchiveCron();

  // Withdrawal alert to admins — 10:00, 13:00, 16:00 SAST if pending requests exist
  const { startWithdrawalAlertCron } = require('./jobs/withdrawalAlertCron');
  startWithdrawalAlertCron();

  // Email queue processor — runs every 2 minutes
  const emailQueueCron = require('node-cron');
  const { processQueue } = require('./services/emailQueue');
  emailQueueCron.schedule('*/2 * * * *', () => {
    processQueue().catch(e => console.error('[emailQueue cron]', e.message));
  });

  // Self-ping every 4 minutes — keeps the Node process and DB pool warm so
  // the first real user request is never cold. Works on all Railway plan tiers.
  const http = require('http');
  emailQueueCron.schedule('*/4 * * * *', () => {
    const req = http.get(`http://localhost:${PORT}/api/health`, res => {
      res.resume(); // drain response body so socket is freed
    });
    req.on('error', () => {}); // ignore — server may be mid-restart
    req.setTimeout(5000, () => req.destroy());
  });
});

/* ─── Graceful Shutdown ─── */
async function shutdown(signal) {
  console.log(`\n[${signal}] Graceful shutdown initiated…`);
  server.close(async () => {
    console.log('[shutdown] HTTP server closed');
    try {
      const pool = require('./db/pool');
      await pool.end();
      console.log('[shutdown] DB pool closed');
    } catch (e) {
      console.error('[shutdown] DB pool close error:', e.message);
    }
    process.exit(0);
  });
  // Force exit after 15 seconds if shutdown stalls
  setTimeout(() => { console.error('[shutdown] Forced exit after timeout'); process.exit(1); }, 15000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
