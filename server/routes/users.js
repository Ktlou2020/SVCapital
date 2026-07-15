/* ═══════════════════════════════════════════════════════
   Users Routes (Admin only)
   GET    /api/users
   GET    /api/users/:id
   POST   /api/users
   PUT    /api/users/:id
   DELETE /api/users/:id
   PATCH  /api/users/:id/toggle-active
   ═══════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../db/pool');
const audit  = require('../services/audit');

const stripHtml = (str) => (str || '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim();
const { requireAuth, requireRole } = require('../middleware/auth');

/* ─── GET /api/users ─── */
router.get('/', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { role, search } = req.query;
    if (isNaN(parseInt(req.query.limit || '50'))) return res.status(400).json({ error: 'Invalid limit parameter.' });
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * limit;
    let conditions = ['1=1'];
    const params = [];

    if (role) {
      params.push(role);
      conditions.push(`role = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(email ILIKE $${params.length} OR first_name ILIKE $${params.length} OR last_name ILIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');
    params.push(limit, offset);

    const { rows } = await pool.query(`
      SELECT id, email, role, first_name, last_name, is_active,
             investor_id, ifa_id, last_login, created_at
      FROM users
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const countRes = await pool.query(`SELECT COUNT(*) FROM users WHERE ${where}`, params.slice(0, -2));
    res.json({ data: rows, total: parseInt(countRes.rows[0].count), page: +page, limit: +limit });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/users/:id ─── */
router.get('/:id', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, first_name, last_name, is_active, investor_id, ifa_id, last_login, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/users ─── */
router.post('/', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { email, password, role = 'investor', investorId, ifaId } = req.body;
    const firstName = stripHtml(req.body.firstName);
    const lastName  = stripHtml(req.body.lastName);
    if (!email || !password || !firstName || !lastName)
      return res.status(400).json({ error: 'email, password, firstName, lastName required.' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await pool.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, investor_id, ifa_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, email, role, first_name, last_name, investor_id, ifa_id, is_active, created_at
    `, [email.toLowerCase().trim(), hash, role, firstName, lastName,
        investorId || null, ifaId || null]);

    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'admin.user.create', entityType: 'user', entityId: user.id,
      description: `Created user ${user.email} with role ${user.role}`,
      ip: req.ip,
    });
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── PUT /api/users/:id ─── */
router.put('/:id', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { email, role, isActive, investorId, ifaId } = req.body;
    const VALID_ROLES = ['investor', 'admin', 'director', 'ifa', 'compliance'];
    if (req.body.role && !VALID_ROLES.includes(req.body.role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    const firstName = req.body.firstName != null ? stripHtml(req.body.firstName) : undefined;
    const lastName  = req.body.lastName  != null ? stripHtml(req.body.lastName)  : undefined;
    const { rows: [user] } = await pool.query(`
      UPDATE users SET
        email       = COALESCE($1, email),
        first_name  = COALESCE($2, first_name),
        last_name   = COALESCE($3, last_name),
        role        = COALESCE($4, role),
        is_active   = COALESCE($5, is_active),
        investor_id = COALESCE($6, investor_id),
        ifa_id      = COALESCE($7, ifa_id),
        updated_at  = NOW()
      WHERE id = $8
      RETURNING id, email, role, first_name, last_name, is_active, investor_id, ifa_id, updated_at
    `, [email, firstName ?? null, lastName ?? null, role,
        isActive !== undefined ? isActive : null,
        investorId, ifaId, req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'admin.user.update', entityType: 'user', entityId: user.id,
      description: `Updated user ${user.email}`,
      ip: req.ip,
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── PATCH /api/users/:id/toggle-active ─── */
router.patch('/:id/toggle-active', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(`
      UPDATE users SET is_active = NOT is_active, updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, role, is_active
    `, [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'admin.user.toggle_active', entityType: 'user', entityId: user.id,
      description: `Set user ${user.email} active=${user.is_active}`,
      ip: req.ip,
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── PATCH /api/users/:id/reset-password ─── */
router.patch('/:id/reset-password', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── DELETE /api/users/:id ─── */
router.delete('/:id', requireAuth, requireRole('director'), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account.' });
    const { rows: [deletedUser] } = await pool.query('SELECT email, role FROM users WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    await audit.log({
      actorId: req.user.id, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'admin.user.delete', entityType: 'user', entityId: req.params.id,
      description: `Deleted user ${deletedUser?.email || req.params.id}`,
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
