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

const router     = require('express').Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit  = require('express-rate-limit');
const pool       = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const emailService = require('../services/email');
const audit        = require('../services/audit');

/* Strip HTML tags from user-controlled text fields to prevent stored XSS */
function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
}

const JWT_SECRET     = process.env.JWT_SECRET;
if (!JWT_SECRET) console.error('[auth] CRITICAL: JWT_SECRET env var is not set — token signing will fail');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const twoFaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { error: 'Too many 2FA attempts.' },
});

function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    codes.push(`${raw.slice(0,5)}-${raw.slice(5)}`); // format: XXXXX-XXXXX
  }
  return codes;
}
const JWT_EXPIRES_IN     = process.env.JWT_EXPIRES_IN || '30m';
const IS_PROD            = process.env.NODE_ENV === 'production';
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_MINUTES    = 30;

if (!process.env.JWT_SECRET) {
  console.error('CRITICAL: JWT_SECRET env var is not set. Set this in Railway environment variables immediately.');
}

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
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 1) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user)
      return res.status(401).json({ error: 'Invalid credentials.' });

    if (!user.is_active)
      return res.status(403).json({ error: 'Account is deactivated. Contact support.' });

    // Per-account lockout (mirrors staff-token lockout pattern)
    if (user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
      const secsLeft = Math.ceil((new Date(user.login_locked_until) - Date.now()) / 1000);
      return res.status(429).json({
        error: `Account locked after too many failed attempts. Try again in ${Math.ceil(secsLeft / 60)} minute(s).`,
        lockedSecsRemaining: secsLeft,
      });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      const newAttempts = (user.login_attempts || 0) + 1;
      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        await pool.query(
          `UPDATE users SET login_attempts = 0,
             login_locked_until = NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'
           WHERE id = $1`, [user.id]
        );
        return res.status(429).json({
          error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
          lockedSecsRemaining: LOCKOUT_MINUTES * 60,
        });
      }
      await pool.query('UPDATE users SET login_attempts = $1 WHERE id = $2', [newAttempts, user.id]);
      const left = MAX_LOGIN_ATTEMPTS - newAttempts;
      return res.status(401).json({
        error: `Invalid credentials. ${left} attempt${left !== 1 ? 's' : ''} remaining.`,
        attemptsLeft: left,
      });
    }
    // Clear failed attempts on successful password match
    await pool.query('UPDATE users SET login_attempts = 0, login_locked_until = NULL WHERE id = $1', [user.id]);

    // 2FA check: if enabled, issue a short-lived pending token instead of full JWT
    if (user.totp_enabled) {
      const pending2FAToken = jwt.sign(
        { purpose: '2fa_pending', userId: user.id },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ requires2FA: true, pending2FAToken });
    }

    // Feature B: login anomaly — track IP and alert on new location
    const newIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (user.last_login_ip && user.last_login_ip !== newIp && newIp) {
      setImmediate(() => emailService.sendLoginAlert(user, { ip: newIp, time: new Date().toISOString() })
        .catch(err => console.error('[email] loginAlert failed:', err.message)));
    }
    await pool.query(
      'UPDATE users SET last_login = NOW(), last_login_ip = $1, last_login_at = NOW() WHERE id = $2',
      [newIp || null, user.id]
    );

    // Also update linked investor record if present
    if (user.investor_id) {
      const { rows: invRows } = await pool.query(
        'SELECT last_login_ip FROM investors WHERE id = $1', [user.investor_id]
      ).catch(() => ({ rows: [] }));
      const invRow = invRows[0];
      if (invRow && invRow.last_login_ip && invRow.last_login_ip !== newIp && newIp) {
        // investor row alert already covered by user alert above — just update tracking
      }
      await pool.query(
        'UPDATE investors SET last_login_ip = $1, last_login_at = NOW() WHERE id = $2',
        [newIp || null, user.investor_id]
      ).catch(() => {});
    }

    const token = signToken(user);

    // Issue refresh token and persist session
    const refreshToken = uuidv4();
    await pool.query(
      'INSERT INTO sessions (user_id, refresh_token, expires_at, ip_address, user_agent) VALUES ($1,$2,NOW()+INTERVAL \'30 days\',$3,$4)',
      [user.id, refreshToken, newIp || null, req.headers['user-agent'] || null]
    );

    res.cookie('svc_token', token, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: 'lax',
      maxAge:   30 * 60 * 1000,
    });
    res.cookie('svc_refresh', refreshToken, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    // Determine redirect URL based on role
    const redirectMap = {
      admin:        '/admin/index.html',
      director:     '/admin/index.html',
      investor:     '/portal/',
      ifa:          '/ifa/index.html',
      fund_manager: '/fund/index.html',
      staff:        '/team/hub.html',
    };

    setImmediate(() => audit.log({
      actorId: user.id, actorEmail: user.email, actorRole: user.role, action: 'user.login',
      entityType: 'users', entityId: user.id,
      description: `${user.role} login: ${user.email}`,
      ip: req.ip,
      platform: req.headers['x-platform'] || null,
    }));

    setImmediate(() => pool.query(
      'INSERT INTO user_login_events (user_id, investor_id, ip_address, user_agent) VALUES ($1, $2, $3, $4)',
      [user.id, user.investor_id || null, (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 45), (req.headers['user-agent'] || '').slice(0, 200)]
    ).catch(e => console.error('[login event]', e.message)));

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
      redirect: redirectMap[user.role] || '/portal/',
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
      email, password, phone,
      idNumber, province, occupation, role = 'investor',
      riskProfile = 'moderate', referredBy = '', notes = '',
      termsAccepted = true, ficaConsent = true, popiaAccepted = true,
    } = req.body;
    const firstName = stripHtml(req.body.firstName);
    const lastName  = stripHtml(req.body.lastName);

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 1) {
      return res.status(400).json({ error: 'Password is required.' });
    }
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
      const _chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const invId = 'SVC-' + Array.from({length: 6}, () => _chars[Math.floor(Math.random() * _chars.length)]).join('');
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

      // Record policy acceptances for compliance audit trail
      const _acceptedAt = new Date().toISOString();
      const _ip  = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null;
      const _ua  = req.headers['user-agent'] || null;
      const _acceptances = [
        { type: 'terms_of_service', flag: termsAccepted },
        { type: 'privacy_policy',   flag: termsAccepted },  // bundled in same checkbox
        { type: 'popia_notice',     flag: popiaAccepted },
        { type: 'fica_consent',     flag: ficaConsent },
        { type: 'risk_disclaimer',  flag: true },            // implied at registration
      ];
      for (const acc of _acceptances) {
        if (!acc.flag) continue;
        pool.query(
          `INSERT INTO accepted_client_documents (investor_id, document_type, document_version, accepted_at, ip_address, user_agent)
           VALUES ($1, $2, '1.0', $3, $4, $5)`,
          [invId, acc.type, _acceptedAt, _ip, _ua]
        ).catch(() => {});
      }

      // Fire-and-forget welcome email
      setImmediate(() => emailService.sendWelcome({
        id: invId,
        email: email.toLowerCase().trim(),
        first_name: firstName.trim(),
      }).catch(err => console.error('[email] welcome failed:', err.message)));

      // Referral bonus: create transaction for referrer if referred by a valid referral code
      if (referredBy) {
        const { rows: referrers } = await pool.query(
          'SELECT id FROM investors WHERE referral_code = $1 LIMIT 1', [referredBy]
        ).catch(() => ({ rows: [] }));
        if (referrers[0]) {
          await pool.query(`
            INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, referred_investor_id, transaction_date, created_at)
            VALUES (gen_random_uuid(), $1, 'referral_bonus', 500, 'pending', $2, $3, $4, NOW(), NOW())
          `, [referrers[0].id, 'REF-' + Date.now(), `Referral bonus — ${firstName.trim()} ${lastName.trim()} joined`, invId]).catch(() => {});
        }
      }
    }

    const token = signToken({ ...newUser, investor_id: newUser.investor_id });

    // Issue refresh token and persist session
    const refreshToken = uuidv4();
    await pool.query(
      'INSERT INTO sessions (user_id, refresh_token, expires_at, ip_address, user_agent) VALUES ($1,$2,NOW()+INTERVAL \'30 days\',$3,$4)',
      [newUser.id, refreshToken, (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null, req.headers['user-agent'] || null]
    );

    res.cookie('svc_token', token, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: 'lax',
      maxAge:   30 * 60 * 1000,
    });
    res.cookie('svc_refresh', refreshToken, {
      httpOnly: true,
      secure:   IS_PROD,
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
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
      redirect: '/portal/',
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
      'SELECT id, email, role, first_name, last_name, investor_id, ifa_id, is_active, last_login, created_at, totp_enabled FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/auth/investor-debug — temporary diagnostic ─── */
router.get('/investor-debug', requireAuth, async (req, res) => {
  try {
    const userRow = await pool.query(
      'SELECT id, email, role, investor_id FROM users WHERE id = $1', [req.user.id]
    );
    const user = userRow.rows[0] || {};
    const investorId = user.investor_id;

    let investor = null, investmentCount = 0, emailMatch = null;
    if (investorId) {
      const ir = await pool.query('SELECT id, email, first_name, last_name FROM investors WHERE id = $1', [investorId]);
      investor = ir.rows[0] || null;
      const cr = await pool.query('SELECT COUNT(*) FROM investments WHERE investor_id = $1', [investorId]);
      investmentCount = parseInt(cr.rows[0].count, 10);
    }
    if (!investor && user.email) {
      const er = await pool.query('SELECT id, email FROM investors WHERE LOWER(email) = LOWER($1) LIMIT 1', [user.email]);
      emailMatch = er.rows[0] || null;
    }
    res.json({
      user_id:          user.id,
      user_email:       user.email,
      users_investor_id: investorId || null,
      jwt_investor_id:  req.user.investorId || null,
      investor_exists:  !!investor,
      investor_id:      investor?.id || null,
      investment_count: investmentCount,
      email_match_id:   emailMatch?.id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/auth/logout ─── */
router.post('/logout', async (req, res) => {
  // TODO(security): JWT denylist — add this token's jti to a Redis/DB denylist (TTL = token expiry)
  // until then, tokens remain valid for up to 8h after logout. Requires: jti claim on all JWTs,
  // a denylist store (Redis recommended), and a check in requireAuth middleware.
  await pool.query('DELETE FROM sessions WHERE refresh_token=$1', [req.cookies?.svc_refresh]).catch(() => {});
  res.clearCookie('svc_token');
  res.clearCookie('svc_refresh', { path: '/api/auth' });
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
  const { email: rawEmail } = req.body;
  if (!rawEmail) return res.status(400).json({ error: 'Email is required.' });
  const emailAddr = rawEmail.toLowerCase().trim();

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, i.first_name
       FROM users u
       LEFT JOIN investors i ON i.email = u.email
       WHERE u.email = $1`,
      [emailAddr]
    );
    // Always return success to avoid email enumeration
    if (rows.length > 0) {
      const user = rows[0];
      const jti = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
      const token = jwt.sign(
        { sub: user.id, purpose: 'password_reset', jti },
        JWT_SECRET,
        { expiresIn: '15m' }
      );
      // Invalidate any previous unused tokens for this user
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1 AND used=false', [user.id]);
      // Record this token so it can only be used once
      await pool.query(
        'INSERT INTO password_reset_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)',
        [jti, user.id, expiresAt]
      );
      const resetLink = `${process.env.BASE_URL || 'https://platform.svcapital.co.za'}/reset-password.html?token=${token}`;
      setImmediate(() => emailService.sendPasswordReset(user.email, user.first_name, resetLink)
        .catch(err => console.error('[email] reset failed:', err.message)));
    }
    res.json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
  } catch (err) {
    console.error('/forgot-password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/auth/reset-password ─── */
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.purpose !== 'password_reset') return res.status(400).json({ error: 'Invalid reset token.' });

    // Enforce one-time-use: check jti in DB and mark as used atomically
    if (!payload.jti) return res.status(400).json({ error: 'Invalid reset token format.' });
    const { rows: tokenRows } = await pool.query(
      `UPDATE password_reset_tokens SET used=true, used_at=NOW()
       WHERE jti=$1 AND used=false AND expires_at > NOW()
       RETURNING user_id`,
      [payload.jti]
    );
    if (!tokenRows[0]) return res.status(400).json({ error: 'This reset link has already been used or has expired. Please request a new one.' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING email',
      [hash, payload.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

    console.log(`[auth] password reset for ${rows[0].email}`);
    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
    if (err.name === 'JsonWebTokenError') return res.status(400).json({ error: 'Invalid reset link.' });
    console.error('/reset-password error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── Shared helpers ─── */
/* Elevate a base (title-derived) role using the apps granted to the person, so
   per-individual app access also grants the role-gated API privileges. */
function elevateRoleByApps(baseRole, appAccess) {
  const apps = Array.isArray(appAccess) ? appAccess : [];
  const RANK = { staff: 0, ifa: 1, fund_manager: 1, admin: 2, director: 3 };
  let appRole = null;
  if (apps.includes('director'))   appRole = 'director';
  else if (apps.includes('admin')) appRole = 'admin';
  else if (apps.includes('fund'))  appRole = 'fund_manager';
  else if (apps.includes('ifa'))   appRole = 'ifa';
  if (appRole && (RANK[appRole] || 0) > (RANK[baseRole] || 0)) return appRole;
  return baseRole;
}

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

async function issueStaffJwt(emp, res) {
  const { rows: userRows } = await pool.query(
    'SELECT id FROM users WHERE email = $1 LIMIT 1', [emp.email]
  );
  const apps = (Array.isArray(emp.app_access) && emp.app_access.length) ? emp.app_access : ['employee'];
  // Role is derived from the title and elevated by the granted apps, so a person
  // granted the Admin Console app receives the 'admin' privileges its role-gated
  // APIs require (titles are just labels under per-individual access).
  const jwtRole = elevateRoleByApps(empToJwtRole(emp.role, emp.level), apps);
  const token = jwt.sign({
    id:        userRows[0]?.id || emp.id,
    email:     emp.email,
    role:      jwtRole,
    firstName: emp.first_name,
    lastName:  emp.last_name,
    empId:     emp.id,
    apps,
  }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.cookie('svc_token', token, {
    httpOnly: true, secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
  });
  return { token, role: jwtRole };
}

/* ─── POST /api/auth/staff-lookup ───────────────────────────────────────────
   Returns employee display fields for the email-lookup step.
   Does NOT return id_number or pin_hash — PIN validation is server-only.
   Returns pin_set so the client knows whether to show "temp PIN" or "your PIN",
   and locked/lockedSecsRemaining so the UI can show a countdown.
   ──────────────────────────────────────────────────────────────────────── */
router.post('/staff-lookup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, role, level, department,
              status, avatar_initials, avatar_color, xp_points,
              app_access, pin_set, login_locked_until
       FROM employees
       WHERE email = $1 AND status = 'active'
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (!rows[0]) return res.status(200).json({ message: 'If an account exists, login instructions have been sent.' });

    const emp = rows[0];
    const locked = !!(emp.login_locked_until && new Date(emp.login_locked_until) > new Date());
    const lockedSecsRemaining = locked
      ? Math.ceil((new Date(emp.login_locked_until) - Date.now()) / 1000) : 0;

    const { login_locked_until: _drop, ...safeEmp } = emp;
    res.json({ employee: safeEmp, locked, lockedSecsRemaining });
  } catch (err) {
    console.error('Staff lookup error:', err.message);
    res.status(500).json({ error: 'Could not connect to the staff directory. Please try again.' });
  }
});

/* ─── POST /api/auth/staff-token ────────────────────────────────────────────
   Validates a PIN submission. Two paths:
     • pin_set = false (first login): validates against last 4 of id_number.
       On success returns {requiresPinSetup: true, setupToken} — a 15-min JWT
       that only authorises the /set-pin endpoint.
     • pin_set = true  (returning):  validates against bcrypt pin_hash.
       On success issues full JWT + sets httpOnly cookie.
   Lockout: 5 failed attempts → 15-minute account lock.
   ──────────────────────────────────────────────────────────────────────── */
router.post('/staff-token', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) return res.status(400).json({ error: 'Email and PIN are required.' });
    if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 4–6 digits.' });
    if (!email.toLowerCase().trim().endsWith('@svcapital.co.za'))
      return res.status(403).json({ error: 'Only @svcapital.co.za accounts may use PIN login.' });

    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, role, level, department,
              status, avatar_initials, avatar_color, xp_points, app_access,
              id_number, pin_hash, pin_set, login_attempts, login_locked_until
       FROM employees WHERE email = $1 AND status = 'active' LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    const emp = rows[0];
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    // Check lockout
    if (emp.login_locked_until && new Date(emp.login_locked_until) > new Date()) {
      const secsLeft = Math.ceil((new Date(emp.login_locked_until) - Date.now()) / 1000);
      return res.status(429).json({
        error: `Account locked after too many failed attempts. Try again in ${Math.ceil(secsLeft/60)} minute(s).`,
        lockedSecsRemaining: secsLeft,
      });
    }

    // Validate PIN
    let valid = false;
    if (!emp.pin_set) {
      const idDigits = (emp.id_number || '').replace(/\D/g, '');
      const tempPin  = idDigits.slice(-4);
      if (tempPin) {
        const _a = Buffer.from(String(pin));
        const _b = Buffer.from(String(tempPin));
        const _match = _a.length === _b.length && crypto.timingSafeEqual(_a, _b);
        valid = _match;
      }
    } else {
      valid = emp.pin_hash ? await bcrypt.compare(pin, emp.pin_hash) : false;
    }

    if (!valid) {
      const newAttempts = (emp.login_attempts || 0) + 1;
      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        await pool.query(
          `UPDATE employees SET login_attempts = 0,
             login_locked_until = NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'
           WHERE id = $1`, [emp.id]
        );
        return res.status(429).json({
          error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
          lockedSecsRemaining: LOCKOUT_MINUTES * 60,
        });
      }
      await pool.query('UPDATE employees SET login_attempts = $1 WHERE id = $2', [newAttempts, emp.id]);
      const left = MAX_LOGIN_ATTEMPTS - newAttempts;
      return res.status(401).json({
        error: `Incorrect PIN. ${left} attempt${left !== 1 ? 's' : ''} remaining.`,
        attemptsLeft: left,
      });
    }

    // Clear failed attempts on success
    await pool.query(
      'UPDATE employees SET login_attempts = 0, login_locked_until = NULL WHERE id = $1', [emp.id]
    );

    // First-time login — return a short-lived setup token, not a full JWT
    if (!emp.pin_set) {
      const setupToken = jwt.sign(
        { empId: emp.id, email: emp.email, type: 'pin-setup' },
        JWT_SECRET, { expiresIn: '15m' }
      );
      return res.json({ requiresPinSetup: true, setupToken });
    }

    // Returning user — issue full JWT
    const { token, role } = await issueStaffJwt(emp, res);
    res.json({ token, role, email: emp.email });
  } catch (err) {
    console.error('Staff-token error:', err.message);
    res.status(500).json({ error: 'Could not verify PIN.' });
  }
});

/* ─── POST /api/auth/set-pin ────────────────────────────────────────────────
   Called after a successful first-login temp-PIN check.
   Accepts the short-lived setupToken + the employee's chosen 6-digit PIN.
   Validates, hashes (bcrypt 12), stores, then issues a full JWT.
   PIN rules: exactly 6 digits, not all identical, not a simple sequence.
   ──────────────────────────────────────────────────────────────────────── */
router.post('/set-pin', async (req, res) => {
  try {
    const { setupToken, pin } = req.body;
    if (!setupToken || !pin) return res.status(400).json({ error: 'setupToken and pin are required.' });
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });

    // Verify setup token
    let payload;
    try {
      payload = jwt.verify(setupToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Setup session expired — please start over.' });
    }
    if (payload.type !== 'pin-setup')
      return res.status(401).json({ error: 'Invalid token type.' });

    // PIN strength rules
    if (/^(\d)\1{5}$/.test(pin))
      return res.status(400).json({ error: 'PIN cannot be all the same digit (e.g. 111111).' });
    const ascending  = '0123456789';
    const descending = '9876543210';
    if (ascending.includes(pin) || descending.includes(pin))
      return res.status(400).json({ error: 'PIN cannot be a simple sequence (e.g. 123456).' });

    const pinHash = await bcrypt.hash(pin, 12);
    await pool.query(
      `UPDATE employees
         SET pin_hash = $1, pin_set = true, login_attempts = 0, login_locked_until = NULL
       WHERE id = $2`,
      [pinHash, payload.empId]
    );

    const { rows } = await pool.query(
      'SELECT id, first_name, last_name, email, role, level FROM employees WHERE id = $1',
      [payload.empId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Employee not found.' });

    const { token, role } = await issueStaffJwt(rows[0], res);
    res.json({ token, role, email: rows[0].email });
  } catch (err) {
    console.error('Set-pin error:', err.message);
    res.status(500).json({ error: 'Could not save PIN.' });
  }
});

/* ─── GET /api/auth/2fa/status ─── */
router.get('/2fa/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [req.user.id]);
    res.json({ enabled: !!(rows[0]?.totp_enabled) });
  } catch (err) { res.status(500).json({ error: 'Internal server error.' }); }
});

/* ─── POST /api/auth/2fa/setup ─── */
// Generates a new secret. Does NOT save it yet — user must verify first.
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const { generateSecret, otpauthUri } = require('../services/totp');
    const secret = generateSecret();
    const uri    = otpauthUri(secret, rows[0].email);
    res.json({ secret, uri });
  } catch (err) { console.error('/2fa/setup error:', err.message); res.status(500).json({ error: 'Internal server error.' }); }
});

/* ─── POST /api/auth/2fa/enable ─── */
// Saves the secret and enables 2FA after verifying the TOTP token.
router.post('/2fa/enable', requireAuth, async (req, res) => {
  try {
    const { secret, token } = req.body;
    if (!secret || !token) return res.status(400).json({ error: 'secret and token are required.' });
    const { verify } = require('../services/totp');
    if (!verify(secret, token)) return res.status(400).json({ error: 'Invalid code — please try again.' });
    await pool.query('UPDATE users SET totp_secret = $1, totp_enabled = true WHERE id = $2', [secret, req.user.id]);
    const codes = generateRecoveryCodes();
    // Delete any old codes for this user
    await pool.query('DELETE FROM totp_recovery_codes WHERE user_id = $1', [req.user.id]);
    // Insert hashed codes
    for (const code of codes) {
      const hash = await bcrypt.hash(code, 10);
      await pool.query(
        'INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES ($1, $2)',
        [req.user.id, hash]
      );
    }
    res.json({ success: true, recoveryCodes: codes }); // send plaintext codes ONCE
  } catch (err) { console.error('/2fa/enable error:', err.message); res.status(500).json({ error: 'Internal server error.' }); }
});

/* ─── POST /api/auth/2fa/disable ─── */
router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Authenticator code required.' });
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]?.totp_enabled) return res.status(400).json({ error: '2FA is not currently enabled.' });
    const { verify } = require('../services/totp');
    if (!verify(rows[0].totp_secret, token)) return res.status(400).json({ error: 'Invalid code.' });
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (err) { console.error('/2fa/disable error:', err.message); res.status(500).json({ error: 'Internal server error.' }); }
});

/* ─── POST /api/auth/2fa/recover ─── */
router.post('/2fa/recover', twoFaLimiter, async (req, res) => {
  try {
    const { pending2FAToken, recoveryCode } = req.body;
    if (!pending2FAToken || !recoveryCode) return res.status(400).json({ error: 'pending2FAToken and recoveryCode are required.' });
    let payload;
    try { payload = jwt.verify(pending2FAToken, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid or expired token.' }); }
    if (payload.purpose !== '2fa_pending') return res.status(401).json({ error: 'Invalid token.' });
    const { rows: codes } = await pool.query(
      'SELECT id, code_hash FROM totp_recovery_codes WHERE user_id = $1 AND used = false',
      [payload.userId]
    );
    let matchedId = null;
    for (const row of codes) {
      const ok = await bcrypt.compare(recoveryCode.trim().toUpperCase(), row.code_hash);
      if (ok) { matchedId = row.id; break; }
    }
    if (!matchedId) return res.status(401).json({ error: 'Invalid or already used recovery code.' });
    await pool.query('UPDATE totp_recovery_codes SET used = true, used_at = NOW() WHERE id = $1', [matchedId]);
    const { rows: users } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (!users[0]) return res.status(404).json({ error: 'User not found.' });
    const user = users[0];
    const fullToken = signToken(user);
    res.json({ token: fullToken, user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name, investorId: user.investor_id }, remainingCodes: codes.length - 1 });
  } catch (err) { console.error('/2fa/recover error:', err.message); res.status(500).json({ error: 'Internal server error.' }); }
});

/* ─── POST /api/auth/2fa/verify-login ─── */
router.post('/2fa/verify-login', twoFaLimiter, async (req, res) => {
  try {
    const { pending2FAToken, token } = req.body;
    if (!pending2FAToken || !token) return res.status(400).json({ error: 'pending2FAToken and token are required.' });
    let payload;
    try { payload = jwt.verify(pending2FAToken, JWT_SECRET); } catch {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (payload.purpose !== '2fa_pending') return res.status(401).json({ error: 'Invalid token.' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = rows[0];
    if (!user || !user.totp_secret) return res.status(400).json({ error: 'User not found or 2FA not configured.' });
    const { verify } = require('../services/totp');
    if (!verify(user.totp_secret, token)) return res.status(401).json({ error: 'Invalid authenticator code.' });
    const newIp2fa = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (user.last_login_ip && user.last_login_ip !== newIp2fa && newIp2fa) {
      setImmediate(() => emailService.sendLoginAlert(user, { ip: newIp2fa, time: new Date().toISOString() })
        .catch(err => console.error('[email] loginAlert (2fa) failed:', err.message)));
    }
    await pool.query(
      'UPDATE users SET last_login = NOW(), last_login_ip = $1, last_login_at = NOW() WHERE id = $2',
      [newIp2fa || null, user.id]
    );
    const fullToken = signToken(user);
    res.cookie('svc_token', fullToken, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 30 * 60 * 1000 });
    const redirectMap = { admin: '/admin/index.html', director: '/admin/index.html', investor: '/portal/', ifa: '/ifa/index.html', fund_manager: '/fund/index.html', staff: '/team/hub.html' };
    res.json({ token: fullToken, user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name, investorId: user.investor_id }, redirect: redirectMap[user.role] || '/portal/' });
  } catch (err) { console.error('/2fa/verify-login error:', err.message); res.status(500).json({ error: 'Internal server error.' }); }
});

/* ─── GET /api/auth/login-history ─── */
router.get('/login-history', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT ip_address, user_agent, login_at FROM user_login_events WHERE user_id = $1 ORDER BY login_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ events: rows });
  } catch (err) { res.status(500).json({ error: 'Internal server error.' }); }
});

/* POST /api/auth/refresh — rotate refresh token, issue new access token */
router.post('/refresh', async (req, res) => {
  const rt = req.cookies?.svc_refresh;
  if (!rt) return res.status(401).json({ error: 'No refresh token' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM sessions WHERE refresh_token=$1 AND expires_at > NOW()', [rt]
    );
    if (!rows[0]) { res.clearCookie('svc_refresh', { path: '/api/auth' }); return res.status(401).json({ error: 'Session expired' }); }
    const { rows: users } = await pool.query('SELECT * FROM users WHERE id=$1', [rows[0].user_id]);
    if (!users[0] || !users[0].is_active) return res.status(401).json({ error: 'Account inactive' });
    const currentIp = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (rows[0].ip_address && currentIp && rows[0].ip_address !== currentIp) {
      console.warn(`[auth/refresh] IP change for user ${rows[0].user_id}: ${rows[0].ip_address} → ${currentIp}`);
    }
    const newRt = uuidv4();
    await pool.query('DELETE FROM sessions WHERE id=$1', [rows[0].id]);
    await pool.query(
      'INSERT INTO sessions (user_id,refresh_token,expires_at,ip_address,user_agent) VALUES ($1,$2,NOW()+INTERVAL \'30 days\',$3,$4)',
      [users[0].id, newRt, (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null, req.headers['user-agent'] || null]
    );
    const token = signToken(users[0]);
    res.cookie('svc_token', token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 30 * 60 * 1000 });
    res.cookie('svc_refresh', newRt, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/api/auth' });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

/* POST /api/auth/signout-all — revoke all sessions for current user */
router.post('/signout-all', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]).catch(() => {});
  res.clearCookie('svc_token');
  res.clearCookie('svc_refresh', { path: '/api/auth' });
  res.json({ success: true });
});

module.exports = router;
