/* ═══════════════════════════════════════════════════════
   Database Migration — Creates all SV Capital tables
   Run: node db/migrate.js
   ═══════════════════════════════════════════════════════ */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool = require('./pool');

const schema = `

/* ─── USERS (authentication) ─── */
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
  investor_id   TEXT,   -- links to investors table
  ifa_id        TEXT,   -- links to ifas table
  staff_pin     TEXT    -- hashed PIN for staff login
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_role_idx  ON users(role);

/* ─── INVESTORS ─── */
CREATE TABLE IF NOT EXISTS investors (
  id                  TEXT PRIMARY KEY,
  first_name          TEXT,
  last_name           TEXT,
  email               TEXT,
  phone               TEXT,
  id_number           TEXT,
  date_of_birth       TEXT,
  province            TEXT,
  address             TEXT,
  occupation          TEXT,
  employer            TEXT,
  risk_profile        TEXT DEFAULT 'moderate'
                        CHECK (risk_profile IN ('conservative','moderate','aggressive')),
  kyc_status          TEXT DEFAULT 'pending'
                        CHECK (kyc_status IN ('pending','verified','rejected','expired')),
  status              TEXT DEFAULT 'active'
                        CHECK (status IN ('active','pending','suspended')),
  wallet_balance      NUMERIC(18,2) DEFAULT 0,
  total_invested      NUMERIC(18,2) DEFAULT 0,
  total_returns       NUMERIC(18,2) DEFAULT 0,
  referral_code       TEXT,
  referred_by         TEXT,
  ifa_id              TEXT,
  date_joined         TIMESTAMPTZ DEFAULT NOW(),
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

/* ─── INVESTMENT POOLS ─── */
CREATE TABLE IF NOT EXISTS investment_pools (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  product_type    TEXT NOT NULL
                    CHECK (product_type IN ('cattle','solar','smme','delivery_bikes','other')),
  status          TEXT DEFAULT 'open'
                    CHECK (status IN ('open','closed','paid_out','cancelled')),
  target_amount   NUMERIC(18,2) DEFAULT 0,
  raised_amount   NUMERIC(18,2) DEFAULT 0,
  min_investment  NUMERIC(18,2) DEFAULT 1000,
  max_investment  NUMERIC(18,2),
  annual_rate     NUMERIC(8,4) DEFAULT 0,
  term_months     INT DEFAULT 6,
  start_date      DATE,
  end_date        DATE,
  description     TEXT,
  risk_level      TEXT DEFAULT 'medium'
                    CHECK (risk_level IN ('low','medium','high')),
  investor_count  INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ─── INVESTMENTS ─── */
CREATE TABLE IF NOT EXISTS investments (
  id              TEXT PRIMARY KEY,
  investor_id     TEXT REFERENCES investors(id) ON DELETE CASCADE,
  pool_id         TEXT REFERENCES investment_pools(id) ON DELETE SET NULL,
  amount          NUMERIC(18,2) NOT NULL,
  status          TEXT DEFAULT 'active'
                    CHECK (status IN ('active','matured','cancelled','pending')),
  start_date      DATE,
  end_date        DATE,
  expected_return NUMERIC(18,2) DEFAULT 0,
  actual_return   NUMERIC(18,2) DEFAULT 0,
  annual_rate     NUMERIC(8,4) DEFAULT 0,
  product_type    TEXT,
  term_months     INT,
  payout_option   TEXT DEFAULT 'reinvest'
                    CHECK (payout_option IN ('reinvest','withdraw','partial')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS investments_investor_idx ON investments(investor_id);
CREATE INDEX IF NOT EXISTS investments_pool_idx     ON investments(pool_id);

/* ─── TRANSACTIONS ─── */
CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  investor_id   TEXT REFERENCES investors(id) ON DELETE CASCADE,
  type          TEXT NOT NULL
                  CHECK (type IN ('deposit','withdrawal','investment','return','fee','transfer','refund')),
  amount        NUMERIC(18,2) NOT NULL,
  status        TEXT DEFAULT 'completed'
                  CHECK (status IN ('pending','completed','failed','cancelled')),
  reference     TEXT,
  description   TEXT,
  investment_id TEXT,
  pool_id       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_investor_idx ON transactions(investor_id);
CREATE INDEX IF NOT EXISTS transactions_type_idx     ON transactions(type);

/* ─── KYC DOCUMENTS ─── */
CREATE TABLE IF NOT EXISTS kyc_documents (
  id            TEXT PRIMARY KEY,
  investor_id   TEXT REFERENCES investors(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL
                  CHECK (doc_type IN ('id_document','proof_of_address','bank_statement','selfie','tax_certificate','other')),
  status        TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  file_url      TEXT,
  file_name     TEXT,
  notes         TEXT,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  submitted_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ─── MATURITY INSTRUCTIONS ─── */
CREATE TABLE IF NOT EXISTS maturity_instructions (
  id              TEXT PRIMARY KEY,
  investor_id     TEXT REFERENCES investors(id) ON DELETE CASCADE,
  investment_id   TEXT,
  instruction     TEXT NOT NULL
                    CHECK (instruction IN ('reinvest','withdraw','partial_reinvest')),
  amount          NUMERIC(18,2),
  bank_account    TEXT,
  bank_name       TEXT,
  account_holder  TEXT,
  account_number  TEXT,
  branch_code     TEXT,
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','processed','cancelled')),
  notes           TEXT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ─── SUPPORT TICKETS ─── */
CREATE TABLE IF NOT EXISTS support_tickets (
  id            TEXT PRIMARY KEY,
  investor_id   TEXT REFERENCES investors(id) ON DELETE CASCADE,
  subject       TEXT NOT NULL,
  message       TEXT,
  category      TEXT DEFAULT 'general'
                  CHECK (category IN ('general','investment','withdrawal','kyc','technical','complaint','other')),
  priority      TEXT DEFAULT 'medium'
                  CHECK (priority IN ('low','medium','high','urgent')),
  status        TEXT DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to   TEXT,
  response      TEXT,
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ─── PLATFORM SETTINGS ─── */
CREATE TABLE IF NOT EXISTS platform_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT,
  description   TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ─── IFAs ─── */
CREATE TABLE IF NOT EXISTS ifas (
  id                TEXT PRIMARY KEY,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT UNIQUE,
  phone             TEXT,
  license_number    TEXT,
  company_name      TEXT,
  status            TEXT DEFAULT 'active'
                      CHECK (status IN ('active','inactive','suspended')),
  commission_rate   NUMERIC(6,4) DEFAULT 1.5,
  assigned_clients  JSONB DEFAULT '[]',
  aum_managed       NUMERIC(18,2) DEFAULT 0,
  date_joined       TIMESTAMPTZ DEFAULT NOW(),
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

/* ─── FUND RUNS ─── */
CREATE TABLE IF NOT EXISTS fund_runs (
  id                TEXT PRIMARY KEY,
  run_name          TEXT NOT NULL,
  product_type      TEXT NOT NULL
                      CHECK (product_type IN ('cattle','solar','smme','delivery_bikes','other')),
  status            TEXT DEFAULT 'draft'
                      CHECK (status IN ('draft','in_progress','completed','cancelled')),
  principal_amount  NUMERIC(18,2) DEFAULT 0,
  annual_rate       NUMERIC(8,6) DEFAULT 0,
  term_days         INT DEFAULT 183,
  start_date        DATE,
  end_date          DATE,
  gross_return      NUMERIC(18,2) DEFAULT 0,
  management_fee    NUMERIC(18,2) DEFAULT 0,
  performance_fee   NUMERIC(18,2) DEFAULT 0,
  structuring_fee   NUMERIC(18,2) DEFAULT 0,
  admin_fee         NUMERIC(18,2) DEFAULT 0,
  total_fees        NUMERIC(18,2) DEFAULT 0,
  net_return        NUMERIC(18,2) DEFAULT 0,
  total_payout      NUMERIC(18,2) DEFAULT 0,
  investor_count    INT DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

/* ─── RETURN SCHEDULES ─── */
CREATE TABLE IF NOT EXISTS return_schedules (
  id              TEXT PRIMARY KEY,
  fund_run_id     TEXT REFERENCES fund_runs(id) ON DELETE CASCADE,
  investor_id     TEXT REFERENCES investors(id) ON DELETE CASCADE,
  amount_invested NUMERIC(18,2),
  expected_return NUMERIC(18,2),
  gross_return    NUMERIC(18,2),
  fees            NUMERIC(18,2),
  net_return      NUMERIC(18,2),
  expected_date   DATE,
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','overdue','cancelled')),
  paid_at         TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ─── AUDIT EVENTS ─── */
CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email  TEXT,
  description TEXT,
  ip_address  TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id);

/* ─── INVESTOR ALLOCATIONS ─── */
CREATE TABLE IF NOT EXISTS investor_allocations (
  id              TEXT PRIMARY KEY,
  fund_run_id     TEXT REFERENCES fund_runs(id) ON DELETE CASCADE,
  investor_id     TEXT REFERENCES investors(id) ON DELETE CASCADE,
  investment_id   TEXT,
  amount          NUMERIC(18,2),
  nav_share       NUMERIC(10,6),
  gross_return    NUMERIC(18,2),
  net_return      NUMERIC(18,2),
  fees            NUMERIC(18,2),
  status          TEXT DEFAULT 'active'
                    CHECK (status IN ('active','paid','cancelled')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ─── FEE LEDGER ─── */
CREATE TABLE IF NOT EXISTS fee_ledger (
  id            TEXT PRIMARY KEY,
  fund_run_id   TEXT REFERENCES fund_runs(id) ON DELETE CASCADE,
  fee_type      TEXT NOT NULL
                  CHECK (fee_type IN ('management','performance','structuring','admin','other')),
  amount        NUMERIC(18,2) NOT NULL,
  rate          NUMERIC(8,6),
  basis         TEXT,
  description   TEXT,
  accrued_at    DATE,
  status        TEXT DEFAULT 'accrued'
                  CHECK (status IN ('accrued','collected','waived')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ─── FUND NOTIFICATIONS ─── */
CREATE TABLE IF NOT EXISTS fund_notifications (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL
                  CHECK (type IN ('overdue','maturity','liquidity','compliance','general','alert')),
  title         TEXT NOT NULL,
  message       TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  is_read       BOOLEAN DEFAULT false,
  priority      TEXT DEFAULT 'medium'
                  CHECK (priority IN ('low','medium','high','critical')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ─── CATTLE COSTS ─── */
CREATE TABLE IF NOT EXISTS cattle_costs (
  id            TEXT PRIMARY KEY,
  cycle_id      TEXT,
  category      TEXT NOT NULL
                  CHECK (category IN ('feed','vet','transport','labour','mortality','purchase','other')),
  amount        NUMERIC(18,2) NOT NULL,
  description   TEXT,
  date          DATE,
  vendor        TEXT,
  invoice_ref   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ─── STAFF / EMPLOYEES ─── */
CREATE TABLE IF NOT EXISTS employees (
  id            TEXT PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL
                  CHECK (role IN ('director','admin','fund_manager','ifa','analyst','support','sales')),
  department    TEXT,
  status        TEXT DEFAULT 'active'
                  CHECK (status IN ('active','inactive','onboarding','suspended')),
  pin_hash      TEXT,
  hire_date     DATE,
  notes         TEXT,
  permissions   JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS employees_email_idx ON employees(email);

/* ─── ACCEPTED CLIENT DOCUMENTS ─── */
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

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');
    await client.query(schema);
    console.log('✅ All tables created successfully.');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
