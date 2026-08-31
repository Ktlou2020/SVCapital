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
  const MAX_WEBHOOK_BYTES = 1024 * 1024;   // Paystack payloads are a few KB
  const chunks = [];
  let size = 0;
  let done  = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    next(err);
  };

  req.on('data', chunk => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_WEBHOOK_BYTES) {
      const err = new Error('Webhook payload too large');
      err.status = 413;
      return finish(err);
    }
    chunks.push(chunk);
  });
  /* Without these the request hangs forever on a dropped connection: no
     response is ever sent and the handler below never runs. */
  req.on('error', finish);
  req.on('aborted', () => finish(new Error('Webhook request aborted')));
  req.on('end', () => {
    if (done) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    req.rawBody = raw;
    try { req.body = JSON.parse(raw || '{}'); } catch (_) { req.body = {}; }
    /* body-parser gates on req._body, not req.body. Without this flag the
       global express.json() below re-reads a stream we have already drained
       and throws "stream is not readable", so the webhook route never runs
       and a real charge.success never credits the wallet. */
    req._body = true;
    finish();
  });
});
// Routes that embed base64 file data — raised body limit
app.use('/api/tables/kyc_documents', express.json({ limit: '15mb' }));
app.use('/api/tables/kyc_documents', express.urlencoded({ extended: true, limit: '15mb' }));
app.use('/api/tables/support_tickets', express.json({ limit: '15mb' }));
app.use('/api/tables/support_tickets', express.urlencoded({ extended: true, limit: '15mb' }));
// Large platform export JSON uploads
app.use('/api/admin/import', express.json({ limit: '50mb' }));
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
app.use('/api/admin',       require('./routes/interest'));
app.use('/api/push',        require('./routes/push'));
// Mobile app push-token shortcut (Capacitor bridge calls /api/investors/push-token)
app.post('/api/investors/push-token', require('./middleware/auth').requireAuth, (req, res, next) => {
  req.url = '/mobile-token';
  require('./routes/push')(req, res, next);
});
app.use('/api/privacy',     require('./routes/privacy'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/analytics',  require('./routes/friction'));
app.use('/api/analytics',  require('./routes/analytics-extra'));
app.use('/api/statements', require('./routes/statements'));
app.use('/api/waitlist',   require('./routes/waitlist'));
app.use('/api/migrate',   require('./routes/migrate'));
app.use('/api/address',   require('./routes/address'));
app.use('/api/events',    require('./routes/events').router);
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/legal',     require('./routes/legal'));
app.use('/api/quests',        require('./routes/quests'));
app.use('/api/referrals',     require('./routes/referrals'));
app.use('/api/testimonials',  require('./routes/testimonials'));
app.use('/api/email-logs',    require('./routes/emailLogs'));
app.use('/api/investments', require('./routes/investments'));
app.use('/api/gifts',        require('./routes/gifts'));
app.use('/api/factsheets',   require('./routes/factsheets'));
app.use('/api/products',     require('./routes/products'));
app.use('/api/opsconsole',  require('./routes/opsconsole'));
app.use('/api/cattle',      require('./routes/cattle'));
app.use('/api/fund',        require('./routes/fundRuns'));
app.use('/api/pe',             require('./routes/pe-extract'));
app.use('/api/pe/documents',   require('./routes/pe-documents'));
app.use('/api/ai',             require('./routes/aiCourses'));
app.use('/api/change-requests',require('./routes/changeRequests'));


/* ─── Health Check ─────────────────────────────────────────────────────────
   Always returns HTTP 200 so Railway knows the process is alive.
   DB connectivity is reported in the body but does NOT affect the status code.
   (Railway healthcheck kills the container on any non-2xx response.)
   ──────────────────────────────────────────────────────────────────────── */
app.get('/api/health', async (req, res) => {
  let db = false, dbError = null;
  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    db = true;
  } catch (err) {
    dbError = err.message;
    console.error('[health] DB check failed (still reporting 200 — liveness, not readiness):', err.message);
  }
  /* Deliberately 200 even when the database is unreachable. This path is wired
     to railway.toml healthcheckPath, and Railway kills the container on any
     non-2xx. Restarting the app cannot fix a database that is down — it just
     drops every in-flight request, empties the connection pool and comes back
     to the same failure, which is a restart loop rather than a recovery. Use
     /api/health/ready for the readiness signal that is allowed to fail. */
  res.status(200).json({
    status: db ? 'ok' : 'degraded',
    db,
    ...(dbError ? { dbError } : {}),
    ts:  new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

/* Readiness — same checks, but honest status codes. Safe for uptime monitors
   and load balancers because nothing here can terminate the container. */
app.get('/api/health/ready', async (req, res) => {
  /* Include the last auto-setup result. A step that fails to apply leaves the
     schema incomplete, and until now the only trace was one line in the boot
     log — long scrolled away by the time anything went wrong. Reported, not
     fatal: a mostly-migrated database still serves most traffic, so this stays
     200 and says what is missing rather than taking the service down. */
  let setup = null;
  try { setup = require('./db/setup').lastResult(); } catch (_) {}

  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'ok', db: true, ts: new Date().toISOString(),
      ...(setup && setup.ok === false
        ? { setup: 'incomplete', setupFailures: setup.failures, setupAt: setup.at }
        : { setup: setup && setup.ok === true ? 'ok' : 'unknown' }),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: false, dbError: err.message });
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
/* ─── Immutable caching for version-stamped assets ─────────────────────────
   The HTML references its scripts and styles with a version query string
   (js/portal.js?v=98) and CLAUDE.md requires that number to be bumped with
   every change. That makes any URL carrying a ?v= immutable by construction:
   its content cannot change without the URL changing too.

   Without this, every one of those assets was served no-cache, so each launch
   spent a conditional round-trip to Railway before a line of JS could run —
   on portal.js that is 168KB gzipped gated behind a request that also has to
   wait out a cold start. The version discipline was already being paid for
   and bought nothing.

   Deliberately keyed on the query string being present rather than on the
   file extension: a request for the same file without a version still
   revalidates, so the mobile service worker's unversioned precache entries
   and any stray direct link keep their old behaviour and cannot get stuck on
   a year-old copy.
   ──────────────────────────────────────────────────────────────────────── */
const IMMUTABLE_MAX_AGE = 31536000;   // one year, the maximum worth expressing

app.use((req, res, next) => {
  if (req.method === 'GET' && req.query && req.query.v && /\.(js|css)$/i.test(req.path)) {
    res.locals._versionedAsset = true;
  }
  next();
});

app.use(express.static(STATIC_DIR, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // HTML files: always revalidate — they carry the version pointers, so a
    // cached copy would keep pointing at superseded assets.
    if (/\.html$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/\.(js|css)$/.test(filePath)) {
      if (res.locals && res.locals._versionedAsset) {
        // Version-stamped: cache hard, the next bump changes the URL.
        res.setHeader('Cache-Control', `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`);
      } else {
        // Unversioned: revalidate (etag-based, no long cache)
        res.setHeader('Cache-Control', 'no-cache');
      }
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

  // Start PE review reminder cron (daily 08:00 SAST)
  const { startReviewReminderCron } = require('./jobs/reviewReminderCron');
  startReviewReminderCron();

  // Interest is credited at maturity only (maturityCron) — monthly accrual disabled.
  // const { startInterestCron } = require('./jobs/interestCron');
  // startInterestCron();

  // Payout processing is now consolidated into the maturity engine (maturityCron).
  // The standalone payoutCron has been retired.

  // Monthly statement email DISABLED. Statements were removed from the portal and
  // the apps, so emailing them was the only remaining path and it ran without
  // anyone choosing it. Re-enable by uncommenting both lines below; the job is
  // untouched and runMonthlyStatements can still be called directly.
  // const { startStatementCron } = require('./jobs/statementCron');
  // startStatementCron();

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

  // Change request daily summary — 08:00 SAST to kagiso@svcapital.co.za
  const { startChangeRequestSummaryCron } = require('./jobs/changeRequestSummaryCron');
  startChangeRequestSummaryCron();

  /* KYC reconciliation — hourly. Corrects investors whose documents are all
     approved but whose record is not, and KYC tickets left open for investors
     already verified. The approval path keeps these in step going forward;
     this catches anything that drifts anyway, so a failure repairs itself
     instead of only being logged. */
  const { startKycReconcile } = require('./jobs/kycReconcileCron');
  startKycReconcile();

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
    // agent:false — the default global agent pools the socket between pings.
    // A fresh socket that closes with the response is one fewer connection
    // for shutdown to reason about, and this ping has no need of pooling.
    const req = http.get({ host: 'localhost', port: PORT, path: '/api/health', agent: false }, res => {
      res.resume(); // drain response body so socket is freed
    });
    req.on('error', () => {}); // ignore — server may be mid-restart
    req.setTimeout(5000, () => req.destroy());
  });
});

/* ─── Graceful Shutdown ─── */
let _shuttingDown = false;

async function shutdown(signal, code = 0) {
  // SIGTERM followed by SIGKILL, or a signal during an exception shutdown,
  // would otherwise call server.close() twice and error on the second pass.
  if (_shuttingDown) return;
  _shuttingDown = true;

  const mb  = n => Math.round(n / 1048576);
  const mem = process.memoryUsage();
  console.log(`\n[${signal}] Graceful shutdown initiated…`);
  /* Printed so a restart can be attributed after the fact rather than guessed
     at. A container that dies seconds after boot with low rss was stopped by
     the platform (deploy, replica cycle, eviction); one that dies with rss up
     against the plan's memory limit is being killed for memory. Without this
     line every restart looks identical in the log. */
  console.log(`[shutdown] uptime ${Math.round(process.uptime())}s · rss ${mb(mem.rss)}MB · heap ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB`);

  server.close(async () => {
    console.log('[shutdown] HTTP server closed');
    try {
      const pool = require('./db/pool');
      await pool.end();
      console.log('[shutdown] DB pool closed');
    } catch (e) {
      console.error('[shutdown] DB pool close error:', e.message);
    }
    process.exit(code);
  });

  /* Node 20's server.close() already drops *idle* keep-alive sockets, but it
     still waits indefinitely for any connection in the middle of a request —
     a slow client, a half-sent request, a stalled upstream. One of those is
     enough that the callback above never runs, so the pool is never drained,
     Postgres logs "connection reset by peer", and the platform SIGKILLs us
     mid-shutdown. Measured: 15s and no callback with one such socket open,
     against 3s and a clean close with this backstop.
     Give real in-flight work three seconds, then take the rest. */
  server.closeIdleConnections?.();
  setTimeout(() => {
    if (server.closeAllConnections) {
      console.warn('[shutdown] forcing remaining connections closed');
      server.closeAllConnections();
    }
  }, 3000).unref();

  /* Below the platform's stop grace period, observed between three and ten
     seconds — the old 15s timer could never fire before the SIGKILL. */
  setTimeout(() => { console.error('[shutdown] Forced exit after timeout'); process.exit(code || 1); }, 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

/* ─── Process-level failure handling ───────────────────────────────────────
   Node 20 terminates the process on an unhandled promise rejection. This
   service fires a lot of promises it never awaits — cron ticks, e-mail sends,
   AML checks, webhook follow-up — so one stray rejection in a background job
   takes down every in-flight request and Railway restarts the container.
   A background failure is not a reason to drop live traffic: log it loudly,
   with a stack, and keep serving.

   An uncaught exception is a different case — the process may be in an
   inconsistent state — so there we do exit, but say why first and drain
   cleanly instead of dying mid-request.
   ──────────────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] a background promise rejected and was not caught:');
  console.error(reason instanceof Error ? (reason.stack || reason.message) : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || err);
  shutdown('uncaughtException', 1);
});

module.exports = app;
