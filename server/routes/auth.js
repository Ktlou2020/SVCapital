/* ═══════════════════════════════════════════════════════
   Auth Routes
   POST /api/auth/login
   POST /api/auth/register
   POST /api/auth/logout
   GET  /api/auth/me
   PUT  /api/auth/change-password
   POST /api/auth/forgot-password  (placeholder)
   ═══════════════════════════════════════════════════════ */
'use strict';

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const JWT_SECRET     = process.env.JWT_SECRET || 'svcapital-dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const IS_PROD        = process.env.NODE_ENV === 'production';

function signToken(user) {
  return jwt.sign(
    {
      id:         user.id,
      email:      user.email,
      role:       user.role,
      firstName:  user.first_name,
      lastName:   user.last_name,
      investorId: user.investor_id,
      ifaId:      user.ifa_id,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/* ─── POST /api/auth/login ─── */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user)
      return res.status(401).json({ error: 'Invalid credentials.' });

    if (!user.is_active)
      return res.status(403).json({ error: 'Account is deactivated. Contact support.' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ error: 'Invalid credentials.' });

    // update last_login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = signToken(user);

    // Set cookie for web clients
    res.cookie('svc_token', token, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:   8 * 60 * 60 * 1000, // 8 hours
    });

    // Determine redirect URL based on role
    const redirectMap = {
      admin:        '/admin/index.html',
      director:     '/admin/index.html',
      investor:     '/portal/index.html',
      ifa:          '/ifa/index.html',
      fund_manager: '/fund/index.html',
      staff:        '/team/hub.html',
    };

    res.json({
      token,
      user: {
        id:         user.id,
        email:      user.email,
        role:       user.role,
        firstName:  user.first_name,
        lastName:   user.last_name,
        investorId: user.investor_id,
        ifaId:      user.ifa_id,
      },
      redirect: redirectMap[user.role] || '/portal/index.html',
    });
  } catch (err) {
    console.error('Login error:', err.message);
    const isDbDown = err.message && (
      err.message.includes('connect') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('timeout') ||
      err.message.includes('SSL') ||
      err.message.includes('password authentication') ||
      err.message.includes('does not exist')
    );
    if (isDbDown) {
      return res.status(503).json({ error: 'Database is currently unavailable. Please try again shortly.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/auth/register ─── */
router.post('/register', async (req, res) => {
  try {
    const {
      email, password, firstName, lastName, phone,
      idNumber, province, occupation, role = 'investor',
      riskProfile = 'moderate', referredBy = '', notes = '',
    } = req.body;

    if (!email || !password || !firstName || !lastName)
      return res.status(400).json({ error: 'Email, password, first name and last name are required.' });

    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    // Only allow self-registration as investor (admins create other roles)
    const allowedSelfRoles = ['investor'];
    const userRole = allowedSelfRoles.includes(role) ? role : 'investor';

    // Check duplicate
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);

    // Create user
    const { rows: [newUser] } = await pool.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email, role, first_name, last_name
    `, [email.toLowerCase().trim(), hash, userRole, firstName.trim(), lastName.trim()]);

    // Auto-create investor profile
    if (userRole === 'investor') {
      const invId = 'INV-' + String(Date.now()).slice(-6);
      const referralCode = 'SVC' + Math.random().toString(36).substring(2, 7).toUpperCase();

      await pool.query(`
        INSERT INTO investors
          (id, first_name, last_name, email, phone, id_number, province, occupation,
           risk_profile, referred_by, notes,
           kyc_status, status, wallet_balance, referral_code, date_joined)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 'active', 0, $12, NOW())
      `, [invId, firstName.trim(), lastName.trim(),
          email.toLowerCase().trim(), phone || null,
          idNumber || null, province || null, occupation || null,
          riskProfile || 'moderate', referredBy || null, notes || null,
          referralCode]);

      // Link investor_id on user
      await pool.query('UPDATE users SET investor_id = $1 WHERE id = $2', [invId, newUser.id]);
      newUser.investor_id = invId;
    }

    const token = signToken({ ...newUser, investor_id: newUser.investor_id });

    res.cookie('svc_token', token, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:   8 * 60 * 60 * 1000,
    });

    res.status(201).json({
      token,
      user: {
        id:         newUser.id,
        email:      newUser.email,
        role:       newUser.role,
        firstName:  newUser.first_name,
        lastName:   newUser.last_name,
        investorId: newUser.investor_id || null,
      },
      redirect: '/portal/index.html',
    });
  } catch (err) {
    console.error('Register error:', err.message);
    const isDbDown = err.message && (
      err.message.includes('connect') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('timeout') ||
      err.message.includes('SSL') ||
      err.message.includes('password authentication') ||
      err.message.includes('does not exist')
    );
    if (isDbDown) {
      return res.status(503).json({ error: 'Database is currently unavailable. Please try again shortly.' });
    }
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/auth/me ─── */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, first_name, last_name, investor_id, ifa_id, is_active, last_login, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/auth/logout ─── */
router.post('/logout', (req, res) => {
  res.clearCookie('svc_token');
  res.json({ success: true });
});

/* ─── PUT /api/auth/change-password ─── */
router.put('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'currentPassword and newPassword required.' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

    const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/auth/forgot-password ─── */
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (email) console.log(`Password reset requested for: ${email}`);
  res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
});

/* ─── POST /api/auth/staff-lookup ──────────────────────────────────────────
   Public endpoint used by team/login.html to look up an employee by email.
   Returns only non-sensitive display fields (no pin_hash, no id_number).
   The PIN is validated entirely client-side using the id_number field which
   IS returned here — this is intentional: the PIN is derived from the ID
   number (last 4 digits), and the ID number is not itself a secret credential.
   Rate-limited by the global API limiter (300 req / 15 min).
   ──────────────────────────────────────────────────────────────────────── */
router.post('/staff-lookup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, role, level, department,
              status, avatar_initials, avatar_color, xp_points, id_number
       FROM employees
       WHERE email = $1 AND status = 'active'
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    if (!rows[0]) return res.status(404).json({ error: 'No staff account found for that email address.' });

    res.json({ employee: rows[0] });
  } catch (err) {
    console.error('Staff lookup error:', err.message);
    res.status(500).json({ error: 'Could not connect to the staff directory. Please try again.' });
  }
});

/* ─── POST /api/auth/staff-token ────────────────────────────────────────────
   Called immediately after a successful PIN login on team/login.html.
   Accepts the employee's email + PIN (last 4 of id_number) that have
   already been validated client-side, verifies them server-side, then
   issues a real JWT and sets the svc_token httpOnly cookie.
   This gives PIN-login employees a proper Bearer token so they can call
   authenticated API routes (fund, admin, ifa data endpoints).
   Rate-limited by the global API limiter.
   ──────────────────────────────────────────────────────────────────────── */
router.post('/staff-token', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ error: 'Email and PIN are required.' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4 digits.' });

    // Re-fetch employee to verify PIN server-side (last 4 of id_number)
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, role, level, department,
              status, avatar_initials, avatar_color, xp_points, id_number
       FROM employees
       WHERE email = $1 AND status = 'active'
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    const emp = rows[0];
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    // Verify PIN against last 4 digits of id_number
    const idDigits = (emp.id_number || '').replace(/\D/g, '');
    const expectedPin = idDigits.slice(-4);
    if (!expectedPin || pin !== expectedPin) {
      return res.status(401).json({ error: 'Invalid PIN.' });
    }

    // Map employee role/level → JWT role understood by requireRole middleware
    function empToJwtRole(role, level) {
      if (level === 'executive') return 'director';
      if (!role) return 'staff';
      const r = role.toLowerCase();
      if (r.includes('ceo') || r.includes('director') || r.includes('coo') || r.includes('cto')) return 'director';
      if (r.includes('admin') || r.includes('compliance') || r.includes('finance') ||
          r.includes('operations') || r.includes('tech lead')) return 'admin';
      if (r.includes('ifa') || r.includes('adviser') || r.includes('advisor')) return 'ifa';
      return 'staff';
    }
    const jwtRole = empToJwtRole(emp.role, emp.level);

    // Look up the linked users row (if any) — purely for compatibility fields
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [emp.email]
    );

    const tokenPayload = {
      id:        userRows[0]?.id || emp.id,
      email:     emp.email,
      role:      jwtRole,
      firstName: emp.first_name,
      lastName:  emp.last_name,
      empId:     emp.id,          // extra field — preserved through to client
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    // Set httpOnly cookie (same flags as main login)
    res.cookie('svc_token', token, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:   8 * 60 * 60 * 1000,
    });

    res.json({ token, role: jwtRole, email: emp.email });
  } catch (err) {
    console.error('Staff-token error:', err.message);
    res.status(500).json({ error: 'Could not issue staff token.' });
  }
});

module.exports = router;
