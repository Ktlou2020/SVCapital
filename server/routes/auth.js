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
      director:     '/team/director.html',
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
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/auth/register ─── */
router.post('/register', async (req, res) => {
  try {
    const {
      email, password, firstName, lastName, phone,
      idNumber, province, occupation, role = 'investor'
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
           kyc_status, status, wallet_balance, referral_code, date_joined)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'active', 0, $9, NOW())
      `, [invId, firstName.trim(), lastName.trim(),
          email.toLowerCase().trim(), phone || null,
          idNumber || null, province || null, occupation || null,
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
    console.error('Register error:', err);
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
  // In production: generate token, store in DB, send email via SendGrid/etc.
  // For now: respond with success to prevent email enumeration
  if (email) {
    console.log(`Password reset requested for: ${email}`);
  }
  res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
});

module.exports = router;
