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
const emailService = require('../services/email');
const smsService   = require('../services/sms');
const audit        = require('../services/audit');

/* ─── Lazy-load push service (graceful if web-push not installed yet) ─── */
let _pushSvc = null;
function _getPush() {
  if (!_pushSvc) {
    try { _pushSvc = require('../services/pushService'); } catch (_) {}
  }
  return _pushSvc;
}

/* ─── Fire-and-forget push helper ─── */
async function _sendPush(investorId, payload) {
  const ps = _getPush();
  if (!ps || !investorId) return;
  try {
    await ps.sendPushToInvestor(investorId, payload);
    await ps.logNotification({
      type:           payload.tag || 'system',
      title:          payload.title,
      body:           payload.body,
      url:            payload.url,
      recipientCount: 1,
      sentBy:         'system',
    });
  } catch (e) {
    console.warn('[tables push hook] error:', e.message);
  }
}

/* ─── Input Validation ─── */
const NUMERIC_FIELDS = new Set(['amount','wallet_balance','total_invested','total_returns','annual_rate','max_capacity','current_invested','recurring_amount','xp_points']);
const STATUS_FIELDS  = { status: ['active','inactive','pending','matured','paid_out','cancelled','rejected','open','closed','resolved','in_review','completed','waitlist','in_progress','waiting_investor'], fica_status: ['pending','approved','rejected','not_started'], bank_account_status: ['none','pending','approved','rejected'], maturity_instruction: ['payout_all','payout_return','reinvest','pending'] };

function validateBody(table, body, isCreate) {
  const errors = [];
  for (const [key, val] of Object.entries(body)) {
    if (NUMERIC_FIELDS.has(key) && val !== null && val !== undefined) {
      const n = Number(val);
      if (isNaN(n)) errors.push(`${key} must be a number`);
      // wallet_balance and amount can't be negative when setting directly (allow negative for adjustments)
      if ((key === 'amount') && n < 0 && isCreate) errors.push(`${key} cannot be negative`);
    }
    if (STATUS_FIELDS[key] && val !== null && val !== undefined) {
      if (!STATUS_FIELDS[key].includes(val)) {
        errors.push(`${key} must be one of: ${STATUS_FIELDS[key].join(', ')}`);
      }
    }
  }
  return errors;
}

/* ─── Whitelist of allowed tables and their primary key column ─── */
const ALLOWED_TABLES = {
  investors:             'id',
  investment_pools:      'id',
  investments:           'id',
  transactions:          'id',
  kyc_documents:         'id',
  maturity_instructions: 'id',
  support_tickets:       'id',
  sub_accounts:          'id',
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
  payslips:              'id',
  employee_onboarding:   'id',
  employee_courses:      'id',
  course_progress:       'id',
  activity_feed:         'id',
  kpi_scores:            'id',
  achievements:          'id',
  daily_checkins:        'id',
  leave_requests:        'id',
  okrs:                  'id',
  peer_feedback:         'id',
  pulse_surveys:         'id',
  pulse_responses:       'id',
  one_on_ones:           'id',
  learning_paths:        'id',
  eva_periods:           'id',
  personal_notes:        'id',
  course_modules:        'id',
  cattle_nav_settings:   'id',
  shortterm_loans:       'id',
  loan_documents:        'id',
  solar_projects:        'id',
  solar_documents:       'id',
  fica_checks:           'id',   // read-only via generic API; writes via /api/fica/*
  quest_completions:     'id',   // read via generic API; writes via /api/quests/*
  users:                 'id',   // limited, no password_hash exposed
  investment_waitlist:   'id',
};

/* ─── Tables that require admin/director role for READ ─── */
const ADMIN_ONLY_TABLES = new Set([
  'audit_events', 'fee_ledger', 'fund_notifications',
  'cattle_costs', 'cattle_cycles', 'cattle_animals',
  'return_schedules', 'investor_allocations',
  'employees', 'employee_onboarding', 'employee_courses',
  'course_progress', 'activity_feed',
  'fica_checks',
]);

/* ─── Tables that require admin/director role for WRITE (stricter than read) ─── */
const ADMIN_WRITE_TABLES = new Set([
  'fee_ledger', 'fund_notifications',
  'cattle_costs', 'cattle_cycles', 'cattle_animals',
  'return_schedules', 'investor_allocations',
  'employees', 'employee_courses',
  'payslips',
  'eva_periods', 'pulse_surveys', 'learning_paths',
]);

/* ─── Columns that must never be set via the generic API ─── */
const PROTECTED_WRITE_COLS = {
  employees: ['pin_hash'],
  users:     ['password_hash', 'staff_pin'],
};

/* ─── Investor-owned tables: column that ties a row to an investor ─── */
const INVESTOR_COLS = {
  investors:             'id',
  investments:           'investor_id',
  transactions:          'investor_id',
  kyc_documents:         'investor_id',
  maturity_instructions: 'investor_id',
  support_tickets:       'investor_id',
  return_schedules:      'investor_id',
  investor_allocations:  'investor_id',
  investment_waitlist:   'investor_id',
  sub_accounts:          'investor_id',
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
      if (INVESTOR_COLS[table]) {
        params.push(req.user.investorId);
        conditions.push(`${INVESTOR_COLS[table]} = $${params.length}`);
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

    // Investor data isolation: verify the row belongs to this investor
    if (req.user.role === 'investor' && INVESTOR_COLS[table]) {
      const ownerCol = INVESTOR_COLS[table];
      const rowOwner = table === 'investors' ? rows[0].id : rows[0][ownerCol];
      if (rowOwner !== req.user.investorId) {
        return res.status(404).json({ error: 'Record not found.' });
      }
    }

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

    const validationErrors = validateBody(table, req.body, true);
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join('; ') });

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
        kpi_scores:            'KPI',
        achievements:          'ACH',
        leave_requests:        'LVE',
        okrs:                  'OKR',
        one_on_ones:           'O1O',
        learning_paths:        'LP',
        eva_periods:           'EVA',
        pulse_surveys:         'PULSE',
        shortterm_loans:       'STL',
        loan_documents:        'LDOC',
        solar_projects:        'SOL',
        solar_documents:       'SDOC',
        sub_accounts:          'SUBACC',
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

    /* ── Wallet credit hook ─────────────────────────────────────────────
       When a completed deposit is created directly (e.g. admin top-up,
       or EFT marked completed), atomically increment wallet_balance.
       Paystack/Ozow deposits are credited via payments.js creditWallet()
       which is idempotent, so double-credits are prevented there.
       This hook covers non-gateway deposits created via the tables API.
    ───────────────────────────────────────────────────────────────────── */
    if (table === 'transactions' && clean.type === 'deposit' && clean.status === 'completed' && clean.investor_id) {
      setImmediate(async () => {
        try {
          await pool.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
            [clean.amount, clean.investor_id]
          );
        } catch (err) {
          console.error('[wallet hook] deposit credit error:', err.message);
        }
      });
    }

    /* ── FICA deposit hook ──────────────────────────────────────────────
       When a completed deposit transaction is created, trigger an
       automated FICA check if the investor has never had one.
       Fire-and-forget: errors are logged but don't affect the response.
    ───────────────────────────────────────────────────────────────────── */
    if (
      table === 'transactions' &&
      clean.type === 'deposit' &&
      (clean.status === 'completed' || clean.status === 'pending') &&
      clean.investor_id
    ) {
      setImmediate(async () => {
        try {
          const { rows: inv } = await pool.query(
            'SELECT * FROM investors WHERE id = $1 AND last_auto_fica_check IS NULL',
            [clean.investor_id]
          );
          if (inv.length > 0) {
            const { runFicaCheck } = require('../services/ficaService');
            await runFicaCheck(inv[0], 'first_deposit');
          }
        } catch (err) {
          console.error('[FICA deposit hook] Error:', err.message);
        }
      });
    }

    // ── Email hooks (fire-and-forget) ──────────────────────────────────────
    setImmediate(async () => {
      try {
        const created = rows[0];

        // New investment → email investor
        if (table === 'investments' && created.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [created.investor_id]);
          if (inv[0]) {
            await emailService.sendInvestmentCreated(inv[0], {
              poolName:       created.pool_name || created.pool_id || 'Investment Pool',
              amount:         created.amount,
              annualRate:     created.annual_rate,
              termMonths:     created.term_months,
              expectedReturn: created.expected_return,
              endDate:        created.end_date,
            });
          }
        }

        // New pending withdrawal → email investor
        if (table === 'transactions' && created.type === 'withdrawal' && created.status === 'pending' && created.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [created.investor_id]);
          if (inv[0]) {
            await emailService.sendWithdrawalRequested(inv[0], {
              amount:    created.amount,
              reference: created.reference || created.id,
            });
          }
        }
      } catch (hookErr) {
        console.error('[email hook POST] error:', hookErr.message);
      }
    });

    // ── Push hooks (fire-and-forget) ──────────────────────────────────────
    setImmediate(async () => {
      try {
        const created = rows[0];

        // New investment → push investor
        if (table === 'investments' && created.investor_id) {
          await _sendPush(created.investor_id, {
            title: 'Investment confirmed',
            body:  `Your investment of R${Number(created.amount || 0).toLocaleString('en-ZA')} has been confirmed.`,
            url:   '/portal/',
            tag:   'investment.created',
          });
        }

        // New pending withdrawal → push investor
        if (table === 'transactions' && created.type === 'withdrawal' && created.status === 'pending' && created.investor_id) {
          await _sendPush(created.investor_id, {
            title: 'Withdrawal request received',
            body:  `Your withdrawal request of R${Number(created.amount || 0).toLocaleString('en-ZA')} is being processed.`,
            url:   '/portal/',
            tag:   'withdrawal.pending',
          });
        }
      } catch (hookErr) {
        console.error('[push hook POST] error:', hookErr.message);
      }
    });
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

    // Investor data isolation: verify record ownership before UPDATE
    if (req.user.role === 'investor' && INVESTOR_COLS[table]) {
      const ownerCol = INVESTOR_COLS[table];
      const selectCol = table === 'investors' ? 'id' : ownerCol;
      const { rows: ownerRows } = await pool.query(
        `SELECT id, ${selectCol} FROM ${table} WHERE ${key} = $1`, [req.params.id]
      );
      if (!ownerRows[0] || ownerRows[0][selectCol] !== req.user.investorId) {
        return res.status(404).json({ error: 'Record not found.' });
      }
    }

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

    // Investor data isolation: verify record ownership before UPDATE
    if (req.user.role === 'investor' && INVESTOR_COLS[table]) {
      const ownerCol = INVESTOR_COLS[table];
      const selectCol = table === 'investors' ? 'id' : ownerCol;
      const { rows: ownerRows } = await pool.query(
        `SELECT id, ${selectCol} FROM ${table} WHERE ${key} = $1`, [req.params.id]
      );
      if (!ownerRows[0] || ownerRows[0][selectCol] !== req.user.investorId) {
        return res.status(404).json({ error: 'Record not found.' });
      }
    }

    const body   = { ...req.body };
    delete body[key];
    delete body.created_at;
    body.updated_at = new Date().toISOString();

    const validationErrors = validateBody(table, req.body, false);
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join('; ') });

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

    // ── Audit + Email hooks (fire-and-forget) ─────────────────────────────
    setImmediate(async () => {
      try {
        const updated = rows[0];
        const actor   = req.user || {};

        // Audit log key status changes
        const auditMap = {
          'kyc_documents:approved':    'kyc.approved',
          'kyc_documents:rejected':    'kyc.rejected',
          'transactions:completed':    'transaction.completed',
          'transactions:rejected':     'transaction.rejected',
          'investments:paid_out':      'investment.paid_out',
          'investors:approved':        'investor.approved',
        };
        const auditKey = body.status ? `${table}:${body.status}` : (body.bank_account_status ? `${table}:${body.bank_account_status}` : null);
        if (auditKey && auditMap[auditKey]) {
          await audit.log({
            actorId: actor.id, actorEmail: actor.email, action: auditMap[auditKey],
            entityType: table, entityId: req.params.id,
            description: `${auditMap[auditKey]} on ${table}#${req.params.id}`,
            ip: req.ip,
          });
        }

        // Deposit confirmed → email + SMS investor
        if (table === 'transactions' && body.status === 'completed' && updated.type === 'deposit' && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) {
            const gateway = updated.description?.includes('Paystack') ? 'Paystack'
                          : updated.description?.includes('Ozow')     ? 'Ozow'
                          : 'EFT';
            await emailService.sendDepositConfirmed(inv[0], updated.amount, updated.reference || updated.id, gateway);
            await smsService.sendDepositConfirmed(inv[0].phone, inv[0].first_name, updated.amount);
          }
        }

        // Support ticket assigned → email the assigned user
        if (table === 'support_tickets' && body.assigned_to) {
          const { rows: assignedUser } = await pool.query(
            `SELECT first_name, last_name, email FROM users WHERE email = $1 AND is_active = true LIMIT 1`,
            [body.assigned_to]
          );
          if (assignedUser[0]) {
            const tktSubject = updated.subject || `Ticket #${updated.id}`;
            await emailService.sendTicketAssigned(assignedUser[0], {
              ticketId:     updated.id,
              subject:      tktSubject,
              investorName: updated.investor_name || updated.investor_id || 'An investor',
              category:     updated.category || '',
              priority:     updated.priority || 'normal',
            });
          }
        }

        // Support ticket response → email investor
        if (table === 'support_tickets' && body.admin_response && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) {
            await emailService.sendTicketResponse(inv[0], {
              subject:       updated.subject,
              adminResponse: updated.admin_response,
            });
          }
        }

        // Investment paid out → email + SMS investor
        if (table === 'investments' && body.status === 'paid_out' && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) {
            const poolName = updated.pool_name || updated.pool_id || 'your investment';
            await emailService.sendInvestmentMatured(inv[0], {
              poolName,
              amount:       updated.amount,
              actualReturn: updated.actual_return || 0,
            });
            await smsService.sendMaturityAlert(inv[0].phone, inv[0].first_name, updated.amount, poolName);
          }
        }

        // Withdrawal completed → email + SMS investor
        if (table === 'transactions' && body.status === 'completed' && updated.type === 'withdrawal' && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) {
            await emailService.sendWithdrawalProcessed(inv[0], {
              amount:    updated.amount,
              reference: updated.reference || updated.id,
              bankName:  inv[0].bank_name,
            });
            await smsService.sendWithdrawalProcessed(inv[0].phone, inv[0].first_name, updated.amount);
          }
        }

        // Withdrawal rejected → refund wallet + email + SMS investor
        if (table === 'transactions' && body.status === 'rejected' && updated.type === 'withdrawal' && updated.investor_id) {
          await pool.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1 WHERE id = $2',
            [updated.amount, updated.investor_id]
          );
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) {
            await emailService.sendWithdrawalRejected(inv[0], {
              amount:    updated.amount,
              reference: updated.reference || updated.id,
              reason:    updated.description,
            });
            await smsService.sendWithdrawalRejected(inv[0].phone, inv[0].first_name, updated.amount);
          }
        }

        // Bank account approved → email investor
        if (table === 'investors' && body.bank_account_status === 'approved') {
          await emailService.sendBankAccountApproved(updated, {
            bankName:      updated.bank_name,
            accountNumber: updated.bank_account_number,
          });
        }

        // FICA status approved → record fica_approved_at timestamp (once only)
        if (table === 'investors' && body.fica_status === 'approved') {
          await pool.query(
            'UPDATE investors SET fica_approved_at=NOW() WHERE id=$1 AND fica_approved_at IS NULL',
            [req.params.id]
          ).catch(() => {});
        }

        // KYC document approved → email investor
        if (table === 'kyc_documents' && body.status === 'approved' && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) await emailService.sendKycApproved(inv[0]);
        }

        // KYC document rejected → email investor with reason from notes
        if (table === 'kyc_documents' && body.status === 'rejected' && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) await emailService.sendKycRejected(inv[0], { notes: updated.notes });
        }

        // Pool reopened → notify waitlisted investors
        if (table === 'investment_pools' && body.status === 'active' && updated.id) {
          (async () => {
            try {
              const { rows: waitlist } = await pool.query(
                `SELECT w.*, inv.email, inv.first_name, inv.last_name
                 FROM investment_waitlist w
                 JOIN investors inv ON inv.id = w.investor_id
                 WHERE w.pool_id = $1 AND w.notified = false`,
                [updated.id]
              );
              for (const entry of waitlist) {
                await emailService.sendWaitlistNotification(
                  { email: entry.email, first_name: entry.first_name, last_name: entry.last_name },
                  { poolName: updated.pool_name || updated.id }
                ).catch(e => console.error('[waitlist] email error:', e.message));
                await pool.query(
                  'UPDATE investment_waitlist SET notified = true, notified_at = NOW() WHERE id = $1',
                  [entry.id]
                );
              }
              console.log(`[waitlist] Notified ${waitlist.length} investors for pool ${updated.id}`);
            } catch (e) {
              console.error('[waitlist] notification error:', e.message);
            }
          })();
        }
      } catch (hookErr) {
        console.error('[email hook PATCH] error:', hookErr.message);
      }
    });

    // ── Push hooks (fire-and-forget) ──────────────────────────────────────
    setImmediate(async () => {
      try {
        const updated = rows[0];

        // Deposit confirmed → push
        if (table === 'transactions' && body.status === 'completed' && updated.type === 'deposit' && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'Deposit confirmed',
            body:  `R${Number(updated.amount || 0).toLocaleString('en-ZA')} has been credited to your wallet.`,
            url:   '/portal/',
            tag:   'deposit.confirmed',
          });
        }

        // Investment paid out → push
        if (table === 'investments' && body.status === 'paid_out' && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'Investment paid out',
            body:  `Your investment of R${Number(updated.amount || 0).toLocaleString('en-ZA')} has matured and been paid out.`,
            url:   '/portal/',
            tag:   'investment.paid_out',
          });
        }

        // KYC approved → push
        if (table === 'kyc_documents' && body.status === 'approved' && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'KYC approved',
            body:  'Your identity document has been verified. You can now invest.',
            url:   '/portal/',
            tag:   'kyc.approved',
          });
        }

        // KYC rejected → push
        if (table === 'kyc_documents' && body.status === 'rejected' && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'KYC document requires attention',
            body:  'One of your documents could not be verified. Please resubmit.',
            url:   '/portal/',
            tag:   'kyc.rejected',
          });
        }

        // Support ticket response → push
        if (table === 'support_tickets' && body.admin_response && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'New response to your support ticket',
            body:  `A response has been added to your ticket: ${updated.subject || 'Support Request'}`,
            url:   '/portal/',
            tag:   'support.response',
          });
        }
      } catch (hookErr) {
        console.error('[push hook PATCH] error:', hookErr.message);
      }
    });
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
