/* ═══════════════════════════════════════════
   Auth Middleware — JWT verification
   ═══════════════════════════════════════════ */
'use strict';

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.error('[auth] CRITICAL: JWT_SECRET env var is not set — all authenticated requests will be rejected');

/**
 * Verify JWT from Authorization header or cookie.
 * Sets req.user = { id, email, role, ... }
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;
  const tokenFromCookie = req.cookies && req.cookies['svc_token'];
  const token = tokenFromHeader || tokenFromCookie;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorised — no token provided.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // View-as tokens (admin magic-link) may only read, not mutate (M-7)
    if (payload.purpose === 'admin_view_as' && !['GET', 'HEAD'].includes(req.method)) {
      return res.status(403).json({ error: 'Forbidden — view-only session cannot perform write operations.' });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorised — invalid or expired token.' });
  }
}

/**
 * Require one of the listed roles.
 * Usage: requireRole('admin','director')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorised.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Forbidden — requires role: ${roles.join(' | ')}.` });
    }
    next();
  };
}

/**
 * Optional auth — attaches req.user if token is valid, but doesn't block.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7)
    : (req.cookies && req.cookies['svc_token']);
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); } catch (_) {}
  }
  next();
}

module.exports = { requireAuth, requireRole, optionalAuth };
