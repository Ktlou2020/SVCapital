'use strict';
/* ═══════════════════════════════════════════════════════════════
   Firebase → SV Capital Migration Script
   ───────────────────────────────────────────────────────────────
   Usage:
     1. Create a folder: migration-data/ in the project root
     2. Copy the 6 export files into it with these exact names:
          users.json
          investmentPools.json
          investments.json
          transactions.json
          bankAccounts.json
          addressDetails.json
     3. Make sure DATABASE_URL is set in your environment
     4. Run:  node server/scripts/migrate-from-firebase.js
   ═══════════════════════════════════════════════════════════════ */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const pool = require('../db/pool');

const DATA_DIR = path.join(__dirname, '../../migration-data');

/* ─── Field mappings ─── */
const PRODUCT_TYPE_MAP = {
  'Delivery Bike Investment':   'delivery_bikes',
  'Short Term Investment':      'smme',
  'Cattle Investment':          'cattle',
  'Solar Investment - 5 Years': 'solar',
  'Solar Investment - 6 Years': 'solar',
  'Solar Investment - 7 Years': 'solar',
  '12J Investment':             'cattle_12j',
  '12J Cattle Investment':      'cattle_12j',
  'iLobola':                    'ilobola',
  'iLobola Investment':         'ilobola',
};
const PRODUCT_ID_MAP = {
  '0J1g67Ln99nMOct6vnqS': 'delivery_bikes',
  '8r3TlnGkizidu1JCgbDp': 'smme',
  'BjrELvLGvQzTSDt9ztGK': 'solar',
  'Q3R5RN21GWJ4lGCtI72R': 'cattle_12j',
  'SfpCxgJjP6i5GUz1JWYp': 'solar',
  'gSjiuqRg3E8IEO2hwfmu': 'cattle',
  'lwKM2GFyCXNd88l1nCAK': 'ilobola',
  'xKQkwQMa0Hnj0dAmGsWH': 'solar',
};
function resolveProductType(p) {
  return PRODUCT_TYPE_MAP[p.productName]
      || PRODUCT_ID_MAP[p.productId]
      || PRODUCT_TYPE_MAP[p.name]
      || 'other';
}

const POOL_STATUS_MAP = {
  MATURED: 'matured',
  ACTIVE:  'active',
  OPEN:    'open',
  CLOSED:  'closed',
};

const INVESTMENT_STATUS_MAP = {
  MATURED:  'matured',
  ACTIVE:   'active',
  PAID_OUT: 'paid_out',
};

const TX_TYPE_MAP = {
  'INVESTMENT':    'investment',
  'RE-INVESTMENT': 'reinvestment',
  'PAYOUT':        'payout',
  'DEPOSIT':       'deposit',
  'WITHDRAWAL':    'withdrawal',
  'RETURN':        'return',
};

const TX_STATUS_MAP = {
  SUCCESSFUL: 'completed',
  PENDING:    'pending',
  FAILED:     'failed',
};

const KYC_STATUS_MAP = {
  Approved:    'approved',
  Unverified:  'pending',
  Outstanding: 'pending',
  Pending:     'pending',
};

function extractPoolId(p) {
  if (!p) return null;
  // p may be a plain path string "investmentPools/ID" or an object { path: "investmentPools/ID" }
  const str = (typeof p === 'object' && p !== null) ? (p.path || p.id || '') : String(p);
  const parts = str.split('/');
  return parts[parts.length - 1] || null;
}

function loadFile(name) {
  const filePath = path.join(DATA_DIR, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}\nCreate migration-data/ and copy your export files there.`);
  }
  console.log(`  Loading ${name}...`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('❌  DATABASE_URL is not set. Export it before running this script.');
    process.exit(1);
  }

  console.log('📂  Loading export files...');
  const users        = loadFile('users.json');
  const pools        = loadFile('investmentPools.json');
  const investments  = loadFile('investments.json');
  const transactions = loadFile('transactions.json');
  const bankAccounts = loadFile('bankAccounts.json');
  const addresses    = loadFile('addressDetails.json');

  console.log(`\n📊  Counts: ${users.length} users · ${pools.length} pools · ${investments.length} investments · ${transactions.length} transactions · ${bankAccounts.length} bank accounts · ${addresses.length} addresses\n`);

  /* ─── Build lookups ─── */
  // Firebase UID → userAccountNumber
  const uidToAccount = {};
  users.forEach(u => { if (u._id) uidToAccount[u._id] = u.userAccountNumber; });

  // Default bank account per userAccountNumber
  const bankByUser = {};
  bankAccounts.forEach(ba => {
    if (ba.defaultAccount && ba.status === 'ACTIVE' && ba.userAccountNumber) {
      if (!bankByUser[ba.userAccountNumber]) bankByUser[ba.userAccountNumber] = ba;
    }
  });

  // Most-recent address per userAccountNumber
  const addressByUser = {};
  addresses.forEach(a => {
    if (!a.userAccountNumber) return;
    const existing = addressByUser[a.userAccountNumber];
    if (!existing || new Date(a.dateUpdated) > new Date(existing.dateUpdated)) {
      addressByUser[a.userAccountNumber] = a;
    }
  });

  // Pool lookup by original _id
  const poolById = {};
  pools.forEach(p => { if (p._id) poolById[p._id] = p; });
  // Maps original _id → DB pool id (built during pool insert step)
  const sourceIdToPoolId = {};

  let errors = 0;

  /* ══════════════════════════════════════════════════════════════
     STEP 1 — Investors
  ══════════════════════════════════════════════════════════════ */
  console.log('👤  [1/6] Migrating investors...');
  let investorOk = 0;

  for (const u of users) {
    const id = u.userAccountNumber;
    if (!id) continue;

    const bank = bankByUser[id];
    const addr = addressByUser[id];

    // Compute total_invested from investment records
    const myInvestments = investments.filter(i => i.userAccountNumber === id);
    const totalInvested = myInvestments
      .filter(i => ['ACTIVE', 'MATURED', 'PAID_OUT'].includes(i.status))
      .reduce((s, i) => s + (parseFloat(i.investedAmount) || 0), 0);

    // Store bank details in notes as JSON
    const notes = bank ? JSON.stringify({
      bank_name:        bank.bankName,
      account_holder:   bank.accountHolderName,
      account_number:   bank.accountNumber,
      branch_code:      bank.branchNumber,
      bank_proof_url:   bank.proof || null,
    }) : null;

    // Parse name — some records use display_name, others name+surname
    const firstName = u.name  || (u.display_name || '').split(' ')[0] || '';
    const lastName  = u.surname || (u.display_name || '').split(' ').slice(1).join(' ') || '';

    const fullAddress = addr?.fullAddress || null;
    const province    = addr?.province?.trim() || null;

    try {
      await pool.query(`
        INSERT INTO investors
          (id, first_name, last_name, email, phone, id_number, date_of_birth,
           kyc_status, status, wallet_balance, total_invested, risk_profile,
           occupation, notes, address, province, date_joined, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
        ON CONFLICT (id) DO UPDATE SET
          first_name     = EXCLUDED.first_name,
          last_name      = EXCLUDED.last_name,
          email          = EXCLUDED.email,
          phone          = EXCLUDED.phone,
          id_number      = EXCLUDED.id_number,
          date_of_birth  = EXCLUDED.date_of_birth,
          kyc_status     = EXCLUDED.kyc_status,
          status         = EXCLUDED.status,
          wallet_balance = EXCLUDED.wallet_balance,
          total_invested = EXCLUDED.total_invested,
          risk_profile   = EXCLUDED.risk_profile,
          occupation     = EXCLUDED.occupation,
          notes          = EXCLUDED.notes,
          address        = EXCLUDED.address,
          province       = EXCLUDED.province,
          updated_at     = NOW()
      `, [
        id,
        firstName,
        lastName,
        (u.email || '').toLowerCase().trim(),
        u.phone_number || '',
        u.identityNumber || '',
        u.dateOfBirth ? new Date(u.dateOfBirth).toISOString().split('T')[0] : null,
        KYC_STATUS_MAP[u.kycStatus] || 'pending',
        u.status === 'ACTIVE' ? 'active' : 'inactive',
        parseFloat(u.wallet) || 0,
        Math.round(totalInvested * 100) / 100,
        (u.riskTolerence || 'Moderate').toLowerCase(),
        u.employmentStatus || null,
        notes,
        fullAddress,
        province,
        u.created_time ? new Date(u.created_time) : new Date(),
      ]);
      investorOk++;
    } catch (err) {
      console.error(`  ✗ investor ${id}: ${err.message}`);
      errors++;
    }
  }
  console.log(`  ✓ ${investorOk} investors imported\n`);

  /* ══════════════════════════════════════════════════════════════
     STEP 2 — Investment pools
  ══════════════════════════════════════════════════════════════ */
  console.log('🏊  [2/6] Migrating investment pools...');
  let poolOk = 0;

  for (const p of pools) {
    if (!p._id) continue;
    const id          = `POOL-MIGR-${p._id}`;
    const productType = resolveProductType(p);

    let termMonths = null;
    if (p.launchDate && p.maturityDate) {
      const diff = new Date(p.maturityDate) - new Date(p.launchDate);
      termMonths = Math.round(diff / (1000 * 60 * 60 * 24 * 30));
    }

    try {
      await pool.query(`
        INSERT INTO investment_pools
          (id, source_id, name, product_type, status, target_amount, actual_rate,
           term_months, start_date, end_date, maturity_date, description, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (id) DO UPDATE SET
          name         = EXCLUDED.name,
          actual_rate  = EXCLUDED.actual_rate,
          product_type = EXCLUDED.product_type,
          source_id    = EXCLUDED.source_id,
          updated_at   = NOW()
      `, [
        id,
        p._id,
        p.name,
        productType,
        POOL_STATUS_MAP[p.status] || 'closed',
        parseFloat(p.maxTotal) || 0,
        parseFloat(p.returnPercentage) || 0,
        termMonths,
        p.launchDate   ? new Date(p.launchDate)   : null,
        p.closingDate  ? new Date(p.closingDate)  : null,
        p.maturityDate ? new Date(p.maturityDate) : null,
        `Migrated from previous platform. Product: ${p.productId || p.productName || p.name}`,
      ]);
      sourceIdToPoolId[p._id] = id;
      poolOk++;
    } catch (err) {
      console.error(`  ✗ pool ${p._id}: ${err.message}`);
      errors++;
    }
  }
  console.log(`  ✓ ${poolOk} pools imported\n`);

  /* ══════════════════════════════════════════════════════════════
     STEP 3 — Investments
  ══════════════════════════════════════════════════════════════ */
  console.log('💰  [3/6] Migrating investments...');
  let investOk = 0;

  for (const inv of investments) {
    if (!inv._id || !inv.userAccountNumber) continue;

    // Pool ref: try inv.pool.path (object), inv.pool (string path), or inv.investmentPool
    const poolRef     = inv.pool?.path || inv.pool || inv.investmentPool || null;
    const origPoolId  = extractPoolId(poolRef);
    const poolId      = origPoolId ? (sourceIdToPoolId[origPoolId] || `POOL-MIGR-${origPoolId}`) : null;
    const srcPool     = origPoolId ? poolById[origPoolId] : null;
    const poolName    = (typeof inv.pool === 'object' ? inv.pool?.name : null) || srcPool?.name || '';
    const productType = PRODUCT_TYPE_MAP[inv.product?.name] || 'other';
    const status      = INVESTMENT_STATUS_MAP[inv.status] || 'active';
    const amount      = parseFloat(inv.investedAmount) || 0;
    const rate        = parseFloat(srcPool?.returnPercentage) || 0;
    const expected    = Math.round(amount * rate * 100) / 100;

    // Normalise maturity instruction
    let matInstr = null;
    if (inv.maturityInstruction?.instruction) {
      matInstr = inv.maturityInstruction.instruction
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace('payout_returns', 'payout_return')
        .replace('payout_all_funds', 'payout_all');
    }

    try {
      await pool.query(`
        INSERT INTO investments
          (id, investor_id, pool_id, pool_name, product_type, amount,
           status, start_date, end_date, annual_rate,
           expected_return, maturity_instruction, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (id) DO UPDATE SET
          status               = EXCLUDED.status,
          maturity_instruction = EXCLUDED.maturity_instruction,
          updated_at           = NOW()
      `, [
        `INV-MIGR-${inv._id}`,
        inv.userAccountNumber,
        poolId,
        poolName,
        productType,
        amount,
        status,
        inv.dateInvested  ? new Date(inv.dateInvested)            : new Date(),
        srcPool?.maturityDate ? new Date(srcPool.maturityDate)    : null,
        rate,
        expected,
        matInstr,
      ]);
      investOk++;
    } catch (err) {
      console.error(`  ✗ investment ${inv._id}: ${err.message}`);
      errors++;
    }
  }
  console.log(`  ✓ ${investOk} investments imported\n`);

  /* ══════════════════════════════════════════════════════════════
     STEP 4 — Transactions
  ══════════════════════════════════════════════════════════════ */
  console.log('🔄  [4/6] Migrating transactions...');
  let txOk = 0;

  for (const tx of transactions) {
    if (!tx._id || !tx.userAccountNumber) continue;

    try {
      await pool.query(`
        INSERT INTO transactions
          (id, investor_id, type, amount, status, reference, description, transaction_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO NOTHING
      `, [
        `TXN-MIGR-${tx._id}`,
        tx.userAccountNumber,
        TX_TYPE_MAP[tx.type] || 'other',
        parseFloat(tx.amount) || 0,
        TX_STATUS_MAP[tx.status] || 'completed',
        tx.txRef || tx._id,
        `${tx.investment?.name || tx.type || ''}`.trim() || 'Migrated transaction',
        tx.dateCreated ? new Date(tx.dateCreated) : new Date(),
      ]);
      txOk++;
    } catch (err) {
      console.error(`  ✗ transaction ${tx._id}: ${err.message}`);
      errors++;
    }
  }
  console.log(`  ✓ ${txOk} transactions imported\n`);

  /* ══════════════════════════════════════════════════════════════
     STEP 5 — KYC documents
  ══════════════════════════════════════════════════════════════ */
  console.log('📄  [5/6] Migrating KYC documents...');
  let kycOk = 0;

  for (const u of users) {
    if (!u.documents?.length || !u.userAccountNumber) continue;

    for (let i = 0; i < u.documents.length; i++) {
      const doc     = u.documents[i];
      const docType = doc.Name === 'ID Document'     ? 'identity'
                    : doc.Name === 'Banking Details'  ? 'bank'
                    : doc.Name === 'Proof of Address' ? 'address'
                    : 'other';

      const status  = doc.Approved || doc.status === 'Approved' ? 'approved'
                    : 'pending';

      try {
        await pool.query(`
          INSERT INTO kyc_documents
            (id, investor_id, type, status, file_url, uploaded_at, reviewed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (id) DO NOTHING
        `, [
          `KYC-MIGR-${u.userAccountNumber}-${docType}-${i}`,
          u.userAccountNumber,
          docType,
          status,
          doc.URL || '',
          doc.Date ? new Date(doc.Date) : new Date(),
          doc.Approved ? new Date(doc.Date) : null,
        ]);
        kycOk++;
      } catch (err) {
        console.error(`  ✗ KYC ${u.userAccountNumber} doc ${i}: ${err.message}`);
        errors++;
      }
    }
  }
  console.log(`  ✓ ${kycOk} KYC documents imported\n`);

  /* ─── Summary ─── */
  console.log('═'.repeat(50));
  console.log('✅  Migration complete!');
  console.log(`    Investors:    ${investorOk}`);
  console.log(`    Pools:        ${poolOk}`);
  console.log(`    Investments:  ${investOk}`);
  console.log(`    Transactions: ${txOk}`);
  console.log(`    KYC docs:     ${kycOk}`);
  if (errors > 0) console.log(`    ⚠️  Errors:      ${errors} (see output above)`);
  console.log('═'.repeat(50));

  await pool.end();
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
