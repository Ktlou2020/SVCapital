/* ═══════════════════════════════════════════════════════
   Auto-setup: runs migrate + seed on first boot if the
   users table is empty. Safe to call on every startup.
   ═══════════════════════════════════════════════════════ */
'use strict';

const pool   = require('./pool');
const bcrypt = require('bcryptjs');

/* ─── Full schema (same as migrate.js, inline so no child process needed) ─── */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'investor'
                  CHECK (role IN ('investor','admin','ifa','fund_manager','staff','director')),
  first_name    TEXT,
  last_name     TEXT,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login    TIMESTAMPTZ,
  investor_id        TEXT,
  ifa_id             TEXT,
  staff_pin          TEXT,
  login_attempts     INT DEFAULT 0,
  login_locked_until TIMESTAMPTZ,
  last_login_ip      TEXT,
  last_login_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_role_idx  ON users(role);

CREATE TABLE IF NOT EXISTS investors (
  id                  TEXT PRIMARY KEY,
  first_name          TEXT, last_name TEXT, email TEXT, phone TEXT,
  id_number           TEXT, date_of_birth TEXT, province TEXT,
  address TEXT, occupation TEXT, employer TEXT,
  risk_profile        TEXT DEFAULT 'moderate',
  kyc_status          TEXT DEFAULT 'pending',
  status              TEXT DEFAULT 'active',
  wallet_balance      NUMERIC(18,2) DEFAULT 0,
  total_invested      NUMERIC(18,2) DEFAULT 0,
  total_returns       NUMERIC(18,2) DEFAULT 0,
  referral_code       TEXT, referred_by TEXT, ifa_id TEXT,
  date_joined         TIMESTAMPTZ DEFAULT NOW(),
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM investors WHERE email IS NULL LIMIT 1) THEN
    ALTER TABLE investors ALTER COLUMN email SET NOT NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS investment_pools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  product_type TEXT NOT NULL, status TEXT DEFAULT 'open',
  target_amount NUMERIC(18,2) DEFAULT 0, raised_amount NUMERIC(18,2) DEFAULT 0,
  min_investment NUMERIC(18,2) DEFAULT 1000, max_investment NUMERIC(18,2),
  annual_rate NUMERIC(8,4) DEFAULT 0, term_months INT DEFAULT 6,
  start_date DATE, end_date DATE, description TEXT,
  risk_level TEXT DEFAULT 'medium', investor_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  pool_id TEXT REFERENCES investment_pools(id) ON DELETE SET NULL,
  amount NUMERIC(18,2) NOT NULL, status TEXT DEFAULT 'active',
  start_date DATE, end_date DATE,
  expected_return NUMERIC(18,2) DEFAULT 0, actual_return NUMERIC(18,2) DEFAULT 0,
  annual_rate NUMERIC(8,4) DEFAULT 0, product_type TEXT, term_months INT,
  payout_option TEXT DEFAULT 'reinvest', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS investments_investor_idx ON investments(investor_id);
CREATE INDEX IF NOT EXISTS investments_pool_idx     ON investments(pool_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  type TEXT NOT NULL, amount NUMERIC(18,2) NOT NULL,
  status TEXT DEFAULT 'completed', reference TEXT, description TEXT,
  investment_id TEXT, pool_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_investor_idx ON transactions(investor_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_investor_id ON transactions(investor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id TEXT PRIMARY KEY,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL, status TEXT DEFAULT 'pending',
  file_url TEXT, file_name TEXT, notes TEXT,
  reviewed_by TEXT, reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maturity_instructions (
  id TEXT PRIMARY KEY,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  investment_id TEXT, instruction TEXT NOT NULL,
  amount NUMERIC(18,2), bank_account TEXT, bank_name TEXT,
  account_holder TEXT, account_number TEXT, branch_code TEXT,
  status TEXT DEFAULT 'pending', notes TEXT, processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, message TEXT,
  category TEXT DEFAULT 'general', priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open', assigned_to TEXT, response TEXT,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY, value TEXT, description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ifas (
  id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT,
  email TEXT UNIQUE, phone TEXT, license_number TEXT, company_name TEXT,
  status TEXT DEFAULT 'active', commission_rate NUMERIC(6,4) DEFAULT 1.5,
  assigned_clients JSONB DEFAULT '[]', aum_managed NUMERIC(18,2) DEFAULT 0,
  date_joined TIMESTAMPTZ DEFAULT NOW(), notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_runs (
  id TEXT PRIMARY KEY, run_name TEXT NOT NULL, product_type TEXT NOT NULL,
  status TEXT DEFAULT 'draft', principal_amount NUMERIC(18,2) DEFAULT 0,
  annual_rate NUMERIC(8,6) DEFAULT 0, term_days INT DEFAULT 183,
  start_date DATE, end_date DATE,
  gross_return NUMERIC(18,2) DEFAULT 0, management_fee NUMERIC(18,2) DEFAULT 0,
  performance_fee NUMERIC(18,2) DEFAULT 0, structuring_fee NUMERIC(18,2) DEFAULT 0,
  admin_fee NUMERIC(18,2) DEFAULT 0, total_fees NUMERIC(18,2) DEFAULT 0,
  net_return NUMERIC(18,2) DEFAULT 0, total_payout NUMERIC(18,2) DEFAULT 0,
  investor_count INT DEFAULT 0, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS return_schedules (
  id TEXT PRIMARY KEY,
  fund_run_id TEXT REFERENCES fund_runs(id) ON DELETE CASCADE,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  amount_invested NUMERIC(18,2), expected_return NUMERIC(18,2),
  gross_return NUMERIC(18,2), fees NUMERIC(18,2), net_return NUMERIC(18,2),
  expected_date DATE, status TEXT DEFAULT 'pending',
  paid_at TIMESTAMPTZ, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT, actor_role TEXT, description TEXT, ip_address TEXT, metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS investor_allocations (
  id TEXT PRIMARY KEY,
  fund_run_id TEXT REFERENCES fund_runs(id) ON DELETE CASCADE,
  investor_id TEXT REFERENCES investors(id) ON DELETE CASCADE,
  investment_id TEXT, amount NUMERIC(18,2), nav_share NUMERIC(10,6),
  gross_return NUMERIC(18,2), net_return NUMERIC(18,2), fees NUMERIC(18,2),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fee_ledger (
  id TEXT PRIMARY KEY,
  fund_run_id TEXT REFERENCES fund_runs(id) ON DELETE CASCADE,
  fee_type TEXT NOT NULL, amount NUMERIC(18,2) NOT NULL,
  rate NUMERIC(8,6), basis TEXT, description TEXT, accrued_at DATE,
  status TEXT DEFAULT 'accrued',
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_notifications (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
  message TEXT, entity_type TEXT, entity_id TEXT,
  is_read BOOLEAN DEFAULT false, priority TEXT DEFAULT 'medium',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cattle_costs (
  id TEXT PRIMARY KEY, cycle_id TEXT, category TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL, description TEXT, date DATE,
  vendor TEXT, invoice_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cattle_cycles (
  id TEXT PRIMARY KEY,
  batch_name TEXT, inv_no TEXT, invoice_date TIMESTAMPTZ,
  cycle_start_date TIMESTAMPTZ, end_date TIMESTAMPTZ, sale_date TIMESTAMPTZ,
  cycle_no TEXT, days_in_cycle INT, company TEXT,
  no_purchased INT DEFAULT 0, mortalities INT DEFAULT 0,
  no_live INT DEFAULT 0, no_sold INT DEFAULT 0, unsold_cattle INT DEFAULT 0,
  avg_cattle_cost NUMERIC(18,4), purchase_value NUMERIC(18,2),
  expected_sale_value NUMERIC(18,2), total_selling_price NUMERIC(18,2),
  selling_price_per_head NUMERIC(18,4), svc_standing_fee NUMERIC(18,2),
  net_return_pct NUMERIC(8,4), outstanding_invoice NUMERIC(18,2),
  invoice_paid TEXT DEFAULT 'Pending',
  status TEXT DEFAULT 'active', notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cattle_cycles_status_idx ON cattle_cycles(status);

CREATE TABLE IF NOT EXISTS cattle_animals (
  id TEXT PRIMARY KEY,
  tag_number TEXT, batch_no TEXT, batch_name TEXT,
  cycle_id TEXT REFERENCES cattle_cycles(id) ON DELETE SET NULL,
  entry_mass NUMERIC(10,2), gender TEXT, breed TEXT,
  status TEXT DEFAULT 'active',
  mortality BOOLEAN DEFAULT false, mortality_date DATE, mortality_report TEXT,
  sold BOOLEAN DEFAULT false, sale_batch TEXT, sale_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cattle_animals_cycle_idx ON cattle_animals(cycle_id);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL, phone TEXT,
  role TEXT NOT NULL, level TEXT DEFAULT 'junior', department TEXT,
  status TEXT DEFAULT 'active', pin_hash TEXT, hire_date DATE, notes TEXT,
  permissions JSONB DEFAULT '{}',
  id_number TEXT, avatar_initials TEXT, avatar_color TEXT DEFAULT '#eda5ff',
  xp_points INT DEFAULT 0, streak_days INT DEFAULT 0,
  eva_weight NUMERIC(6,2) DEFAULT 1.0,
  base_salary NUMERIC(18,2) DEFAULT 0,
  bio TEXT, birth_date DATE,
  -- Banking
  bank_account_number TEXT, bank_name TEXT, bank_account_type TEXT,
  bank_branch_code TEXT, bank_account_holder TEXT, proof_of_banking_url TEXT,
  -- Emergency contact
  emergency_contact_name TEXT, emergency_contact_phone TEXT,
  -- Address
  address_line1 TEXT, address_line2 TEXT, address_city TEXT,
  address_province TEXT, address_postal_code TEXT,
  -- Documents
  proof_of_id_url TEXT,
  -- Employee number (unique, admin-assignable)
  employee_number TEXT UNIQUE,
  badges JSONB DEFAULT '[]', start_date DATE,
  pin_set BOOLEAN DEFAULT false,
  login_attempts INT DEFAULT 0, login_locked_until TIMESTAMPTZ,
  totp_secret TEXT, totp_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS employees_email_idx ON employees(email);

-- Add missing columns to existing deployments (safe — IF NOT EXISTS equivalent)
DO $$ BEGIN
  BEGIN ALTER TABLE employees ADD COLUMN level TEXT DEFAULT 'junior'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN id_number TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN avatar_initials TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN avatar_color TEXT DEFAULT '#eda5ff'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN xp_points INT DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN streak_days INT DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN eva_weight NUMERIC(6,2) DEFAULT 1.0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN base_salary NUMERIC(18,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN bio TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN birth_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN bank_account_number TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN badges JSONB DEFAULT '[]'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN start_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- PIN setup columns
  BEGIN ALTER TABLE employees ADD COLUMN pin_set BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN login_attempts INT DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN login_locked_until TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- TOTP 2FA columns (reserved for next phase)
  BEGIN ALTER TABLE employees ADD COLUMN totp_secret TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN totp_enabled BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Banking detail columns
  BEGIN ALTER TABLE employees ADD COLUMN bank_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN bank_account_type TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN bank_branch_code TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN bank_account_holder TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN proof_of_banking_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Emergency contact
  BEGIN ALTER TABLE employees ADD COLUMN emergency_contact_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN emergency_contact_phone TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Address
  BEGIN ALTER TABLE employees ADD COLUMN address_line1 TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN address_line2 TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN address_city TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN address_province TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN address_postal_code TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Documents & employee number
  BEGIN ALTER TABLE employees ADD COLUMN proof_of_id_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE employees ADD COLUMN employee_number TEXT UNIQUE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Per-individual app access (replaces role-based RBAC for staff app access)
  BEGIN ALTER TABLE employees ADD COLUMN app_access TEXT[]; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN partner_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN actual_rate NUMERIC(8,4) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investments ADD COLUMN pool_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investments ADD COLUMN payout_date TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investments ADD COLUMN maturity_alert_sent_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investments ADD COLUMN maturity_3day_alert_sent_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Investor bank detail columns for wallet withdrawals
  BEGIN ALTER TABLE investors ADD COLUMN bank_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN bank_account_holder TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN bank_account_number TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN bank_branch_code TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN bank_account_type TEXT DEFAULT 'current'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN bank_account_status TEXT DEFAULT 'none'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN bank_account_notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- sub_account_id on transactions for sub-account deposits
  BEGIN ALTER TABLE transactions ADD COLUMN sub_account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- TOTP 2FA columns for users table
  BEGIN ALTER TABLE users ADD COLUMN totp_secret TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Login lockout and tracking columns for users table
  BEGIN ALTER TABLE users ADD COLUMN login_attempts INT DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE users ADD COLUMN login_locked_until TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE users ADD COLUMN last_login_ip TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Auto-maturity processing tracking
  BEGIN ALTER TABLE investments ADD COLUMN maturity_processed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- IFA commission invoice tracking
  BEGIN ALTER TABLE ifas ADD COLUMN last_invoice_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE ifas ADD COLUMN total_commission_paid NUMERIC(18,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Transaction columns used by portal investment flow and Paystack creditWallet
  BEGIN ALTER TABLE transactions ADD COLUMN transaction_date TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE transactions ADD COLUMN investor_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Maturity instruction on investments (used by maturity flow)
  BEGIN ALTER TABLE investments ADD COLUMN maturity_instruction TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- TOTP + login tracking for users
  BEGIN ALTER TABLE users ADD COLUMN totp_temp_secret TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE users ADD COLUMN last_login_ip TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- TOTP + login tracking for investors
  BEGIN ALTER TABLE investors ADD COLUMN totp_secret TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN totp_temp_secret TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN totp_enabled BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN last_login_ip TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN last_login_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Recurring investment columns for investors
  BEGIN ALTER TABLE investors ADD COLUMN recurring_amount NUMERIC(12,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN recurring_pool_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN recurring_enabled BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN recurring_product_type TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN recurring_day INT DEFAULT 1; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Auto wallet top-up (Paystack authorization-based recurring charge)
  BEGIN ALTER TABLE investors ADD COLUMN auto_topup_enabled BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN auto_topup_amount NUMERIC(12,2); EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN auto_topup_day INT DEFAULT 1; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Withdrawal notes column on transactions
  BEGIN ALTER TABLE transactions ADD COLUMN notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Investment pool capacity columns (Feature: waitlist)
  BEGIN ALTER TABLE investment_pools ADD COLUMN max_capacity NUMERIC(15,2) DEFAULT NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN current_invested NUMERIC(15,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- FICA re-verification tracking
  BEGIN ALTER TABLE investors ADD COLUMN fica_approved_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN fica_resubmit_requested_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Referral tracking on transactions
  BEGIN ALTER TABLE transactions ADD COLUMN referred_investor_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Term sheet URL on investment pools
  BEGIN ALTER TABLE investment_pools ADD COLUMN term_sheet_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Fee management columns on investment pools
  BEGIN ALTER TABLE investment_pools ADD COLUMN management_fee_pct NUMERIC(8,4) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN management_fee_frequency TEXT DEFAULT 'once'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN operational_fee_pct NUMERIC(8,4) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN operational_fee_frequency TEXT DEFAULT 'annual'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN maturity_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- Pool target type: 'amount' (raise to a goal amount) or 'date' (open until a closing date)
  BEGIN ALTER TABLE investment_pools ADD COLUMN target_type TEXT DEFAULT 'amount'; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investment_pools ADD COLUMN investment_start_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- EVA tracking on investments (% of net-VAT management fee configured via platform_settings eva_rate)
  BEGIN ALTER TABLE investments ADD COLUMN is_reinvestment BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investments ADD COLUMN eva_amount NUMERIC(12,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
  -- System-generated tickets (AML checks etc — hidden from client view)
  BEGIN ALTER TABLE support_tickets ADD COLUMN is_system BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
END $$;

-- One-time backfill: seed each EXISTING employee's individual app access from
-- their role/level so nobody loses access when access becomes per-individual.
-- Guarded by NOT EXISTS so it runs ONLY while the whole table is unseeded (the
-- initial migration). Once any employee has app_access set, this never runs
-- again — so employees added later keep app_access = NULL and are treated as
-- ['employee'] (My Dashboard only) until a director grants them more.
UPDATE employees SET app_access = CASE
  WHEN level = 'executive'                                   THEN ARRAY['employee','team','fund','admin','ifa','portal','director','accounting']
  WHEN role IN ('CEO','COO')                                 THEN ARRAY['employee','team','fund','admin','ifa','portal','director']
  WHEN role IN ('Operations Manager','Finance Manager','Tech Lead') THEN ARRAY['employee','team','fund','admin']
  WHEN role = 'Investment Analyst'                           THEN ARRAY['employee','team','fund']
  WHEN role IN ('Compliance Officer','Internal Audit')       THEN ARRAY['employee','admin']
  WHEN role = 'Client Relations'                             THEN ARRAY['employee','portal']
  WHEN role = 'Admin'                                        THEN ARRAY['employee','admin','accounting']
  ELSE ARRAY['employee']
END
WHERE app_access IS NULL
  AND NOT EXISTS (SELECT 1 FROM employees WHERE app_access IS NOT NULL);

CREATE TABLE IF NOT EXISTS compliance_calendar (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE NOT NULL,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investment_waitlist (
  id TEXT PRIMARY KEY,
  investor_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  notified BOOLEAN DEFAULT false,
  UNIQUE(investor_id, pool_id)
);

CREATE TABLE IF NOT EXISTS investor_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id TEXT NOT NULL,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE push_subscriptions ADD COLUMN user_agent TEXT;
  EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE push_subscriptions ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS push_subs_endpoint_idx ON push_subscriptions ((subscription->>'endpoint'));
CREATE INDEX IF NOT EXISTS push_subs_investor_idx ON push_subscriptions (investor_id);
DO $$ BEGIN
  ALTER TABLE push_subscriptions
    ADD CONSTRAINT push_subs_investor_fk
    FOREIGN KEY (investor_id) REFERENCES investors(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR undefined_table THEN NULL;
END $$;

/* Paystack reusable card tokens for auto wallet top-up */
CREATE TABLE IF NOT EXISTS paystack_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id TEXT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  authorization_code TEXT NOT NULL,
  email TEXT NOT NULL,
  card_type TEXT,
  last4 TEXT,
  exp_month TEXT,
  exp_year TEXT,
  bank TEXT,
  channel TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(investor_id)
);
CREATE INDEX IF NOT EXISTS paystack_auth_investor_idx ON paystack_authorizations (investor_id);

CREATE TABLE IF NOT EXISTS push_notifications_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  recipient_count INT DEFAULT 0,
  sent_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pay_period TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  basic_salary NUMERIC(18,2) DEFAULT 0,
  bonus NUMERIC(18,2) DEFAULT 0,
  other_earnings NUMERIC(18,2) DEFAULT 0,
  total_earnings NUMERIC(18,2) DEFAULT 0,
  tax NUMERIC(18,2) DEFAULT 0,
  uif_employee NUMERIC(18,2) DEFAULT 0,
  other_deductions NUMERIC(18,2) DEFAULT 0,
  total_deductions NUMERIC(18,2) DEFAULT 0,
  nett_pay NUMERIC(18,2) DEFAULT 0,
  uif_company NUMERIC(18,2) DEFAULT 0,
  ytd_taxable_earnings NUMERIC(18,2) DEFAULT 0,
  ytd_tax_paid NUMERIC(18,2) DEFAULT 0,
  ytd_taxable_company_contributions NUMERIC(18,2) DEFAULT 0,
  ytd_taxable_fringe_benefits NUMERIC(18,2) DEFAULT 0,
  ytd_provision_annual_bonus NUMERIC(18,2) DEFAULT 0,
  notes TEXT,
  generated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payslips_emp_idx ON payslips(employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS payslips_emp_period_idx ON payslips(employee_id, pay_period);

CREATE TABLE IF NOT EXISTS employee_onboarding (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'not_started',
  tasks_total INT DEFAULT 0, tasks_completed INT DEFAULT 0,
  welcome_message TEXT, assigned_buddy TEXT, notes TEXT,
  created_by TEXT, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS emp_onboarding_emp_idx ON employee_onboarding(employee_id);

CREATE TABLE IF NOT EXISTS employee_courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, description TEXT,
  category TEXT DEFAULT 'general', level TEXT DEFAULT 'beginner',
  duration_minutes INT DEFAULT 30, xp_reward INT DEFAULT 100,
  is_required BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true,
  modules JSONB DEFAULT '[]', thumbnail_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_progress (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  course_id TEXT, status TEXT DEFAULT 'enrolled',
  current_module INT DEFAULT 1, modules_completed JSONB DEFAULT '[]',
  quiz_scores JSONB DEFAULT '[]', overall_quiz_score NUMERIC(6,2) DEFAULT 0,
  xp_earned INT DEFAULT 0, kpi_applied BOOLEAN DEFAULT false,
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS course_progress_emp_idx ON course_progress(employee_id);

CREATE TABLE IF NOT EXISTS activity_feed (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  icon TEXT, color TEXT, xp_shown INT DEFAULT 0,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS activity_feed_emp_idx ON activity_feed(employee_id);

CREATE TABLE IF NOT EXISTS kpi_scores (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  period_month TEXT NOT NULL,
  revenue_contribution NUMERIC(6,2) DEFAULT 0,
  client_satisfaction NUMERIC(6,2) DEFAULT 0,
  task_completion_rate NUMERIC(6,2) DEFAULT 0,
  response_time_score NUMERIC(6,2) DEFAULT 0,
  compliance_score NUMERIC(6,2) DEFAULT 0,
  innovation_score NUMERIC(6,2) DEFAULT 0,
  team_collaboration NUMERIC(6,2) DEFAULT 0,
  attendance_score NUMERIC(6,2) DEFAULT 0,
  overall_score NUMERIC(6,2) DEFAULT 0,
  submitted_by TEXT, submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS kpi_scores_emp_idx ON kpi_scores(employee_id);

CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL, badge_name TEXT, badge_icon TEXT,
  badge_color TEXT, category TEXT, description TEXT,
  xp_awarded INT DEFAULT 0,
  awarded_at TIMESTAMPTZ DEFAULT NOW(), awarded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS achievements_emp_idx ON achievements(employee_id);

CREATE TABLE IF NOT EXISTS daily_checkins (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  mood TEXT, tasks_planned TEXT, tasks_completed TEXT, notes TEXT,
  xp_awarded INT DEFAULT 0, streak_contribution INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS daily_checkins_emp_idx ON daily_checkins(employee_id);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL, start_date DATE, end_date DATE,
  days_requested INT DEFAULT 1, reason TEXT,
  status TEXT DEFAULT 'pending',
  eva_impact_pct NUMERIC(6,2) DEFAULT 0,
  approved_by TEXT, approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS leave_requests_emp_idx ON leave_requests(employee_id);

CREATE TABLE IF NOT EXISTS okrs (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  period_month TEXT, objective TEXT NOT NULL,
  kr1_text TEXT, kr2_text TEXT, kr3_text TEXT,
  kr1_progress NUMERIC(6,2) DEFAULT 0,
  kr2_progress NUMERIC(6,2) DEFAULT 0,
  kr3_progress NUMERIC(6,2) DEFAULT 0,
  kr1_target NUMERIC(6,2) DEFAULT 100,
  kr2_target NUMERIC(6,2) DEFAULT 100,
  kr3_target NUMERIC(6,2) DEFAULT 100,
  overall_progress NUMERIC(6,2) DEFAULT 0,
  kpi_dimension TEXT, kpi_boost_on_complete NUMERIC(6,2) DEFAULT 0,
  status TEXT DEFAULT 'active', manager_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS okrs_emp_idx ON okrs(employee_id);

CREATE TABLE IF NOT EXISTS peer_feedback (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  from_employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  to_employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'kudos', kpi_dimension TEXT, message TEXT,
  rating INT, is_public BOOLEAN DEFAULT true,
  period_month TEXT, xp_awarded INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS peer_feedback_to_idx   ON peer_feedback(to_employee_id);
CREATE INDEX IF NOT EXISTS peer_feedback_from_idx ON peer_feedback(from_employee_id);

CREATE TABLE IF NOT EXISTS pulse_surveys (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'active', week TEXT,
  q1 TEXT, q2 TEXT, q3 TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pulse_responses (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  survey_id TEXT REFERENCES pulse_surveys(id) ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  week TEXT, r1 TEXT, r2 TEXT, r3 TEXT,
  enps INT, open_comment TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(survey_id, employee_id)
);
CREATE INDEX IF NOT EXISTS pulse_responses_emp_idx ON pulse_responses(employee_id);

CREATE TABLE IF NOT EXISTS one_on_ones (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  manager_id TEXT, scheduled_date DATE,
  status TEXT DEFAULT 'scheduled',
  agenda TEXT, employee_notes TEXT, manager_notes TEXT,
  action_items JSONB DEFAULT '[]', mood_rating INT,
  topics TEXT[], next_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS one_on_ones_emp_idx ON one_on_ones(employee_id);

CREATE TABLE IF NOT EXISTS learning_paths (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  role_target TEXT,
  thumbnail_color TEXT DEFAULT '#eda5ff',
  thumbnail_icon TEXT DEFAULT 'fa-road',
  course_ids JSONB DEFAULT '[]',
  is_mandatory BOOLEAN DEFAULT false,
  deadline_days INT, xp_bonus INT DEFAULT 0, badge_reward TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eva_periods (
  id TEXT PRIMARY KEY, period_month TEXT UNIQUE NOT NULL,
  total_aum NUMERIC(18,2) DEFAULT 0,
  gross_revenue NUMERIC(18,2) DEFAULT 0,
  operational_costs NUMERIC(18,2) DEFAULT 0,
  team_pool_pct NUMERIC(6,2) DEFAULT 50,
  team_pool_amount NUMERIC(18,2) DEFAULT 0,
  individual_split_pct NUMERIC(6,2) DEFAULT 60,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS personal_notes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled', content TEXT,
  pinned BOOLEAN DEFAULT false, is_private BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS personal_notes_emp_idx ON personal_notes(employee_id);

CREATE TABLE IF NOT EXISTS course_modules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  course_id TEXT REFERENCES employee_courses(id) ON DELETE CASCADE,
  module_index INT NOT NULL DEFAULT 1, title TEXT NOT NULL,
  estimated_minutes INT DEFAULT 15, xp_reward INT DEFAULT 50,
  content TEXT, key_points JSONB DEFAULT '[]', quiz JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS course_modules_course_idx ON course_modules(course_id);

CREATE TABLE IF NOT EXISTS cattle_nav_settings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  setting_key TEXT UNIQUE NOT NULL,
  setting_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shortterm_loans (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL, business_reg TEXT,
  contact_name TEXT, contact_phone TEXT, loan_ref TEXT,
  amount_disbursed NUMERIC(18,2) DEFAULT 0,
  interest_rate NUMERIC(8,6) DEFAULT 0,
  interest_amount NUMERIC(18,2) DEFAULT 0,
  total_repayable NUMERIC(18,2) DEFAULT 0,
  partial_repayments NUMERIC(18,2) DEFAULT 0,
  status TEXT DEFAULT 'active',
  disbursement_date TIMESTAMPTZ, repayment_date TIMESTAMPTZ,
  actual_repayment_date TIMESTAMPTZ, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shortterm_loans_status_idx ON shortterm_loans(status);

CREATE TABLE IF NOT EXISTS loan_documents (
  id TEXT PRIMARY KEY,
  loan_id TEXT REFERENCES shortterm_loans(id) ON DELETE CASCADE,
  doc_type TEXT DEFAULT 'other', doc_name TEXT, doc_url TEXT,
  file_size TEXT, mime_type TEXT,
  uploaded_by TEXT, uploaded_at TIMESTAMPTZ DEFAULT NOW(), notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS loan_documents_loan_idx ON loan_documents(loan_id);

CREATE TABLE IF NOT EXISTS solar_projects (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL, location TEXT,
  capacity_kw NUMERIC(10,2), investor_count INT,
  product_type TEXT DEFAULT '7yr',
  status TEXT DEFAULT 'active',
  term_years INT, capital_deployed NUMERIC(18,2) DEFAULT 0,
  annual_rate NUMERIC(8,6) DEFAULT 0,
  contracted_return NUMERIC(18,2), actual_return NUMERIC(18,2) DEFAULT 0,
  start_date TIMESTAMPTZ, maturity_date TIMESTAMPTZ, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS solar_projects_status_idx ON solar_projects(status);

CREATE TABLE IF NOT EXISTS solar_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES solar_projects(id) ON DELETE CASCADE,
  doc_type TEXT DEFAULT 'other', doc_name TEXT, doc_url TEXT,
  file_size BIGINT, mime_type TEXT,
  uploaded_by TEXT, uploaded_at TIMESTAMPTZ DEFAULT NOW(), notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS solar_documents_project_idx ON solar_documents(project_id);

CREATE TABLE IF NOT EXISTS fica_checks (
  id                TEXT PRIMARY KEY,
  investor_id       TEXT REFERENCES investors(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL,
  id_check_status   TEXT DEFAULT 'pending',
  bank_check_status TEXT DEFAULT 'skipped',
  overall_status    TEXT DEFAULT 'pending',
  id_result         JSONB DEFAULT '{}',
  bank_result       JSONB DEFAULT '{}',
  check_date        TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fica_checks_investor_idx ON fica_checks(investor_id);
CREATE INDEX IF NOT EXISTS fica_checks_date_idx     ON fica_checks(check_date);

CREATE TABLE IF NOT EXISTS accepted_client_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id      TEXT REFERENCES investors(id) ON DELETE CASCADE,
  document_type    TEXT NOT NULL
                     CHECK (document_type IN ('terms_of_service','privacy_policy','popia_notice','fica_consent','risk_disclaimer')),
  document_version TEXT NOT NULL DEFAULT '1.0',
  accepted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address       TEXT,
  user_agent       TEXT
);
CREATE INDEX IF NOT EXISTS acd_investor_idx    ON accepted_client_documents(investor_id);
CREATE INDEX IF NOT EXISTS acd_accepted_at_idx ON accepted_client_documents(accepted_at DESC);

CREATE TABLE IF NOT EXISTS quest_completions (
  id           TEXT PRIMARY KEY,
  investor_id  TEXT REFERENCES investors(id) ON DELETE CASCADE,
  quest_id     TEXT NOT NULL,
  xp_awarded   INT DEFAULT 0,
  data         JSONB DEFAULT '{}',
  completed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS quest_inv_quest_uidx ON quest_completions(investor_id, quest_id);
CREATE INDEX        IF NOT EXISTS quest_inv_idx        ON quest_completions(investor_id);

CREATE TABLE IF NOT EXISTS sub_accounts (
  id                   TEXT PRIMARY KEY,
  parent_investor_id   TEXT REFERENCES investors(id) ON DELETE CASCADE,
  account_type         TEXT NOT NULL,
  name                 TEXT NOT NULL,
  wallet_balance       NUMERIC(18,2) DEFAULT 0,
  total_invested       NUMERIC(18,2) DEFAULT 0,
  total_returns        NUMERIC(18,2) DEFAULT 0,
  kyc_status           TEXT DEFAULT 'pending',
  status               TEXT DEFAULT 'active',
  registration_number  TEXT,
  vat_number           TEXT,
  trust_number         TEXT,
  trustee_name         TEXT,
  stokvel_reg_number   TEXT,
  member_count         INT DEFAULT 0,
  date_of_birth        TEXT,
  id_number            TEXT,
  relationship         TEXT,
  email                TEXT,
  phone                TEXT,
  savings_goal         NUMERIC(18,2) DEFAULT 0,
  savings_goal_label   TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sub_accounts_parent_idx ON sub_accounts(parent_investor_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  refresh_token TEXT UNIQUE NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(refresh_token);

-- Mobile push notification tokens (one per device per investor)
CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id TEXT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (investor_id, token)
);
CREATE INDEX IF NOT EXISTS push_tokens_investor_idx ON push_tokens(investor_id);

-- Signup friction events: anonymous per-session tracking of friction points
CREATE TABLE IF NOT EXISTS signup_friction_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  step          INT,
  field_name    TEXT,
  error_message TEXT,
  time_on_step_ms INT,
  device_type   TEXT,
  client_type   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS friction_session_idx ON signup_friction_events(session_id);
CREATE INDEX IF NOT EXISTS friction_type_idx    ON signup_friction_events(event_type);
CREATE INDEX IF NOT EXISTS friction_created_idx ON signup_friction_events(created_at);

CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used        BOOLEAN DEFAULT false,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON totp_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS user_login_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  investor_id TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  login_at    TIMESTAMPTZ DEFAULT NOW(),
  success     BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS login_events_user_idx ON user_login_events(user_id, login_at DESC);

CREATE TABLE IF NOT EXISTS investor_statements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id   TEXT NOT NULL,
  period_year   INT NOT NULL,
  period_month  INT NOT NULL,
  pdf_data      TEXT,  -- base64 encoded PDF
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(investor_id, period_year, period_month)
);
CREATE INDEX IF NOT EXISTS inv_statements_investor_idx ON investor_statements(investor_id, period_year DESC, period_month DESC);

CREATE TABLE IF NOT EXISTS email_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email     TEXT NOT NULL,
  template     TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending, sent, failed, dead
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  scheduled_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_queue_status_idx ON email_queue(status, scheduled_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jti        TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL,
  used       BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pwd_reset_jti_idx ON password_reset_tokens(jti);

CREATE TABLE IF NOT EXISTS international_waitlist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  TEXT NOT NULL,
  email      TEXT NOT NULL,
  country    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS gifts (
  id              TEXT PRIMARY KEY,
  sender_id       TEXT REFERENCES investors(id) ON DELETE CASCADE,
  recipient_id    TEXT REFERENCES investors(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  recipient_name  TEXT,
  amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  message         TEXT,
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','expired','cancelled')),
  claim_token     TEXT UNIQUE,
  sent_at         TIMESTAMPTZ DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gifts_sender_idx          ON gifts(sender_id);
CREATE INDEX IF NOT EXISTS gifts_recipient_idx       ON gifts(recipient_id);
CREATE INDEX IF NOT EXISTS gifts_recipient_email_idx ON gifts(recipient_email);
CREATE INDEX IF NOT EXISTS gifts_claim_token_idx     ON gifts(claim_token);

CREATE TABLE IF NOT EXISTS testimonials (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id      TEXT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  rating           INT  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  initials         TEXT NOT NULL,
  product_label    TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  rejection_reason TEXT,
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS testimonials_investor_uidx ON testimonials(investor_id);
CREATE INDEX        IF NOT EXISTS testimonials_status_idx    ON testimonials(status);

CREATE TABLE IF NOT EXISTS email_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error       TEXT,
  resend_id   TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_logs_sent_at_idx  ON email_logs(sent_at DESC);
CREATE INDEX IF NOT EXISTS email_logs_to_email_idx ON email_logs(to_email);

CREATE TABLE IF NOT EXISTS product_factsheets (
  id          TEXT PRIMARY KEY,
  pool_id     TEXT REFERENCES investment_pools(id) ON DELETE CASCADE,
  pool_name   TEXT,
  file_name   TEXT NOT NULL,
  file_url    TEXT NOT NULL,
  file_size   BIGINT,
  mime_type   TEXT DEFAULT 'application/pdf',
  version     TEXT,
  uploaded_by TEXT,
  is_current  BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS factsheets_pool_idx     ON product_factsheets(pool_id);
CREATE INDEX IF NOT EXISTS factsheets_current_idx  ON product_factsheets(pool_id, is_current);

CREATE TABLE IF NOT EXISTS products (
  id                  TEXT PRIMARY KEY,
  product_type        TEXT NOT NULL UNIQUE,   -- key used by investment_pools.product_type
  label               TEXT NOT NULL,          -- e.g. "Cattle Investment"
  headline            TEXT,                   -- e.g. "Grow with the herd."
  description         TEXT,
  key_details         TEXT,                   -- one bullet per line
  min_investment      NUMERIC(18,2) DEFAULT 500,
  term_months         INT DEFAULT 12,
  benchmark_rate      NUMERIC(8,4) DEFAULT 0, -- e.g. 0.13 = 13% benchmark
  performance_fee_pct NUMERIC(8,4) DEFAULT 0, -- e.g. 0.20 = 20% above benchmark
  risk_profile        TEXT DEFAULT 'Medium',
  risk_color          TEXT DEFAULT '#fec24f',
  icon                TEXT DEFAULT 'fa-circle',
  color               TEXT DEFAULT '#656565',
  badge_class         TEXT DEFAULT 'badge--gray',
  partner_name        TEXT,
  factsheet_url       TEXT,                   -- base64 data URL or external link
  factsheet_name      TEXT,
  is_active           BOOLEAN DEFAULT true,
  display_on_homepage BOOLEAN DEFAULT true,
  sort_order          INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS products_type_idx ON products(product_type);
`;

/* Default product catalogue — seeded once, then fully editable in the admin
   console. Parameterised inserts avoid any apostrophe-escaping issues. */
const DEFAULT_PRODUCTS = [
  {
    product_type: 'cattle', label: 'Cattle Investment', headline: 'Grow with the herd.', partner_name: 'Beefcor',
    description: "Partner with Beefcor, one of South Africa's most respected feedlots, and watch your returns grow alongside the cattle. Each investment pool funds a herd of cattle that enters at 200–230kg and is raised to 450–500kg before sale to an abattoir.",
    key_details: [
      'Cattle enter feedlot at 200–230kg and are raised to 450–500kg',
      'Returns are determined by weight gain and market price per kilogram',
      'Beefcor guarantees 99% cattle survival rate',
      '9 consecutive years of delivering consistent returns',
      "Supports South Africa's agricultural economy",
      'Performance fee: 20% on returns above 13% benchmark',
    ].join('\n'),
    min_investment: 500, term_months: 12, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium-High', risk_color: '#fec24f', icon: 'fa-cow', color: '#fec24f',
    badge_class: 'badge--gold', partner_name: 'Beefcor', sort_order: 1,
  },
  {
    product_type: 'solar_7yr', label: 'Solar Investment (7yr)', headline: 'Power your returns.',
    description: 'Fund solar energy installations for homes and businesses across South Africa and earn from clean, contracted energy generation over a 7-year term.',
    key_details: ['Funds rooftop & commercial solar installations', 'Contracted energy offtake agreements', 'Supports SA energy independence'].join('\n'),
    min_investment: 10000, term_months: 84, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium', risk_color: '#fec24f', icon: 'fa-solar-panel', color: '#22c55e',
    badge_class: 'badge--green', sort_order: 2,
  },
  {
    product_type: 'solar_6yr', label: 'Solar Investment (6yr)', headline: 'Power your returns.',
    description: 'Fund solar energy installations across South Africa over a 6-year term.',
    key_details: ['Funds rooftop & commercial solar installations', 'Contracted energy offtake agreements'].join('\n'),
    min_investment: 10000, term_months: 72, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium', risk_color: '#fec24f', icon: 'fa-solar-panel', color: '#22c55e',
    badge_class: 'badge--green', sort_order: 3,
  },
  {
    product_type: 'solar_5yr', label: 'Solar Investment (5yr)', headline: 'Power your returns.',
    description: 'Fund solar energy installations across South Africa over a 5-year term.',
    key_details: ['Funds rooftop & commercial solar installations', 'Contracted energy offtake agreements'].join('\n'),
    min_investment: 10000, term_months: 60, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium', risk_color: '#fec24f', icon: 'fa-solar-panel', color: '#22c55e',
    badge_class: 'badge--green', sort_order: 4,
  },
  {
    product_type: 'short_term', label: 'Short Term Investment', headline: 'Fast, focused growth.', partner_name: 'MoolaLend',
    description: 'Fund South African SMMEs through asset finance. Capital is deployed into vetted businesses generating strong short-cycle returns.',
    key_details: ['Capital deployed to vetted SMMEs', 'Returns from SMME receivables financing & asset-backed loans', 'Short investment cycles', 'Asset-backed where possible'].join('\n'),
    min_investment: 1000, term_months: 5, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium', risk_color: '#fec24f', icon: 'fa-bolt', color: '#656565',
    badge_class: 'badge--blue', sort_order: 5,
  },
  {
    product_type: 'smme', label: 'SMME', headline: 'Back local business.',
    description: 'Fund vetted small, medium and micro enterprises through short-cycle asset finance.',
    key_details: ['Capital deployed to vetted SMMEs', 'Short investment cycles'].join('\n'),
    min_investment: 1000, term_months: 1, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium', risk_color: '#fec24f', icon: 'fa-bolt', color: '#656565',
    badge_class: 'badge--blue', sort_order: 6,
  },
  {
    product_type: 'delivery_bike', label: 'Delivery Bikes', headline: 'Steady wheels, steady returns.',
    description: 'Fleet funding for delivery riders working with platforms like Mr D, Takealot and Uber Eats. Steady, predictable returns.',
    key_details: ['Funds delivery motorcycle fleets', 'Predictable lease-based returns', 'Supports gig-economy riders'].join('\n'),
    min_investment: 3100, term_months: 18, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Low-Medium', risk_color: '#22c55e', icon: 'fa-motorcycle', color: '#f97316',
    badge_class: 'badge--orange', sort_order: 7,
  },
  {
    product_type: 'gridfarmer', label: 'GridFarmer', headline: 'Buy a hectare, not a fund.',
    description: 'Own a uniquely identified 1-hectare white maize GPS grid. Your return is tethered to the physical yield of your specific plot — satellite-monitored, GPS-verified at harvest. Not a pool, not an index.',
    key_details: [
      'Direct production rights on a named 1-ha GPS grid',
      'Return = actual yield (tons) × SAFEX harvest-window VWAP',
      'Fortnightly NDVI satellite monitoring during growing season',
      'Hardware-logged yield at harvest — no manual reporting',
      'Option B: embedded MPCI insurance underwritten by Santam Agriculture',
      'Outside CISCA perimeter — non-pooled structure',
      'Launching October 2026 — Maize Draft season',
    ].join('\n'),
    min_investment: 17000, term_months: 12, benchmark_rate: 0, performance_fee_pct: 0,
    risk_profile: 'High', risk_color: '#ff5229', icon: 'fa-seedling', color: '#65ed00',
    badge_class: 'badge--green', partner_name: 'GridFarmer', sort_order: 8,
  },
];

async function seedProducts() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS count FROM products');
    if (parseInt(rows[0].count, 10) > 0) {
      console.log('ℹ️  Products table already has data — skipping seed.');
      return;
    }
    for (const p of DEFAULT_PRODUCTS) {
      await pool.query(
        `INSERT INTO products
           (id, product_type, label, headline, description, key_details,
            min_investment, term_months, benchmark_rate, performance_fee_pct,
            risk_profile, risk_color, icon, color, badge_class, partner_name, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (product_type) DO NOTHING`,
        [
          `PROD-${p.product_type.toUpperCase()}`, p.product_type, p.label, p.headline,
          p.description, p.key_details, p.min_investment, p.term_months, p.benchmark_rate,
          p.performance_fee_pct, p.risk_profile, p.risk_color, p.icon, p.color,
          p.badge_class, p.partner_name || null, p.sort_order,
        ]
      );
    }
    console.log('✅ Default products seeded.');
  } catch (err) {
    console.error('[seedProducts] error:', err.message);
  }
}

const SEED_TESTIMONIALS = [
  { display_name: 'Sello Moja',         initials: 'SM', body: 'Platform is easy to use. Returns out perform all banks for all investments. Thanks for listening to us and introducing minor accounts. Real growth and nice diversification portfolios.' },
  { display_name: 'Kabelo Rakgantso',   initials: 'KR', body: 'The organisation really projected their company\'s value proposition fully towards me as their new client and my money is in safe hands.' },
  { display_name: 'Travis Dikoko',      initials: 'TD', body: 'Great app for investing. I love it!' },
  { display_name: 'Russel Chiume',      initials: 'RC', body: 'For someone who is new to investing, it is very helpful with guiding you to investments that suit your needs and pocket.' },
  { display_name: 'William Keenan',     initials: 'WK', body: 'A professional service and great investment return.' },
  { display_name: 'Nhlakanipho Mzobe',  initials: 'NM', body: 'The entire process was quite seamless. Very impressed with your App. I absolutely have no complaints.' },
  { display_name: 'Nolukholo Gamede',   initials: 'NG', body: 'Customer service yase SV Capital is beautiful.' },
  { display_name: 'Roland Hepson',      initials: 'RH', body: "I'm very happy with my experience and have no complaints." },
];

async function seedTestimonials() {
  try {
    // Allow admin-seeded testimonials that aren't tied to a specific investor account
    await pool.query(`ALTER TABLE testimonials ALTER COLUMN investor_id DROP NOT NULL`).catch(() => {});
    for (const t of SEED_TESTIMONIALS) {
      await pool.query(
        `INSERT INTO testimonials (rating, body, display_name, initials, status, approved_at)
         SELECT 5, $1, $2, $3, 'approved', NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM testimonials WHERE display_name = $2 AND investor_id IS NULL
          )`,
        [t.body, t.display_name, t.initials]
      );
    }
    console.log('✅ Seeded testimonials ready.');
  } catch (err) {
    console.error('[seedTestimonials] error:', err.message);
  }
}

async function autoSetup() {
  if (!process.env.DATABASE_URL) {
    console.log('⚠️  Skipping auto-setup: DATABASE_URL not set.');
    return;
  }

  try {
    console.log('🔄 Running auto-setup (migrate + seed if empty)…');

    // 1. Create all tables
    await pool.query(SCHEMA);
    console.log('✅ Schema ready.');

    // 1b. Add new columns to existing tables (safe — IF NOT EXISTS)
    await pool.query(`
      DO $$ BEGIN
        BEGIN ALTER TABLE investors ADD COLUMN last_auto_fica_check TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN fica_auto_status TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN xp_points INT DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN xp_level TEXT DEFAULT 'seed'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN investor_profile JSONB DEFAULT '{}'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE support_tickets ADD COLUMN investor_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE support_tickets ADD COLUMN investor_email TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE support_tickets ADD COLUMN admin_response TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE support_tickets ADD COLUMN proof_attached BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE support_tickets ADD COLUMN proof_filename TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE support_tickets ADD COLUMN file_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE kyc_documents ADD COLUMN sub_account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE kyc_documents ADD COLUMN file_data TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE kyc_documents ADD COLUMN investor_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE kyc_documents ADD COLUMN reviewed_date TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE transactions ADD COLUMN sub_account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investments ADD COLUMN sub_account_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE audit_events ADD COLUMN actor_role TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE audit_events ADD COLUMN actor_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE audit_events ADD COLUMN platform TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investment_pools ADD COLUMN cycled_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
        -- Merge legacy 'paid_out' status into 'matured' (pools + investments)
        BEGIN UPDATE investment_pools SET status = 'matured' WHERE status = 'paid_out'; EXCEPTION WHEN others THEN NULL; END;
        BEGIN UPDATE investments      SET status = 'matured' WHERE status = 'paid_out'; EXCEPTION WHEN others THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN fica_status TEXT DEFAULT 'pending'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN investor_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN pool_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN instruction_type TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN custom_payout_amount NUMERIC(18,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN submitted_date TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN total_payout NUMERIC(18,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE maturity_instructions ADD COLUMN reinvest_pool_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investments ADD COLUMN switch_product_type TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investments ADD COLUMN custom_payout_amount NUMERIC(18,2); EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE cattle_animals ADD COLUMN dim_tag TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE cattle_animals ADD COLUMN extra_colour_tag TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_holder TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_number TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_branch TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_type TEXT DEFAULT 'current'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_status TEXT DEFAULT 'none'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_reference TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
      END $$
    `);

    // Backfill sa_reference for existing sub-accounts that don't have one
    await pool.query(`
      UPDATE sub_accounts
      SET sa_reference = 'SA-' || UPPER(SUBSTRING(MD5(id) FOR 6))
      WHERE sa_reference IS NULL OR sa_reference = ''
    `).catch(() => {});
    console.log('✅ Investor FICA + gamification columns ready.');

    // 1b2. Seed default products (idempotent — only inserts missing product types)
    await seedProducts();

    // Backfill partner_name for existing products
    await pool.query(`
      UPDATE products SET partner_name = 'Beefcor'            WHERE product_type = 'cattle'                        AND (partner_name IS NULL OR partner_name = '');
      UPDATE products SET partner_name = 'The Solar Experts'  WHERE product_type IN ('solar_7yr','solar_6yr','solar_5yr') AND (partner_name IS NULL OR partner_name = '');
      UPDATE products SET partner_name = 'MoolaLend'          WHERE product_type IN ('short_term','smme')          AND (partner_name IS NULL OR partner_name = '');
    `).catch(() => {});

    // Update short_term key_details to include receivables financing bullet
    await pool.query(`
      UPDATE products
      SET key_details = 'Capital deployed to vetted SMMEs\nReturns from SMME receivables financing & asset-backed loans\nShort investment cycles\nAsset-backed where possible'
      WHERE product_type = 'short_term'
        AND key_details NOT LIKE '%receivables%'
    `).catch(() => {});

    await seedTestimonials();

    // 1c. Performance indexes (each wrapped individually so one failure won't abort the rest)
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_transactions_investor_id ON transactions(investor_id)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_investments_investor_id ON investments(investor_id)',
      'CREATE INDEX IF NOT EXISTS idx_investments_status ON investments(status)',
      'CREATE INDEX IF NOT EXISTS idx_investments_pool_id ON investments(pool_id)',
      'CREATE INDEX IF NOT EXISTS idx_investments_end_date ON investments(end_date)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_investment_id ON transactions(investment_id)',
      'CREATE INDEX IF NOT EXISTS idx_support_tickets_investor_id ON support_tickets(investor_id)',
      'CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)',
      'CREATE INDEX IF NOT EXISTS idx_kyc_documents_investor_id ON kyc_documents(investor_id)',
      'CREATE INDEX IF NOT EXISTS idx_audit_events_actor_id ON audit_events(actor_id)',
      'CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_investors_status ON investors(status)',
      'CREATE INDEX IF NOT EXISTS idx_investors_fica_status ON investors(fica_status)',
      'CREATE INDEX IF NOT EXISTS idx_investment_waitlist_pool_id ON investment_waitlist(pool_id)',
      'CREATE INDEX IF NOT EXISTS idx_investment_waitlist_investor_id ON investment_waitlist(investor_id)',
    ];
    for (const sql of indexes) {
      try {
        await pool.query(sql);
      } catch (idxErr) {
        console.warn('⚠️  Index creation warning:', idxErr.message);
      }
    }
    console.log('✅ Performance indexes ready.');

    // 1d. Upgrade transactions.reference to UNIQUE if the existing index is plain
    // (required so ON CONFLICT (reference) DO NOTHING works in payments.js + interestCron.js)
    try {
      const { rows: idxInfo } = await pool.query(`
        SELECT ix.indisunique FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i  ON i.oid = ix.indexrelid
        WHERE t.relname = 'transactions' AND i.relname = 'idx_transactions_reference'
      `);
      if (!idxInfo[0]?.indisunique) {
        await pool.query('DROP INDEX IF EXISTS idx_transactions_reference');
        await pool.query('CREATE UNIQUE INDEX idx_transactions_reference ON transactions(reference)');
        console.log('✅ transactions.reference index upgraded to UNIQUE.');
      }
    } catch (idxErr) {
      console.warn('⚠️  Could not upgrade transactions.reference to UNIQUE:', idxErr.message);
    }

    // 1e. Repair users.investor_id for accounts where it is null OR points to a
    // non-existent investor record (e.g. stale demo value like 'INV-001').
    // When this is wrong the JWT carries a bad investorId, the server scopes every
    // query to that phantom ID (WHERE 1=0 equivalent), and the portal shows nothing.
    // Runs on every boot; is a no-op once all rows are correct.
    try {
      const { rowCount } = await pool.query(`
        UPDATE users u
        SET    investor_id = i.id
        FROM   investors i
        WHERE  LOWER(u.email) = LOWER(i.email)
          AND  u.role = 'investor'
          AND  (
            u.investor_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM investors WHERE id = u.investor_id)
          )
      `);
      if (rowCount > 0) {
        console.log(`✅ Repaired users.investor_id for ${rowCount} account(s).`);
      }
    } catch (backfillErr) {
      console.warn('⚠️  investor_id repair warning:', backfillErr.message);
    }

    // 2. Ensure the COO account exists — upsert so existing users are never wiped
    const cooPassword = process.env.COO_PASSWORD;
    if (!cooPassword) throw new Error('[setup] COO_PASSWORD env var must be set before seeding the database');

    const { rows: existing } = await pool.query(
      "SELECT id FROM users WHERE email = 'coo@svcapital.co.za' LIMIT 1"
    );

    if (existing.length > 0) {
      const { rows: count } = await pool.query('SELECT COUNT(*) FROM users');
      console.log(`✅ Database already provisioned (${count[0].count} users) — skipping seed.`);
      return;
    }

    // First-time setup: COO account missing — create it without touching other users
    console.log('🌱 Provisioning COO account…');
    const cooHash = await bcrypt.hash(cooPassword, 12);

    await pool.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name)
      VALUES ('coo@svcapital.co.za', $1, 'director', 'COO', 'SV Capital')
      ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        role          = 'director',
        is_active     = true
    `, [cooHash]);

    // 4. Seed investment pools (operational reference data — not personal)
    await pool.query(`
      INSERT INTO investment_pools
        (id, name, product_type, status, target_amount, raised_amount,
         min_investment, annual_rate, term_months, start_date, end_date,
         description, risk_level, investor_count)
      VALUES
        ('POOL-001','Cattle Finance Q1 2024','cattle','closed',2000000,1980000,5000,0.1483,6,
         '2024-01-01','2024-07-01','6-month cattle finance cycle — Limpopo region.','medium',8),
        ('POOL-002','Solar Energy 7-Year','solar','open',5000000,3250000,10000,0.2140,84,
         '2024-03-01','2031-03-01','Premium 7-year solar PPA — guaranteed offtake.','low',12),
        ('POOL-003','SMME Short-Term Q2','smme','open',1000000,870000,1000,0.1392,5,
         '2024-04-01','2024-09-01','Short-term SMME bridge lending.','high',15),
        ('POOL-004','Delivery Bikes Cycle 3','delivery_bikes','open',1500000,1100000,2500,0.1600,12,
         '2024-02-01','2025-02-01','E-commerce delivery fleet.','medium',10),
        ('POOL-005','Cattle Finance Q2 2024','cattle','open',2500000,1200000,5000,0.1500,6,
         '2024-07-01','2025-01-01','Second cattle cycle — Mpumalanga herd.','medium',5),
        ('POOL-006','Solar Energy 5-Year','solar','open',3000000,750000,10000,0.0641,60,
         '2024-06-01','2029-06-01','Community solar energy 5-year PPA.','low',7),
        ('POOL-007','SMME Q3 Batch','smme','open',800000,400000,1000,0.1392,5,
         '2024-08-01','2025-01-01','Q3 SMME lending pool.','high',9),
        ('POOL-008','Solar 6-Year Premium','solar','open',4000000,500000,10000,0.1553,72,
         '2024-09-01','2030-09-01','6-year solar with mid-term liquidity window.','low',3),
        ('POOL-009','Cattle Q3 — Karoo Region','cattle','open',1800000,200000,5000,0.1483,6,
         '2024-10-01','2025-04-01','Karoo region cattle cycle.','medium',2),
        ('POOL-010','Delivery Bikes Cycle 4','delivery_bikes','open',2000000,100000,2500,0.1800,12,
         '2024-11-01','2025-11-01','Expanded fleet — last-mile logistics.','medium',1)
      ON CONFLICT (id) DO NOTHING
    `);

    // 5. Seed platform settings
    await pool.query(`
      INSERT INTO platform_settings (key, value, description) VALUES
        ('platform_name',       'SV Capital',                    'Platform display name'),
        ('company_name',        'SmartVest Financial Services',  'Legal company name'),
        ('fsp_number',          'FSP #52449',                    'FSCA FSP licence number'),
        ('support_email',       'support@svcapital.co.za',       'Support email address'),
        ('min_investment',      '1000',                          'Global minimum investment (ZAR)'),
        ('kyc_required',        'true',                          'KYC required before investment'),
        ('maintenance_mode',    'false',                         'Maintenance mode'),
        ('currency',            'ZAR',                           'Platform currency'),
        ('eva_rate',            '0.15',                          'EVA rate — % of net-VAT upfront fee allocated to the referring employee')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);

    // 6. Seed COO employee record (for team/login.html staff portal access)
    await pool.query(`
      INSERT INTO employees
        (id, first_name, last_name, email, role, level, department,
         status, id_number, avatar_initials, avatar_color, xp_points, hire_date)
      VALUES
        ('EMP-COO-001', 'COO', 'SV Capital', 'coo@svcapital.co.za',
         'CEO', 'executive', 'Executive',
         'active', '0000000009001', 'CO', '#eda5ff', 0, NOW())
      ON CONFLICT (email) DO UPDATE SET
        role = 'CEO', level = 'executive', department = 'Executive',
        status = 'active', id_number = '0000000009001',
        avatar_initials = 'CO', avatar_color = '#eda5ff'
    `);

    // 7. Backfill investments.end_date to match pool's canonical maturity_date.
    //    The portal previously computed end_date client-side (today + term_months),
    //    causing each investor in the same pool to have a different maturity date.
    try {
      const { rowCount } = await pool.query(`
        UPDATE investments i
        SET end_date = ip.maturity_date
        FROM investment_pools ip
        WHERE ip.id = i.pool_id
          AND ip.maturity_date IS NOT NULL
          AND i.status IN ('active', 'waitlist')
          AND (i.end_date IS DISTINCT FROM ip.maturity_date)
      `);
      if (rowCount > 0) console.log(`✅ Backfilled maturity dates for ${rowCount} investment(s).`);
    } catch (bfErr) {
      console.warn('⚠️  Maturity date backfill skipped:', bfErr.message);
    }

    // 8. Backfill cattle_cycles.cycle_start_date from invoice_date.
    //    "Invoice Date_" in the import CSV is the cycle start date — previously
    //    it only populated invoice_date; now we also copy it to cycle_start_date.
    try {
      const { rowCount } = await pool.query(`
        UPDATE cattle_cycles
        SET cycle_start_date = invoice_date
        WHERE invoice_date IS NOT NULL
          AND cycle_start_date IS NULL
      `);
      if (rowCount > 0) console.log(`✅ Backfilled cycle_start_date for ${rowCount} cattle cycle(s).`);
    } catch (bfErr) {
      console.warn('⚠️  Cattle cycle start date backfill skipped:', bfErr.message);
    }

    console.log('✅ Provisioning complete — COO account ready.');

  } catch (err) {
    console.error('❌ Auto-setup error:', err.message);
    // Don't crash the server — log the error and continue
  }
}

module.exports = autoSetup;
