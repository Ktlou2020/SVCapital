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
const pool         = require('./db/pool');

const authRoutes   = require('./routes/auth');
const usersRoutes  = require('./routes/users');
const tablesRoutes = require('./routes/tables');

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
    // Allow requests with no origin (mobile apps, curl, same-origin)
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
app.use('/api/auth',   authRoutes);
app.use('/api/users',  usersRoutes);
app.use('/api/tables', tablesRoutes);

/* ─── Health Check ─── */
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

/* ─── Static Frontend Files ─── */
// Serve the frontend from the parent directory (project root)
const STATIC_DIR = path.join(__dirname, '..');
app.use(express.static(STATIC_DIR, {
  index: false, // We handle index manually
  setHeaders: (res, filePath) => {
    // Cache static assets (CSS/JS/images) aggressively, but not HTML
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

/* ─── SPA Fallback — serve index.html for all non-API, non-file routes ─── */
app.get('*', (req, res) => {
  // If the path looks like a file (has extension), 404
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SV Capital server running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Database:    ${process.env.DATABASE_URL ? '✅ Connected' : '⚠️  DATABASE_URL not set'}`);
});

module.exports = app;
