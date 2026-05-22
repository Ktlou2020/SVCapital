/* ═══════════════════════════════════════════════════════
   Seed Script — populates all tables with demo data
   Run: node db/seed.js
   ═══════════════════════════════════════════════════════ */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const pool    = require('./pool');
const bcrypt  = require('bcryptjs');

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding database...');
    await client.query('BEGIN');

    /* ─── USERS ─── */
    const adminHash    = await bcrypt.hash('Admin@2024!', 12);
    const investorHash = await bcrypt.hash('Demo@2024!', 12);
    const ifaHash      = await bcrypt.hash('ifa123', 12);

    await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, investor_id)
      VALUES
        ('admin@svcapital.co.za',    $1, 'admin',    'Ayanda',  'Dlamini',  NULL),
        ('director@svcapital.co.za', $1, 'director', 'Sarah',   'Van Wyk',  NULL),
        ('investor@svcapital.co.za', $2, 'investor', 'Thabo',   'Nkosi',    'INV-001'),
        ('thabo@email.co.za',        $2, 'investor', 'Thabo',   'Nkosi',    'INV-001'),
        ('priya@email.co.za',        $2, 'investor', 'Priya',   'Naidoo',   'INV-002'),
        ('sipho@email.co.za',        $2, 'investor', 'Sipho',   'Zulu',     'INV-003'),
        ('maria@email.co.za',        $2, 'investor', 'Maria',   'Santos',   'INV-004'),
        ('james@email.co.za',        $2, 'investor', 'James',   'Mokoena',  'INV-005'),
        ('ifa@svcapital.co.za',      $3, 'ifa',      'Bongani', 'Khumalo',  NULL)
      ON CONFLICT (email) DO NOTHING
    `, [adminHash, investorHash, ifaHash]);

    /* ─── INVESTORS ─── */
    await client.query(`
      INSERT INTO investors
        (id, first_name, last_name, email, phone, id_number, province, occupation,
         risk_profile, kyc_status, status, wallet_balance, total_invested, total_returns,
         referral_code, date_joined)
      VALUES
        ('INV-001','Thabo','Nkosi','thabo@email.co.za','082 123 4567','8801015800082','Gauteng','Engineer','moderate','verified','active',45000,250000,31200,'SVC001','2023-01-15'),
        ('INV-002','Priya','Naidoo','priya@email.co.za','071 234 5678','9203026100083','KwaZulu-Natal','Doctor','conservative','verified','active',12500,180000,22000,'SVC002','2023-03-01'),
        ('INV-003','Sipho','Zulu','sipho@email.co.za','065 345 6789','7706016200084','Western Cape','Teacher','moderate','verified','active',8000,95000,11800,'SVC003','2023-06-20'),
        ('INV-004','Maria','Santos','maria@email.co.za','083 456 7890','9512056300085','Gauteng','Accountant','aggressive','pending','active',22000,320000,48500,'SVC004','2023-09-05'),
        ('INV-005','James','Mokoena','james@email.co.za','076 567 8901','8804016400086','Limpopo','Entrepreneur','moderate','verified','active',5500,75000,9200,'SVC005','2024-01-10')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── INVESTMENT POOLS ─── */
    await client.query(`
      INSERT INTO investment_pools
        (id, name, product_type, status, target_amount, raised_amount, min_investment, annual_rate,
         term_months, start_date, end_date, description, risk_level, investor_count)
      VALUES
        ('POOL-001','Cattle Finance Q1 2024','cattle','closed',2000000,1980000,5000,0.1483,6,'2024-01-01','2024-07-01','6-month cattle finance cycle — Limpopo region.','medium',8),
        ('POOL-002','Solar Energy 7-Year','solar','open',5000000,3250000,10000,0.2140,84,'2024-03-01','2031-03-01','Premium 7-year solar PPA — guaranteed offtake.','low',12),
        ('POOL-003','SMME Short-Term Q2','smme','open',1000000,870000,1000,0.1392,5,'2024-04-01','2024-09-01','Short-term SMME bridge lending.','high',15),
        ('POOL-004','Delivery Bikes Cycle 3','delivery_bikes','open',1500000,1100000,2500,0.1600,12,'2024-02-01','2025-02-01','E-commerce delivery fleet.','medium',10),
        ('POOL-005','Cattle Finance Q2 2024','cattle','open',2500000,1200000,5000,0.1500,6,'2024-07-01','2025-01-01','Second cattle cycle — expanded Mpumalanga herd.','medium',5),
        ('POOL-006','Solar Energy 5-Year','solar','open',3000000,750000,10000,0.0641,60,'2024-06-01','2029-06-01','Community solar energy 5-year PPA.','low',7),
        ('POOL-007','SMME Q3 Batch','smme','open',800000,400000,1000,0.1392,5,'2024-08-01','2025-01-01','Q3 SMME lending pool.','high',9),
        ('POOL-008','Solar 6-Year Premium','solar','open',4000000,500000,10000,0.1553,72,'2024-09-01','2030-09-01','6-year solar with mid-term liquidity window.','low',3),
        ('POOL-009','Cattle Q3 — Karoo Region','cattle','open',1800000,200000,5000,0.1483,6,'2024-10-01','2025-04-01','Karoo region merino cattle cycle.','medium',2),
        ('POOL-010','Delivery Bikes Cycle 4','delivery_bikes','open',2000000,100000,2500,0.1800,12,'2024-11-01','2025-11-01','Expanded fleet — last-mile logistics.','medium',1)
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── INVESTMENTS ─── */
    await client.query(`
      INSERT INTO investments
        (id, investor_id, pool_id, amount, status, start_date, end_date,
         expected_return, actual_return, annual_rate, product_type, term_months, payout_option)
      VALUES
        ('INV-TXN-001','INV-001','POOL-001',100000,'matured','2024-01-15','2024-07-15',7415,7415,0.1483,'cattle',6,'reinvest'),
        ('INV-TXN-002','INV-001','POOL-002',75000,'active','2024-03-01',NULL,16050,0,0.2140,'solar',84,'withdraw'),
        ('INV-TXN-003','INV-001','POOL-004',50000,'active','2024-02-01',NULL,8000,0,0.1600,'delivery_bikes',12,'reinvest'),
        ('INV-TXN-004','INV-002','POOL-001',80000,'matured','2024-01-15','2024-07-15',5932,5932,0.1483,'cattle',6,'withdraw'),
        ('INV-TXN-005','INV-002','POOL-002',60000,'active','2024-03-01',NULL,12840,0,0.2140,'solar',84,'reinvest'),
        ('INV-TXN-006','INV-003','POOL-003',30000,'active','2024-04-01',NULL,1741.5,0,0.1392,'smme',5,'withdraw'),
        ('INV-TXN-007','INV-003','POOL-004',40000,'active','2024-02-01',NULL,6400,0,0.1600,'delivery_bikes',12,'reinvest'),
        ('INV-TXN-008','INV-004','POOL-002',150000,'active','2024-03-01',NULL,32100,0,0.2140,'solar',84,'reinvest'),
        ('INV-TXN-009','INV-004','POOL-001',100000,'matured','2024-01-15','2024-07-15',7415,7415,0.1483,'cattle',6,'reinvest'),
        ('INV-TXN-010','INV-005','POOL-003',25000,'active','2024-04-01',NULL,1451.25,0,0.1392,'smme',5,'withdraw')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── TRANSACTIONS ─── */
    await client.query(`
      INSERT INTO transactions
        (id, investor_id, type, amount, status, reference, description, created_at)
      VALUES
        ('TXN-001','INV-001','deposit',100000,'completed','DEP-001','Initial deposit','2024-01-10'),
        ('TXN-002','INV-001','investment',100000,'completed','INV-TXN-001','Cattle Finance Q1 investment','2024-01-15'),
        ('TXN-003','INV-001','deposit',75000,'completed','DEP-002','Deposit for solar investment','2024-02-25'),
        ('TXN-004','INV-001','investment',75000,'completed','INV-TXN-002','Solar 7-Year investment','2024-03-01'),
        ('TXN-005','INV-001','return',7415,'completed','RET-001','Cattle Q1 return paid','2024-07-16'),
        ('TXN-006','INV-001','deposit',50000,'completed','DEP-003','Delivery bikes investment deposit','2024-01-28'),
        ('TXN-007','INV-001','investment',50000,'completed','INV-TXN-003','Delivery Bikes Cycle 3','2024-02-01'),
        ('TXN-008','INV-002','deposit',80000,'completed','DEP-004','INV-002 initial deposit','2024-01-10'),
        ('TXN-009','INV-002','investment',80000,'completed','INV-TXN-004','Cattle Finance Q1','2024-01-15'),
        ('TXN-010','INV-002','return',5932,'completed','RET-002','Cattle Q1 return paid','2024-07-16'),
        ('TXN-011','INV-002','deposit',60000,'completed','DEP-005','Solar investment deposit','2024-02-25'),
        ('TXN-012','INV-002','investment',60000,'completed','INV-TXN-005','Solar 7-Year','2024-03-01'),
        ('TXN-013','INV-003','deposit',70000,'completed','DEP-006','INV-003 deposit','2024-01-20'),
        ('TXN-014','INV-003','investment',30000,'completed','INV-TXN-006','SMME Short-Term','2024-04-01'),
        ('TXN-015','INV-003','investment',40000,'completed','INV-TXN-007','Delivery Bikes','2024-02-01')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── KYC DOCUMENTS ─── */
    await client.query(`
      INSERT INTO kyc_documents
        (id, investor_id, doc_type, status, file_name, submitted_at)
      VALUES
        ('KYC-001','INV-001','id_document','approved','thabo_id.pdf','2024-01-10'),
        ('KYC-002','INV-001','proof_of_address','approved','thabo_poa.pdf','2024-01-10'),
        ('KYC-003','INV-002','id_document','approved','priya_id.pdf','2024-03-01'),
        ('KYC-004','INV-002','proof_of_address','approved','priya_poa.pdf','2024-03-01'),
        ('KYC-005','INV-004','id_document','pending','maria_id.pdf','2024-09-05'),
        ('KYC-006','INV-004','proof_of_address','pending','maria_poa.pdf','2024-09-05')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── SUPPORT TICKETS ─── */
    await client.query(`
      INSERT INTO support_tickets
        (id, investor_id, subject, message, category, priority, status, created_at)
      VALUES
        ('TKT-001','INV-001','When will my returns be paid?','Cattle Q1 matured — waiting for return.','investment','medium','resolved','2024-07-14'),
        ('TKT-002','INV-002','KYC document upload issue','Cannot upload bank statement.','kyc','high','resolved','2024-03-15'),
        ('TKT-003','INV-003','Solar pool availability','Are there more solar pools opening?','investment','low','open','2024-07-20'),
        ('TKT-004','INV-004','Account verification pending','My account shows pending for 3 weeks.','kyc','high','in_progress','2024-09-20')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── MATURITY INSTRUCTIONS ─── */
    await client.query(`
      INSERT INTO maturity_instructions
        (id, investor_id, investment_id, instruction, status, created_at)
      VALUES
        ('MAT-001','INV-001','INV-TXN-002','reinvest','pending','2024-06-01'),
        ('MAT-002','INV-001','INV-TXN-003','withdraw','pending','2024-01-20'),
        ('MAT-003','INV-002','INV-TXN-004','withdraw','processed','2024-07-15'),
        ('MAT-004','INV-003','INV-TXN-006','withdraw','pending','2024-08-20')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── PLATFORM SETTINGS ─── */
    await client.query(`
      INSERT INTO platform_settings (key, value, description)
      VALUES
        ('platform_name',       'SV Capital',                     'Platform display name'),
        ('company_name',        'SmartVest Financial Services',   'Legal company name'),
        ('fsp_number',          'FSP #52449',                     'FSCA FSP licence number'),
        ('support_email',       'support@svcapital.co.za',        'Support email address'),
        ('min_investment',      '1000',                           'Global minimum investment (ZAR)'),
        ('kyc_required',        'true',                           'KYC required before investment'),
        ('maintenance_mode',    'false',                          'Put platform in maintenance mode'),
        ('currency',            'ZAR',                            'Platform currency'),
        ('timezone',            'Africa/Johannesburg',            'Platform timezone'),
        ('session_timeout_hrs', '8',                              'JWT session timeout in hours')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);

    /* ─── IFAs ─── */
    await client.query(`
      INSERT INTO ifas
        (id, first_name, last_name, email, phone, license_number, company_name,
         status, commission_rate, assigned_clients, aum_managed, date_joined)
      VALUES
        ('IFA-001','Bongani','Khumalo','bongani@khumalo-wealth.co.za','011 234 5678','FSP-48821','Khumalo Wealth Management','active',1.5,'["INV-001","INV-002"]',430000,'2022-05-01'),
        ('IFA-002','Zanele','Moyo','zanele@moyo-advisory.co.za','021 345 6789','FSP-51234','Moyo Financial Advisory','active',1.2,'["INV-003"]',95000,'2023-01-15'),
        ('IFA-003','Pieter','van der Berg','pieter@vpw.co.za','041 456 7890','FSP-39821','Van der Berg & Partners','active',2.0,'["INV-004"]',320000,'2022-11-20'),
        ('IFA-004','Lindiwe','Dube','lindiwe@dubewealth.co.za','031 567 8901','FSP-62341','Dube Wealth Solutions','inactive',1.5,'[]',0,'2023-07-10'),
        ('IFA-005','Ahmed','Patel','ahmed@patelinvest.co.za','012 678 9012','FSP-44532','Patel Investment Group','active',1.8,'["INV-005"]',75000,'2023-09-01')
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── FUND RUNS ─── */
    await client.query(`
      INSERT INTO fund_runs
        (id, run_name, product_type, status, principal_amount, annual_rate, term_days,
         start_date, end_date, gross_return, management_fee, performance_fee, total_fees,
         net_return, total_payout, investor_count)
      VALUES
        ('FR-001','Cattle Run Q1 2024','cattle','completed',1980000,0.1483,183,'2024-01-01','2024-07-03',147329.7,19800,7366.5,27166.5,120163.2,2100163.2,8),
        ('FR-002','Solar 7yr Fund 2024','solar','in_progress',3250000,0.2140,2555,'2024-03-01',NULL,696700,97500,34835,132335,564365,3814365,12),
        ('FR-003','SMME Q2 2024','smme','in_progress',870000,0.1392,152,'2024-04-01',NULL,50612.16,8700,2530.6,11230.6,39381.56,909381.56,15),
        ('FR-004','Delivery Bikes Cycle 3','delivery_bikes','in_progress',1100000,0.1600,365,'2024-02-01',NULL,176000,16500,8800,25300,150700,1250700,10)
      ON CONFLICT (id) DO NOTHING
    `);

    /* ─── EMPLOYEES ─── */
    const dirPin  = await bcrypt.hash('1234', 12);
    const staffPin = await bcrypt.hash('5678', 12);
    await client.query(`
      INSERT INTO employees
        (id, first_name, last_name, email, role, department, status, pin_hash, hire_date)
      VALUES
        ('EMP-001','Ayanda','Dlamini','ayanda@svcapital.co.za','admin','Operations','active',$1,'2022-01-15'),
        ('EMP-002','Sarah','Van Wyk','sarah@svcapital.co.za','director','Executive','active',$1,'2021-06-01'),
        ('EMP-003','Kagiso','Sithole','kagiso@svcapital.co.za','analyst','Finance','active',$2,'2023-03-10'),
        ('EMP-004','Nandi','Msomi','nandi@svcapital.co.za','support','Customer Service','active',$2,'2023-07-01')
      ON CONFLICT (id) DO NOTHING
    `, [dirPin, staffPin]);

    await client.query('COMMIT');
    console.log('✅ Seed data inserted successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

seed();
