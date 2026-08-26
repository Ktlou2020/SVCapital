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

/* ─── Lazy-load SSE broadcast ─── */
let _sseBroadcast = null;
function _getBroadcast() {
  if (!_sseBroadcast) { try { _sseBroadcast = require('./events').broadcast; } catch (_) {} }
  return _sseBroadcast;
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
const STATUS_FIELDS  = { status: ['active','inactive','suspended','pending','pending_fica','fica_submitted','matured','paid_out','cancelled','rejected','failed','open','filling','closed','resolved','in_review','completed','waitlist','in_progress','waiting_investor','submitted','approved','expired','archived'], fica_status: ['pending','approved','rejected','not_started','submitted','in_progress'], bank_account_status: ['none','pending','approved','rejected'], maturity_instruction: ['payout_all','payout_return','payout_custom','reinvest','switch_product','custom_switch','pending'] };
const TABLE_STATUS_OVERRIDES = {
  pe_companies:    ['prospect','deal_flow','due_diligence','approved','portfolio','exited','declined'],
  pe_fees:         ['projected','invoiced','paid','overdue','waived'],
  change_requests: ['pending','reviewing','approved','rejected','implemented'],
};

/* Normalise external fica_status values (e.g. from Firebase import / KYC provider) to internal ones */
const _FICA_NORM_MAP = { Approved:'approved', Verified:'approved', Declined:'rejected', Unverified:'not_started', Outstanding:'pending', Pending:'pending' };

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
      const allowed = (key === 'status' && TABLE_STATUS_OVERRIDES[table]) ? TABLE_STATUS_OVERRIDES[table] : STATUS_FIELDS[key];
      if (!allowed.includes(val)) {
        errors.push(`${key} must be one of: ${allowed.join(', ')}`);
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
  solar_investment_periods: 'id',
  solar_documents:       'id',
  fica_checks:           'id',   // read-only via generic API; writes via /api/fica/*
  quest_completions:     'id',   // read via generic API; writes via /api/quests/*
  users:                 'id',   // limited, no password_hash exposed
  investment_waitlist:      'id',
  international_waitlist:   'id',
  compliance_calendar:      'id',
  accepted_client_documents: 'id',
  products:                 'id',
  pe_companies:             'id',
  pe_deals:                 'id',
  pe_financials:            'id',
  pe_fees:                  'id',
  pe_updates:               'id',
  pe_reviews:               'id',
  change_requests:          'id',
};

/* ─── Tables that require admin/director role for READ ─── */
const ADMIN_ONLY_TABLES = new Set([
  'audit_events', 'fee_ledger', 'fund_notifications',
  'cattle_costs', 'cattle_cycles', 'cattle_animals',
  'return_schedules', 'investor_allocations',
  'fica_checks', 'accepted_client_documents',
  'compliance_calendar',
]);
// NOTE: `employees` is intentionally NOT admin-only — it is row-isolated via
// EMPLOYEE_OWNED_COLS so each staff member can read only their own record.
// `employee_courses` is a shared course catalog readable by all staff (writes
// remain admin-only via ADMIN_WRITE_TABLES).

/* ─── Tables that require admin/director role for WRITE (stricter than read) ─── */
const ADMIN_WRITE_TABLES = new Set([
  'fee_ledger', 'fund_notifications',
  'cattle_costs', 'cattle_cycles', 'cattle_animals',
  'return_schedules', 'investor_allocations',
  'employees', 'employee_courses',
  'payslips',
  'eva_periods', 'pulse_surveys', 'learning_paths',
  'products',
  'investment_pools', 'platform_settings', 'fund_runs', 'ifas',
  'fica_checks', 'compliance_calendar', 'accepted_client_documents',
]);

/* ─── Columns that must never be written via the generic API (any role) ─── */
const ALWAYS_PROTECTED_COLS = new Set([
  'pin_hash', 'password_hash', 'staff_pin', 'totp_enabled',
]);
/* ─── Columns that non-admin roles (investor, ifa, staff) cannot write ─── */
const INVESTOR_PROTECTED_COLS = new Set([
  'fica_status', 'kyc_status', 'wallet_balance', 'total_invested',
]);
/* ─── Combined set used by legacy references ─── */
const PROTECTED_WRITE_COLS = new Set([...ALWAYS_PROTECTED_COLS, ...INVESTOR_PROTECTED_COLS]);

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
  sub_accounts:          'parent_investor_id',
};

/* ─── Employee-owned tables: rows belong to a specific employee ─── */
/* Non-admin staff (with empId in JWT) are auto-filtered to their own rows. */
/* Admin/director roles see all rows. */
const EMPLOYEE_OWNED_COLS = {
  employees:           'id',          // staff may read/modify only their own record
  kpi_scores:          'employee_id',
  achievements:        'employee_id',
  leave_requests:      'employee_id',
  daily_checkins:      'employee_id',
  okrs:                'employee_id',
  pulse_responses:     'employee_id',
  one_on_ones:         'employee_id',
  personal_notes:      'employee_id',
  payslips:            'employee_id',
  activity_feed:       'employee_id',
  course_progress:     'employee_id',
  change_requests:     'employee_id',
  employee_onboarding: 'employee_id',
};

/* ─── Columns to strip from responses ─── */
const STRIP_COLS = {
  investors: ['totp_secret', 'totp_temp_secret'],
  users: ['password_hash', 'staff_pin', 'totp_secret', 'totp_temp_secret'],
  employees: ['pin_hash', 'id_number', 'login_attempts', 'login_locked_until'],
};

const ADMIN_ROLES = new Set(['admin', 'director', 'fund_manager']);

function stripSensitive(table, rows, ownEmpId, userRole) {
  const cols = STRIP_COLS[table];
  if (!cols) return rows;
  return rows.map(row => {
    const clean = { ...row };
    cols.forEach(c => {
      // pin_hash is always stripped — never exposed.
      if (c === 'pin_hash') { delete clean[c]; return; }
      // id_number: visible to the employee themselves and to admin/director roles.
      if (c === 'id_number' && table === 'employees') {
        if ((ownEmpId && row.id === ownEmpId) || ADMIN_ROLES.has(userRole)) return;
      }
      delete clean[c];
    });
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

/* ─── GET /api/tables/leave-calendar ───────────────────────────────
   Shared team leave calendar: any authenticated staff member can see
   EVERYONE's APPROVED leave (with names/colours) so the calendar is
   visible to the whole team. Must be declared before the generic
   /:table route so it isn't treated as a table name. */
router.get('/leave-calendar', requireAuth, async (req, res) => {
  if (!req.user.empId && !['admin', 'director', 'fund_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Staff only.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT lr.id, lr.employee_id, lr.leave_type,
              TO_CHAR(lr.start_date, 'YYYY-MM-DD') AS start_date,
              TO_CHAR(lr.end_date,   'YYYY-MM-DD') AS end_date,
              lr.days_requested, lr.status, lr.reason,
              e.first_name, e.last_name, e.avatar_color, e.avatar_initials
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       WHERE lr.status = 'approved'
         AND lr.end_date >= (NOW() - INTERVAL '60 days')
       ORDER BY lr.start_date`
    );
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('[leave-calendar] error:', err.message);
    res.status(500).json({ error: 'Could not load leave calendar.' });
  }
});

/* ─── GET /api/tables/:table ─── */
router.get('/:table', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;

    let { page = 1, limit = 100, search, sort, order = 'asc', date_from, date_to, ...filters } = req.query;
    page  = Math.max(1, parseInt(page));
    limit = Math.max(1, parseInt(limit));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params     = [];

    // ─── Role-based access control ───
    const isAdminOrDirector = ['admin', 'director', 'fund_manager'].includes(req.user.role);
    limit = Math.min(isAdminOrDirector ? 10000 : 500, limit);

    // employee tables: admins get all; staff with empId are filtered to their own rows
    const isLeadOrExec = ['lead', 'executive'].includes(req.user.level);
    if (!isAdminOrDirector) {
      if (ADMIN_ONLY_TABLES.has(table)) {
        return res.status(403).json({ error: 'Forbidden.' });
      }
      // Employee-owned tables require a staff identity (empId) and are isolated
      // to that employee's own rows. Non-staff (e.g. investors) get nothing.
      // Exception: leads and executives may read change_requests without ownership filter.
      if (EMPLOYEE_OWNED_COLS[table] || table === 'peer_feedback') {
        if (!req.user.empId) {
          return res.status(403).json({ error: 'Forbidden.' });
        }
        if (EMPLOYEE_OWNED_COLS[table] && !(table === 'change_requests' && isLeadOrExec)) {
          params.push(req.user.empId);
          conditions.push(`${EMPLOYEE_OWNED_COLS[table]} = $${params.length}`);
        }
        // peer_feedback: staff can only see rows they sent or received
        if (table === 'peer_feedback') {
          params.push(req.user.empId);
          params.push(req.user.empId);
          conditions.push(`(from_employee_id = $${params.length - 1} OR to_employee_id = $${params.length})`);
        }
      }
    }

    // ─── Role-based data isolation ───
    // Investors only see their own data
    if (req.user.role === 'investor') {
      let investorId = req.user.investorId;
      // JWT may lack investorId for older sessions — look it up from users table
      if (!investorId && req.user.id) {
        const uRow = await pool.query('SELECT investor_id FROM users WHERE id = $1', [req.user.id]);
        investorId = uRow.rows[0]?.investor_id || null;
      }
      // Verify the ID actually exists — stale/demo values like 'INV-001' look non-null
      // but point to no real investor, causing WHERE 1=0 on every scoped query.
      if (investorId) {
        const vRow = await pool.query('SELECT id FROM investors WHERE id = $1 LIMIT 1', [investorId]);
        if (!vRow.rows[0]) investorId = null; // invalid — fall through to email match
      }
      // Last resort: match investor by email (case-insensitive) and auto-repair the broken users.investor_id link
      if (!investorId && req.user.email) {
        const eRow = await pool.query('SELECT id FROM investors WHERE LOWER(email) = LOWER($1) LIMIT 1', [req.user.email]);
        investorId = eRow.rows[0]?.id || null;
        if (investorId && req.user.id) {
          pool.query('UPDATE users SET investor_id=$1 WHERE id=$2', [investorId, req.user.id]).catch(() => {});
        }
      }
      if (INVESTOR_COLS[table]) {
        if (investorId) {
          params.push(investorId);
          conditions.push(`${INVESTOR_COLS[table]} = $${params.length}`);
        } else {
          conditions.push('1=0'); // no investor linked — return nothing
        }
      }

      /* A cancelled investment is an administrative record, not a holding. It
         was showing on the client's own dashboard as a card. Excluded here
         rather than filtered in the UI so it never reaches the browser at all
         and no surface can reintroduce it by forgetting the filter.
         Staff roles are unaffected — admin still sees every record. */
      if (table === 'investments') {
        conditions.push(`COALESCE(status, '') <> 'cancelled'`);
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

    // Date range filter (used by audit log and other date-ranged tables)
    if (date_from) {
      params.push(date_from);
      conditions.push(`created_at >= $${params.length}::date`);
    }
    if (date_to) {
      params.push(date_to);
      conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    // Filter by remaining query params (simple equality)
    for (const [key, val] of Object.entries(filters)) {
      // Skip internal params
      if (['page','limit','search','sort','order','date_from','date_to'].includes(key)) continue;
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
      } else if (table === 'audit_events') {
        conditions.push(`(event_type ILIKE $${params.length} OR user_email ILIKE $${params.length} OR description ILIKE $${params.length} OR entity_type ILIKE $${params.length} OR ip_address ILIKE $${params.length})`);
      } else if (table === 'cattle_animals') {
        conditions.push(`(tag_number ILIKE $${params.length} OR batch_name ILIKE $${params.length} OR batch_no::text ILIKE $${params.length} OR breed ILIKE $${params.length})`);
      } else if (table === 'cattle_cycles') {
        conditions.push(`(batch_name ILIKE $${params.length} OR company ILIKE $${params.length} OR inv_no::text ILIKE $${params.length})`);
      } else {
        conditions.push(`id::text ILIKE $${params.length}`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort — use the original date column for tables that have one
    const defaultSort = {
      investors:                 'date_joined',
      transactions:              'COALESCE(transaction_date, created_at)',
      investments:               'COALESCE(start_date, created_at)',
      cattle_animals:            'tag_number',
      cattle_cycles:             'batch_name',
      accepted_client_documents: 'accepted_at',
    };
    const defaultDir = (table === 'cattle_animals' || table === 'cattle_cycles') ? 'ASC' : 'DESC';
    let orderClause = `ORDER BY ${defaultSort[table] || 'created_at'} ${defaultDir} NULLS LAST`;
    if (sort && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort)) {
      const dir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      orderClause = `ORDER BY ${sort} ${dir} NULLS LAST`;
    }

    params.push(limit, offset);

    /* ── Special query for investment_pools: enrich with live aggregates ── */
    let query, countQuery;
    if (table === 'investment_pools') {
      const whereClause = where ? where.replace(/\b(status|id|name|product_type|created_at)\b/g, 'ip.$1') : '';
      query = `
        SELECT
          ip.*,
          COALESCE(agg.live_investor_count,  name_agg.live_investor_count,  0) AS live_investor_count,
          COALESCE(agg.live_raised,          name_agg.live_raised,          0) AS live_raised,
          COALESCE(agg.live_active_amount,   name_agg.live_active_amount,   0) AS live_active_amount,
          COALESCE(agg.live_investment_count,name_agg.live_investment_count, 0) AS live_investment_count
        FROM investment_pools ip
        LEFT JOIN (
          SELECT
            pool_id,
            COUNT(DISTINCT CASE WHEN status != 'cancelled' AND sub_account_id IS NOT NULL THEN 'sa:' || sub_account_id
                                WHEN status != 'cancelled' THEN 'inv:' || investor_id END) AS live_investor_count,
            SUM(CASE WHEN status IN ('active','matured','paid_out') THEN amount ELSE 0 END) AS live_raised,
            SUM(CASE WHEN status = 'active'  THEN amount ELSE 0 END)            AS live_active_amount,
            COUNT(CASE WHEN status != 'cancelled' THEN 1 END)                   AS live_investment_count
          FROM investments
          WHERE pool_id IS NOT NULL
          GROUP BY pool_id
        ) agg ON agg.pool_id = ip.id
        LEFT JOIN (
          SELECT
            pool_name,
            COUNT(DISTINCT CASE WHEN status != 'cancelled' AND sub_account_id IS NOT NULL THEN 'sa:' || sub_account_id
                                WHEN status != 'cancelled' THEN 'inv:' || investor_id END) AS live_investor_count,
            SUM(CASE WHEN status IN ('active','matured','paid_out') THEN amount ELSE 0 END) AS live_raised,
            SUM(CASE WHEN status = 'active'  THEN amount ELSE 0 END)            AS live_active_amount,
            COUNT(CASE WHEN status != 'cancelled' THEN 1 END)                   AS live_investment_count
          FROM investments
          WHERE pool_name IS NOT NULL
          GROUP BY pool_name
        ) name_agg ON name_agg.pool_name = ip.name AND agg.pool_id IS NULL
        ${whereClause}
        ${orderClause.replace(/\b(status|id|name|product_type|created_at)\b/g, 'ip.$1')}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
      countQuery = `SELECT COUNT(*) FROM investment_pools ip ${whereClause}`;
    } else if (table === 'investments') {
      // Always resolve product_type from the linked pool so migrated investments
      // display the correct product label regardless of what was stored on the row.
      const invWhere   = where   ? where.replace(/\b(id|investor_id|pool_id|status|product_type|created_at|start_date|end_date|amount)\b/g, 'i.$1') : '';
      const invOrder   = orderClause.replace(/\b(id|investor_id|pool_id|status|product_type|created_at|start_date|end_date|amount)\b/g, 'i.$1');
      query = `
        SELECT i.*,
               COALESCE(ip.product_type, i.product_type) AS product_type,
               ip.actual_rate AS pool_actual_rate
        FROM investments i
        LEFT JOIN investment_pools ip ON ip.id = i.pool_id
        ${invWhere}
        ${invOrder}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
      countQuery = `SELECT COUNT(*) FROM investments i LEFT JOIN investment_pools ip ON ip.id = i.pool_id ${invWhere}`;
    } else if (table === 'kyc_documents') {
      // Exclude file_data (base64 blobs) from list queries — fetching thousands of
      // documents with embedded file contents times out. File data is only fetched
      // by specific routes (bankVerify, portal) that select it explicitly.
      query = `
        SELECT id, investor_id, doc_type, status, file_url, file_name, notes,
               reviewed_by, reviewed_at, submitted_at, created_at, updated_at,
               sub_account_id, investor_name, reviewed_date, expiry_date, doc_subtype
        FROM kyc_documents
        ${where}
        ${orderClause}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
      countQuery = `SELECT COUNT(*) FROM kyc_documents ${where}`;
    } else {
      query = `
        SELECT * FROM ${table}
        ${where}
        ${orderClause}
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
      countQuery = `SELECT COUNT(*) FROM ${table} ${where}`;
    }

    const countParams = params.slice(0, -2);

    const [dataResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
    ]);

    const rows  = stripSensitive(table, dataResult.rows, req.user?.empId, req.user?.role);
    const total = parseInt(countResult.rows[0].count);

    // Normalise legacy return-transaction wording: "Monthly interest" → "Return Earned"
    // (covers existing rows for all platforms; the interest cron already writes the new wording).
    if (table === 'transactions') {
      for (const r of rows) {
        if (r && typeof r.description === 'string' && r.description.indexOf('Monthly interest') !== -1) {
          r.description = r.description.replace(/Monthly interest/g, 'Return Earned');
        }
        // Strip admin-only notes from non-admin/director users
        if (r && !isAdminOrDirector) {
          r.notes = undefined;
        }
      }
    }

    res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/tables/investors/next-account ─── */
router.get('/investors/next-account', requireAuth, async (req, res) => {
  try {
    if (!['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });
    const { rows } = await pool.query(`
      SELECT COALESCE(
        MAX(CAST(REGEXP_REPLACE(id, '^[A-Za-z]+-', '') AS BIGINT)),
        100000
      ) + 1 AS next_num
      FROM investors
      WHERE id ~ '^[A-Za-z]+-[0-9]+$'
    `);
    res.json({ account_number: `SV-${rows[0].next_num}` });
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/tables/investors/:id/activity ─── */
/* Returns login/session/device activity for an investor (admin only) */
router.get('/investors/:id/activity', requireAuth, async (req, res) => {
  try {
    if (!['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const investorId = req.params.id;

    const [userRes, pushRes, sessionRes, invRes] = await Promise.all([
      pool.query(`
        SELECT id, email, role, created_at, last_login, totp_enabled, is_active
        FROM users WHERE investor_id = $1 LIMIT 1
      `, [investorId]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT platform,
               COALESCE(app_version, NULL) AS app_version,
               COALESCE(device_name, NULL) AS device_name,
               created_at, updated_at
        FROM push_tokens WHERE investor_id = $1
        ORDER BY updated_at DESC
      `, [investorId]).catch(() =>
        pool.query(`SELECT platform, created_at, updated_at FROM push_tokens WHERE investor_id = $1 ORDER BY updated_at DESC`, [investorId]).catch(() => ({ rows: [] }))
      ),

      pool.query(`
        SELECT s.ip_address, s.user_agent, s.created_at, s.last_used_at, s.expires_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE u.investor_id = $1
          AND s.expires_at > NOW()
        ORDER BY s.last_used_at DESC
        LIMIT 10
      `, [investorId]).catch(() => ({ rows: [] })),

      pool.query(`
        SELECT last_login_at FROM investors WHERE id = $1 LIMIT 1
      `, [investorId]).catch(() => ({ rows: [] })),
    ]);

    // Merge investor.last_login_at as fallback when users.last_login is null
    const userRow = userRes.rows[0] || null;
    const invLastLogin = invRes.rows[0]?.last_login_at || null;
    if (userRow && !userRow.last_login && invLastLogin) {
      userRow.last_login = invLastLogin;
    }

    res.json({
      user:     userRow,
      devices:  pushRes.rows,
      sessions: sessionRes.rows,
    });
  } catch (err) {
    console.error('[tables] investor activity', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/tables/investment_pools/:id/merge ─── */
/* Moves all investments from source pool into target pool, then deletes source */
router.post('/investment_pools/:id/merge', requireAuth, async (req, res) => {
  try {
    if (!['admin','director'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const sourceId = req.params.id;
    const { target_pool_id } = req.body || {};
    if (!target_pool_id)    return res.status(400).json({ error: 'target_pool_id required' });
    if (target_pool_id === sourceId) return res.status(400).json({ error: 'Cannot merge a pool into itself' });

    const { rowCount: merged } = await pool.query(
      `UPDATE investments SET pool_id = $1 WHERE pool_id = $2`,
      [target_pool_id, sourceId]
    );
    await pool.query(`DELETE FROM investment_pools WHERE id = $1`, [sourceId]);
    res.json({ merged, deleted: sourceId });
  } catch (err) {
    console.error('[merge pool]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/tables/investment_pools/:id/all-investments ─── */
/* Returns all investments for a pool matched by pool_id OR legacy pool_name */
router.get('/investment_pools/:id/all-investments', requireAuth, async (req, res) => {
  try {
    if (!['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const poolId = req.params.id;
    const { rows } = await pool.query(`
      SELECT
        i.id, i.investor_id, i.sub_account_id, i.pool_id, i.pool_name,
        i.amount, i.status, i.start_date, i.end_date, i.annual_rate,
        i.term_months, i.product_type, i.payout_option, i.notes,
        i.maturity_instruction, i.is_reinvestment, i.created_at,
        ip.actual_rate AS pool_actual_rate,
        inv.first_name || ' ' || inv.last_name AS investor_name,
        inv.email AS investor_email
      FROM investments i
      JOIN investors inv ON inv.id = i.investor_id
      JOIN investment_pools ip ON ip.id = $1
      WHERE i.pool_id = $1
         OR (i.pool_name = ip.name AND i.pool_id IS NULL)
      ORDER BY i.end_date DESC NULLS LAST, i.created_at DESC
    `, [poolId]);

    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('[pool all-investments]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/tables/investment_pools/unmerge ─── */
/* Recreates a deleted source pool and moves specified investments back into it */
router.post('/investment_pools/unmerge', requireAuth, async (req, res) => {
  try {
    if (!['admin', 'director'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const { investment_ids, pool: poolData } = req.body || {};
    if (!Array.isArray(investment_ids) || !investment_ids.length)
      return res.status(400).json({ error: 'investment_ids required' });
    if (!poolData?.name || !poolData?.product_type)
      return res.status(400).json({ error: 'pool.name and pool.product_type required' });

    const newPoolId = uuidv4();
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query(
        `INSERT INTO investment_pools
           (id, name, product_type, status, target_amount, raised_amount,
            min_investment, max_investment, annual_rate, term_months,
            start_date, end_date, maturity_date, description, risk_level,
            partner_name, management_fee_pct, operational_fee_pct,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())`,
        [
          newPoolId,
          poolData.name,
          poolData.product_type,
          poolData.status || 'open',
          poolData.target_amount || 0,
          0,
          poolData.min_investment || 1000,
          poolData.max_investment || null,
          poolData.annual_rate || 0,
          poolData.term_months || 6,
          poolData.start_date || null,
          poolData.end_date || null,
          poolData.maturity_date || null,
          poolData.description || null,
          poolData.risk_level || 'medium',
          poolData.partner_name || null,
          poolData.management_fee_pct || 0,
          poolData.operational_fee_pct || 0,
        ]
      );
      const { rowCount: moved } = await dbClient.query(
        `UPDATE investments SET pool_id = $1
         WHERE id = ANY($2::text[])`,
        [newPoolId, investment_ids]
      );
      await dbClient.query('COMMIT');
      res.json({ pool_id: newPoolId, moved });
    } catch (err) {
      await dbClient.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[unmerge pools]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/tables/investment_pools/:id/investors ─── */
/* Returns all investors + their investment details for a specific pool */
router.get('/investment_pools/:id/investors', requireAuth, async (req, res) => {
  try {
    if (!['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

    const [poolRes, evaRes] = await Promise.all([
      pool.query('SELECT management_fee_pct, operational_fee_pct FROM investment_pools WHERE id = $1', [req.params.id]),
      pool.query("SELECT value FROM platform_settings WHERE key = 'eva_rate'"),
    ]);
    const mgmtFeePct = parseFloat(poolRes.rows[0]?.management_fee_pct) || 0;
    const evaRate    = parseFloat(evaRes.rows[0]?.value) || 0.15;

    const { rows } = await pool.query(`
      SELECT
        inv.id            AS investment_id,
        inv.investor_id,
        inv.sub_account_id,
        inv.amount,
        inv.status        AS investment_status,
        inv.start_date,
        inv.end_date,
        inv.annual_rate,
        inv.expected_return,
        inv.maturity_instruction,
        inv.is_reinvestment,
        COALESCE(inv.eva_amount, 0) AS eva_amount,
        i.first_name,
        i.last_name,
        i.email,
        i.phone,
        i.kyc_status,
        sa.name         AS sub_account_name,
        sa.account_type AS sub_account_type,
        ip.actual_rate  AS pool_actual_rate
      FROM investments inv
      LEFT JOIN investors i ON i.id = inv.investor_id
      LEFT JOIN sub_accounts sa ON sa.id = inv.sub_account_id
      LEFT JOIN investment_pools ip ON ip.id = inv.pool_id
      WHERE inv.pool_id = $1
         OR (
           inv.pool_id IS NULL
           AND inv.pool_name IS NOT NULL
           AND inv.pool_name = (SELECT name FROM investment_pools WHERE id = $1 LIMIT 1)
         )
      ORDER BY inv.start_date DESC NULLS LAST
    `, [req.params.id]);

    // Augment each row with fee breakdown
    const PLATFORM_FEE_PCT = 0.01;
    rows.forEach(r => {
      const amt         = parseFloat(r.amount) || 0;
      const platformFee = r.is_reinvestment ? 0 : Math.round(amt * PLATFORM_FEE_PCT * 100) / 100;
      const upfrontFee  = Math.round(amt * mgmtFeePct * 100) / 100;
      // EVA is evaRate% of the upfront fee net of 15% VAT — taken from the upfront fee, not additional
      const evaCalc     = Math.round((upfrontFee / 1.15) * evaRate * 100) / 100;
      const totalFees   = Math.round((platformFee + upfrontFee) * 100) / 100;
      const netAmount   = Math.round((amt - upfrontFee) * 100) / 100;
      r.platform_fee    = platformFee;
      r.upfront_fee     = upfrontFee;
      r.eva_contribution = evaCalc;
      r.total_fees      = totalFees;
      r.net_amount      = netAmount;
    });

    const activeRows = rows.filter(r => r.investment_status !== 'cancelled');
    const summary = {
      total_invested:       activeRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
      investor_count:       new Set(activeRows.map(r => r.sub_account_id ? `sa:${r.sub_account_id}` : `inv:${r.investor_id}`)).size,
      active_count:         rows.filter(r => r.investment_status === 'active').length,
      matured_count:        rows.filter(r => r.investment_status === 'matured').length,
      cancelled_count:      rows.filter(r => r.investment_status === 'cancelled').length,
      total_platform_fees:  activeRows.reduce((s, r) => s + (r.platform_fee || 0), 0),
      total_upfront_fees:   activeRows.reduce((s, r) => s + (r.upfront_fee || 0), 0),
      total_eva:            activeRows.reduce((s, r) => s + (r.eva_contribution || 0), 0),
      total_fees:           activeRows.reduce((s, r) => s + (r.total_fees || 0), 0),
      total_net_invested:   activeRows.reduce((s, r) => s + (r.net_amount || 0), 0),
      mgmt_fee_pct:         mgmtFeePct,
    };

    res.json({ investors: rows, summary });
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── GET /api/tables/:table/:id ─── */
router.get('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;
    const isAdminOrDirector = ['admin', 'director', 'fund_manager'].includes(req.user.role);

    // FIX 4: ADMIN_ONLY_TABLES check for single-record GET
    if (!isAdminOrDirector && ADMIN_ONLY_TABLES && ADMIN_ONLY_TABLES.has(table)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }


    let rows;
    if (table === 'investments') {
      const r = await pool.query(
        `SELECT i.*, COALESCE(ip.product_type, i.product_type) AS product_type,
                ip.actual_rate AS pool_actual_rate
         FROM investments i
         LEFT JOIN investment_pools ip ON ip.id = i.pool_id
         WHERE i.${key} = $1 LIMIT 1`,
        [req.params.id]
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT * FROM ${table} WHERE ${key} = $1 LIMIT 1`,
        [req.params.id]
      );
      rows = r.rows;
    }
    if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });

    // Investor data isolation: verify the row belongs to this investor
    if (req.user.role === 'investor' && INVESTOR_COLS[table]) {
      let investorId = req.user.investorId;
      // JWT may lack investorId for older sessions — look it up from users table
      if (!investorId && req.user.id) {
        const uRow = await pool.query('SELECT investor_id FROM users WHERE id = $1', [req.user.id]);
        investorId = uRow.rows[0]?.investor_id || null;
      }
      // Last resort: match investor by email (case-insensitive) and auto-repair the link
      if (!investorId && req.user.email) {
        const eRow = await pool.query('SELECT id FROM investors WHERE LOWER(email) = LOWER($1) LIMIT 1', [req.user.email]);
        investorId = eRow.rows[0]?.id || null;
        if (investorId && req.user.id) {
          pool.query('UPDATE users SET investor_id=$1 WHERE id=$2', [investorId, req.user.id]).catch(() => {});
        }
      }
      const ownerCol = INVESTOR_COLS[table];
      const rowOwner = table === 'investors' ? rows[0].id : rows[0][ownerCol];
      if (rowOwner !== investorId) {
        return res.status(404).json({ error: 'Record not found.' });
      }
      // Same rule as the list: a client cannot fetch a cancelled investment
      // directly either. 404, matching what a non-existent record returns —
      // nothing here should confirm that the record exists.
      if (table === 'investments' && rows[0].status === 'cancelled') {
        return res.status(404).json({ error: 'Record not found.' });
      }
    }

    // IFA single-record GET: look up assigned_clients from DB — it is not in the JWT payload
    if (req.user && req.user.role === 'ifa' && rows[0] && rows[0].investor_id) {
      const { rows: ifaRows } = await pool.query(
        'SELECT assigned_clients FROM ifas WHERE id = $1', [req.user.ifaId]
      );
      const assigned = ifaRows[0]?.assigned_clients || [];
      if (!assigned.includes(rows[0].investor_id)) {
        return res.status(403).json({ error: 'Forbidden.' });
      }
    }

    const [clean] = stripSensitive(table, rows, req.user?.empId, req.user?.role);
    res.json(clean);
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
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

    const isPrivileged = ['admin', 'director', 'fund_manager'].includes(req.user.role);
    ALWAYS_PROTECTED_COLS.forEach(c => delete body[c]);
    if (!isPrivileged) INVESTOR_PROTECTED_COLS.forEach(c => delete body[c]);

    // Normalise external FICA status values before validation
    if (body.fica_status && _FICA_NORM_MAP[body.fica_status]) body.fica_status = _FICA_NORM_MAP[body.fica_status];
    if (body.kyc_status  && _FICA_NORM_MAP[body.kyc_status])  body.kyc_status  = _FICA_NORM_MAP[body.kyc_status];

    const validationErrors = validateBody(table, body, true);
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join('; ') });

    const _badPostKey = Object.keys(body).find(k => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
    if (_badPostKey) return res.status(400).json({ error: 'Invalid field name: ' + _badPostKey });

    // ── Investment affordability guard + atomic deduction ──────────────
    // Runs inside a DB transaction with a row-level lock (FOR UPDATE) so two
    // concurrent POST requests cannot both pass the balance check and both
    // deduct — the second request blocks until the first commits.
    let _investmentWalletDeducted = false;
    if (table === 'investments' && req.user.role === 'investor') {
      const rawAmount = parseFloat(body.amount) || 0;
      if (rawAmount <= 0) return res.status(400).json({ error: 'Investment amount must be greater than zero.' });

      // fee_inclusive: client sends total wallet spend; server splits into pool amount + fee
      const feeInclusive = !!body.fee_inclusive;
      delete body.fee_inclusive; // not a DB column

      const isReinvestment = !!body.is_reinvestment;
      let poolAmount, platformFee, required;

      if (feeInclusive && !isReinvestment) {
        poolAmount  = Math.round((rawAmount / 1.01) * 100) / 100;
        platformFee = rawAmount - poolAmount;  // exact, no extra rounding
        required    = rawAmount;               // exact wallet deduction
        body.amount = poolAmount;              // store pool amount in investments record
      } else {
        poolAmount  = rawAmount;
        platformFee = isReinvestment ? 0 : Math.round(rawAmount * 0.01 * 100) / 100;
        required    = rawAmount + platformFee;
      }

      if (body.pool_id) {
        const { rows: pr } = await pool.query('SELECT min_investment FROM investment_pools WHERE id = $1', [body.pool_id]);
        const minInv = parseFloat(pr[0]?.min_investment) || 0;
        if (minInv && required < minInv - 0.005) {
          return res.status(400).json({ error: `Minimum investment for this pool is R${minInv.toLocaleString('en-ZA')}.` });
        }
      }

      const walletLabel = body.sub_account_id ? 'this sub-account' : 'your wallet';

      const _invClient = await pool.connect();
      try {
        await _invClient.query('BEGIN');
        let walletBal = 0;
        if (body.sub_account_id) {
          const { rows: sa } = await _invClient.query(
            'SELECT wallet_balance FROM sub_accounts WHERE id=$1 AND parent_investor_id=$2 FOR UPDATE',
            [body.sub_account_id, req.user.investorId]
          );
          if (!sa[0]) {
            await _invClient.query('ROLLBACK');
            return res.status(403).json({ error: 'Forbidden.' });
          }
          walletBal = parseFloat(sa[0].wallet_balance) || 0;
        } else {
          const { rows: iv } = await _invClient.query(
            'SELECT wallet_balance FROM investors WHERE id = $1 FOR UPDATE', [body.investor_id]
          );
          walletBal = parseFloat(iv[0]?.wallet_balance) || 0;
        }
        if (required - walletBal > 0.001) {
          await _invClient.query('ROLLBACK');
          return res.status(400).json({
            error: isReinvestment
            ? `Insufficient balance. This reinvestment requires R${required.toLocaleString('en-ZA')} but the available balance in ${walletLabel} is R${walletBal.toLocaleString('en-ZA')}.`
            : `Insufficient balance. This investment requires R${required.toLocaleString('en-ZA')} but the available balance in ${walletLabel} is R${walletBal.toLocaleString('en-ZA')}.`,
          });
        }
        // Deduct while holding the row lock — prevents double-spend on concurrent requests
        if (body.sub_account_id) {
          await _invClient.query(
            `UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, total_invested = COALESCE(total_invested, 0) + $2, updated_at = NOW() WHERE id = $3`,
            [required, poolAmount, body.sub_account_id]
          );
        } else {
          await _invClient.query(
            `UPDATE investors SET wallet_balance = wallet_balance - $1, total_invested = COALESCE(total_invested, 0) + $2, updated_at = NOW() WHERE id = $3`,
            [required, poolAmount, body.investor_id]
          );
        }
        // For fee_inclusive: record the exact fee now so the hook's ON CONFLICT is a no-op
        if (feeInclusive && !isReinvestment && platformFee > 0 && body.id) {
          const feeId = `FEE-${body.id}`;
          await _invClient.query(
            `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
             VALUES ($1, $2, $3, 'fee', $4, 'completed', $5, '1% platform fee on investment', NOW(), NOW(), NOW())
             ON CONFLICT (id) DO NOTHING`,
            [feeId, body.investor_id, body.sub_account_id || null, platformFee, feeId]
          );
        }
        await _invClient.query('COMMIT');
        _investmentWalletDeducted = true;
      } catch (e) {
        await _invClient.query('ROLLBACK');
        throw e;
      } finally {
        _invClient.release();
      }
    }

    // ── Withdrawal FICA gate ──────────────────────────────────────────────────
    // Investors must have approved/verified FICA before they can withdraw funds.
    if (table === 'transactions' && body.type === 'withdrawal' && req.user.role === 'investor') {
      const investorIdToCheck = body.investor_id || req.user.investorId;
      const { rows: ficaRows } = await pool.query(
        'SELECT fica_status, kyc_status FROM investors WHERE id = $1',
        [investorIdToCheck]
      );
      const ficaInv = ficaRows[0];
      const ficaOk = ficaInv && (
        ficaInv.fica_status === 'approved' || ficaInv.fica_status === 'verified' ||
        ficaInv.kyc_status  === 'approved' || ficaInv.kyc_status  === 'verified'
      );
      if (!ficaOk) {
        return res.status(403).json({
          error: 'Withdrawals are not available until your FICA / KYC verification is complete. Please ensure all required documents have been submitted and approved by the compliance team.',
        });
      }
    }

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
        change_requests:       'CR',
      };
      const prefix = prefixMap[table] || 'REC';
      body.id = `${prefix}-${Date.now()}`;
    }

    // Auto-generate sa_reference for new sub_accounts
    if (table === 'sub_accounts' && !body.sa_reference) {
      const _rc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      body.sa_reference = 'SA-' + Array.from({length: 6}, () => _rc[Math.floor(Math.random() * _rc.length)]).join('');
    }

    const keys   = Object.keys(body);
    const values = Object.values(body);
    const cols   = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    /* ── Money-moving inserts are atomic ────────────────────────────────
       A completed deposit/payout/referral_bonus must credit the wallet, and a
       completed return must accrue to total_returns. Both used to run in a
       setImmediate hook after the row was already committed and the 201 already
       sent, so a crash or a failing UPDATE in between left a completed
       transaction with no matching balance change and no error surfaced to the
       caller. The PUT path solved this with a DB transaction; the insert path
       now does the same, so the row and its balance effect commit together or
       not at all.

       This is the only place these types are credited on insert. The direct-SQL
       writers (payments.js, manualCredit.js, maturityCron.js, payoutCron.js,
       gifts.js, interest.js) do not pass through this route and apply their own
       effects, so there is no overlap between them and this hook.
    ──────────────────────────────────────────────────────────────────── */
    const _moneyTypes = ['deposit', 'payout', 'referral_bonus', 'return'];
    const _isMoneyInsert = table === 'transactions' && body.status === 'completed' &&
      body.investor_id && _moneyTypes.includes(body.type);

    let rows;
    if (_isMoneyInsert) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        const ins = await dbClient.query(
          `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
          values
        );
        const c   = ins.rows[0];
        const amt = parseFloat(c.amount);
        if (c.type === 'return') {
          // Accrual, not cash — matches jobs/interestCron.js:71
          await dbClient.query(
            'UPDATE investors SET total_returns = COALESCE(total_returns,0) + $1, updated_at = NOW() WHERE id = $2',
            [amt, c.investor_id]
          );
        } else if (c.sub_account_id && c.type === 'deposit') {
          await dbClient.query(
            'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
            [amt, c.sub_account_id]
          );
        } else {
          await dbClient.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
            [amt, c.investor_id]
          );
        }
        await dbClient.query('COMMIT');
        rows = ins.rows;
      } catch (txErr) {
        await dbClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        dbClient.release();
      }
    } else {
      const r = await pool.query(
        `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      rows = r.rows;
    }
    const [clean] = stripSensitive(table, rows, req.user?.empId, req.user?.role);
    res.status(201).json(clean);

    // ── Audit log (fire-and-forget) ────────────────────────────────────────
    setImmediate(() => {
      const _actor = req.user || {};
      const _actorName = [_actor.firstName, _actor.lastName].filter(Boolean).join(' ').trim() || _actor.email || 'Admin';
      audit.log({
        actorId: _actor.id, actorEmail: _actor.email, actorRole: _actor.role,
        action: `${table}.created`,
        entityType: table, entityId: rows[0]?.id ? String(rows[0].id) : null,
        description: `${_actorName} created ${table} record`,
        ip: req.ip, platform: 'admin',
      });
    });

    /* The wallet-credit and return-accrual hooks that used to live here now run
       inside the insert transaction above, so the row and its balance effect are
       atomic. Do not re-add a post-response hook for these types — it would
       credit a second time on top of the transactional write. */

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
            // Investment start = pool closing date + 1 day; maturity = pool maturity_date
            let startDate = null;
            let maturityDate = created.end_date;
            if (created.pool_id) {
              const { rows: pr } = await pool.query('SELECT end_date, maturity_date FROM investment_pools WHERE id = $1', [created.pool_id]);
              if (pr[0]?.end_date) {
                const d = new Date(pr[0].end_date);
                d.setDate(d.getDate() + 1);
                startDate = d.toISOString().split('T')[0];
              }
              if (pr[0]?.maturity_date) {
                maturityDate = pr[0].maturity_date;
                // Overwrite the client-computed end_date with the pool's canonical maturity date
                // so the cron, portal display, and alert emails all use the same date.
                await pool.query(
                  'UPDATE investments SET end_date = $1 WHERE id = $2',
                  [maturityDate, created.id]
                );
              }
            }
            await emailService.sendInvestmentCreated(inv[0], {
              poolName:   created.pool_name || created.pool_id || 'Investment Pool',
              amount:     created.amount,
              termMonths: created.term_months,
              endDate:    maturityDate,
              startDate,
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

        // New leave request → email all directors + log to the activity feed
        if (table === 'leave_requests' && created.employee_id) {
          const { rows: empRows } = await pool.query(
            'SELECT first_name, last_name FROM employees WHERE id = $1', [created.employee_id]
          );
          const emp = empRows[0] || {};
          const employeeName = `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || created.employee_id;

          // Email every director/admin
          const { rows: directors } = await pool.query(
            "SELECT email, first_name, last_name FROM users WHERE role IN ('director','admin') AND email IS NOT NULL AND is_active = true"
          );
          for (const d of directors) {
            await emailService.sendLeaveRequestSubmitted(d, {
              employeeName,
              leaveType: created.leave_type,
              startDate: created.start_date,
              endDate:   created.end_date,
              days:      created.days_requested,
              reason:    created.reason,
            });
          }

          // Activity feed entry (shows under the employee's recent activity)
          await pool.query(
            `INSERT INTO activity_feed (id, employee_id, type, title, body, icon, color, is_public, created_at)
             VALUES ($1,$2,'leave_submitted',$3,$4,'fa-calendar-day','#fec24f',false,NOW())
             ON CONFLICT (id) DO NOTHING`,
            [
              `ACT-LVREQ-${created.id}`,
              created.employee_id,
              `Leave requested — ${(created.leave_type || 'leave').replace(/_/g, ' ')}`,
              `${created.days_requested || ''} day(s) · awaiting director approval`,
            ]
          );
        }

        // New KYC document → notify all admins/directors + SSE broadcast
        if (table === 'kyc_documents' && created.investor_id) {
          const investorName = created.investor_name || created.investor_id;
          const { rows: kycAdmins } = await pool.query(
            "SELECT email, first_name, last_name FROM users WHERE role IN ('director','admin') AND email IS NOT NULL AND is_active = true"
          );
          for (const kycAdmin of kycAdmins) {
            await emailService.sendKycDocumentReceived(kycAdmin, {
              investorName,
              docType:    created.doc_type,
              investorId: created.investor_id,
            });
          }
          try {
            const bcast = _getBroadcast();
            if (bcast) bcast('kyc_submitted', { investor_name: investorName, doc_type: created.doc_type, investor_id: created.investor_id });
          } catch (_) {}
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
          let poolName = created.pool_name || '';
          let startDateStr = '';
          try {
            if (created.pool_id) {
              const { rows: pr } = await pool.query(
                'SELECT name, end_date FROM investment_pools WHERE id = $1', [created.pool_id]
              );
              if (pr[0]) {
                if (!poolName && pr[0].name) poolName = pr[0].name;
                if (pr[0].end_date) {
                  const sd = new Date(pr[0].end_date);
                  sd.setDate(sd.getDate() + 1);
                  startDateStr = sd.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
                }
              }
            }
          } catch (_) {}
          const amtStr = `R${Number(created.amount || 0).toLocaleString('en-ZA')}`;
          const bodyParts = [`${amtStr} invested`];
          if (poolName) bodyParts.push(poolName);
          if (startDateStr) bodyParts.push(`starts ${startDateStr}`);
          await _sendPush(created.investor_id, {
            title: 'Investment confirmed',
            body:  bodyParts.join(' · '),
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

    /* ── Investment hook ─────────────────────────────────────────────────
       When a new investment is created:
       1. Deduct the investment amount + 1% platform fee from the wallet
       2. Increment total_invested
       3. Record a fee transaction
       4. Calculate EVA (20% of net-VAT management fee) on new funds only
    ───────────────────────────────────────────────────────────────────── */
    if (table === 'investments' && clean.investor_id && parseFloat(clean.amount) > 0) {
      setImmediate(async () => {
        try {
          const investAmt      = parseFloat(clean.amount);
          const isReinvestment = !!clean.is_reinvestment;
          const platformFee    = isReinvestment ? 0 : Math.round(investAmt * 0.01 * 100) / 100;
          const totalDeduct    = investAmt + platformFee;

          // Deduct wallet + total_invested — skip if already done atomically in the
          // affordability transaction above (investor-role POSTs only).
          if (!_investmentWalletDeducted) {
            if (clean.sub_account_id) {
              await pool.query(
                `UPDATE sub_accounts
                   SET wallet_balance = GREATEST(0, wallet_balance - $1),
                       total_invested = COALESCE(total_invested, 0) + $2,
                       updated_at     = NOW()
                 WHERE id = $3`,
                [totalDeduct, investAmt, clean.sub_account_id]
              );
            } else {
              await pool.query(
                `UPDATE investors
                   SET wallet_balance  = GREATEST(0, wallet_balance - $1),
                       total_invested  = COALESCE(total_invested, 0) + $2,
                       updated_at      = NOW()
                 WHERE id = $3`,
                [totalDeduct, investAmt, clean.investor_id]
              );
            }
          }

          // Record the platform fee — skipped for reinvestments (no fee charged)
          if (!isReinvestment) {
            const feeId = `FEE-${clean.id}`;
            await pool.query(
              `INSERT INTO transactions (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at)
               VALUES ($1, $2, $3, 'fee', $4, 'completed', $5, '1% platform fee on investment', NOW(), NOW())
               ON CONFLICT (id) DO NOTHING`,
              [feeId, clean.investor_id, clean.sub_account_id || null, platformFee, feeId]
            );
          }

          // EVA calculation — only on new funds (not reinvestments)
          if (!clean.is_reinvestment && clean.pool_id) {
            const [poolRes, evaRes] = await Promise.all([
              pool.query('SELECT management_fee_pct FROM investment_pools WHERE id = $1', [clean.pool_id]),
              pool.query("SELECT value FROM platform_settings WHERE key = 'eva_rate'"),
            ]);
            const mgtFeePct = parseFloat(poolRes.rows[0]?.management_fee_pct) || 0;
            const evaRate   = parseFloat(evaRes.rows[0]?.value) || 0.15;
            if (mgtFeePct > 0) {
              const grossMgtFee = investAmt * mgtFeePct;
              const netMgtFee   = grossMgtFee / 1.15;   // net of 15% South African VAT
              const evaAmount   = Math.round(netMgtFee * evaRate * 100) / 100;
              await pool.query(
                'UPDATE investments SET eva_amount = $1 WHERE id = $2',
                [evaAmount, clean.id]
              );
            }
          }

          // Update pool aggregate counters on new investments
          if (clean.pool_id) {
            await pool.query(
              `UPDATE investment_pools
                  SET raised_amount    = COALESCE(raised_amount, 0) + $1,
                      current_invested = COALESCE(current_invested, 0) + $1,
                      investor_count   = (
                        SELECT COUNT(DISTINCT CASE WHEN sub_account_id IS NOT NULL
                                                   THEN 'sa:' || sub_account_id
                                                   ELSE 'inv:' || investor_id END)
                        FROM investments
                        WHERE pool_id = $2 AND status IN ('active','matured','paid_out')
                      ),
                      updated_at       = NOW()
                WHERE id = $2`,
              [investAmt, clean.pool_id]
            );
          }

          // Auto-unarchive investor when they make their first investment
          await pool.query(
            `UPDATE investors SET status = 'active', archived_at = NULL, updated_at = NOW()
             WHERE id = $1 AND status = 'archived'`,
            [clean.investor_id]
          );

          console.log(`[investment hook] R${investAmt} deducted from wallet for investment ${clean.id}${isReinvestment ? ' (reinvestment — no platform fee)' : ` + R${platformFee} platform fee`}`);
        } catch (err) {
          console.error('[investment hook] error:', err.message);
        }
      });
    }
  } catch (err) {
    console.error('[tables POST]', req.params.table, err.message);
    const msg = err.detail || err.message || 'Internal server error.';
    res.status(500).json({ error: msg });
  }
});

/* ─── PUT /api/tables/:table/:id ─── */
router.put('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;

    if (['users'].includes(table))
      return res.status(403).json({ error: `Use /api/users for table: ${table}` });
    if (ADMIN_WRITE_TABLES.has(table) && !['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

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

    // Employee data isolation: staff can only modify their own rows.
    // Exception: leads and executives may update change_requests regardless of ownership.
    const isLeadOrExec = ['lead','executive'].includes(req.user.level);
    const isCrReviewer = table === 'change_requests' && isLeadOrExec;
    if (req.user.empId && !['admin','director','fund_manager'].includes(req.user.role) && !isCrReviewer) {
      if (EMPLOYEE_OWNED_COLS[table]) {
        const ownerCol = EMPLOYEE_OWNED_COLS[table];
        const { rows: ownerRows } = await pool.query(
          `SELECT ${ownerCol} FROM ${table} WHERE ${key} = $1`, [req.params.id]
        );
        if (!ownerRows[0] || ownerRows[0][ownerCol] !== req.user.empId) {
          return res.status(403).json({ error: 'Forbidden — you can only modify your own records.' });
        }
      }
    }

    const body   = { ...req.body };
    delete body[key]; // don't update PK
    delete body.created_at;
    body.updated_at = new Date().toISOString();

    const isPrivileged = ['admin', 'director', 'fund_manager'].includes(req.user.role);
    ALWAYS_PROTECTED_COLS.forEach(c => delete body[c]);
    if (!isPrivileged) INVESTOR_PROTECTED_COLS.forEach(c => delete body[c]);

    const _badKey = Object.keys(body).find(k => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
    if (_badKey) return res.status(400).json({ error: 'Invalid field name: ' + _badKey });

    const keys   = Object.keys(body);
    const values = Object.values(body);
    const sets   = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets} WHERE ${key} = $${values.length} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });
    const [clean] = stripSensitive(table, rows, req.user?.empId, req.user?.role);
    res.json(clean);
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── PATCH /api/tables/:table/:id ─── */
router.patch('/:table/:id', requireAuth, validateTable, async (req, res) => {
  try {
    const table = req.params.table;
    const key   = req.tableKey;

    if (['users'].includes(table))
      return res.status(403).json({ error: `Use /api/users for table: ${table}` });
    if (ADMIN_WRITE_TABLES.has(table) && !['admin','director','fund_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden.' });

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

    // Employee data isolation: staff can only modify their own rows
    if (req.user.empId && !['admin','director','fund_manager'].includes(req.user.role)) {
      if (EMPLOYEE_OWNED_COLS[table]) {
        const ownerCol = EMPLOYEE_OWNED_COLS[table];
        const { rows: ownerRows } = await pool.query(
          `SELECT ${ownerCol} FROM ${table} WHERE ${key} = $1`, [req.params.id]
        );
        if (!ownerRows[0] || ownerRows[0][ownerCol] !== req.user.empId) {
          return res.status(403).json({ error: 'Forbidden — you can only modify your own records.' });
        }
      }
    }

    const body   = { ...req.body };
    delete body[key];
    delete body.created_at;
    body.updated_at = new Date().toISOString();

    const isPrivileged = ['admin', 'director', 'fund_manager'].includes(req.user.role);
    ALWAYS_PROTECTED_COLS.forEach(c => delete body[c]);
    if (!isPrivileged) INVESTOR_PROTECTED_COLS.forEach(c => delete body[c]);

    if (body.fica_status && _FICA_NORM_MAP[body.fica_status]) body.fica_status = _FICA_NORM_MAP[body.fica_status];
    if (body.kyc_status  && _FICA_NORM_MAP[body.kyc_status])  body.kyc_status  = _FICA_NORM_MAP[body.kyc_status];

    // Auto-inject reviewer identity whenever an approval or rejection is recorded
    {
      const _actor = req.user || {};
      const _actorName = [_actor.firstName, _actor.lastName].filter(Boolean).join(' ').trim() || _actor.email || 'Admin';
      const _isApproveDecline = v => v === 'approved' || v === 'rejected';
      const _now = new Date().toISOString();

      if (table === 'kyc_documents' && _isApproveDecline(body.status)) {
        if (!body.reviewed_by)  body.reviewed_by  = _actorName;
        if (!body.reviewed_at)  body.reviewed_at  = _now;
      }
      if (table === 'transactions' && (body.status === 'completed' || body.status === 'rejected')) {
        body.reviewed_by  = _actorName;
        body.reviewed_at  = _now;
      }
      if (table === 'investors' && _isApproveDecline(body.fica_status)) {
        body.fica_reviewed_by = _actorName;
      }
      if (table === 'investors' && _isApproveDecline(body.bank_account_status)) {
        body.bank_account_reviewed_by = _actorName;
      }
      if (table === 'sub_accounts' && _isApproveDecline(body.sa_bank_status)) {
        body.sa_bank_reviewed_by = _actorName;
      }
    }

    const _badKey = Object.keys(body).find(k => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
    if (_badKey) return res.status(400).json({ error: 'Invalid field name: ' + _badKey });

    const validationErrors = validateBody(table, body, false);
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join('; ') });

    const keys   = Object.keys(body);
    const values = Object.values(body);
    const sets   = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    values.push(req.params.id);

    // For transaction completion use a conditional UPDATE inside a DB transaction
    // to prevent race-condition double-credits AND ensure the wallet credit is
    // atomic with the status change (both succeed or both roll back).
    /* _didCompleteNow is true only when this request actually transitioned the
       row into 'completed' (the conditional UPDATE below matched). It is the
       correct trigger for one-time side effects like the confirmation email.

       It replaces _skipWalletCredit, which conflated two opposite situations:
       "no transition happened" and "the credit was applied". The email block
       keyed off that flag, so it emailed on a no-op re-save of an already
       completed deposit and stayed silent on the genuine completion — exactly
       backwards. (The flag dates from when the email block also credited the
       wallet; the credit moved into the transaction and the guard was left
       behind.) */
    let rows, _didCompleteNow = false, _withdrawalRefundDone = false;
    if (table === 'transactions' && body.status === 'completed') {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        const { rows: updated } = await dbClient.query(
          `UPDATE ${table} SET ${sets} WHERE ${key} = $${values.length} AND status <> 'completed' RETURNING *`,
          values
        );
        if (!updated[0]) {
          await dbClient.query('ROLLBACK');
          const { rows: existing } = await pool.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
          if (!existing[0]) return res.status(404).json({ error: 'Record not found.' });
          // Already completed — this request changed nothing, so no side effects.
          rows = existing;
        } else {
          const u = updated[0];
          // `return` accrues to total_returns rather than crediting the wallet —
          // see the note on the insert-side hook above.
          if (u.investor_id && u.type === 'return') {
            await dbClient.query(
              'UPDATE investors SET total_returns = COALESCE(total_returns,0) + $1, updated_at = NOW() WHERE id = $2',
              [parseFloat(u.amount), u.investor_id]
            );
          } else if (u.investor_id &&
              (u.type === 'deposit' || u.type === 'payout' || u.type === 'referral_bonus')) {
            if (u.sub_account_id && u.type === 'deposit') {
              await dbClient.query(
                'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2',
                [parseFloat(u.amount), u.sub_account_id]
              );
            } else {
              await dbClient.query(
                'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
                [parseFloat(u.amount), u.investor_id]
              );
            }
          }
          await dbClient.query('COMMIT');
          _didCompleteNow = true;
          rows = updated;
        }
      } catch (txErr) {
        await dbClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        dbClient.release();
      }
    } else {
      const result = await pool.query(
        `UPDATE ${table} SET ${sets} WHERE ${key} = $${values.length} RETURNING *`,
        values
      );
      rows = result.rows;
      if (!rows[0]) return res.status(404).json({ error: 'Record not found.' });
      // Withdrawal rejection: refund wallet here (before response) so it is atomic
      // and survives a process restart between response and setImmediate.
      if (table === 'transactions' && body.status === 'rejected' && rows[0].type === 'withdrawal' && rows[0].investor_id) {
        await pool.query(
          'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
          [rows[0].amount, rows[0].investor_id]
        );
        _withdrawalRefundDone = true;
      }
    }
    const [clean] = stripSensitive(table, rows, req.user?.empId, req.user?.role);
    res.json(clean);

    // ── Audit + Email hooks (fire-and-forget) ─────────────────────────────
    setImmediate(async () => {
      try {
        const updated = rows[0];
        const actor   = req.user || {};

        // Comprehensive audit log — every PATCH is recorded
        const _auditFields = Object.keys(body).filter(k => !['updated_at', 'reviewed_at'].includes(k));
        if (_auditFields.length) {
          const _actorName = [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() || actor.email || 'Admin';
          const _fieldSummary = _auditFields.length <= 3
            ? _auditFields.map(k => `${k}=${JSON.stringify(body[k])}`).join(', ')
            : `${_auditFields.slice(0, 2).map(k => `${k}=${JSON.stringify(body[k])}`).join(', ')} …+${_auditFields.length - 2} more`;
          await audit.log({
            actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
            action: `${table}.updated`,
            entityType: table, entityId: req.params.id,
            description: `${_actorName} set ${_fieldSummary}`,
            after: body, ip: req.ip, platform: 'admin',
          });
        }

        // Deposit confirmed → email + SMS the investor, once, on the transition
        // into completed. Gateway deposits never reach this route: payments.js
        // creates them already completed and sends their own notification.
        if (table === 'transactions' && _didCompleteNow &&
            updated.investor_id && updated.type === 'deposit') {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) {
            const gateway = updated.description?.includes('Paystack') ? 'Paystack'
                          : updated.description?.includes('Ozow')     ? 'Ozow'
                          : 'EFT';
            // Non-blocking, and independent of each other: this hook block runs
            // many more notifications after this one, and an awaited throw here
            // would skip all of them.
            await Promise.allSettled([
              emailService.sendDepositConfirmed(inv[0], updated.amount, updated.reference || updated.id, gateway)
                .catch(e => { console.error('[deposit email]', e.message); throw e; }),
              smsService.sendDepositConfirmed(inv[0].phone, inv[0].first_name, updated.amount)
                .catch(e => { console.error('[deposit sms]', e.message); throw e; }),
            ]);
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

        // Leave request decided → email the staff member + log to activity feed
        if (table === 'leave_requests' && (body.status === 'approved' || body.status === 'rejected') && updated.employee_id) {
          const { rows: empRows } = await pool.query(
            'SELECT first_name, last_name, email FROM employees WHERE id = $1', [updated.employee_id]
          );
          const emp = empRows[0];
          if (emp && emp.email) {
            await emailService.sendLeaveOutcome(emp, {
              status:    body.status,
              leaveType: updated.leave_type,
              startDate: updated.start_date,
              endDate:   updated.end_date,
              days:      updated.days_requested,
              reviewedBy: updated.approved_by || (actor.firstName ? `${actor.firstName} ${actor.lastName || ''}`.trim() : null),
            });
          }
          const approved = body.status === 'approved';
          await pool.query(
            `INSERT INTO activity_feed (id, employee_id, type, title, body, icon, color, is_public, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW())
             ON CONFLICT (id) DO NOTHING`,
            [
              `ACT-LVOUT-${updated.id}`,
              updated.employee_id,
              approved ? 'leave_approved' : 'leave_rejected',
              `Leave ${approved ? 'approved' : 'declined'} — ${(updated.leave_type || 'leave').replace(/_/g, ' ')}`,
              `${updated.days_requested || ''} day(s) · ${updated.start_date || ''} – ${updated.end_date || ''}`,
              approved ? 'fa-calendar-check' : 'fa-calendar-xmark',
              approved ? '#22c55e' : '#ef4444',
            ]
          );
        }

        // Support ticket response → email investor (skip internal admin-only categories)
        const _skipResponseEmail = ['bank_verification', 'fica_submission', 'fica'].includes(updated.category);
        if (table === 'support_tickets' && body.admin_response && updated.investor_id && !_skipResponseEmail) {
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

        // Withdrawal rejected → email + SMS investor (wallet already refunded before response)
        if (table === 'transactions' && body.status === 'rejected' && updated.type === 'withdrawal' && updated.investor_id && _withdrawalRefundDone) {
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

        // FICA status approved → only allow if all 3 required docs are approved.
        // bank_statement is treated as equivalent to proof_of_bank (supports migrated clients).
        if (table === 'investors' && body.fica_status === 'approved') {
          const REQUIRED_DOCS = ['id_document', 'proof_of_address', 'proof_of_bank'];
          const BANK_ALIASES   = ['proof_of_bank', 'bank_statement'];
          const { rows: approvedDocs } = await pool.query(
            `SELECT DISTINCT doc_type FROM kyc_documents
             WHERE investor_id = $1 AND status = 'approved'
               AND doc_type = ANY($2)`,
            [req.params.id, [...REQUIRED_DOCS, ...BANK_ALIASES]]
          );
          const approvedSet = new Set(approvedDocs.map(d => d.doc_type));
          // bank_statement satisfies the proof_of_bank requirement
          const hasBankDoc = BANK_ALIASES.some(t => approvedSet.has(t));
          const allApproved = approvedSet.has('id_document') && approvedSet.has('proof_of_address') && hasBankDoc;
          if (!allApproved) {
            const missing = [];
            if (!approvedSet.has('id_document'))    missing.push('id_document');
            if (!approvedSet.has('proof_of_address')) missing.push('proof_of_address');
            if (!hasBankDoc)                         missing.push('proof_of_bank or bank_statement');
            return res.status(400).json({
              error: `Cannot approve FICA: the following required documents are not yet approved: ${missing.join(', ')}.`,
            });
          }
          await pool.query(
            `UPDATE investors
                SET fica_approved_at = COALESCE(fica_approved_at, NOW()),
                    kyc_status       = 'approved',
                    status           = CASE WHEN status IN ('pending','pending_fica','fica_submitted') THEN 'active' ELSE status END,
                    updated_at       = NOW()
              WHERE id = $1`,
            [req.params.id]
          ).catch(() => {});
        }

        // KYC document approved → promote investor FICA/KYC status once all 3 required docs are approved.
        // bank_statement is treated as equivalent to proof_of_bank (supports migrated clients).
        if (table === 'kyc_documents' && body.status === 'approved' && updated.investor_id) {
          const BANK_ALIASES = ['proof_of_bank', 'bank_statement'];
          const { rows: approvedDocs } = await pool.query(
            `SELECT DISTINCT doc_type FROM kyc_documents
             WHERE investor_id = $1 AND status = 'approved'
               AND doc_type = ANY($2)`,
            [updated.investor_id, ['id_document', 'proof_of_address', ...BANK_ALIASES]]
          );
          const approvedSet = new Set(approvedDocs.map(d => d.doc_type));
          const hasBankDoc  = BANK_ALIASES.some(t => approvedSet.has(t));
          const allApproved = approvedSet.has('id_document') && approvedSet.has('proof_of_address') && hasBankDoc;
          // Note the individual doc approval on any open KYC/FICA support tickets
          const _docLabel = (updated.doc_type || 'document').replace(/_/g, ' ');
          await pool.query(
            `UPDATE support_tickets
                SET admin_response = CASE
                      WHEN admin_response IS NULL OR admin_response = ''
                        THEN $2
                      ELSE admin_response || E'\n' || $2
                    END,
                    updated_at = NOW()
              WHERE investor_id = $1
                AND status IN ('open', 'in_progress', 'under_review')
                AND category IN ('fica_submission', 'kyc_submission', 'fica', 'kyc', 'document_verification')`,
            [updated.investor_id, `[System] KYC document approved: ${_docLabel} — ${new Date().toLocaleDateString('en-ZA')}`]
          ).catch(() => {});

          if (allApproved) {
            await pool.query(
              `UPDATE investors
                  SET fica_status       = 'approved',
                      kyc_status        = 'approved',
                      status            = CASE WHEN status IN ('pending','pending_fica','fica_submitted') THEN 'active' ELSE status END,
                      fica_approved_at  = COALESCE(fica_approved_at, NOW()),
                      updated_at        = NOW()
                WHERE id = $1 AND fica_status != 'approved'`,
              [updated.investor_id]
            ).catch(() => {});
            const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
            if (inv[0]) await emailService.sendKycApproved(inv[0]);

            // Auto-resolve all open KYC/FICA support tickets — no need to approve twice
            await pool.query(
              `UPDATE support_tickets
                  SET status         = 'resolved',
                      admin_response = CASE
                        WHEN admin_response IS NULL OR admin_response = ''
                          THEN $2
                        ELSE admin_response || E'\n' || $2
                      END,
                      responded_at   = NOW(),
                      updated_at     = NOW()
                WHERE investor_id = $1
                  AND status IN ('open', 'in_progress', 'under_review')
                  AND category IN ('fica_submission', 'kyc_submission', 'fica', 'kyc', 'document_verification')`,
              [updated.investor_id, '[System] All KYC/FICA documents have been verified and approved. Account is now active.']
            ).catch(() => {});
          }
        }

        // Sub-account KYC document approved → check if sub-account is now fully FICA-verified
        if (table === 'kyc_documents' && body.status === 'approved' && updated.sub_account_id) {
          const saId = updated.sub_account_id;
          const { rows: saDocs } = await pool.query(
            `SELECT doc_type FROM kyc_documents WHERE sub_account_id=$1 AND status='approved' AND doc_type='id_document' LIMIT 1`,
            [saId]
          );
          const { rows: saRows } = await pool.query('SELECT * FROM sub_accounts WHERE id=$1', [saId]);
          const sa = saRows[0];
          if (sa && saDocs.length > 0 && sa.sa_bank_status === 'approved' && sa.kyc_status !== 'approved') {
            await pool.query(`UPDATE sub_accounts SET kyc_status='approved', updated_at=NOW() WHERE id=$1`, [saId]);
            const { rows: invRows } = await pool.query('SELECT * FROM investors WHERE id=$1', [sa.parent_investor_id]);
            if (invRows[0]) await emailService.sendSubAccountFicaApproved(invRows[0], { saName: sa.name }).catch(() => {});
          }
        }

        // Sub-account bank status approved → check if sub-account is now fully FICA-verified
        if (table === 'sub_accounts' && body.sa_bank_status === 'approved') {
          const saId = req.params.id;
          const { rows: saDocs } = await pool.query(
            `SELECT doc_type FROM kyc_documents WHERE sub_account_id=$1 AND status='approved' AND doc_type='id_document' LIMIT 1`,
            [saId]
          );
          if (saDocs.length > 0) {
            const { rows: saRows } = await pool.query('SELECT * FROM sub_accounts WHERE id=$1', [saId]);
            const sa = saRows[0];
            if (sa && sa.kyc_status !== 'approved') {
              await pool.query(`UPDATE sub_accounts SET kyc_status='approved', updated_at=NOW() WHERE id=$1`, [saId]);
              const { rows: invRows } = await pool.query('SELECT * FROM investors WHERE id=$1', [sa.parent_investor_id]);
              if (invRows[0]) await emailService.sendSubAccountFicaApproved(invRows[0], { saName: sa.name }).catch(() => {});
            }
          }
        }

        // KYC document rejected → email investor with reason from notes
        if (table === 'kyc_documents' && body.status === 'rejected' && updated.investor_id) {
          const { rows: inv } = await pool.query('SELECT * FROM investors WHERE id = $1', [updated.investor_id]);
          if (inv[0]) await emailService.sendKycRejected(inv[0], { notes: updated.notes });
        }

        // Pool opened or activated → notify waitlisted investors
        if (table === 'investment_pools' && (body.status === 'active' || body.status === 'open') && updated.id) {
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
                  { email: entry.email, first_name: entry.first_name, last_name: entry.last_name, id: entry.investor_id },
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

        // Withdrawal completed → push
        if (table === 'transactions' && body.status === 'completed' && updated.type === 'withdrawal' && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'Withdrawal processed',
            body:  `R${Number(updated.amount || 0).toLocaleString('en-ZA')} has been sent to your bank account.`,
            url:   '/portal/',
            tag:   'withdrawal.approved',
          });
        }

        // Withdrawal rejected → push
        if (table === 'transactions' && body.status === 'rejected' && updated.type === 'withdrawal' && updated.investor_id) {
          await _sendPush(updated.investor_id, {
            title: 'Withdrawal request declined',
            body:  `Your withdrawal of R${Number(updated.amount || 0).toLocaleString('en-ZA')} was declined. Funds returned to your wallet.`,
            url:   '/portal/',
            tag:   'withdrawal.rejected',
          });
        }
      } catch (hookErr) {
        console.error('[push hook PATCH] error:', hookErr.message);
      }
    });
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
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
      (ADMIN_ONLY_TABLES.has(table) || ADMIN_WRITE_TABLES.has(table) ||
       ['investors','investment_pools'].includes(table)) &&
      !['admin','director','fund_manager'].includes(req.user.role)
    ) return res.status(403).json({ error: 'Forbidden — admin only.' });

    // Employee data isolation: staff can only delete their own rows
    if (req.user.empId && !['admin','director','fund_manager'].includes(req.user.role)) {
      if (EMPLOYEE_OWNED_COLS[table]) {
        const ownerCol = EMPLOYEE_OWNED_COLS[table];
        const { rows: ownerRows } = await pool.query(
          `SELECT ${ownerCol} FROM ${table} WHERE ${key} = $1`, [req.params.id]
        );
        if (!ownerRows[0] || ownerRows[0][ownerCol] !== req.user.empId) {
          return res.status(403).json({ error: 'Forbidden — you can only delete your own records.' });
        }
      }
    }

    const result = await pool.query(
      `DELETE FROM ${table} WHERE ${key} = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Record not found.' });
    res.json({ success: true, deleted: req.params.id });

    // ── Audit log (fire-and-forget) ────────────────────────────────────────
    setImmediate(() => {
      const _actor = req.user || {};
      const _actorName = [_actor.firstName, _actor.lastName].filter(Boolean).join(' ').trim() || _actor.email || 'Admin';
      audit.log({
        actorId: _actor.id, actorEmail: _actor.email, actorRole: _actor.role,
        action: `${table}.deleted`,
        entityType: table, entityId: req.params.id,
        description: `${_actorName} deleted ${table}#${req.params.id}`,
        ip: req.ip, platform: 'admin',
      });
    });
  } catch (err) {
    console.error('[tables]', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
