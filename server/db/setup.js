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

DO $$ BEGIN
  ALTER TABLE investors ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE investors ADD COLUMN IF NOT EXISTS street_address TEXT;
  ALTER TABLE investors ADD COLUMN IF NOT EXISTS suburb TEXT;
  ALTER TABLE investors ADD COLUMN IF NOT EXISTS postal_code TEXT;
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

DO $$ BEGIN
  ALTER TABLE investment_pools ADD COLUMN IF NOT EXISTS maturity_summary JSONB;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

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
  BEGIN ALTER TABLE investors ADD COLUMN last_login TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
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
  -- Investor demographic fields for reporting
  BEGIN ALTER TABLE investors ADD COLUMN gender TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
  BEGIN ALTER TABLE investors ADD COLUMN heard_about_us TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
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
  documents_url TEXT, foxess_device_sn TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS solar_projects_status_idx ON solar_projects(status);

CREATE TABLE IF NOT EXISTS solar_investment_periods (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES solar_projects(id) ON DELETE CASCADE,
  product_type TEXT DEFAULT '7yr',
  term_years INT,
  capital_deployed NUMERIC(18,2) DEFAULT 0,
  annual_rate NUMERIC(8,6) DEFAULT 0,
  contracted_return NUMERIC(18,2),
  start_date TIMESTAMPTZ,
  maturity_date TIMESTAMPTZ,
  actual_return NUMERIC(18,2) DEFAULT 0,
  status TEXT DEFAULT 'active',
  notes TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS solar_periods_project_idx ON solar_investment_periods(project_id);

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

CREATE TABLE IF NOT EXISTS invest_funnel_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id      TEXT,
  event_type       TEXT NOT NULL,
  pool_id          TEXT,
  product_type     TEXT,
  stage            TEXT,
  fee_seen         BOOLEAN,
  amount_entered   BOOLEAN,
  amount_bucket    TEXT,
  wallet_bucket    TEXT,
  shortfall_bucket TEXT,
  gateway          TEXT,
  platform         TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ife_investor_idx ON invest_funnel_events(investor_id);
CREATE INDEX IF NOT EXISTS ife_type_idx     ON invest_funnel_events(event_type);
CREATE INDEX IF NOT EXISTS ife_created_idx  ON invest_funnel_events(created_at);

CREATE TABLE IF NOT EXISTS interest_distributions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period              TEXT NOT NULL,
  pim_file_name       TEXT,
  total_interest      NUMERIC(18,2) DEFAULT 0,
  accounts_credited   INT DEFAULT 0,
  accounts_skipped    INT DEFAULT 0,
  accounts_unmatched  INT DEFAULT 0,
  applied_by          TEXT,
  applied_at          TIMESTAMPTZ,
  status              TEXT DEFAULT 'applied',
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS id_period_applied_idx ON interest_distributions(period) WHERE status = 'applied';

CREATE TABLE IF NOT EXISTS interest_distribution_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id   UUID REFERENCES interest_distributions(id) ON DELETE CASCADE,
  sub_account_id    TEXT,
  investor_id       TEXT,
  account_reference TEXT NOT NULL,
  client_name_pim   TEXT,
  pim_balance       NUMERIC(18,2),
  platform_balance  NUMERIC(18,2),
  interest_amount   NUMERIC(18,2),
  transaction_id    TEXT,
  status            TEXT NOT NULL DEFAULT 'applied',
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idi_dist_idx ON interest_distribution_items(distribution_id);
CREATE INDEX IF NOT EXISTS idi_sa_idx   ON interest_distribution_items(sub_account_id);

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
  sector              TEXT,                   -- e.g. "Agriculture", "Energy"
  factsheet_url       TEXT,                   -- base64 data URL or external link
  factsheet_name      TEXT,
  is_active           BOOLEAN DEFAULT true,
  display_on_homepage BOOLEAN DEFAULT true,
  sort_order          INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS products_type_idx ON products(product_type);

-- ── Private Equity Monitor ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pe_companies (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  sector               TEXT NOT NULL,
  sub_sector           TEXT,
  country              TEXT DEFAULT 'South Africa',
  city                 TEXT,
  description          TEXT,
  website              TEXT,
  registration_number  TEXT,
  vat_number           TEXT,
  founded_year         INT,
  employee_count       INT,
  status               TEXT DEFAULT 'portfolio'
                         CHECK (status IN ('prospect','deal_flow','due_diligence','approved','portfolio','exited','declined')),
  aum_amount           NUMERIC(18,2) DEFAULT 0,
  fee_rate             NUMERIC(8,4) DEFAULT 0.02,
  fee_billing_period   TEXT DEFAULT 'annual' CHECK (fee_billing_period IN ('monthly','quarterly','annual')),
  entry_date           DATE,
  exit_date            DATE,
  exit_value           NUMERIC(18,2),
  contact_name         TEXT,
  contact_email        TEXT,
  contact_phone        TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pe_companies_sector_idx ON pe_companies(sector);
CREATE INDEX IF NOT EXISTS pe_companies_status_idx ON pe_companies(status);

CREATE TABLE IF NOT EXISTS pe_deals (
  id                  TEXT PRIMARY KEY,
  company_name        TEXT NOT NULL,
  company_id          TEXT REFERENCES pe_companies(id) ON DELETE SET NULL,
  stage               TEXT NOT NULL DEFAULT 'sourcing'
                        CHECK (stage IN ('sourcing','screening','due_diligence','ic_review','approved','closed','declined','exited')),
  deal_type           TEXT DEFAULT 'equity'
                        CHECK (deal_type IN ('equity','debt','hybrid','mezzanine','convertible')),
  sector              TEXT,
  target_amount       NUMERIC(18,2),
  committed_amount    NUMERIC(18,2) DEFAULT 0,
  deal_description    TEXT,
  investment_thesis   TEXT,
  key_risks           TEXT,
  source              TEXT,
  originator          TEXT,
  assigned_analyst    TEXT,
  sourced_date        DATE,
  screening_date      DATE,
  dd_start_date       DATE,
  ic_date             DATE,
  decision_date       DATE,
  decision_notes      TEXT,
  priority            TEXT DEFAULT 'medium'
                        CHECK (priority IN ('low','medium','high','urgent')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pe_deals_stage_idx    ON pe_deals(stage);
CREATE INDEX IF NOT EXISTS pe_deals_company_idx  ON pe_deals(company_id);
CREATE INDEX IF NOT EXISTS pe_deals_sector_idx   ON pe_deals(sector);

CREATE TABLE IF NOT EXISTS pe_financials (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES pe_companies(id) ON DELETE CASCADE,
  financial_year      INT NOT NULL,
  revenue             NUMERIC(18,2),
  gross_profit        NUMERIC(18,2),
  ebitda              NUMERIC(18,2),
  ebit                NUMERIC(18,2),
  net_profit          NUMERIC(18,2),
  total_assets        NUMERIC(18,2),
  total_liabilities   NUMERIC(18,2),
  equity              NUMERIC(18,2),
  cash                NUMERIC(18,2),
  total_debt          NUMERIC(18,2),
  capex               NUMERIC(18,2),
  operating_cashflow  NUMERIC(18,2),
  free_cashflow       NUMERIC(18,2),
  revenue_growth      NUMERIC(8,4),
  ebitda_margin       NUMERIC(8,4),
  net_margin          NUMERIC(8,4),
  notes               TEXT,
  audited             BOOLEAN DEFAULT false,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, financial_year)
);
CREATE INDEX IF NOT EXISTS pe_financials_company_idx ON pe_financials(company_id, financial_year DESC);

CREATE TABLE IF NOT EXISTS pe_fees (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES pe_companies(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  fee_type        TEXT DEFAULT 'management'
                    CHECK (fee_type IN ('management','performance','transaction','monitoring','other')),
  amount          NUMERIC(18,2) NOT NULL,
  status          TEXT DEFAULT 'projected'
                    CHECK (status IN ('projected','invoiced','paid','overdue','waived')),
  invoice_date    DATE,
  due_date        DATE,
  paid_date       DATE,
  invoice_number  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pe_fees_company_idx ON pe_fees(company_id);
CREATE INDEX IF NOT EXISTS pe_fees_status_idx  ON pe_fees(status);
CREATE INDEX IF NOT EXISTS pe_fees_due_idx     ON pe_fees(due_date);

CREATE TABLE IF NOT EXISTS pe_updates (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES pe_companies(id) ON DELETE CASCADE,
  update_type  TEXT DEFAULT 'general'
                 CHECK (update_type IN ('general','financial','operational','governance','risk','exit')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  author       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pe_updates_company_idx ON pe_updates(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pe_reviews (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES pe_companies(id) ON DELETE CASCADE,
  review_date      DATE NOT NULL,
  next_review_date DATE,
  notes            TEXT,
  attendees        TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pe_reviews_company_idx ON pe_reviews(company_id, review_date DESC);
CREATE INDEX IF NOT EXISTS pe_reviews_next_idx    ON pe_reviews(next_review_date);

-- ── Change Requests & Suggestions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS change_requests (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL,
  submitted_by     TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'other'
                     CHECK (category IN ('feature','bug','process','data','security','ui_ux','other')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (priority IN ('low','medium','high','urgent')),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  expected_impact  TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','reviewing','approved','rejected','implemented')),
  admin_notes      TEXT,
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS change_requests_employee_idx ON change_requests(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS change_requests_status_idx   ON change_requests(status);
CREATE INDEX IF NOT EXISTS change_requests_priority_idx ON change_requests(priority);

CREATE TABLE IF NOT EXISTS change_request_comments (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cr_comments_req_idx ON change_request_comments(request_id, created_at);

CREATE TABLE IF NOT EXISTS change_request_attachments (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT,
  file_data   TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cr_attachments_req_idx ON change_request_attachments(request_id);

CREATE TABLE IF NOT EXISTS cr_events (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('new_request','new_comment','status_change')),
  actor_name  TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS cr_events_created_idx ON cr_events(created_at DESC);

CREATE TABLE IF NOT EXISTS cr_notification_clears (
  employee_id TEXT PRIMARY KEY,
  cleared_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
    product_type: 'cattle_12j', label: '12J Cattle Investment', headline: 'Tax-efficient cattle returns.',
    partner_name: 'Beefcor',
    description: "Section 12J tax-incentivised cattle investment. Partner with Beefcor's feedlot to grow returns while qualifying for a full SARS income tax deduction on invested capital.",
    key_details: [
      'Full SARS Section 12J income tax deduction on invested capital',
      'Cattle enter feedlot at 200–230kg and are raised to 450–500kg',
      'Returns determined by weight gain and market price per kilogram',
      'Beefcor guarantees 99% cattle survival rate',
      'Minimum 5-year holding period for 12J tax benefit',
    ].join('\n'),
    min_investment: 5000, term_months: 60, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Medium-High', risk_color: '#fec24f', icon: 'fa-cow', color: '#fec24f',
    badge_class: 'badge--gold', sort_order: 9,
  },
  {
    product_type: 'ilobola', label: 'iLobola', headline: 'Save for what matters most.',
    description: "A dedicated savings and growth vehicle designed to help you accumulate funds for lobola. Earn competitive returns while working toward one of life's most meaningful milestones.",
    key_details: [
      'Purpose-built savings vehicle for lobola preparation',
      'Competitive fixed returns over a defined term',
      'Flexible contribution amounts',
      'Withdraw at maturity or roll over to a new cycle',
    ].join('\n'),
    min_investment: 500, term_months: 12, benchmark_rate: 0.13, performance_fee_pct: 0.20,
    risk_profile: 'Low-Medium', risk_color: '#22c55e', icon: 'fa-heart', color: '#eda5ff',
    badge_class: 'badge--purple', sort_order: 10,
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
        BEGIN ALTER TABLE investment_pools ADD COLUMN source_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
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
        BEGIN ALTER TABLE sub_accounts ADD COLUMN pim_account_ref TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE products ADD COLUMN sector TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE transactions ADD COLUMN date_updated TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE push_tokens ADD COLUMN app_version TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE push_tokens ADD COLUMN device_name TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE gifts ADD COLUMN gift_card_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE gifts ADD COLUMN product_type TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE gifts ADD COLUMN firebase_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investment_pools ADD COLUMN admin_notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE kyc_documents ADD COLUMN expiry_date DATE; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE kyc_documents ADD COLUMN doc_subtype TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE solar_projects ADD COLUMN documents_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE solar_projects ADD COLUMN foxess_device_sn TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN role_target TEXT DEFAULT 'all'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN department TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN difficulty TEXT DEFAULT 'intermediate'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN estimated_minutes INT DEFAULT 30; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN kpi_dimension TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN kpi_boost_points INT DEFAULT 5; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN modules_count INT DEFAULT 3; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN quiz_questions INT DEFAULT 3; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN pass_score INT DEFAULT 60; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN status TEXT DEFAULT 'active'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN ai_generated BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN learning_objectives TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN thumbnail_icon TEXT DEFAULT 'fa-book'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE employee_courses ADD COLUMN thumbnail_color TEXT DEFAULT '#eda5ff'; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN pim_account_ref TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN fica_reviewed_by TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE investors ADD COLUMN bank_account_reviewed_by TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE transactions ADD COLUMN reviewed_by TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE transactions ADD COLUMN reviewed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END;
        BEGIN ALTER TABLE sub_accounts ADD COLUMN sa_bank_reviewed_by TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
      END $$
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS gifts_firebase_id_idx ON gifts(firebase_id) WHERE firebase_id IS NOT NULL`).catch(() => {});

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

    // Upsert cattle_12j product (safe on existing deployments)
    await pool.query(`
      INSERT INTO products
        (id, product_type, label, headline, description, key_details,
         min_investment, term_months, benchmark_rate, performance_fee_pct,
         risk_profile, risk_color, icon, color, badge_class, partner_name, sort_order)
      VALUES
        ('PROD-CATTLE_12J', 'cattle_12j', '12J Cattle Investment', 'Tax-efficient cattle returns.',
         'Section 12J tax-incentivised cattle investment. Partner with Beefcor''s feedlot to grow returns while qualifying for a full SARS income tax deduction on invested capital.',
         'Full SARS Section 12J income tax deduction on invested capital
Cattle enter feedlot at 200–230kg and are raised to 450–500kg
Returns determined by weight gain and market price per kilogram
Beefcor guarantees 99% cattle survival rate
Minimum 5-year holding period for 12J tax benefit',
         5000, 60, 0.13, 0.20, 'Medium-High', '#fec24f', 'fa-cow', '#fec24f', 'badge--gold', 'Beefcor', 9)
      ON CONFLICT (product_type) DO NOTHING
    `).catch(() => {});

    // Upsert iLobola product (safe on existing deployments)
    await pool.query(`
      INSERT INTO products
        (id, product_type, label, headline, description, key_details,
         min_investment, term_months, benchmark_rate, performance_fee_pct,
         risk_profile, risk_color, icon, color, badge_class, sort_order)
      VALUES
        ('PROD-ILOBOLA', 'ilobola', 'iLobola', 'Save for what matters most.',
         'A dedicated savings and growth vehicle designed to help you accumulate funds for lobola. Earn competitive returns while working toward one of life''s most meaningful milestones.',
         'Purpose-built savings vehicle for lobola preparation
Competitive fixed returns over a defined term
Flexible contribution amounts
Withdraw at maturity or roll over to a new cycle',
         500, 12, 0.13, 0.20, 'Low-Medium', '#22c55e', 'fa-heart', '#eda5ff', 'badge--purple', 10)
      ON CONFLICT (product_type) DO NOTHING
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

    // 2a. Always seed PE portfolio companies (idempotent — ON CONFLICT DO UPDATE)
    try {
      await pool.query(`
        INSERT INTO pe_companies
          (id, name, sector, status, aum_amount, entry_date, description)
        VALUES
          ('peco-hb-svc-2025',       'Hillermann Brothers Properties Proprietary Limited', 'Property',      'portfolio', 300000000, '2025-07-01', 'Property holding company partnered with SV Capital.'),
          ('peco-sas-svc-2025',      'Scientific Aquatic Services Pty Ltd',                'Other',         'portfolio', 1000,       '2025-07-01', 'Aquatic services company partnered with SV Capital.'),
          ('peco-gma-svc-2025',      'GM Associates Proprietary Limited',                  'Other',         'portfolio', 50000000,   '2025-07-01', 'Associates firm partnered with SV Capital.'),
          ('peco-edelsenz-svc-2025', 'EdelSenz Proprietary Limited',                       'Other',         'portfolio', 25000000,   '2025-08-01', 'Technology and services company partnered with SV Capital.'),
          ('peco-steelstudio-svc-2026','New Steel Studio Proprietary Limited',             'Manufacturing', 'portfolio', NULL,       '2026-08-01', 'Steel manufacturing company partnered with SV Capital.')
        ON CONFLICT (id) DO UPDATE SET
          name       = EXCLUDED.name,
          sector     = EXCLUDED.sector,
          status     = EXCLUDED.status,
          aum_amount = EXCLUDED.aum_amount,
          entry_date = EXCLUDED.entry_date,
          description = EXCLUDED.description
      `);
      await pool.query(`
        INSERT INTO pe_fees
          (id, company_id, period_start, period_end, amount, status, due_date, notes)
        VALUES
          ('pefee-hb-2025-07',          'peco-hb-svc-2025',          '2025-07-01','2025-07-31', 10400, 'invoiced', '2025-08-01', 'Monthly management fee — 51% SVC R5304 | 49% partner R5096'),
          ('pefee-sas-2025-07',         'peco-sas-svc-2025',         '2025-07-01','2025-07-31', 40000, 'invoiced', '2025-08-01', 'Monthly management fee — 51% SVC R20400 | 49% partner R19600'),
          ('pefee-gma-2025-07',         'peco-gma-svc-2025',         '2025-07-01','2025-07-31', 40000, 'invoiced', '2025-08-01', 'Monthly management fee — 51% SVC R20400 | 49% partner R19600'),
          ('pefee-edelsenz-2025-08',    'peco-edelsenz-svc-2025',    '2025-08-01','2025-08-31', 6500,  'invoiced', '2025-09-01', 'Monthly management fee — 51% SVC R3315 | 49% partner R3185'),
          ('pefee-steelstudio-2026-08', 'peco-steelstudio-svc-2026', '2026-08-01','2026-08-31', 10500, 'invoiced', '2026-09-01', 'Monthly management fee — 51% SVC R5355 | 49% partner R5145')
        ON CONFLICT (id) DO UPDATE SET
          company_id   = EXCLUDED.company_id,
          period_start = EXCLUDED.period_start,
          period_end   = EXCLUDED.period_end,
          amount       = EXCLUDED.amount,
          status       = EXCLUDED.status,
          due_date     = EXCLUDED.due_date,
          notes        = EXCLUDED.notes
      `);
      console.log('✅ PE portfolio companies seeded.');
    } catch (peErr) {
      console.warn('⚠️  PE portfolio seed warning:', peErr.message);
    }

    // 2b-pre. Seed standard SV Capital courses (idempotent — ON CONFLICT DO NOTHING)
    await seedStandardCourses(pool);

    // 2b. Ensure change_requests app key is in every employee's app_access array
    try {
      await pool.query(`
        UPDATE employees
        SET app_access = array_append(app_access, 'change_requests')
        WHERE app_access IS NOT NULL
          AND NOT (app_access @> ARRAY['change_requests']::TEXT[])
      `);
      console.log('✅ change_requests app access ensured for all employees.');
    } catch (crErr) {
      console.warn('⚠️  change_requests access patch warning:', crErr.message);
    }

    // 2c. Grant moolalend access to CEOs, Finance Managers, and Executives
    try {
      await pool.query(`
        UPDATE employees
        SET app_access = array_append(app_access, 'moolalend')
        WHERE app_access IS NOT NULL
          AND NOT (app_access @> ARRAY['moolalend']::TEXT[])
          AND (level = 'executive' OR role IN ('CEO', 'Finance Manager'))
      `);
      console.log('✅ moolalend app access granted to eligible employees.');
    } catch (mlErr) {
      console.warn('⚠️  moolalend access patch warning:', mlErr.message);
    }

    // 2d. Migrate change_requests.id from UUID to TEXT if created before fix
    try {
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'change_requests'
              AND column_name = 'id'
              AND data_type = 'uuid'
          ) THEN
            ALTER TABLE change_requests ALTER COLUMN id TYPE TEXT;
          END IF;
        END $$;
      `);
    } catch (migrErr) {
      console.warn('⚠️  change_requests id migration warning:', migrErr.message);
    }

    // 2. Ensure the COO account exists — upsert so existing users are never wiped
    const { rows: existing } = await pool.query(
      "SELECT id FROM users WHERE email = 'coo@svcapital.co.za' LIMIT 1"
    );

    if (existing.length > 0) {
      const { rows: count } = await pool.query('SELECT COUNT(*) FROM users');
      console.log(`✅ Database already provisioned (${count[0].count} users) — skipping seed.`);
      return;
    }

    // First-time setup: COO account missing — password required
    const cooPassword = process.env.COO_PASSWORD;
    if (!cooPassword) throw new Error('[setup] COO_PASSWORD env var must be set before seeding the database');

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
        ('eva_rate',            '0.15',                          'EVA rate — % of net-VAT upfront fee allocated to the referring employee'),
        ('resend_emails_enabled','true',                         'Set to false to suppress all outbound Resend emails (maintenance / testing)')
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

    // 8. Migrate product_type 'smme' → 'short_term' everywhere.
    //    SMME products are now unified under the Short Term Investment type.
    //    Safe to run repeatedly — WHERE clause prevents no-op re-runs.
    try {
      const { rowCount: poolRows } = await pool.query(`
        UPDATE investment_pools SET product_type = 'short_term' WHERE product_type = 'smme'
      `);
      const { rowCount: invRows } = await pool.query(`
        UPDATE investments SET product_type = 'short_term' WHERE product_type = 'smme'
      `);
      const { rowCount: prodRows } = await pool.query(`
        UPDATE products SET product_type = 'short_term' WHERE product_type = 'smme'
      `).catch(() => ({ rowCount: 0 }));
      const total = poolRows + invRows + prodRows;
      if (total > 0) console.log(`✅ Migrated smme→short_term: ${poolRows} pools, ${invRows} investments, ${prodRows} products.`);
    } catch (bfErr) {
      console.warn('⚠️  smme→short_term migration skipped:', bfErr.message);
    }

    // 9. Backfill cattle_cycles.cycle_start_date from invoice_date.
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

    // 10. Fix Bike Fleet Investment 22 maturity date (UTC save bug: 31 Jul stored as 30 Jul).
    //     Corrects the pool and propagates to all active investments in that pool.
    try {
      const { rowCount: poolFix } = await pool.query(`
        UPDATE investment_pools
           SET maturity_date = '2026-07-31', updated_at = NOW()
         WHERE name ILIKE '%Bike Fleet Investment 22%'
           AND maturity_date = '2026-07-30'
      `);
      if (poolFix > 0) {
        const { rowCount: invFix } = await pool.query(`
          UPDATE investments i
             SET end_date = '2026-07-31', updated_at = NOW()
            FROM investment_pools ip
           WHERE ip.id = i.pool_id
             AND ip.name ILIKE '%Bike Fleet Investment 22%'
             AND i.end_date = '2026-07-30'
        `);
        console.log(`✅ Fixed Bike Fleet Investment 22 maturity date: ${poolFix} pool(s), ${invFix} investment(s).`);
      }
    } catch (bfErr) {
      console.warn('⚠️  Bike Fleet Investment 22 maturity fix skipped:', bfErr.message);
    }

    console.log('✅ Provisioning complete — COO account ready.');

  } catch (err) {
    console.error('❌ Auto-setup error:', err.message);
    // Don't crash the server — log the error and continue
  }
}

/* ─────────────────────────────────────────────────────────────
   Standard SV Capital course library — seeded once, idempotent
───────────────────────────────────────────────────────────── */
const STANDARD_COURSES = [
  {
    id: 'CRS-OB-001',
    title: 'Welcome to SV Capital',
    description: 'An introduction to SV Capital\'s mission, values, culture, and the team structure that powers our growth. Every new team member completes this first.',
    category: 'company_culture', difficulty: 'beginner', estimated_minutes: 40,
    xp_reward: 150, role_target: 'all', kpi_dimension: 'team_collaboration',
    kpi_boost_points: 8, modules_count: 3, quiz_questions: 3, pass_score: 60,
    is_required: true, thumbnail_icon: 'fa-building', thumbnail_color: '#eda5ff',
    learning_objectives: 'Understand SV Capital\'s mission and products, know how the EVA pool works, and explain our values to a client.',
    modules: [
      {
        module_index: 1, title: 'Our Mission, Vision & Values', estimated_minutes: 12, xp_reward: 45,
        content: `<h3>Why SV Capital Exists</h3><p>SV Capital was founded with a clear purpose: to give everyday South Africans access to the same alternative investment opportunities historically reserved for the ultra-wealthy. We connect retail investors with cattle farming, renewable energy, and short-term lending deals — asset classes that produce real, tangible returns.</p><h3>Our Core Values</h3><ul><li><strong>Transparency</strong> — every investor knows exactly where their money is and what it's earning</li><li><strong>Accountability</strong> — we own our results, celebrate wins honestly, and fix mistakes fast</li><li><strong>Growth</strong> — we invest in our clients' futures and in each other's careers</li><li><strong>Integrity</strong> — we are FSCA-regulated under FAIS and hold ourselves to the highest standard</li></ul><h3>What This Means for You</h3><p>Every action you take — a client call, an email, a data entry — either builds or erodes trust. Our values aren't wall art; they're the standard by which we measure every decision.</p>`,
        key_points: ['SV Capital democratises access to alternative investments for South African retail investors','Our four core values are Transparency, Accountability, Growth, and Integrity','We are FSCA-regulated under FAIS — compliance is non-negotiable','Everything you do either builds or erodes client trust','Your daily work directly contributes to growing AUM and the EVA pool'],
        quiz: [
          { question: 'What is SV Capital\'s primary purpose?', options: ['To serve only HNW individuals', 'To give retail investors access to alternative investments', 'To compete with JSE-listed funds', 'To provide banking services'], correct: 1, explanation: 'SV Capital\'s founding mission is democratising access to asset classes like cattle, solar, and short-term lending for everyday South Africans.' },
          { question: 'Which regulatory body oversees SV Capital?', options: ['SARB', 'JSE', 'FSCA under FAIS', 'National Treasury'], correct: 2, explanation: 'We are regulated by the FSCA (Financial Sector Conduct Authority) under the FAIS Act — this governs how we advise and interact with clients.' },
          { question: 'Which of the following best reflects the SV Capital value of Accountability?', options: ['Escalating all mistakes to management immediately', 'Owning results, celebrating wins honestly, and fixing mistakes fast', 'Never admitting errors to clients', 'Passing responsibility to other departments'], correct: 1, explanation: 'Accountability means owning outcomes at every level — not just when things go right.' },
        ],
      },
      {
        module_index: 2, title: 'How SV Capital Makes Money', estimated_minutes: 15, xp_reward: 53,
        content: `<h3>Our Three Investment Pillars</h3><p>SV Capital generates returns through three core asset classes. Understanding these is essential — you'll discuss them with clients daily.</p><h3>1. Cattle Farming Investments</h3><p>We finance cattle farming cycles with farmers across Limpopo, Mpumalanga, and the Free State. Investors earn returns when cattle are sold at market. Typical cycle: 5–8 months. Target return: 14–17% per annum. Risk: medium — hedged through insurance and experienced farming partners.</p><h3>2. Solar Energy Projects</h3><p>We raise capital for commercial solar installations with signed Power Purchase Agreements (PPAs). Investors earn long-term, inflation-linked returns over 5–7 year terms. Target return: 6–21% per annum depending on structure. Risk: low — government-backed offtake agreements.</p><h3>3. Short-Term Lending</h3><p>We provide bridge lending to SMMEs and private borrowers. Shorter terms (3–6 months), higher returns (13–16% per annum). Risk: higher, managed through credit assessment and collateral requirements.</p><h3>The AUM Equation</h3><p>Assets Under Management (AUM) is the most important number in our business. More AUM means more fee income, more EVA pool to share, and more capacity to hire and grow. Every investment we facilitate, every client we retain, directly grows AUM.</p>`,
        key_points: ['Our three pillars are cattle farming, solar energy, and short-term lending', 'Cattle cycles run 5–8 months with 14–17% target returns', 'Solar projects are long-term (5–7 years) with stable PPA-backed returns', 'Short-term lending offers higher returns with higher managed risk', 'AUM growth is the north-star metric — everything traces back to it'],
        quiz: [
          { question: 'Which SV Capital product typically has the longest investment term?', options: ['Short-term lending', 'Cattle farming', 'Solar energy projects', 'Bridge lending'], correct: 2, explanation: 'Solar projects are structured over 5–7 years with Power Purchase Agreements providing stable, long-term cashflows.' },
          { question: 'What does AUM stand for and why does it matter?', options: ['Accounts Under Management — it determines headcount', 'Assets Under Management — it drives fee income and the EVA pool', 'Annual Utility Measure — a compliance KPI', 'Allocated Unit Model — a pricing methodology'], correct: 1, explanation: 'AUM (Assets Under Management) is the total value of client investments we manage. More AUM = more revenue = larger EVA pool for the team.' },
          { question: 'Which product carries the highest risk profile at SV Capital?', options: ['Solar energy', 'Cattle farming', 'Short-term lending', 'Government bonds'], correct: 2, explanation: 'Short-term lending to SMMEs carries the highest risk, managed through credit assessments and collateral — hence the higher returns.' },
        ],
      },
      {
        module_index: 3, title: 'Your Role in Our Growth Story', estimated_minutes: 13, xp_reward: 52,
        content: `<h3>The EVA Pool — How You Benefit</h3><p>Economic Value Added (EVA) is the profit SV Capital generates after covering all costs. A portion of this is shared with the team through the EVA pool. The split: <strong>60% is distributed based on individual KPI scores</strong>, and <strong>40% based on collective team performance</strong>. This means your personal KPIs directly affect your payout — and your collaboration affects everyone's.</p><h3>Your 8 KPI Dimensions</h3><p>You are scored monthly across 8 dimensions: Revenue Contribution, Client Satisfaction, Task Completion, Response Time, Compliance, Innovation, Team Collaboration, and Attendance. These aren't abstract — each ties to a real behaviour that grows the business.</p><h3>OKRs: Your Personal Roadmap</h3><p>Beyond KPIs, you set quarterly Objectives and Key Results (OKRs). These are ambitious goals that push you beyond the baseline. Strong OKR completion is a signal for promotion consideration.</p><h3>Growing Together</h3><p>SV Capital promotes from within. The fastest route to Lead, Senior, or Executive level is consistent KPI performance, strong OKRs, high peer feedback scores, and demonstrated leadership — which starts by completing this onboarding and contributing immediately.</p>`,
        key_points: ['The EVA pool is split 60% individual KPI-weighted, 40% collective team performance', 'You are scored monthly across 8 KPI dimensions', 'OKRs are quarterly personal goals that drive promotion consideration', 'SV Capital promotes from within — performance is the path', 'Your learning directly boosts KPI scores through course completion bonuses'],
        quiz: [
          { question: 'How is the SV Capital EVA pool distributed?', options: ['Equally among all staff', '100% based on seniority', '60% individual KPI-weighted, 40% collective team performance', '80% to leadership, 20% to staff'], correct: 2, explanation: 'The 60/40 split incentivises both personal excellence and team collaboration — the two pillars of SV Capital\'s culture.' },
          { question: 'How many KPI dimensions are you scored on monthly?', options: ['4', '6', '8', '10'], correct: 2, explanation: 'The 8 dimensions are: Revenue Contribution, Client Satisfaction, Task Completion, Response Time, Compliance, Innovation, Team Collaboration, and Attendance.' },
          { question: 'What is the primary pathway to promotion at SV Capital?', options: ['Tenure — time with the company', 'Consistent KPI performance, OKRs, peer feedback, and leadership behaviour', 'Academic qualifications only', 'Being assigned to senior projects'], correct: 1, explanation: 'SV Capital promotes from within based on demonstrated performance, not seniority. Strong KPIs, OKRs, and peer feedback are the signal.' },
        ],
      },
    ],
  },
  {
    id: 'CRS-OB-002',
    title: 'Investment Products Deep Dive',
    description: 'A thorough walkthrough of each SV Capital investment product — returns, risk, timelines, and how to discuss them confidently with investors.',
    category: 'products', difficulty: 'intermediate', estimated_minutes: 55,
    xp_reward: 200, role_target: 'all', kpi_dimension: 'revenue_contribution',
    kpi_boost_points: 10, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-chart-pie', thumbnail_color: '#fec24f',
    learning_objectives: 'Explain each product\'s mechanics, risk, and return profile to a prospective investor and match the right product to a client\'s needs.',
    modules: [
      {
        module_index: 1, title: 'Cattle Farming & Agricultural Finance', estimated_minutes: 18, xp_reward: 60,
        content: `<h3>How the Cattle Cycle Works</h3><p>SV Capital finances cattle acquisition and fattening cycles with vetted farming partners. Investors' capital is pooled into a farming tranche; when the herd is sold at market, returns are distributed proportionally. The typical cycle runs <strong>5–8 months</strong>.</p><h3>The Numbers</h3><ul><li>Target return: <strong>14–17% per annum</strong> (prorated for the cycle length)</li><li>Minimum investment: <strong>R5 000</strong></li><li>Risk level: <strong>Medium</strong></li><li>Collateral: Livestock insurance + farming partner guarantees</li></ul><h3>Risk Management</h3><p>All herds are insured against death, disease, and theft. We partner only with experienced, accredited farmers with proven track records. SV Capital monitors herd health and market conditions throughout the cycle.</p><h3>Client Conversation Guide</h3><p>When discussing cattle farming with clients, emphasise: (1) the tangible nature of the asset — real animals with insurance, (2) the short-term liquidity cycle — 5–8 months is accessible, (3) the return premium over traditional savings — 14–17% vs 8–10% from banks.</p>`,
        key_points: ['Cattle cycles run 5–8 months with 14–17% per annum target returns', 'Minimum investment is R5 000', 'All herds are insured against death, disease, and theft', 'We only partner with accredited, experienced farmers', 'Emphasise: tangible asset, short cycle, return premium over banks'],
        quiz: [
          { question: 'What is the typical duration of a SV Capital cattle farming cycle?', options: ['1–2 months', '3–4 months', '5–8 months', '12–18 months'], correct: 2, explanation: 'Cattle farming cycles typically run 5–8 months from acquisition to sale, making them attractive medium-term investments.' },
          { question: 'What is the minimum investment amount for SV Capital cattle farming products?', options: ['R1 000', 'R2 500', 'R5 000', 'R10 000'], correct: 2, explanation: 'The minimum investment for cattle farming is R5 000, keeping it accessible while maintaining viable pool sizes.' },
          { question: 'Which risk mitigation is applied to all cattle farming investments?', options: ['Government guarantees', 'Livestock insurance covering death, disease, and theft', 'Capital protection from SV Capital reserves', 'JSE-listed bond backing'], correct: 1, explanation: 'All cattle herds are insured against the primary risks — death, disease, and theft — as the core risk mitigation tool.' },
        ],
      },
      {
        module_index: 2, title: 'Solar Energy & Renewable Investments', estimated_minutes: 20, xp_reward: 70,
        content: `<h3>The Solar Opportunity</h3><p>South Africa's electricity crisis has created a powerful tailwind for commercial solar investments. SV Capital finances commercial-scale solar installations — factories, farms, and municipalities — that have signed <strong>Power Purchase Agreements (PPAs)</strong> guaranteeing electricity offtake for 5–7 years.</p><h3>Product Variants</h3><ul><li><strong>Solar 5-Year:</strong> 6–8% per annum — lower risk, shorter term, ideal for conservative investors</li><li><strong>Solar 7-Year:</strong> 18–21% per annum — higher return, infrastructure scale, ideal for growth-focused investors</li><li><strong>Grid Farmer Program:</strong> Co-ownership of distributed solar assets across the SV Capital portfolio</li></ul><h3>Why Solar is Low Risk</h3><p>PPAs are legally binding contracts between the solar operator and the energy buyer. The buyer is contractually obligated to purchase electricity at a fixed price — this creates predictable, recurring cashflows that underpin investor returns. We only fund projects with signed PPAs and creditworthy offtakers.</p><h3>Client Fit</h3><p>Solar suits investors with a longer horizon (5–7 years) who want stable, inflation-linked returns with the added benefit of contributing to South Africa's energy transition. Ideal for retirement-planning investors or those building a passive income base.</p>`,
        key_points: ['Solar investments are backed by signed Power Purchase Agreements (PPAs)', '5-Year Solar offers 6–8% p.a.; 7-Year Solar offers 18–21% p.a.', 'PPA creates predictable cashflows — this is the core risk mitigation', 'Suitable for investors with 5–7 year horizons', 'Solar investments contribute to South Africa\'s energy transition'],
        quiz: [
          { question: 'What is a Power Purchase Agreement (PPA) and why is it important?', options: ['A government subsidy for solar', 'A legally binding contract guaranteeing electricity offtake at a fixed price', 'An insurance policy for solar panels', 'A bank guarantee on returns'], correct: 1, explanation: 'A PPA is a legally binding contract where the buyer agrees to purchase electricity at a fixed price — this predictable cashflow underpins solar investment returns.' },
          { question: 'Which SV Capital solar product offers the highest returns?', options: ['Solar 5-Year at 6–8% p.a.', 'Grid Farmer Program', 'Solar 7-Year at 18–21% p.a.', 'Both are identical'], correct: 2, explanation: 'The 7-Year Solar product offers 18–21% p.a. — higher than the 5-Year due to longer lock-in and infrastructure scale.' },
          { question: 'Which investor profile is best suited to solar energy products?', options: ['Investors needing money within 12 months', 'Investors with 5–7 year horizons seeking stable returns', 'Speculative investors seeking 50%+ returns', 'Investors who only want JSE-listed assets'], correct: 1, explanation: 'Solar suits investors with a 5–7 year horizon who want stable, PPA-backed returns — ideal for retirement planning or building passive income.' },
        ],
      },
      {
        module_index: 3, title: 'Short-Term Lending & Fixed Returns', estimated_minutes: 17, xp_reward: 70,
        content: `<h3>Our Lending Products</h3><p>SV Capital's short-term lending arm provides bridge capital to SMMEs and individuals who cannot access conventional bank credit quickly enough. Loan terms run <strong>3–6 months</strong> with monthly interest payments. Target investor return: <strong>13–16% per annum</strong>.</p><h3>Credit Assessment Process</h3><p>Every loan application goes through our internal credit committee. We assess: business cashflow, repayment history, collateral availability, and sector risk. Only applications meeting our threshold are funded — this discipline is what protects investor capital.</p><h3>Risk Profile & Management</h3><ul><li>Risk level: <strong>Higher</strong> than cattle or solar</li><li>Mitigation: Collateral requirements, credit scoring, portfolio diversification</li><li>No single loan may exceed 15% of a pool — concentration risk is managed structurally</li><li>Investors are warned of the higher risk in disclosure documents</li></ul><h3>Disclosure Obligations (FAIS)</h3><p>Under FAIS, you must disclose the risk profile of this product clearly before any investor commits. Short-term lending must be positioned as higher-risk, higher-reward — never sold as "safe" or "guaranteed". Document every disclosure in writing.</p>`,
        key_points: ['Short-term lending runs 3–6 months at 13–16% p.a. target returns', 'All loans go through a credit committee assessment before funding', 'Risk is higher than cattle or solar — must be disclosed under FAIS', 'No single loan exceeds 15% of a pool — concentration risk managed structurally', 'Always disclose risk profile in writing before a client commits'],
        quiz: [
          { question: 'What is the typical loan term for SV Capital short-term lending products?', options: ['1–2 weeks', '1–3 months', '3–6 months', '12–24 months'], correct: 2, explanation: 'Short-term lending products run 3–6 months, offering faster liquidity than cattle or solar while delivering 13–16% p.a. returns.' },
          { question: 'Under FAIS, what must you do before a client invests in short-term lending?', options: ['Nothing — returns speak for themselves', 'Disclose the higher risk profile in writing', 'Get approval from the CEO', 'Only explain the returns, not the risks'], correct: 1, explanation: 'FAIS requires clear, written disclosure of a product\'s risk profile before a client commits. Short-term lending must be presented as higher-risk, never "safe" or "guaranteed".' },
          { question: 'Why is no single loan allowed to exceed 15% of a pool?', options: ['To comply with tax requirements', 'To manage concentration risk and protect investor capital', 'To limit company exposure to any one sector', 'To meet reserve ratio requirements'], correct: 1, explanation: 'Capping individual loan exposure at 15% of the pool prevents a single default from significantly impacting the whole investor pool — a core risk management principle.' },
        ],
      },
    ],
  },
  {
    id: 'CRS-OB-003',
    title: 'FAIS & FSCA Compliance Essentials',
    description: 'The regulatory framework every SV Capital team member must understand. Covers FAIS obligations, KYC/FICA requirements, and how we protect our clients and our licence.',
    category: 'compliance', difficulty: 'intermediate', estimated_minutes: 50,
    xp_reward: 200, role_target: 'all', kpi_dimension: 'compliance_score',
    kpi_boost_points: 12, modules_count: 3, quiz_questions: 3, pass_score: 80,
    is_required: true, thumbnail_icon: 'fa-shield-halved', thumbnail_color: '#22c55e',
    learning_objectives: 'Identify FAIS obligations when communicating with clients, complete a KYC/FICA verification correctly, and flag potential AML red flags to the compliance team.',
    modules: [
      {
        module_index: 1, title: 'What FAIS Requires of Us', estimated_minutes: 18, xp_reward: 60,
        content: `<h3>The Financial Advisory and Intermediary Services Act</h3><p>FAIS (Act 37 of 2002) governs how financial services providers in South Africa advise clients and render intermediary services. SV Capital holds an FSP licence — this licence is our permission to operate. Losing it means losing the business.</p><h3>Key Obligations Under FAIS</h3><ul><li><strong>Fit and Proper:</strong> All representatives must be competent and have the required qualifications</li><li><strong>Disclosure:</strong> We must disclose who we are, our remuneration, and product risks before any advice is given</li><li><strong>Suitability:</strong> We must ensure any investment recommended is appropriate for the client's risk profile and financial situation</li><li><strong>Record-Keeping:</strong> All advice must be documented and records kept for 5 years</li></ul><h3>What This Means in Practice</h3><p>Never promise specific returns to a client. Never describe a product as "safe" without qualifying it. Always provide the Key Information Document (KID) before a client invests. If a client asks for advice beyond your scope, escalate to a licensed representative immediately.</p>`,
        key_points: ['FAIS Act 37 of 2002 governs all financial advisory and intermediary services', 'SV Capital\'s FSP licence allows us to operate — protecting it is everyone\'s job', 'Key obligations: Disclosure, Suitability, Record-Keeping, Fit and Proper', 'Never promise specific returns or describe any product as "safe" without qualification', 'All advice must be documented and records kept for 5 years'],
        quiz: [
          { question: 'What does FAIS stand for?', options: ['Financial Assets and Investment Scheme', 'Financial Advisory and Intermediary Services Act', 'Formal Advice and Investment Standards', 'Financial Authorisation and Investor Safeguard'], correct: 1, explanation: 'FAIS stands for Financial Advisory and Intermediary Services Act (Act 37 of 2002) — the primary legislation governing SV Capital\'s advisory activities.' },
          { question: 'How long must SV Capital keep records of financial advice given to clients?', options: ['1 year', '2 years', '5 years', '10 years'], correct: 2, explanation: 'FAIS requires records of all advice to be kept for a minimum of 5 years. This enables regulatory audits and client dispute resolution.' },
          { question: 'A client asks you to "just tell them" which product is the best investment right now. What should you do?', options: ['Recommend the highest-returning product', 'Refuse to engage entirely', 'Assess their risk profile first and only recommend a suitable product with proper disclosure', 'Pass them to someone else without explanation'], correct: 2, explanation: 'FAIS requires that any recommendation be suitable for the client\'s risk profile and circumstances, and that all relevant disclosures are made. Suitability before recommendation.' },
        ],
      },
      {
        module_index: 2, title: 'KYC, FICA & Client Verification', estimated_minutes: 17, xp_reward: 70,
        content: `<h3>Know Your Client (KYC)</h3><p>KYC is the process of verifying who our clients are before they invest. This is both a FICA requirement and a core risk management practice. At SV Capital, KYC is completed digitally through our investor portal — but you need to understand what's required and why.</p><h3>Required FICA Documents</h3><ul><li><strong>Identity verification:</strong> SA ID document or passport (both sides)</li><li><strong>Proof of address:</strong> Utility bill or bank statement, not older than 3 months</li><li><strong>Source of funds:</strong> Payslip, bank statement, or letter of employment for initial investments over R25 000</li></ul><h3>The Verification Process</h3><p>Once documents are uploaded, our compliance team verifies against SARS, Home Affairs, and our internal credit-check systems. Status moves from Pending → Submitted → Approved/Rejected. Clients cannot invest until their FICA status is Approved.</p><h3>Why This Protects Everyone</h3><p>FICA compliance prevents us from being used for money laundering, fraud, or terrorism financing. If SV Capital processes funds from a sanctioned person or entity, we face criminal liability and licence revocation. KYC isn't admin — it's our shield.</p>`,
        key_points: ['KYC is required under FICA before any client can invest', 'Required documents: SA ID/passport, proof of address (under 3 months), source of funds', 'FICA status must reach Approved before a client can invest', 'Verification uses SARS, Home Affairs, and internal systems', 'KYC prevents money laundering, fraud, and terrorism financing — protecting the licence'],
        quiz: [
          { question: 'What proof of address document is acceptable for FICA verification?', options: ['A handwritten letter from the client', 'A utility bill or bank statement not older than 3 months', 'A lease agreement from any year', 'A social media profile showing the client\'s address'], correct: 1, explanation: 'FICA requires a utility bill or bank statement dated within the last 3 months — this proves current residency and is recent enough to be reliable.' },
          { question: 'What happens if a client\'s FICA status is still Pending?', options: ['They can invest with a smaller amount', 'They must wait — clients cannot invest until FICA status is Approved', 'A team member can override the status', 'They need to contact their bank'], correct: 1, explanation: 'FICA compliance is a hard gate. No investment can be processed until the client\'s KYC documents are verified and their status is Approved.' },
          { question: 'Why is FICA compliance critical for SV Capital specifically?', options: ['It increases our returns', 'It prevents SV Capital from being used for money laundering or fraud, protecting our FSP licence', 'It is optional but recommended', 'It only applies to investments over R1 million'], correct: 1, explanation: 'Processing funds from a sanctioned or fraudulent source exposes SV Capital to criminal liability and FSP licence revocation. FICA is our legal and reputational shield.' },
        ],
      },
      {
        module_index: 3, title: 'Anti-Money Laundering & Red Flags', estimated_minutes: 15, xp_reward: 70,
        content: `<h3>What is Money Laundering?</h3><p>Money laundering is the process of making illegally obtained funds appear legitimate. South Africa's Financial Intelligence Centre Act (FICA) requires all financial institutions — including SV Capital — to implement AML controls and report suspicious activity to the FIC.</p><h3>Red Flags to Watch For</h3><ul><li>A client insists on paying cash or through an untraceable method</li><li>Investment amounts are suspiciously round or structured to fall just below reporting thresholds</li><li>The client cannot explain the source of their funds or gives inconsistent answers</li><li>A third party wants to invest on behalf of the client with no explanation</li><li>The client shows unusual urgency to complete a transaction without completing KYC</li></ul><h3>What to Do if You Spot a Red Flag</h3><p>Do not confront the client. Do not complete the transaction. Report the concern immediately to your line manager or the Compliance Officer. Log the interaction in writing. SV Capital has a legal obligation to file a Suspicious Transaction Report (STR) with the FIC within 15 days of identification.</p><h3>Tipping Off is a Crime</h3><p>Once a suspicious transaction report has been filed, you are legally prohibited from telling the client that a report was made. This is known as "tipping off" and is a criminal offence under FICA.</p>`,
        key_points: ['Money laundering is disguising illegal funds as legitimate — SV Capital must actively prevent it', 'Watch for: cash insistence, round amounts, third-party payers, unexplained urgency', 'Never confront the client — report to your line manager or Compliance Officer', 'SV Capital must file a Suspicious Transaction Report (STR) within 15 days of identification', 'Telling a client they\'ve been reported ("tipping off") is a criminal offence under FICA'],
        quiz: [
          { question: 'A client insists on paying cash for a R50 000 investment and becomes aggressive when asked about the source of funds. What do you do?', options: ['Process the transaction to avoid conflict', 'Ask a colleague to handle it instead', 'Do not complete the transaction — report it to the Compliance Officer immediately', 'Request an ID document and continue'], correct: 2, explanation: 'Insisting on cash payment and inability to explain source of funds are classic AML red flags. Do not complete the transaction and report it to the Compliance Officer.' },
          { question: 'Within how many days must SV Capital file a Suspicious Transaction Report (STR)?', options: ['5 days', '10 days', '15 days', '30 days'], correct: 2, explanation: 'FICA requires financial institutions to file an STR with the Financial Intelligence Centre within 15 days of identifying a suspicious transaction.' },
          { question: 'After an STR has been filed, what is prohibited by law?', options: ['Processing further transactions with the client', 'Telling the client that a report was filed (tipping off)', 'Discussing the report with your manager', 'Keeping a written record of the interaction'], correct: 1, explanation: '"Tipping off" — informing a client that a suspicious transaction report has been filed against them — is a criminal offence under FICA.' },
        ],
      },
    ],
  },
  {
    id: 'CRS-FIN-001',
    title: 'Financial Reconciliation & Reporting',
    description: 'A practical guide to SV Capital\'s reconciliation processes — matching deposits to wallets, identifying discrepancies, and producing accurate financial reports.',
    category: 'finance', difficulty: 'intermediate', estimated_minutes: 45,
    xp_reward: 180, role_target: 'staff', kpi_dimension: 'task_completion_rate',
    kpi_boost_points: 8, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: false, thumbnail_icon: 'fa-scale-balanced', thumbnail_color: '#60a5fa',
    learning_objectives: 'Perform a wallet reconciliation, identify and escalate discrepancies, and produce a clean reconciliation report for the weekly finance review.',
    modules: [
      {
        module_index: 1, title: 'Understanding Our Reconciliation Process', estimated_minutes: 15, xp_reward: 54,
        content: `<h3>What We Reconcile and Why</h3><p>Reconciliation is the process of verifying that our internal wallet balances match actual deposits and investment activity. At SV Capital, we reconcile three things: <strong>investor wallet balances</strong> against transaction history, <strong>investment amounts</strong> against pool raised totals, and <strong>bank statements</strong> against recorded deposits.</p><h3>The Three-Source Rule</h3><p>Every rand must be traceable through three sources: (1) the investor's transaction record, (2) the investment pool record, and (3) the bank statement or payment gateway confirmation. If any of these three don't align, we have a discrepancy.</p><h3>The Admin Console Reconciliation Tab</h3><p>The SV Capital admin panel has a dedicated Reconciliation tab showing every investor's: total deposits, total invested, wallet balance, expected wallet, variance, and status. A "Discrepancy" flag means the wallet balance doesn't match what the transaction history predicts. Your job is to investigate and resolve.</p><h3>Common Causes of Discrepancies</h3><ul><li>Payment gateway (Paystack/Ozow) fees deducted before crediting</li><li>EFT deposits not yet matched to an investor account</li><li>Duplicate transaction entries from system errors</li><li>Manual credits applied without corresponding transaction records</li></ul>`,
        key_points: ['Reconciliation verifies wallet balances match deposits and investment activity', 'The three-source rule: transaction record, pool record, and bank statement must all align', 'Use the Admin Console Reconciliation tab as your primary reconciliation tool', 'A variance > R1.00 flags a discrepancy requiring investigation', 'Common causes: gateway fees, unmatched EFTs, duplicate entries, unrecorded manual credits'],
        quiz: [
          { question: 'What does a "Discrepancy" flag on the Reconciliation tab mean?', options: ['The investor hasn\'t completed KYC', 'The wallet balance doesn\'t match what the transaction history predicts', 'The investor has overdue investments', 'A payment is pending approval'], correct: 1, explanation: 'A Discrepancy flag means the investor\'s current wallet balance doesn\'t match the expected balance calculated from their transaction history. This requires investigation.' },
          { question: 'What is the "three-source rule" in reconciliation?', options: ['Every reconciliation must be approved by three managers', 'Every transaction must be traceable through the transaction record, pool record, and bank statement', 'Three team members must sign off on every credit', 'Every discrepancy requires three attempts to resolve before escalation'], correct: 1, explanation: 'Every rand must trace through: (1) the investor transaction record, (2) the investment pool record, and (3) the bank statement or gateway confirmation.' },
          { question: 'What is the minimum variance amount that triggers a discrepancy flag?', options: ['R0.01', 'R1.00', 'R10.00', 'R100.00'], correct: 1, explanation: 'A variance greater than R1.00 is flagged as a discrepancy. This tolerance accounts for rounding differences while catching genuine reconciliation errors.' },
        ],
      },
      {
        module_index: 2, title: 'Identifying & Resolving Discrepancies', estimated_minutes: 16, xp_reward: 63,
        content: `<h3>Step-by-Step Investigation</h3><p>When you find a discrepancy, follow this process before making any adjustments:</p><ol><li>Check the investor's full transaction history — look for missing entries or duplicates</li><li>Pull the payment gateway confirmation for any deposit in the relevant period</li><li>Check if a pending EFT matches the variance amount</li><li>Review the audit log for any manual changes to the wallet balance</li><li>If unresolved, escalate to the Finance Manager with a written summary</li></ol><h3>Resolution Methods</h3><p>There are two resolution paths, and they are not interchangeable:</p><ul><li><strong>Wallet Reconciliation (preferred):</strong> The system recalculates the wallet balance from all completed transactions. Use this when transactions are complete and correct but the balance is wrong.</li><li><strong>Manual Credit (audit trail required):</strong> A direct balance adjustment with a mandatory note. Use only when a legitimate deposit occurred but no transaction record exists. Every manual credit must reference the source: bank statement line, Paystack reference, or EFT proof.</li></ul><h3>What Not to Do</h3><p>Never adjust a wallet balance without an audit note. Never mark a pending transaction as completed without payment confirmation. When in doubt, escalate — a wrong balance that gets investigated is far better than a wrong balance that gets hidden.</p>`,
        key_points: ['Always investigate before adjusting — check transaction history, gateway records, and audit logs', 'Wallet Reconciliation is preferred — recalculates from transaction history', 'Manual Credit is a last resort — always requires a written reason and source reference', 'Never adjust a balance without an audit note', 'When in doubt, escalate to the Finance Manager with a written summary'],
        quiz: [
          { question: 'What is the preferred method to resolve a wallet discrepancy?', options: ['Manual credit directly to the wallet', 'Wallet Reconciliation — recalculates from completed transactions', 'Deleting the incorrect transaction', 'Asking the investor to re-submit their payment'], correct: 1, explanation: 'Wallet Reconciliation is preferred because it recalculates the balance from the underlying transaction data — no manual entry, no audit risk.' },
          { question: 'When is a Manual Credit appropriate?', options: ['Whenever the wallet balance looks wrong', 'Only when a legitimate deposit occurred but no transaction record exists', 'As a shortcut when reconciliation takes too long', 'To add bonus returns for long-term clients'], correct: 1, explanation: 'Manual credits are only appropriate when a legitimate, confirmed deposit exists (bank statement, gateway receipt) but wasn\'t recorded. Every manual credit requires a written reference.' },
          { question: 'You find a discrepancy but cannot identify the cause after checking all sources. What should you do?', options: ['Apply a manual credit to clear the variance', 'Ignore it — small variances self-correct', 'Escalate to the Finance Manager with a written summary of what you checked', 'Delete the investor\'s transaction history and start fresh'], correct: 2, explanation: 'Escalation with documentation is the correct path when investigation doesn\'t resolve a discrepancy. A documented escalation protects you and the business.' },
        ],
      },
      {
        module_index: 3, title: 'Reporting Standards & Documentation', estimated_minutes: 14, xp_reward: 63,
        content: `<h3>The Weekly Finance Review</h3><p>Every week, SV Capital's Finance Manager reviews a reconciliation summary covering: total AUM, total wallet balances, total invested, unresolved discrepancies, and pending deposits. Your role is to ensure this data is accurate before the report is compiled.</p><h3>What Good Documentation Looks Like</h3><ul><li>Every discrepancy has a reference number, date identified, amount, investor ID, and resolution status</li><li>Every manual credit has: date, amount, investor ID, reason, and supporting document reference</li><li>Every EFT match has: bank statement date, amount, and investor account linked</li><li>The weekly report is dated, signed off by the preparer, and archived</li></ul><h3>Exporting Reconciliation Data</h3><p>The Admin Console Reconciliation tab has a CSV export function that downloads all investor data — name, account number, email, total deposited, total invested, wallet balance, expected wallet, variance, and status. This export is the source of truth for the weekly finance report. Use it; don't recreate it manually.</p><h3>Retention & Compliance</h3><p>Under FICA and general financial record-keeping law, all financial records must be retained for a minimum of 5 years. All reconciliation reports, manual credit notes, and EFT matching records fall under this requirement.</p>`,
        key_points: ['Prepare reconciliation data before the weekly Finance Manager review', 'Every discrepancy must be documented: reference, date, amount, investor ID, status', 'Use the Admin Console CSV export as the source of truth — don\'t recreate data manually', 'Every manual credit needs: date, amount, investor ID, reason, and supporting document', 'Financial records must be retained for a minimum of 5 years under FICA'],
        quiz: [
          { question: 'Where should you export reconciliation data for the weekly finance report?', options: ['Manually compile it from individual investor profiles', 'Use the Admin Console Reconciliation tab CSV export', 'Ask the IT team to run a database query', 'Copy it from the investor\'s statement emails'], correct: 1, explanation: 'The Admin Console Reconciliation tab CSV export is the authoritative source — use it directly rather than manually compiling data, which risks errors.' },
          { question: 'What must every manual credit record include?', options: ['Only the amount and date', 'Date, amount, investor ID, reason, and supporting document reference', 'The Finance Manager\'s verbal approval only', 'Just a note in the team chat'], correct: 1, explanation: 'Every manual credit must be fully documented: date, amount, investor ID, reason, and a reference to the supporting document (bank statement, gateway receipt, etc.).' },
          { question: 'For how long must SV Capital retain financial reconciliation records?', options: ['1 year', '3 years', '5 years', '10 years'], correct: 2, explanation: 'FICA and financial record-keeping law require a minimum of 5 years\' retention for all financial records, including reconciliation reports and manual credit notes.' },
        ],
      },
    ],
  },
  {
    id: 'CRS-OPS-001',
    title: 'Client Onboarding Excellence',
    description: 'The end-to-end investor onboarding journey — from first contact through FICA verification to first investment. Master every touchpoint to deliver a five-star experience.',
    category: 'client_service', difficulty: 'intermediate', estimated_minutes: 45,
    xp_reward: 180, role_target: 'staff', kpi_dimension: 'client_satisfaction',
    kpi_boost_points: 10, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: false, thumbnail_icon: 'fa-user-plus', thumbnail_color: '#f97316',
    learning_objectives: 'Guide a new investor through signup, KYC verification, and first investment with zero dropped steps and maximum confidence.',
    modules: [
      {
        module_index: 1, title: 'The Investor Journey — First Impressions', estimated_minutes: 15, xp_reward: 54,
        content: `<h3>Why First Impressions Define Everything</h3><p>Research consistently shows that the first 24 hours of a client's experience determines whether they invest, stay, and refer others. At SV Capital, the onboarding journey begins the moment someone submits a signup — before they've spoken to a human.</p><h3>The Onboarding Touchpoints</h3><ol><li><strong>Welcome Email:</strong> Automated, sent immediately on signup. Sets expectations about the FICA process and timeline.</li><li><strong>FICA Prompt:</strong> Appears on the portal dashboard until documents are uploaded. Clear, simple, and not punitive.</li><li><strong>Human Follow-Up:</strong> Within 48 hours of signup, a team member checks if the client has uploaded documents and offers to assist.</li><li><strong>FICA Approved Notification:</strong> Sent immediately on approval — "You're ready to invest!" — with a direct link to the marketplace.</li><li><strong>First Investment Confirmation:</strong> Personalised confirmation with investment details, timeline, and what to expect next.</li></ol><h3>The 48-Hour Rule</h3><p>If a newly signed-up investor has not uploaded FICA documents within 48 hours, they receive a personal outreach from the operations team. This single intervention is the highest-ROI activity in the entire onboarding process — it converts hesitant signups into first-time investors.</p>`,
        key_points: ['The first 24 hours of onboarding determines if a client invests, stays, and refers', 'Five key touchpoints: Welcome email → FICA prompt → Human follow-up → Approval → First investment', 'The 48-hour follow-up for non-uploaders is the highest-ROI onboarding intervention', 'FICA approval notification should include a direct link to the marketplace', 'First investment confirmation should be personalised with timeline and next steps'],
        quiz: [
          { question: 'What is the 48-hour rule in SV Capital client onboarding?', options: ['All FICA documents must be verified within 48 hours', 'If a new signup hasn\'t uploaded FICA documents within 48 hours, they receive a personal outreach', 'New investors can only invest 48 hours after signup', 'All new clients receive a call within 48 hours of their first investment'], correct: 1, explanation: 'The 48-hour follow-up for non-uploaders is the highest-ROI onboarding intervention — it converts hesitant signups into first-time investors before they disengage.' },
          { question: 'Which touchpoint should include a direct link to the investment marketplace?', options: ['The welcome email', 'The FICA prompt in the portal', 'The FICA Approved notification', 'The first investment confirmation'], correct: 2, explanation: 'The FICA Approved notification — "You\'re ready to invest!" — should include a direct link to the marketplace to capitalise on the moment of approval excitement.' },
          { question: 'When does the client onboarding journey begin?', options: ['When the client makes their first call to SV Capital', 'The moment a signup is submitted — before any human interaction', 'When FICA documents are first uploaded', 'When the first investment is made'], correct: 1, explanation: 'Onboarding begins at signup submission — the automated welcome email and portal experience shape first impressions before any human touchpoint occurs.' },
        ],
      },
      {
        module_index: 2, title: 'KYC Verification & Common Pitfalls', estimated_minutes: 16, xp_reward: 63,
        content: `<h3>The FICA Document Checklist</h3><p>Every investor must provide three categories of documents before investing: identity verification, proof of address, and (for larger amounts) source of funds. Getting this right the first time prevents delays and client frustration.</p><h3>Identity Verification — Common Pitfalls</h3><ul><li><strong>Expired ID/passport:</strong> Documents must be current — check the expiry date</li><li><strong>Poor scan quality:</strong> All four corners must be visible, no glare or blur</li><li><strong>Smart ID card:</strong> Both the front AND back are required</li><li><strong>Foreign nationals:</strong> Must provide passport — South African ID is not applicable</li></ul><h3>Proof of Address — Common Pitfalls</h3><ul><li><strong>Older than 3 months:</strong> Must be recent — check the document date carefully</li><li><strong>Wrong name:</strong> Must match the ID document exactly — married names must be consistent</li><li><strong>Handwritten documents:</strong> Not accepted — must be a utility bill or bank statement</li><li><strong>P.O. Box address:</strong> Not accepted — must be a physical address</li></ul><h3>Handling Rejections Gracefully</h3><p>When a document is rejected, the client receives an automated notification with the specific reason. Your role is to follow up personally within 24 hours, explain clearly what's needed, and offer to walk them through re-uploading. Never leave a rejection sitting — every day of delay is a day without investment.</p>`,
        key_points: ['Smart ID cards require both front and back', 'Proof of address must be under 3 months old and match the name on the ID exactly', 'Follow up personally within 24 hours of any document rejection', 'Handwritten documents and P.O. Box addresses are not accepted', 'Getting documents right first time prevents client frustration and delays'],
        quiz: [
          { question: 'A client uploads only the front of their Smart ID card. What should you do?', options: ['Approve it — the front contains all necessary information', 'Contact the client and request the back of the card as well', 'Reject the application permanently', 'Request a passport instead'], correct: 1, explanation: 'Smart ID cards require both front and back — the back contains the barcode and additional security features needed for FICA verification.' },
          { question: 'A client\'s proof of address is 4 months old. What is the correct action?', options: ['Accept it — a month over is close enough', 'Reject it and contact the client for a document dated within the last 3 months', 'Approve with a manager note', 'Request a bank statement instead'], correct: 1, explanation: 'Proof of address must be dated within the last 3 months — FICA requires recent proof of residency. A 4-month-old document must be rejected and the client asked to provide a current one.' },
          { question: 'After a document rejection, what is the expected response time for personal follow-up?', options: ['Within 24 hours', 'Within 48 hours', 'Within 1 week', 'When the client contacts us next'], correct: 0, explanation: 'Personal follow-up within 24 hours of a rejection is the standard. Every day without follow-up risks losing the investor to disengagement or a competitor.' },
        ],
      },
      {
        module_index: 3, title: 'From Verified to First Investment', estimated_minutes: 14, xp_reward: 63,
        content: `<h3>The Critical Window After FICA Approval</h3><p>The 72 hours after FICA approval is when conversion from "verified client" to "first-time investor" is highest. Clients are engaged, excited, and ready — your job is to capitalise on this window by making the first investment as frictionless as possible.</p><h3>Guiding the First Deposit</h3><p>When helping a new investor make their first deposit, walk them through the payment options available on the portal: <strong>Paystack</strong> (instant card payment), <strong>Ozow</strong> (instant EFT), and <strong>Manual EFT</strong> (1–2 business days). Emphasise Paystack or Ozow for the fastest credit — instant wallet credit means they can invest immediately.</p><h3>First Investment Conversations</h3><p>New investors often have two questions: "Which product should I choose?" and "How much should I start with?" Your answers must be FAIS-compliant: (1) ask about their risk tolerance and investment horizon before recommending, (2) never suggest a specific amount — guide them to use what they're comfortable with, starting from the minimum. Document the conversation.</p><h3>Post-Investment Nurture</h3><p>After the first investment: send a personalised confirmation, set a reminder to check in at the midpoint of their investment term, and flag them as a potential referral source at maturity. Clients who receive proactive mid-term communication are 3× more likely to reinvest and refer.</p>`,
        key_points: ['The 72 hours after FICA approval is the highest conversion window', 'Recommend Paystack or Ozow for instant wallet credit and immediate investment capability', 'All product recommendations must follow FAIS suitability assessment — ask before recommending', 'Never suggest a specific investment amount — guide clients to start from the minimum', 'Mid-term check-ins make clients 3× more likely to reinvest and refer'],
        quiz: [
          { question: 'Why is the 72-hour window after FICA approval important?', options: ['It is when the investor\'s risk profile expires', 'Conversion from verified client to first investor is highest in this window', 'All investments must be made within 72 hours of approval', 'It is when the system auto-credits a welcome bonus'], correct: 1, explanation: 'Clients are most engaged and ready to act immediately after approval. The 72-hour window is when conversion rates are highest — proactive outreach in this period maximises first investments.' },
          { question: 'A new investor asks which product they should choose. What is the correct FAIS-compliant response?', options: ['Recommend the highest-returning product immediately', 'Ask about their risk tolerance and investment horizon before making any recommendation', 'Tell them all products are equally suitable', 'Refer them to the website FAQ'], correct: 1, explanation: 'FAIS requires a suitability assessment before any recommendation. Ask about risk tolerance and investment horizon first, then match the appropriate product to their profile.' },
          { question: 'Which payment method results in the fastest wallet credit and immediate investment capability?', options: ['Manual EFT — banks process fastest', 'Paystack or Ozow — instant credit', 'Cheque deposit', 'Cash at the SV Capital office'], correct: 1, explanation: 'Paystack and Ozow are instant payment methods — the wallet is credited immediately, allowing the client to invest right away. Manual EFT takes 1–2 business days.' },
        ],
      },
    ],
  },
  {
    id: 'CRS-SALES-001',
    title: 'Growing Our AUM',
    description: 'Strategies for growing Assets Under Management through IFA partnerships, referral programmes, and effective product positioning for HNW clients.',
    category: 'sales', difficulty: 'advanced', estimated_minutes: 50,
    xp_reward: 200, role_target: 'director', kpi_dimension: 'revenue_contribution',
    kpi_boost_points: 12, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: false, thumbnail_icon: 'fa-chart-line', thumbnail_color: '#00d4aa',
    learning_objectives: 'Identify and qualify IFA partnership opportunities, structure a product pitch for an HNW client, and implement a referral strategy that compounds AUM growth.',
    modules: [
      {
        module_index: 1, title: 'Understanding Our Target Market', estimated_minutes: 17, xp_reward: 60,
        content: `<h3>Who We Serve</h3><p>SV Capital's core investor base is South African HNW (high-net-worth) individuals investing between R25 000 and R500 000 per product. Our fastest-growing segment is the emerging middle class: professionals aged 28–45 with disposable income seeking higher returns than traditional savings products.</p><h3>The Investor Mindset</h3><p>Most SV Capital investors come to us because banks and money market funds no longer satisfy them. They've done basic investing; now they want <strong>real assets</strong>, <strong>higher returns</strong>, and <strong>transparency</strong> about where their money is. Our job is to show them we deliver on all three.</p><h3>Segmenting Your Pipeline</h3><ul><li><strong>Conservative (40–60+ years):</strong> Solar 5-Year — long-term, stable, PPA-backed</li><li><strong>Growth-Seeking (30–50 years):</strong> Cattle cycles + Solar 7-Year — higher return, acceptable medium term</li><li><strong>Income-Seeking (any age):</strong> Short-term lending — quarterly income, higher return, higher risk disclosure required</li></ul><h3>The Decision Trigger</h3><p>Most investors don't act on the first conversation. They research, compare, and return. Your follow-up cadence is what converts interest to investment: Day 1 (first contact), Day 3 (send product summary), Day 7 (check-in call), Day 14 (ask for a decision). After Day 14, move to monthly nurture.</p>`,
        key_points: ['Core target: SA HNW investors aged 28–45, R25 000–R500 000 investment range', 'Investors come to us wanting real assets, higher returns, and transparency', 'Segment: Conservative → Solar 5-Year, Growth → Cattle + Solar 7-Year, Income → Short-term', 'Follow-up cadence: Day 1 → Day 3 → Day 7 → Day 14 → monthly nurture', 'Most investors don\'t act on the first conversation — the follow-up converts'],
        quiz: [
          { question: 'Which product best suits a conservative investor aged 55 who prioritises stability?', options: ['Short-term lending at 16% p.a.', 'Solar 5-Year at 6–8% p.a. with PPA backing', 'Cattle farming cycle', 'Solar 7-Year at 21% p.a.'], correct: 1, explanation: 'A conservative investor prioritising stability is best suited to Solar 5-Year — PPA-backed, lower risk, and providing steady returns over a defined term.' },
          { question: 'An interested prospect hasn\'t responded to your first two messages. It\'s Day 10. What is the correct next action?', options: ['Stop following up — they\'re not interested', 'Send a Day 7 check-in call (you\'re behind schedule)', 'Wait until Day 30 to follow up', 'Escalate to the director immediately'], correct: 1, explanation: 'The follow-up cadence calls for a Day 7 check-in call. By Day 10, this is overdue — make the call now and log the interaction.' },
          { question: 'What is the primary reason HNW investors choose SV Capital over banks?', options: ['SV Capital is government-guaranteed', 'Real assets, higher returns, and full transparency about where money is invested', 'Lower minimum investments than banks', 'SV Capital is the only FAIS-licensed firm in SA'], correct: 1, explanation: 'Investors come to SV Capital because banks don\'t offer real assets or transparency about deployment. Our pitch is: know exactly where your money is and earn more than the bank pays.' },
        ],
      },
      {
        module_index: 2, title: 'IFA Partnerships & Referral Networks', estimated_minutes: 18, xp_reward: 70,
        content: `<h3>Why IFAs Matter</h3><p>Independent Financial Advisors (IFAs) are the most efficient AUM growth channel available to SV Capital. A single IFA with 50–200 clients represents a potential pipeline of millions of rands in new investment — and they're already trusted by their clients. One IFA relationship, properly managed, can outperform months of direct marketing.</p><h3>Finding IFA Partners</h3><ul><li>FPI (Financial Planning Institute) member directory</li><li>CFP (Certified Financial Planner) networks</li><li>Direct outreach to boutique advisory firms in Gauteng, Western Cape, and KZN</li><li>Referrals from existing IFA partners — the most effective source</li></ul><h3>The IFA Pitch</h3><p>IFAs choose SV Capital because: (1) our products are genuinely differentiated from what banks offer their clients, (2) we handle all investor servicing — they introduce, we maintain, (3) our platform is professional and auditable under FAIS. The pitch is: "Give your clients something genuinely different. We do the work; you add the value."</p><h3>Managing IFA Relationships</h3><p>IFA relationships require regular maintenance: quarterly product updates, performance reporting for their client portfolios, and annual strategy conversations. IFAs who feel informed and supported send referrals consistently. IFAs who feel ignored switch to competitors.</p>`,
        key_points: ['A single IFA can represent millions in potential AUM — the highest-ROI growth channel', 'Find IFAs through FPI/CFP directories, boutique advisory firms, and existing partner referrals', 'IFA pitch: differentiated products + we handle servicing + FAIS-auditable platform', 'Maintain IFA relationships with quarterly updates and annual strategy sessions', 'IFAs who feel informed send consistent referrals; IFAs who feel ignored switch'],
        quiz: [
          { question: 'Why are IFA partnerships considered the highest-ROI AUM growth channel?', options: ['They require no ongoing maintenance', 'One IFA can represent 50–200 pre-qualified clients with existing trust', 'They are the cheapest marketing channel', 'IFAs invest their own capital through SV Capital'], correct: 1, explanation: 'An IFA brings access to a client base they\'ve already built trust with — one relationship converts into potentially millions in AUM without the cost of building that trust from scratch.' },
          { question: 'What is the key message in the IFA pitch about client servicing?', options: ['IFAs must service clients themselves', 'SV Capital handles all investor servicing — IFAs introduce, SV Capital maintains', 'IFAs need to monitor investments daily', 'SV Capital and IFAs share servicing equally'], correct: 1, explanation: 'The IFA pitch emphasises that we handle all investor servicing — IFAs introduce clients and we maintain the relationship. This makes SV Capital low-effort for the IFA.' },
          { question: 'An IFA partner hasn\'t received a product update in 6 months and is becoming less responsive. What should you do?', options: ['Wait for them to reach out when they have a client referral', 'Send a quarterly product performance update immediately and schedule a call', 'Replace them with a new IFA partner', 'Send a formal complaint about their lack of referrals'], correct: 1, explanation: 'IFAs who feel uninformed stop sending referrals. An immediate catch-up with performance data and a scheduled strategy call re-establishes the relationship before it goes cold.' },
        ],
      },
      {
        module_index: 3, title: 'Pitching Products to HNW Clients', estimated_minutes: 15, xp_reward: 70,
        content: `<h3>The HNW Conversation Framework</h3><p>High-net-worth clients are sophisticated. They've heard pitches before. The most effective approach is <strong>curiosity-led, not product-led</strong>: ask about their current portfolio, what's working, and what they wish was different. Only when you understand their context do you introduce SV Capital products.</p><h3>The Three-Question Discovery</h3><ol><li>"What does your current investment portfolio look like?" — understand their baseline</li><li>"What return are you currently achieving, and are you happy with it?" — identify the gap</li><li>"How would you feel about a portion of your portfolio in real assets — cattle, solar, lending — with higher returns?" — plant the idea</li></ol><h3>Handling the Most Common Objections</h3><ul><li><strong>"Is it safe?"</strong> — "No investment is without risk, but here's exactly how we manage it: [insurance/PPA/credit assessment]. We believe risk disclosure is the foundation of trust."</li><li><strong>"I've never heard of SV Capital."</strong> — "We're a licensed FSP (licence number on request) — you can verify us on the FSCA register. Here's our client performance history."</li><li><strong>"I need to think about it."</strong> — "Of course. Can I send you the Key Information Document? And would a follow-up call next week work?" — always define the next step.</li></ul><h3>The FAIS Constraint as a Selling Point</h3><p>FAIS compliance isn't a limitation — it's a trust signal. HNW clients are increasingly suspicious of unregulated platforms. Positioning our regulatory compliance upfront ("We are FAIS-regulated and can show you our licence") differentiates SV Capital from less scrupulous alternatives.</p>`,
        key_points: ['Use a curiosity-led, not product-led, approach with HNW clients', 'Three-question discovery: current portfolio → current returns → openness to real assets', 'Handle "Is it safe?" with honest risk disclosure and specific mitigation — never deny risk', 'Always define the next step before ending any client conversation', 'FAIS compliance is a trust signal — use it as a differentiator, not a disclaimer'],
        quiz: [
          { question: 'What is the most effective approach when pitching to a sophisticated HNW client?', options: ['Lead with your highest-returning product immediately', 'Use a curiosity-led approach — understand their portfolio before introducing products', 'Focus only on returns and avoid mentioning risk', 'Present all three products simultaneously'], correct: 1, explanation: 'HNW clients are sophisticated and distrust pushy pitches. A curiosity-led approach — asking about their current portfolio and gaps — builds trust before introducing SV Capital solutions.' },
          { question: 'A prospect says "Is it safe?" How should you respond under FAIS?', options: ['Say "Yes, absolutely" to close the deal', 'Acknowledge that no investment is without risk and explain specifically how SV Capital manages it', 'Avoid the question and redirect to returns', 'Tell them to speak to their accountant'], correct: 1, explanation: 'FAIS prohibits misrepresentation. Saying "absolutely safe" is false and a regulatory violation. The correct response is honest: acknowledge risk and explain specific mitigation measures.' },
          { question: 'A prospect says "I need to think about it." What is the best next step?', options: ['Say "Okay, call me when you\'re ready."', 'Offer the KID and define a specific follow-up time — "Would next Tuesday work for a call?"', 'Send a formal proposal and wait 30 days', 'Escalate to the director to close the deal'], correct: 1, explanation: 'Never end a conversation without a defined next step. Offering the KID and scheduling a specific follow-up call keeps the prospect in the pipeline without pressure.' },
        ],
      },
    ],
  },
  // ── CATTLE INVESTMENT PRODUCT ──────────────────────────────────────
  {
    id: 'CRS-PROD-CATTLE-001',
    title: 'Cattle Investment: The Complete Guide',
    description: 'Master SV Capital\'s flagship product — the Cattle Investment. Understand the full agricultural value chain, how returns are generated through the Beefcor partnership, and how to confidently present this product to clients.',
    category: 'products', difficulty: 'intermediate', estimated_minutes: 50,
    xp_reward: 200, role_target: 'all', kpi_dimension: 'revenue_contribution',
    kpi_boost_points: 12, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-cow', thumbnail_color: '#f97316',
    learning_objectives: 'Explain exactly how the Cattle Investment works, calculate indicative returns for a client, describe what protects investor capital, and handle the top objections with confidence and FAIS compliance.',
    modules: [
      {
        module_index: 1, title: 'The Cattle Investment: Product Fundamentals', estimated_minutes: 15, xp_reward: 60,
        content: `<h3>SV Capital's Flagship Product</h3><p>The Cattle Investment is SV Capital's foundational product — the one that started it all. It gives everyday South Africans the ability to participate in the commercial cattle value chain, an asset class that has historically been accessible only to large agri-businesses and family farming operations.</p><p>Investors pool their capital into a collective cattle investment backed by South African livestock, managed through an experienced farming and feedlot network. The underlying asset is real, physical, and essential — cattle that feed the nation.</p><h3>Key Product Parameters</h3><ul><li><strong>Target Return:</strong> 14.58% per annum</li><li><strong>Investment Term:</strong> 12 months</li><li><strong>Minimum Investment:</strong> R500</li><li><strong>Payment:</strong> At maturity (lump sum — capital + returns)</li><li><strong>Early Withdrawal:</strong> Not available during the investment term</li><li><strong>Underlying Asset:</strong> Livestock / cattle assets</li></ul><h3>Why Cattle?</h3><p>South Africa's commercial cattle industry is a multi-billion-rand sector with consistent demand driven by population growth and food consumption. Unlike equity markets, cattle values are anchored to real biological growth and market prices for beef — not sentiment or speculation. This makes cattle an effective inflation hedge and portfolio diversifier.</p><p>As a team member, understanding that this product offers returns <em>above</em> typical bank deposit rates (7–8% p.a.) while being backed by physical assets is your first selling point. The comparison is stark: a bank deposit earns 7–8% backed by a bank's balance sheet; our Cattle Investment targets 14.58% backed by real animals with real commercial value.</p>`,
        key_points: [
          'The Cattle Investment targets 14.58% p.a. over a fixed 12-month term with R500 minimum entry',
          'It is SV Capital\'s flagship product — asset-backed by physical South African livestock',
          'Capital is pooled with other investors and deployed into the full cattle farming cycle',
          'Payment of capital plus returns is made at maturity — no early withdrawal is permitted',
          'Cattle provide a natural inflation hedge as their value is tied to real food demand, not market sentiment',
        ],
        quiz: [
          { question: 'What is the target annual return for the SV Capital Cattle Investment?', options: ['7–8% p.a.', '21.40% p.a.', '14.58% p.a.', '±13.64% p.a.'], correct: 2, explanation: 'The Cattle Investment targets 14.58% per annum — significantly above traditional bank deposit rates of 7–8% p.a., backed by real livestock assets.' },
          { question: 'When is the investor\'s capital and return paid out in the Cattle Investment?', options: ['Monthly over 12 months', 'Quarterly in equal instalments', 'At maturity (end of the 12-month term)', 'Early withdrawal is available at any time'], correct: 2, explanation: 'All returns are paid at maturity — as a lump sum of capital plus applicable returns. Early withdrawal is not available during the 12-month term.' },
          { question: 'What is the minimum investment amount for the Cattle Investment?', options: ['R1,000', 'R5,000', 'R500', 'R10,000'], correct: 2, explanation: 'The Cattle Investment has a minimum of just R500, making it accessible to a wide range of investors — from first-time retail investors to HNW clients adding diversification.' },
        ],
      },
      {
        module_index: 2, title: 'How Returns Are Generated: The Cattle Value Chain', estimated_minutes: 18, xp_reward: 70,
        content: `<h3>The Agricultural Engine Behind Your Returns</h3><p>Understanding how returns are actually generated is critical — both for your confidence as an advisor and for your clients' trust. This module unpacks the full cattle investment cycle from capital deployment to payout.</p><h3>Step 1: Capital Pooling & Deployment</h3><p>When an investor places funds through platform.svcapital.co.za, their capital is pooled with other investors and collectively deployed into the cattle farming cycle. This pooling model allows SV Capital to operate at commercial farming scale — accessing Beefcor's world-class feedlot infrastructure — while allowing individuals to participate from just R500.</p><h3>Step 2: Backgrounding Phase (~60 Days at Beefcor)</h3><p>Cattle sourced using pooled investor capital undergo approximately <strong>60 days of backgrounding</strong> at Beefcor's facilities. Backgrounding is the process of preparing cattle for the feedlot through optimised feeding, health management, and conditioning. Beefcor is one of South Africa's leading feedlot operators, providing institutional-grade infrastructure, veterinary oversight, and biosecurity standards.</p><h3>Step 3: Offtake Agreement for Finishing</h3><p>After backgrounding, cattle are sold under an <strong>offtake agreement to Beefcor for finishing</strong>. Finishing is the final feeding phase where cattle reach market weight and readiness. The offtake agreement is a pre-negotiated commercial contract ensuring Beefcor takes the cattle at a defined price — this is a key risk-reduction mechanism that removes price uncertainty at the point of sale.</p><h3>Step 4: Market Sale & Return Distribution</h3><p>At maturity, when cattle reach market readiness and are sold, the proceeds generate the return on investment. After all costs, the net return is calculated and investors receive their capital plus applicable returns — targeting 14.58% p.a. over the 12-month cycle.</p><h3>What Makes This Structurally Sound</h3><p>The two most important structural features are: (1) the Beefcor partnership — a regulated, experienced commercial operator managing real cattle under professional standards; and (2) the offtake agreement — which provides a defined exit pathway for the cattle, reducing market price risk at the end of the cycle.</p>`,
        key_points: [
          'Investor capital is pooled and deployed into the commercial cattle farming cycle via Beefcor\'s facilities',
          'Cattle undergo ~60 days of backgrounding at Beefcor — a leading SA feedlot operator — before the finishing phase',
          'An offtake agreement with Beefcor defines the sale terms for finished cattle, reducing price uncertainty',
          'Returns are generated through the cattle value cycle: sourcing → backgrounding → offtake → market sale',
          'The Beefcor partnership provides institutional-grade farming, veterinary care, and biosecurity standards',
        ],
        quiz: [
          { question: 'What happens during the "backgrounding" phase of the Cattle Investment?', options: ['Investor funds are collected and pooled', 'Cattle are prepared for the feedlot through optimised feeding and health management over ~60 days', 'Cattle are sold at market and proceeds distributed', 'Legal documentation and KYC are completed'], correct: 1, explanation: 'Backgrounding is the ~60-day phase at Beefcor where cattle are conditioned through nutrition, veterinary care, and health management — preparing them for the finishing phase.' },
          { question: 'What is an "offtake agreement" and why is it important for the Cattle Investment?', options: ['An agreement for early investor withdrawal', 'A pre-negotiated contract for Beefcor to purchase the finished cattle at defined terms — reducing price risk', 'A tax certificate issued at maturity', 'An insurance policy covering disease risk'], correct: 1, explanation: 'The offtake agreement with Beefcor is a commercial contract securing the cattle sale at defined terms. This removes market price uncertainty at the critical point of realising the investment return.' },
          { question: 'How does the pooling model benefit small investors in the Cattle Investment?', options: ['It reduces the investment term to 6 months', 'It allows individuals investing from R500 to access commercial-scale Beefcor feedlot infrastructure', 'It guarantees the 14.58% return regardless of cattle prices', 'It provides monthly income distributions'], correct: 1, explanation: 'Pooling aggregates capital from many investors, enabling SV Capital to operate at commercial scale through Beefcor — infrastructure normally only accessible to large agri-businesses — while individual entry starts at just R500.' },
        ],
      },
      {
        module_index: 3, title: 'Capital Protection, Risk Management & Client Conversations', estimated_minutes: 17, xp_reward: 70,
        content: `<h3>How Investor Capital Is Protected</h3><p>When a client asks "What protects my money?" — this is the most important question you will answer. The Cattle Investment has three layers of capital protection that you must be able to articulate clearly and accurately under FAIS.</p><h3>Protection Layer 1: Asset Backing</h3><p>The investment is backed by real, physical cattle. Unlike paper assets, cattle have intrinsic commercial value — they produce income through the beef supply chain. The underlying assets are not abstract; they are living, productive assets whose value is verifiable and tangible.</p><h3>Protection Layer 2: Experienced Operators</h3><p>Capital is managed through Beefcor — an experienced feedlot operator with deep industry expertise, established commercial relationships, and professional farming protocols. This is not a startup operation; Beefcor represents institutional-grade agricultural management.</p><h3>Protection Layer 3: Insurance Coverage</h3><p>Cattle are <strong>insured against key risks including disease, theft, and natural hazards</strong>. This insurance layer provides a financial safety net against the unpredictable events that can occur in agricultural environments. When you communicate this to clients, you're demonstrating that SV Capital has thought carefully about downside scenarios.</p><h3>Handling the Top Client Objections</h3><p><strong>"Is my money guaranteed?"</strong><br>Under FAIS, you cannot say an investment is guaranteed unless it legally is. The correct response: "No investment is without risk, but the Cattle Investment is structured with specific protections — physical asset backing, experienced operators through Beefcor, and insurance against disease, theft, and natural hazards. SV Capital has a 0% historical capital loss record across completed investments."</p><p><strong>"Why can't I withdraw early?"</strong><br>The response: "The investment is tied to a specific agricultural cycle — the cattle need approximately 12 months to complete the backgrounding and finishing phases. Early withdrawal would disrupt the cycle and could result in selling assets before they've reached full value. This is why the 12-month term is fixed, and why the returns are higher than a flexible bank deposit."</p><p><strong>"What happens if the cattle die?"</strong><br>The response: "That's exactly why we insure all cattle against disease, theft, and natural hazards. Beefcor also maintains professional veterinary oversight and biosecurity standards. SV Capital has managed multiple cattle cycles with a 0% capital loss record."</p><h3>The EVA Pool Connection</h3><p>Every successful Cattle Investment you facilitate contributes to AUM growth and your KPI score in the revenue_contribution dimension. A client investing R50,000 in the Cattle Investment earns SV Capital management fees that flow directly into the EVA pool — the 60% individual component of which is linked directly to your contribution.</p>`,
        key_points: [
          'Three layers protect investor capital: physical asset backing (real cattle), experienced operators (Beefcor), and insurance against disease, theft and natural hazards',
          'Under FAIS you cannot claim investments are "guaranteed" — always explain specific risk mitigants instead',
          'The 12-month fixed term exists because it matches the agricultural cycle — early withdrawal would disrupt it',
          'SV Capital has a 0% historical capital loss record across all completed investment cycles',
          'Every Cattle Investment you facilitate grows AUM and your revenue_contribution KPI score',
        ],
        quiz: [
          { question: 'A client asks: "Is my money guaranteed in the Cattle Investment?" What is the FAIS-compliant response?', options: ['"Yes, absolutely — Beefcor guarantees your capital"', '"No investment is without risk, but the Cattle Investment has specific protections: asset backing, experienced operators, and insurance"', '"Don\'t worry about that — we\'ve never had a problem"', '"It depends on cattle prices — no one can say"'], correct: 1, explanation: 'FAIS prohibits misrepresentation. Saying "guaranteed" is false and a regulatory violation. Always explain the specific risk mitigants: asset backing, Beefcor expertise, and insurance coverage.' },
          { question: 'Which three risks are cattle insured against in the Cattle Investment?', options: ['Market price risk, currency risk, interest rate risk', 'Disease, theft, and natural hazards', 'Fraud, drought, and inflation', 'Operator default, currency depreciation, and tax changes'], correct: 1, explanation: 'Cattle in the SV Capital Cattle Investment are insured against disease, theft, and natural hazards — three of the most common risk events in agricultural operations.' },
          { question: 'What is SV Capital\'s historical capital loss rate across completed investments?', options: ['2–3%', 'Under 5%', '0%', 'Around 1%'], correct: 2, explanation: 'SV Capital has a 0% historical capital loss record across completed investments — across 3,000+ investors in Cattle, Solar, Logistics, and Short-Term products. This is a powerful trust signal when speaking with clients.' },
        ],
      },
    ],
  },

  // ── SHORT-TERM INVESTMENT PRODUCT ──────────────────────────────────
  {
    id: 'CRS-PROD-STI-001',
    title: 'Short-Term Investment: The Portfolio Liquidity Anchor',
    description: 'Deep-dive into SV Capital\'s Short-Term Investment — the 5-month SMME-funded opportunity that gives clients both strong returns and the quickest path back to liquidity in our product suite. Learn the mechanics, risk profile, and how to position it in a client\'s portfolio.',
    category: 'products', difficulty: 'intermediate', estimated_minutes: 45,
    xp_reward: 180, role_target: 'all', kpi_dimension: 'revenue_contribution',
    kpi_boost_points: 10, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-clock-rotate-left', thumbnail_color: '#fec24f',
    learning_objectives: 'Explain how the Short-Term Investment generates returns through SMME funding, articulate what "portfolio liquidity anchor" means in practical terms, and position this product correctly for different client risk appetites.',
    modules: [
      {
        module_index: 1, title: 'Understanding the Short-Term Investment', estimated_minutes: 14, xp_reward: 54,
        content: `<h3>The Portfolio Liquidity Anchor</h3><p>The Short-Term Investment occupies a specific and strategic role in the SV Capital product suite. While the Cattle Investment (12 months) and Solar Investment (7 years) offer longer commitment horizons, the Short-Term Investment provides investors with a <strong>5-month pathway to returns</strong> — making it the most liquid option in the standard product range and an ideal entry point for first-time or cautious investors.</p><h3>What Is the Investment?</h3><p>The Short-Term Investment provides funding to South African SMMEs (Small, Medium, and Micro Enterprises) — productive businesses that need working capital to execute commercial activities. By connecting retail investor capital with SMME funding needs, SV Capital creates a return-generating cycle that supports real economic activity across South Africa.</p><h3>Key Product Parameters</h3><ul><li><strong>Target Return:</strong> ±13.64% per annum</li><li><strong>Investment Term:</strong> 5 months</li><li><strong>Minimum Investment:</strong> R1,000</li><li><strong>Payment:</strong> At maturity</li><li><strong>Early Withdrawal:</strong> May be available after 5 months, subject to applicable terms and a reduced return</li><li><strong>Underlying Asset:</strong> Short-term productive assets (SMME funding)</li></ul><h3>Why This Product Matters</h3><p>Not every client can lock capital away for 12 months or 7 years. The Short-Term Investment is the answer for clients who want above-market returns but need confidence that they can access their capital within a shorter cycle. The 5-month term positions it as a higher-yield alternative to money market accounts or fixed deposits, backed by productive economic activity rather than bank balance sheets.</p><p>From a portfolio strategy perspective, advise clients to consider using the Short-Term Investment as a "liquidity anchor" — keeping a portion of their SV Capital portfolio in this product while allocating to longer-term opportunities like Cattle or Solar. This gives them flexibility without sacrificing the entire portfolio's return potential.</p>`,
        key_points: [
          'The Short-Term Investment targets ±13.64% p.a. over a 5-month term with a R1,000 minimum',
          'Capital funds South African SMMEs — supporting real productive economic activity',
          'It is the most liquid product in the SV Capital suite, making it ideal for cautious or first-time investors',
          'Early exit may be available after 5 months but subject to applicable terms and a reduced return',
          'Position it as a "liquidity anchor" alongside longer-term products like Cattle and Solar',
        ],
        quiz: [
          { question: 'What is the investment term for the Short-Term Investment?', options: ['12 months', '7 years', '3 months', '5 months'], correct: 3, explanation: 'The Short-Term Investment has a 5-month term — the shortest in the SV Capital suite, making it the most accessible for investors concerned about locking up capital.' },
          { question: 'What does the Short-Term Investment fund with investor capital?', options: ['Solar panel infrastructure', 'South African SMMEs and their productive commercial activities', 'Cattle farming cycles at Beefcor', 'Government infrastructure bonds'], correct: 1, explanation: 'The Short-Term Investment deploys capital to fund South African SMMEs — small and medium enterprises executing productive commercial activities. Returns are generated from the performance of these funded businesses.' },
          { question: 'What does "portfolio liquidity anchor" mean in the context of the Short-Term Investment?', options: ['The product locks capital for the longest term available', 'It provides the most liquid option in the SV Capital suite, giving clients a shorter-cycle return pathway', 'It is backed by government liquidity guarantees', 'It allows daily withdrawals like a money market account'], correct: 1, explanation: 'A "liquidity anchor" means the Short-Term Investment keeps a portion of a client\'s portfolio accessible within a shorter timeframe (5 months), balancing flexibility with the higher returns of longer-term products like Cattle and Solar.' },
        ],
      },
      {
        module_index: 2, title: 'SMME Funding Mechanics & Return Generation', estimated_minutes: 16, xp_reward: 63,
        content: `<h3>How Your Client\'s Capital Works</h3><p>When an investor commits R5,000 to the Short-Term Investment, that capital doesn't sit in a bank account — it goes to work immediately in the SMME economy. Understanding the mechanics of this cycle helps you explain returns with confidence and positions you as a knowledgeable advisor.</p><h3>The Funding Cycle</h3><p><strong>Step 1 — Pooling:</strong> Investor capital is pooled with other investors to reach commercially viable funding amounts for SMME borrowers. This collective approach allows SV Capital to work with businesses that require capital beyond what a single retail investor could provide.</p><p><strong>Step 2 — SMME Deployment:</strong> Pooled capital is deployed to fund SMMEs and their productive activities. These are real South African businesses — in sectors like manufacturing, logistics, construction, and services — that require short-term working capital to execute contracts, purchase stock, or fund operations.</p><p><strong>Step 3 — Returns from Performance:</strong> Returns are generated from the performance of the funded SMME businesses and their underlying commercial activities. The target return of ±13.64% p.a. reflects the yield from this productive deployment.</p><p><strong>Step 4 — Maturity Payout:</strong> At the end of the 5-month term, investors receive their capital plus applicable returns. If early exit is available and a client exercises it after 5 months, the return may be reduced under applicable terms.</p><h3>Understanding the "±" in the Target Return</h3><p>The target return is expressed as <strong>±13.64% p.a.</strong> — the "±" (plus/minus) notation is important. It indicates that this is a target, not a guaranteed fixed return. Returns are subject to the performance of the underlying SMME investments and are disclosed in the applicable investment documentation.</p><p>When communicating this to clients, always use language like "the current target return is approximately 13.64% per annum" — never state it as a guaranteed figure. This is both accurate and FAIS-compliant.</p><h3>Comparing to Alternatives</h3><p>Help clients contextualise the return. A standard 5-month fixed deposit at a major South African bank pays roughly 7–8% p.a. The Short-Term Investment targets approximately 13.64% p.a. — nearly double — backed by productive SMME activity rather than a bank's funding margin. The trade-off is that returns are not guaranteed in the same way as a bank deposit, which is why you must be transparent about this distinction.</p>`,
        key_points: [
          'Capital is pooled and deployed to fund South African SMMEs executing productive commercial activities',
          'Returns are generated from SMME business performance — not guaranteed but targeted at ±13.64% p.a.',
          'The "±" notation means the target return can be above or below 13.64% — always present it as a target, not a guarantee',
          'At maturity, investors receive capital plus applicable returns; early exit may be available with reduced return',
          'The Short-Term Investment targets roughly double the return of a 5-month bank fixed deposit',
        ],
        quiz: [
          { question: 'Why is the Short-Term Investment target return expressed as "±13.64% p.a." rather than a fixed number?', options: ['It means returns are guaranteed to always exceed 13.64%', 'The ± indicates this is a target based on SMME performance, not a guaranteed fixed return', 'It adjusts with the South African repo rate monthly', 'It means different investors receive different rates based on their investment size'], correct: 1, explanation: 'The ± notation is critical for FAIS compliance — it signals that 13.64% p.a. is a target return subject to the underlying SMME investment performance, disclosed in investment documentation. Never present it as a guaranteed fixed return.' },
          { question: 'Which of the following best describes how the Short-Term Investment generates returns?', options: ['Through stock market dividends from listed SMME shares', 'Through cattle sales at the end of a farming cycle', 'Through the commercial performance of funded SMME businesses and their productive activities', 'Through solar energy tariff revenues over 7 years'], correct: 2, explanation: 'Returns in the Short-Term Investment are generated from the performance of South African SMMEs funded with investor capital — their productive commercial activities create the yield that investors receive.' },
          { question: 'How should you position the Short-Term Investment\'s return to a client comparing it to a fixed deposit?', options: ['"It\'s the same as a bank fixed deposit but slightly more flexible"', '"It targets approximately double the return of a 5-month bank fixed deposit, backed by productive SMME activity, though returns are not guaranteed in the same way"', '"It\'s guaranteed to outperform any fixed deposit on the market"', '"The return is exactly 13.64% regardless of SMME performance"'], correct: 1, explanation: 'The accurate, FAIS-compliant position is that the Short-Term Investment targets approximately double a bank\'s fixed deposit rate (~7–8% p.a.) but involves a different risk profile — returns are linked to SMME performance and are not bank-guaranteed.' },
        ],
      },
      {
        module_index: 3, title: 'Positioning, Risk Disclosure & Portfolio Strategy', estimated_minutes: 15, xp_reward: 63,
        content: `<h3>Who Is the Short-Term Investment For?</h3><p>Matching the right product to the right client is a core FAIS obligation. The Short-Term Investment is particularly well-suited for specific client profiles that you should recognise quickly in a conversation.</p><p><strong>Profile 1 — The First-Time Investor:</strong> A client who has never invested in alternatives before. The 5-month term reduces commitment anxiety. Starting with R1,000–R5,000 lets them experience the SV Capital platform, receive a payout, and build confidence before committing to longer-term products.</p><p><strong>Profile 2 — The Cash Manager:</strong> A client who holds excess cash in a money market or savings account earning 5–6% p.a. For capital they don't need immediately but will need within the year, the Short-Term Investment offers a significantly better return with a defined exit.</p><p><strong>Profile 3 — The Portfolio Diversifier:</strong> A client who has already invested in Cattle or Solar but wants to maintain some shorter-cycle liquidity within their SV Capital portfolio. The Short-Term Investment anchors that liquidity position while still earning above-market returns.</p><h3>Risk Disclosure — What You Must Always Say</h3><p>Under FAIS, you are required to ensure clients understand the material risks before investing. For the Short-Term Investment, the key disclosures are:</p><ul><li>Returns and capital are <strong>not guaranteed</strong> and are subject to the applicable investment documentation and underlying investment performance</li><li>The investment is structured around a <strong>defined objective and term</strong> — it is not a bank deposit</li><li>Early exit may be available after 5 months but is subject to applicable terms and may result in a <strong>reduced return</strong></li><li>SV Capital operates under an <strong>FSCA FAIS licence</strong> — all advice must be suitable for the client's risk profile and financial position</li></ul><h3>The Portfolio Approach</h3><p>The most sophisticated advisors at SV Capital don't sell individual products — they build client portfolios. A balanced SV Capital portfolio might look like: 40% Cattle Investment (core, 12-month), 20% Short-Term Investment (liquidity anchor, rolling 5-month), 40% Solar (long-term inflation-linked, 7 years). This spread gives the client exposure to multiple return cycles, different asset types, and a defined liquidity window every 5 months.</p><h3>EVA Pool Impact</h3><p>The Short-Term Investment re-deploys every 5 months. A client who reinvests their Short-Term capital generates AUM contribution twice per year rather than once — this has a compounding positive effect on your revenue_contribution KPI and on the collective EVA pool.</p>`,
        key_points: [
          'Best client profiles: first-time investors, cash managers with idle savings, and portfolio diversifiers needing liquidity',
          'Must disclose: returns are not guaranteed, subject to SMME performance and investment documentation',
          'Early exit after 5 months may be available but results in a reduced return — always communicate this clearly',
          'A balanced SV Capital portfolio might split 40% Cattle / 20% Short-Term / 40% Solar for diversified return cycles',
          'Short-Term Investment re-deploys every 5 months — twice yearly AUM contribution boosts your revenue KPI',
        ],
        quiz: [
          { question: 'Under FAIS, what must you always disclose about the Short-Term Investment?', options: ['That returns are guaranteed at exactly 13.64% p.a.', 'That returns and capital are not guaranteed and are subject to investment documentation and underlying performance', 'That early withdrawal is always available at full return', 'That the investment is backed by a government guarantee'], correct: 1, explanation: 'FAIS requires material risk disclosure. The Short-Term Investment\'s returns and capital are not guaranteed — they depend on SMME performance. You must communicate this clearly before any investment is made.' },
          { question: 'Which client profile is LEAST suited to the Short-Term Investment as their only SV Capital product?', options: ['A first-time investor testing the platform with R5,000', 'A client with 7-year savings goals who wants maximum long-term return', 'A client holding excess cash in a money market account', 'A portfolio diversifier needing liquidity within their SV Capital allocation'], correct: 1, explanation: 'A client with a 7-year horizon and maximum return objective is better served by the Solar Investment (21.40% p.a., 7 years). The Short-Term Investment\'s shorter cycle and lower target return don\'t maximise their long-term wealth creation goals.' },
          { question: 'Why does the Short-Term Investment\'s 5-month re-deployment cycle benefit your KPI performance?', options: ['It reduces compliance obligations per transaction', 'It re-deploys AUM twice per year, creating double the annual revenue contribution per reinvesting client', 'It qualifies for a higher platform fee than other products', 'It has no KPI impact — only completed Solar investments count'], correct: 1, explanation: 'Because the Short-Term Investment matures and redeploys every 5 months, a reinvesting client creates two AUM contribution events per year. This doubles their positive impact on your revenue_contribution KPI versus a once-per-year Cattle cycle.' },
        ],
      },
    ],
  },

  // ── SOLAR INVESTMENT PRODUCT ────────────────────────────────────────
  {
    id: 'CRS-PROD-SOLAR-001',
    title: 'Solar Investment: The Renewable Infrastructure Asset',
    description: 'Understand SV Capital\'s highest-returning product — the Solar Investment at 21.40% p.a. over 7 years. Learn the renewable energy infrastructure model, why long-term structured returns outperform short-cycle products, and how to match this product to the right client.',
    category: 'products', difficulty: 'advanced', estimated_minutes: 55,
    xp_reward: 220, role_target: 'all', kpi_dimension: 'revenue_contribution',
    kpi_boost_points: 15, modules_count: 3, quiz_questions: 3, pass_score: 70,
    is_required: true, thumbnail_icon: 'fa-solar-panel', thumbnail_color: '#fec24f',
    learning_objectives: 'Explain what drives the Solar Investment\'s 21.40% p.a. return, articulate why South Africa\'s energy crisis creates a structural investment opportunity, describe the 7-year structure and capital protection, and confidently present this product to HNWI and long-term investors.',
    modules: [
      {
        module_index: 1, title: 'The Solar Investment: South Africa\'s Energy Opportunity', estimated_minutes: 18, xp_reward: 66,
        content: `<h3>The Renewable Infrastructure Asset</h3><p>The Solar Investment is SV Capital's highest-returning and longest-duration product. At a target return of <strong>21.40% per annum over 7 years</strong>, it represents a fundamentally different value proposition from the Cattle or Short-Term products — one anchored in South Africa's structural energy transformation rather than an agricultural or lending cycle.</p><h3>Key Product Parameters</h3><ul><li><strong>Target Return:</strong> 21.40% per annum</li><li><strong>Investment Term:</strong> 7 years</li><li><strong>Minimum Investment:</strong> From R10,000*</li><li><strong>Underlying Asset:</strong> Solar infrastructure</li><li><strong>Asset Class:</strong> Renewable energy / infrastructure</li></ul><p><em>*The first Solar Investment Project had a minimum investment of R10,000. Minimum investment varies by project.</em></p><h3>Why Solar? South Africa\'s Structural Opportunity</h3><p>South Africa's energy crisis has created a once-in-a-generation investment opportunity in renewable infrastructure. The country faces a structural electricity supply shortfall — driven by ageing Eskom infrastructure, delayed new generation capacity, and rising electricity demand from a growing economy. Commercial solar installations solve this problem directly for businesses that need reliable power.</p><p>The key insight: <strong>solar energy generates a predictable, contractually secured revenue stream</strong> through Power Purchase Agreements (PPAs) — long-term contracts where businesses commit to purchasing solar-generated electricity. These PPAs are the commercial anchor that makes solar infrastructure a relatively stable, long-term investment.</p><h3>Why 21.40%? Understanding the Return Premium</h3><p>The Solar Investment commands the highest target return in the SV Capital suite for three reasons:</p><ol><li><strong>Capital Lock-Up Premium:</strong> You are committing capital for 7 years — significantly longer than the Cattle (12 months) or Short-Term (5 months) products. Investors are compensated for this illiquidity with a higher return.</li><li><strong>Infrastructure Scale:</strong> Solar installations represent significant capital expenditure — R10,000+ minimums reflect the larger-scale commercial infrastructure being funded.</li><li><strong>Long-Term Inflation Linkage:</strong> Solar energy tariffs are often structured with inflation escalators, meaning returns can keep pace with or exceed inflation over the 7-year term — a characteristic the short-cycle products don\'t offer.</li></ol><h3>The Strategic Role: "Solar for Inflation-Linked Yield"</h3><p>Within the SV Capital partner onboarding framework, Solar occupies the specific role of "inflation-linked yield" in a client portfolio. While Cattle provides capital growth, and Short-Term provides liquidity, Solar provides the long-term, inflation-resistant income stream — the equivalent of a long-duration bond but backed by real energy infrastructure rather than a government's creditworthiness.</p>`,
        key_points: [
          'The Solar Investment targets 21.40% p.a. over 7 years — the highest return in the SV Capital suite',
          'South Africa\'s structural energy crisis creates a durable, long-term commercial solar opportunity',
          'Power Purchase Agreements (PPAs) provide contracted revenue streams that anchor solar investment returns',
          'The 21.40% premium reflects three factors: illiquidity (7 years), infrastructure scale (R10,000+ min), and inflation linkage',
          'Solar\'s strategic portfolio role is "inflation-linked yield" — a long-duration income anchor',
        ],
        quiz: [
          { question: 'What is the target return for the SV Capital Solar Investment?', options: ['14.58% p.a.', '21.40% p.a.', '±13.64% p.a.', '7–8% p.a.'], correct: 1, explanation: 'The Solar Investment targets 21.40% per annum over a 7-year term — the highest target return in the SV Capital product suite, reflecting the long commitment period and infrastructure scale.' },
          { question: 'What is a Power Purchase Agreement (PPA) and why does it matter to Solar Investment returns?', options: ['A partner profit agreement between SV Capital and Beefcor', 'A long-term contract where a business commits to purchasing solar-generated electricity — providing contracted revenue that anchors investment returns', 'A government subsidy for solar panel installation', 'A payment plan for investors to fund solar projects in instalments'], correct: 1, explanation: 'A PPA (Power Purchase Agreement) is a commercial contract between the solar installation operator and a business buyer committing to purchase electricity. PPAs provide the predictable, contractually secured revenue stream that makes solar a relatively stable long-term investment.' },
          { question: 'Why does the Solar Investment command a higher target return (21.40%) than Cattle (14.58%) or Short-Term (±13.64%)?', options: ['Solar is safer than the other products, justifying higher returns', 'The higher return reflects the 7-year lock-up premium, larger infrastructure scale, and inflation-linked structure', 'Solar investments are unregulated, allowing higher returns without disclosure', 'It is a government-subsidised return that does not depend on market performance'], correct: 1, explanation: 'The 21.40% target reflects three premia: (1) 7-year illiquidity — investors cannot access capital for the full term; (2) infrastructure scale — larger commercial deployments with R10,000+ minimums; (3) inflation-linkage — solar tariff structures can keep pace with CPI.' },
        ],
      },
      {
        module_index: 2, title: 'How Solar Infrastructure Returns Are Generated', estimated_minutes: 19, xp_reward: 77,
        content: `<h3>From Capital to Current: The Solar Value Chain</h3><p>Understanding exactly how your client's R10,000+ generates a 21.40% p.a. return over 7 years is essential. Unlike the cattle product (which has a clear biological cycle) or the short-term product (which has a 5-month funding cycle), the Solar Investment operates on an infrastructure model — capital is deployed into a physical asset that generates revenue continuously over years.</p><h3>The Infrastructure Model</h3><p>Commercial solar installations are built to generate electricity for specific business customers under long-term contracts. The investment structure works as follows:</p><p><strong>1. Capital Deployment:</strong> Investor capital is pooled and used to fund the construction or acquisition of commercial solar infrastructure. This infrastructure — rooftop or ground-mounted solar panels, inverters, cabling, and monitoring systems — is a physical, real-world asset with tangible and insurable value.</p><p><strong>2. Energy Generation & Revenue:</strong> Once operational, the solar installation generates electricity sold to the commercial offtake customer under a Power Purchase Agreement. The energy tariff (often with CPI escalation clauses) creates a regular, contracted revenue stream.</p><p><strong>3. Returns Accumulating Over 7 Years:</strong> Over the 7-year investment term, returns accumulate from the ongoing PPA revenue. The target of 21.40% p.a. reflects the annual yield from this revenue stream after operational costs, management fees, and the required return to investors.</p><p><strong>4. Capital + Returns at Maturity:</strong> At the end of the 7-year term, investors receive their original capital plus accumulated applicable returns — the full cycle of the infrastructure investment realised.</p><h3>The R200M+ Portfolio Context</h3><p>SV Capital manages R200M+ in assets across productive real assets. Solar forms a key part of the Renewable Energy pillar within the R450M strategic product architecture — targeted at R20M AUM in the near term and scaling as part of the broader platform transition. When you sell the Solar Investment, you're contributing to the growth of this pillar and its long-term institutional credibility.</p><h3>Asset Protection: What Backs the Investment</h3><p>The Solar Investment is backed by physical solar infrastructure assets. These are immovable, tangible assets with a clear commercial purpose and insurable value. Unlike financial instruments backed by a counterparty's creditworthiness, solar infrastructure provides collateral that exists independently of any single business's financial health.</p><p>Key risk factors that clients should be aware of (and that you must disclose): technology performance (panels degrade ~0.5% per year, which is modelled into return projections), regulatory changes (energy policy can affect tariff structures), and operator performance (the company managing the installation's operations).</p>`,
        key_points: [
          'Solar infrastructure generates returns through PPAs — contracted electricity sales over the 7-year term',
          'Solar panels are physical, insurable assets with tangible commercial value — not paper investments',
          'Returns accumulate over 7 years from ongoing PPA revenue; capital plus returns paid at maturity',
          'Solar forms SV Capital\'s Renewable Energy pillar within the R450M strategic product architecture',
          'Key risks to disclose: panel degradation (~0.5%/year, modelled in), regulatory changes, and operator performance',
        ],
        quiz: [
          { question: 'How does the Solar Investment generate its 21.40% p.a. target return?', options: ['Through daily electricity spot-market trading on the JSE', 'Through contracted PPA revenue from commercial solar energy sales, accumulating over the 7-year infrastructure cycle', 'Through quarterly dividends from listed solar companies on the JSE', 'Through cattle sales and agricultural income linked to seasonal crop cycles'], correct: 1, explanation: 'Returns come from Power Purchase Agreements — commercial electricity sales contracts that generate regular revenue from the solar installation over the full 7-year term. This contracted revenue model is what makes solar a relatively predictable long-term investment.' },
          { question: 'What is the approximate annual degradation rate of solar panels, and why is it important to know?', options: ['5% per year — this is why returns decline sharply after year 3', '~0.5% per year — this is modelled into the return projections so it does not surprise investors', '0% — modern panels do not degrade', '10% per year — this is the primary risk in the Solar Investment'], correct: 1, explanation: 'Solar panels degrade at approximately 0.5% per year in output efficiency. This is a known, predictable factor that is modelled into the 21.40% p.a. return projections — so it doesn\'t represent a hidden risk, but it is a material fact advisors should be able to explain.' },
          { question: 'Why is physical solar infrastructure considered a stronger collateral base than a financial instrument?', options: ['Physical assets always increase in value', 'Solar infrastructure exists independently of any single counterparty\'s credit risk — it is a real, insurable, productive asset', 'Physical assets are exempt from FSCA regulation', 'Solar panels are the only government-insured investment class in South Africa'], correct: 1, explanation: 'Unlike bonds or financial instruments whose value depends on a counterparty\'s ability to pay, solar infrastructure exists as a tangible, productive asset. It can generate revenue independently and has insurable physical value — separating it from counterparty credit risk.' },
        ],
      },
      {
        module_index: 3, title: 'Matching Solar to the Right Client & Building Long-Term Relationships', estimated_minutes: 18, xp_reward: 77,
        content: `<h3>Who Should Invest in Solar?</h3><p>The Solar Investment's 7-year term and R10,000+ minimum mean it targets a specific client profile. Matching this product correctly is one of your most important advisory responsibilities under FAIS.</p><p><strong>Ideal Client Profile 1 — The Long-Horizon Wealth Builder:</strong> A client aged 25–50 with long-term wealth accumulation goals who is not dependent on the invested capital for near-term expenses. The 7-year commitment aligns with their investment horizon, and 21.40% p.a. delivers material wealth compounding over that period.</p><p><strong>Ideal Client Profile 2 — The Inflation-Conscious Saver:</strong> A client concerned that inflation (currently 4–6% p.a. in South Africa) is eroding their savings. With inflation-linked revenue structures, the Solar Investment is designed to outpace inflation by a significant margin over 7 years — a powerful narrative for clients watching purchasing power decline.</p><p><strong>Ideal Client Profile 3 — The ESG-Motivated Investor:</strong> Many HNW clients actively look for investments that align with environmental or social values. Solar energy is inherently an ESG-compatible investment — it reduces carbon emissions, supports South Africa's energy transition, and creates jobs in the renewable energy sector.</p><p><strong>Profile to Approach with Caution:</strong> Clients who may need the invested capital within 7 years (e.g., funding a child's university education in 3 years, purchasing property in 4 years). The 7-year lock-up must be compatible with their full financial picture before you recommend Solar.</p><h3>Handling the "7 Years is Too Long" Objection</h3><p>This is the most common objection to the Solar Investment. The effective response combines three elements:</p><ol><li><strong>Reframe the horizon:</strong> "Seven years sounds long, but most people don't touch their pension funds for 20–30 years and earn 8–10%. You're achieving more than double that return for just 7 years of commitment."</li><li><strong>Contextualise with real outcomes:</strong> "On R100,000, targeting 21.40% p.a. compounded over 7 years means your total return at maturity could be significantly above your principal — let me show you what the numbers look like."</li><li><strong>Portfolio balance:</strong> "This doesn't have to be your only SV Capital product. Many clients run Short-Term or Cattle alongside Solar — so they have shorter-cycle liquidity while Solar builds long-term wealth."</li></ol><h3>The Bigger Picture: SV Capital's Energy Strategy</h3><p>The Solar Investment is not just a product — it's a statement about where South Africa's economy is going. By FY28 (Portfolio Diversification phase), SV Capital targets systematic expansion of its Renewable Energy pillar. Clients who invest now are participating in the foundation of that growth story. When you present Solar, you're selling a vision of Africa's energy future — not just a return percentage.</p><h3>FAIS Obligations for Solar</h3><p>Because of the 7-year term and larger minimum investment, Solar conversations carry heightened advisory responsibility. Always: document the client's risk profile before recommending, ensure they understand capital is not liquid for 7 years, disclose that returns are subject to investment documentation and underlying infrastructure performance, and confirm they have sufficient liquid savings outside this investment for their near-term needs.</p>`,
        key_points: [
          'Ideal Solar clients: long-horizon wealth builders, inflation-conscious savers, and ESG-motivated investors',
          'Approach with caution: clients who may need the invested capital within the 7-year term',
          'Reframe the 7-year objection: compare to pension funds, show real rand outcomes, and offer a portfolio balance approach',
          'FAIS obligation: always document risk profile, confirm capital can be locked for 7 years, and disclose all material risks',
          'Selling Solar means selling SV Capital\'s long-term energy vision — a powerful narrative for sophisticated clients',
        ],
        quiz: [
          { question: 'Which client is LEAST suited to the Solar Investment as a standalone recommendation?', options: ['A 35-year-old with R50,000 in savings they won\'t need for 10 years', 'A 45-year-old HNW investor building a diversified long-term portfolio', 'A 40-year-old who needs R100,000 in 3 years to fund their child\'s university fees', 'An ESG-conscious investor who wants exposure to South Africa\'s energy transition'], correct: 2, explanation: 'A client who needs R100,000 in 3 years cannot lock capital in a 7-year Solar Investment. Under FAIS, suitability requires confirming the client has adequate liquidity outside the investment for their near-term financial needs.' },
          { question: 'A prospect says "7 years is too long." What is the MOST effective response?', options: ['"You\'re right — maybe this isn\'t for you. Let me show you the Cattle Investment instead."', '"Reframe: pension funds lock capital for 20–30 years at 8–10%. Solar delivers more than double that return for just 7 years — and you can balance it with shorter-cycle products."', '"The 7-year term is mandatory — no exceptions. Would you like to invest?"', '"We can reduce the term to 5 years if you invest more than R50,000."'], correct: 1, explanation: 'Effective objection handling reframes the concern rather than surrendering or misrepresenting the product. Comparing to pension fund time horizons and returns contextualises 7 years as a reasonable commitment for the reward — and offering a portfolio balance approach removes the "all or nothing" pressure.' },
          { question: 'What additional FAIS obligation applies to Solar Investment recommendations compared to lower-minimum products?', options: ['No additional obligations — all products carry the same advisory requirements', 'Because of the 7-year term and larger minimum, you must document the client\'s risk profile, confirm the capital can be locked for 7 years, and ensure sufficient liquid savings remain outside the investment', 'Solar is exempt from FAIS because it is an infrastructure product', 'You only need verbal confirmation that the client understands the term'], correct: 1, explanation: 'The larger minimum and longer term heighten your FAIS advisory duty. Document the risk profile, confirm 7-year liquidity tolerance, disclose all material risks in writing, and verify the client retains adequate liquid savings outside the Solar Investment for their near-term needs.' },
        ],
      },
    ],
  },
];

async function seedStandardCourses(pool) {
  try {
    let seeded = 0;
    for (const course of STANDARD_COURSES) {
      const { modules, ...courseData } = course;
      const { rowCount } = await pool.query(
        `INSERT INTO employee_courses
           (id, title, description, category, difficulty, estimated_minutes, xp_reward,
            role_target, kpi_dimension, kpi_boost_points, modules_count, quiz_questions,
            pass_score, is_required, is_active, thumbnail_icon, thumbnail_color,
            learning_objectives, ai_generated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING`,
        [courseData.id, courseData.title, courseData.description, courseData.category,
         courseData.difficulty, courseData.estimated_minutes, courseData.xp_reward,
         courseData.role_target, courseData.kpi_dimension, courseData.kpi_boost_points,
         courseData.modules_count, courseData.quiz_questions, courseData.pass_score,
         courseData.is_required, true, courseData.thumbnail_icon, courseData.thumbnail_color,
         courseData.learning_objectives, false]
      );
      if (rowCount > 0) {
        for (const m of modules) {
          await pool.query(
            `INSERT INTO course_modules
               (course_id, module_index, title, estimated_minutes, xp_reward, content, key_points, quiz)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT DO NOTHING`,
            [courseData.id, m.module_index, m.title, m.estimated_minutes, m.xp_reward,
             m.content, JSON.stringify(m.key_points), JSON.stringify(m.quiz)]
          );
        }
        seeded++;
      }
    }
    if (seeded > 0) console.log(`✅ Standard courses seeded: ${seeded} new course(s).`);
  } catch (err) {
    console.warn('⚠️  Standard course seed warning:', err.message);
  }
}

module.exports = autoSetup;
