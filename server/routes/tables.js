/* ═══════════════════════════════════════════════════════
   Generic Table API — matches existing frontend API calls
   GET    /api/tables/:table
   GET    /api/tables/:table/:id
   POST   /api/tables/:table
   PUT    /api/tables/:table/:id
   PATCH  /api/tables/:table/:id
   DELETE /api/tables/:table/:id
   ═══════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');

/* ─── Whitelist of allowed tables and their primary key column ─── */
const ALLOWED_TABLES = {
  investors:             'id',
  investment_pools:      'id',
  investments:           'id',
  transactions:          'id',
  kyc_documents:         'id',
  maturity_instructions: 'id',
  support_tickets:       'id',
  platform_settings:     'key',
  ifas:                  'id',
  fund_runs:             'id',
  return_schedules:      'id',
  audit_events:          'id',
  investor_allocations:  'id',
  fee_ledger:            'id',
  fund_notifications:    'id',
  cattle_costs:          'id',
  cattle_cycles:         'id',
  cattle_animals:        'id',
  employees:             'id',
  employee_onboarding:   'id',
  employee_courses:      'id',
  course_progress:       'id',
  activity_feed:         'id',
  users:                 'id',   // limited, no password_hash exposed
};

/* ─── Tables that require admin/director role for READ ─── */
const ADMIN_ONLY_TABLES = new Set([
  'audit_events', 'fee_ledger', 'fund_notifications',
  'cattle_costs', 'cattle_cycles', 'cattle_animals',
  'return_schedules', 'investor_allocations',
  'employees', 'employee_onboarding', 'employee_courses',
  'course_progress', 'activity_feed',
]);

/* ─── Tables that require admin/director role for WRITE (stricter than read) ─── */
const ADMIN_WRITE_TABLES = new Set([
  'fee_ledger', 'fund_notifications',
  'cattle_costs', 'cattle_cycles', 'cattle_animals',
  'return_schedules', 'investor_allocations',
  'employees', 'employee_courses',
]);

/* ─── Columns that must never be set via the generic API ─── */
const PROTECTED_WRITE_COLS = {
  employees: ['pin_hash'],
  users:     ['password_hash', 'staff_pin'],
};

/* ─── Columns to strip from responses ─── */
const STRIP_COLS = {
  users: ['password_hash', 'staff_pin'],
  employees: ['pin_hash'],
};

function stripSensitive(table, rows) {
  const cols = STRIP_COLS[table];
  if (!cols) return rows;
  return rows.map(row => {
    const clean = { ...row };
    cols.forEach(c => delete clean[c]);
    return clean;
  });
}

/* ─── Validate table name ─── */
function validateTable(req, res, next) {
  const table = req.params.table;
  if (!ALLOWED_TABLES[table])
    return res.status(404).json({ error: `Unknown table: ${table}` });
  req.tableKey = ALLOWED_TABLES[table];
  next();
}

/* ─── GET /api/tables/:table ─── */
router.get('/:table', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;

    // Check admin-only tables
    if (ADMIN_ONLY_TABLES.has(table) && !['admin','director','fund_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    let { page = 1, limit = 100, search, sort, order = 'asc', ...filters } = req.query;
    page  = Math.max(1, parseInt(page));
    limit = Math.min(500, Math.max(1, parseInt(limit)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    // ─── Role-based data isolation ───
    // Investors only see their own data
    if (req.user.role === 'investor' && req.user.investorId) {
      const investorCols = {
        investments:           'investor_id',
        transactions:          'investor_id',
        kyc_documents:         'investor_id',
        maturity_instructions: 'investor_id',
        support_tickets:       'investor_id',
        return_schedules:      'investor_id',
        investor_allocations:  'investor_id',
      };
      if (investorCols[table]) {
        params.push(req.user.investorId);
        conditions.push(`${investorCols[table]} = $${params.length}`);
      }
    }

    // IFAs only see their assigned clients' data
    if (req.user.role === 'ifa' && req.user.ifaId) {
      const ifaCols = {
        investments:  'investor_id',
        transactions: 'investor_id',
        support_tickets: 'investor_id',
      };
      if (ifaCols[table]) {
        // Get assigned clients
        const ifaData = await pool.query('SELECT assigned_clients FROM ifas WHERE id = $1', [req.user.ifaId]);
        const clients = ifaData.rows[0]?.assigned_clients || [];
        if (clients.length > 0) {
          params.push(clients);
          conditions.push(`${ifaCols[table]} = ANY($${params.length})`);
        } else {
          conditions.push('1=0'); // IFA has no clients — return empty
        }
      }
    }

    // Filter by remaining query params (simple equality)
    for (const [key, val] of Object.entries(filters)) {
      // Skip internal params
      if (['page','limit','search','sort','order'].includes(key)) continue;
      // Validate column names (alphanumeric + underscore only)
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
      params.push(val);
      conditions.push(`${key} = $${params.length}`);
    }

    // Search (across text columns)
    // For platform_settings search key/value
    if (search) {
      params.push(`%${search}%`);
      if (table === 'platform_settings') {
        conditions.push(`(key ILIKE $${params.length} OR value ILIKE $${params.length} OR description ILIKE $${params.length})`);
      } else if (table === 'investors') {
        conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR id ILIKE $${params.length} OR phone ILIKE $${params.length})`);
      } else if (table === 'users') {
        conditions.push(`(email ILIKE $${params.length} OR first_name ILIKE $${params.length} OR last_name ILIKE $${params.length})`);
      } else if (table === 'ifas') {
        conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR company_name ILIKE $${params.length} OR license_number ILIKE $${params.length})`);
      } else {
        conditions.push(`id::text ILIKE $${params.length}`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort
    let orderClause = 'ORDER BY created_at DESC NULLS LAST';
    if (sort && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort)) {
      const dir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      orderClause = `ORDER BY ${sort} ${dir} NULLS LAST`;
    }

    params.push(limit, offset);
    const query = `
      SELECT * FROM ${table}
      ${where}
      ${orderClause}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const countParams = params.slice(0, -2);
    const countQuery  = `SELECT COUNT(*) FROM ${table} ${where}`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
    ]);

    const rows  = stripSensitive(table, dataResult.rows);
    const total = parseInt(countResult.rows[0].count);

    res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(`GET /${req.params.table}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/tables/:table/:id ─── */
router.get('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;
    const { rows } = await pool.query(
      `SELECT * FROM ${table} WHERE ${key} = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });
    const [clean] = stripSensitive(table, rows);
    res.json(clean);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/tables/:table ─── */
router.post('/:table', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;

    // Protect sensitive tables
    if (['users','audit_events'].includes(table))
      return res.status(403).json({ error: `Use /api/auth or /api/users for table: ${table}` });
    if (ADMIN_WRITE_TABLES.has(table) && !['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const body = { ...req.body };

    // Strip columns that must never be set via the generic API (e.g. pin_hash, password_hash)
    const protectedCols = PROTECTED_WRITE_COLS[table] || [];
    protectedCols.forEach(c => delete body[c]);

    // Auto-generate ID if missing
    if (!body.id) {
      const prefixMap = {
        investors:             'INV',
        investment_pools:      'POOL',
        investments:           'INV-TXN',
        transactions:          'TXN',
        kyc_documents:         'KYC',
        maturity_instructions: 'MAT',
        support_tickets:       'TKT',
        ifas:                  'IFA',
        fund_runs:             'FR',
        return_schedules:      'RS',
        audit_events:          'AUD',
        investor_allocations:  'ALLOC',
        fee_ledger:            'FEE',
        fund_notifications:    'NOTIF',
        cattle_costs:          'CC',
        cattle_cycles:         'CYC',
        cattle_animals:        'ANM',
        employees:             'EMP',
      };
      const prefix = prefixMap[table] || 'REC';
      body.id = `${prefix}-${Date.now()}`;
    }

    const keys   = Object.keys(body);
    const values = Object.values(body);
    const cols   = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    const [clean] = stripSensitive(table, rows);
    res.status(201).json(clean);
  } catch (err) {
    console.error(`POST /${req.params.table}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── PUT /api/tables/:table/:id ─── */
router.put('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;

    if (['users'].includes(table))
      return res.status(403).json({ error: `Use /api/users for table: ${table}` });

    const body   = { ...req.body };
    delete body[key]; // don't update PK
    delete body.created_at;
    // auto updated_at
    body.updated_at = new Date().toISOString();

    const keys   = Object.keys(body);
    const values = Object.values(body);
    const sets   = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets} WHERE ${key} = $${values.length} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });
    const [clean] = stripSensitive(table, rows);
    res.json(clean);
  } catch (err) {
    console.error(`PUT /${req.params.table}/${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── PATCH /api/tables/:table/:id ─── */
router.patch('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;

    if (['users'].includes(table))
      return res.status(403).json({ error: `Use /api/users for table: ${table}` });

    const body   = { ...req.body };
    delete body[key];
    delete body.created_at;
    body.updated_at = new Date().toISOString();

    const keys   = Object.keys(body);
    const values = Object.values(body);
    const sets   = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets} WHERE ${key} = $${values.length} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });
    const [clean] = stripSensitive(table, rows);
    res.json(clean);
  } catch (err) {
    console.error(`PATCH /${req.params.table}/${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── DELETE /api/tables/:table/:id ─── */
router.delete('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;

    if (['users'].includes(table))
      return res.status(403).json({ error: `Use /api/users for table: ${table}` });
    if (['audit_events'].includes(table))
      return res.status(403).json({ error: 'Audit events are immutable.' });

    // Admin-only tables and investors/pools require admin/director role to delete
    if (
      (ADMIN_ONLY_TABLES.has(table) || ['investors','investment_pools'].includes(table)) &&
      !['admin','director'].includes(req.user.role)
    ) return res.status(403).json({ error: 'Forbidden — admin only.' });

    const result = await pool.query(
      `DELETE FROM ${table} WHERE ${key} = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Record not found.' });
    res.json({ success: true, deleted: req.params.id });
  } catch (err) {
    console.error(`DELETE /${req.params.table}/${req.params.id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
