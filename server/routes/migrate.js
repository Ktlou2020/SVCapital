'use strict';
const express      = require('express');
const multer       = require('multer');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const { requireAuth, requireRole } = require('../middleware/auth');
const pool         = require('../db/pool');
const emailService = require('../services/email');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
/* Maps the productId field (Firestore document reference) to our product_type.
   Pools export uses productId, not productName, so this is the primary resolver. */
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
const POOL_STATUS_MAP       = { MATURED:'matured', ACTIVE:'active', OPEN:'open', CLOSED:'closed' };
const INVESTMENT_STATUS_MAP = { MATURED:'matured', ACTIVE:'active', PAID_OUT:'matured', COMPLETE:'matured', CANCELLED:'cancelled' };
const TX_TYPE_MAP = {
  'INVESTMENT':'investment', 'RE-INVESTMENT':'investment', 'PAYOUT':'return',
  'DEPOSIT':'deposit', 'WITHDRAWAL':'withdrawal', 'RETURN':'return',
};
const TX_STATUS_MAP  = { SUCCESSFUL:'completed', PENDING:'pending', FAILED:'failed' };
const KYC_STATUS_MAP = { Approved:'approved', Unverified:'pending', Outstanding:'pending', Pending:'pending' };
const KYC_DOC_TYPE_MAP = {
  'ID Document':       'id_document',
  'Banking Details':   'bank_statement',
  'Proof of Address':  'proof_of_address',
};

function extractPoolId(p) {
  if (!p) return null;
  // p may be a plain path string "investmentPools/ID" or an object { path: "investmentPools/ID" }
  const str = (typeof p === 'object' && p !== null) ? (p.path || p.id || '') : String(p);
  const parts = str.split('/');
  return parts[parts.length - 1] || null;
}

/* Run items through fn in parallel batches to avoid DB connection exhaustion */
async function inBatches(items, fn, size = 40) {
  const counts = { ok: 0 };
  const errors = [];
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(fn));
    results.forEach(r => {
      if (r.status === 'fulfilled') counts.ok++;
      else errors.push(r.reason?.message || String(r.reason));
    });
  }
  return { ok: counts.ok, errors };
}

/* ── POST /api/migrate/run ── */
router.post('/run',
  requireAuth,
  requireRole('admin', 'director'),
  upload.fields([
    { name: 'users',          maxCount: 1 },
    { name: 'pools',          maxCount: 1 },
    { name: 'investments',    maxCount: 1 },
    { name: 'transactions',   maxCount: 1 },
    { name: 'bankAccounts',   maxCount: 1 },
    { name: 'addressDetails', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files || {};

    function parse(name, required = true) {
      const f = files[name];
      if (!f || !f[0]) {
        if (required) throw new Error(`Missing file: ${name}`);
        return [];
      }
      return JSON.parse(f[0].buffer.toString('utf8'));
    }

    let users, pools, investments, transactions, bankAccounts, addresses;
    try {
      users        = parse('users',          false);
      pools        = parse('pools',          false);
      investments  = parse('investments',    false);
      transactions = parse('transactions',   false);
      bankAccounts = parse('bankAccounts',   false);
      addresses    = parse('addressDetails', false);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!users.length && !pools.length && !investments.length && !transactions.length && !bankAccounts.length && !addresses.length) {
      return res.status(400).json({ error: 'No files uploaded. Please select at least one JSON file to migrate.' });
    }

    /* ─── Build lookups (all O(n), done once) ─── */
    const bankByUser = {};
    bankAccounts.forEach(ba => {
      if (ba.defaultAccount && ba.status === 'ACTIVE' && ba.userAccountNumber) {
        if (!bankByUser[ba.userAccountNumber]) bankByUser[ba.userAccountNumber] = ba;
      }
    });

    const addressByUser = {};
    addresses.forEach(a => {
      if (!a.userAccountNumber) return;
      const ex = addressByUser[a.userAccountNumber];
      if (!ex || new Date(a.dateUpdated) > new Date(ex.dateUpdated)) addressByUser[a.userAccountNumber] = a;
    });

    const poolById = {};
    pools.forEach(p => { if (p._id) poolById[p._id] = p; });
    // Maps original _id → DB pool id (built during pool insert step)
    const sourceIdToPoolId = {};

    /* Pre-aggregate invested amounts per user — avoids O(n²) scan */
    const investedByUser = {};
    investments.forEach(inv => {
      if (!inv.userAccountNumber) return;
      if (!['ACTIVE','MATURED','PAID_OUT'].includes(inv.status)) return;
      investedByUser[inv.userAccountNumber] =
        (investedByUser[inv.userAccountNumber] || 0) + (parseFloat(inv.investedAmount) || 0);
    });

    const counts = {};
    const allErrors = [];

    /* ── 1. Investors ── */
    const investorResult = await inBatches(
      users.filter(u => u.userAccountNumber),
      async u => {
        const id          = u.userAccountNumber;
        const bank        = bankByUser[id];
        const addr        = addressByUser[id];
        const firstName   = u.name    || (u.display_name || '').split(' ')[0] || '';
        const lastName    = u.surname || (u.display_name || '').split(' ').slice(1).join(' ') || '';
        const totalInvested = Math.round((investedByUser[id] || 0) * 100) / 100;
        const notes = bank ? JSON.stringify({
          bank_name: bank.bankName, account_holder: bank.accountHolderName,
          account_number: bank.accountNumber, branch_code: bank.branchNumber,
          bank_proof_url: bank.proof || null,
        }) : null;
        const status = u.status === 'ACTIVE' ? 'active' : 'suspended';

        await pool.query(`
          INSERT INTO investors
            (id, first_name, last_name, email, phone, id_number, date_of_birth,
             kyc_status, status, wallet_balance, total_invested, risk_profile,
             occupation, notes, address, province, date_joined, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
          ON CONFLICT (id) DO UPDATE SET
            first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, email=EXCLUDED.email,
            phone=EXCLUDED.phone, id_number=EXCLUDED.id_number, date_of_birth=EXCLUDED.date_of_birth,
            kyc_status=EXCLUDED.kyc_status, status=EXCLUDED.status,
            wallet_balance=EXCLUDED.wallet_balance, total_invested=EXCLUDED.total_invested,
            risk_profile=EXCLUDED.risk_profile, occupation=EXCLUDED.occupation,
            notes=EXCLUDED.notes, address=EXCLUDED.address, province=EXCLUDED.province,
            updated_at=NOW()
        `, [
          id, firstName, lastName, (u.email||'').toLowerCase().trim(), u.phone_number||'',
          u.identityNumber||'',
          u.dateOfBirth ? new Date(u.dateOfBirth).toISOString().split('T')[0] : null,
          KYC_STATUS_MAP[u.kycStatus] || 'pending', status,
          parseFloat(u.wallet) || 0, totalInvested,
          (u.riskTolerence || 'Moderate').toLowerCase(),
          u.employmentStatus || null, notes,
          addr?.fullAddress || null, addr?.province?.trim() || null,
          u.created_time ? new Date(u.created_time) : new Date(),
        ]);
      }
    );
    counts.investors = investorResult.ok;
    allErrors.push(...investorResult.errors.slice(0, 10).map(e => `investor: ${e}`));

    /* ── 1b. Users (login accounts) for migrated investors ── */
    const JWT_SECRET  = process.env.JWT_SECRET;
    const BASE_URL    = process.env.BASE_URL || 'https://platform.svcapital.co.za';
    const tempHash    = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    const userResult = await inBatches(
      users.filter(u => u.userAccountNumber && u.email),
      async u => {
        const email     = (u.email || '').toLowerCase().trim();
        const firstName = u.name    || (u.display_name || '').split(' ')[0] || '';
        const lastName  = u.surname || (u.display_name || '').split(' ').slice(1).join(' ') || '';

        // Upsert user — skip if already has an account
        const { rows: [newUser] } = await pool.query(`
          INSERT INTO users (email, password_hash, role, first_name, last_name)
          VALUES ($1, $2, 'investor', $3, $4)
          ON CONFLICT (email) DO NOTHING
          RETURNING id, email, first_name
        `, [email, tempHash, firstName, lastName]);

        // Only send setup email for newly created users (not pre-existing accounts)
        if (newUser && JWT_SECRET) {
          const jti       = crypto.randomBytes(16).toString('hex');
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
          const token     = jwt.sign(
            { sub: newUser.id, purpose: 'password_reset', jti },
            JWT_SECRET,
            { expiresIn: '7d' }
          );
          await pool.query(
            'INSERT INTO password_reset_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3)',
            [jti, newUser.id, expiresAt]
          );
          const resetLink = `${BASE_URL}/reset-password?token=${token}`;
          setImmediate(() =>
            emailService.sendAccountSetup(newUser.email, newUser.first_name || firstName, resetLink)
              .catch(err => console.error('[migrate] setup email failed:', newUser.email, err.message))
          );
        }
      }
    );
    counts.users = userResult.ok;
    allErrors.push(...userResult.errors.slice(0, 10).map(e => `user: ${e}`));

    /* ── 2. Pools ── */
    const poolResult = await inBatches(
      pools.filter(p => p._id),
      async p => {
        const pid = `POOL-MIGR-${p._id}`;
        let termMonths = null;
        if (p.launchDate && p.maturityDate)
          termMonths = Math.round((new Date(p.maturityDate) - new Date(p.launchDate)) / (1000*60*60*24*30));
        await pool.query(`
          INSERT INTO investment_pools
            (id, source_id, name, product_type, status, target_amount, actual_rate,
             term_months, start_date, end_date, maturity_date, description, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
          ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, status=EXCLUDED.status, actual_rate=EXCLUDED.actual_rate,
            product_type=EXCLUDED.product_type, source_id=EXCLUDED.source_id, updated_at=NOW()
        `, [
          pid, p._id, p.name, resolveProductType(p),
          POOL_STATUS_MAP[p.status]||'closed',
          parseFloat(p.maxTotal)||0, parseFloat(p.returnPercentage)||0, termMonths,
          p.launchDate   ? new Date(p.launchDate)   : null,
          p.closingDate  ? new Date(p.closingDate)  : null,
          p.maturityDate ? new Date(p.maturityDate) : null,
          `Migrated from previous platform. Product: ${p.productId || p.productName || p.name}`,
        ]);
        sourceIdToPoolId[p._id] = pid;
      }
    );
    counts.pools = poolResult.ok;
    allErrors.push(...poolResult.errors.slice(0, 10).map(e => `pool: ${e}`));

    /* ── 3. Investments ── */
    const invResult = await inBatches(
      investments.filter(inv => inv._id && inv.userAccountNumber),
      async inv => {
        // Pool ref: try inv.pool.path (object), inv.pool (string path), or inv.investmentPool
        const poolRef    = inv.pool?.path || inv.pool || inv.investmentPool || null;
        const origPoolId = extractPoolId(poolRef);
        const dbPoolId   = origPoolId ? (sourceIdToPoolId[origPoolId] || `POOL-MIGR-${origPoolId}`) : null;
        const srcPool    = origPoolId ? poolById[origPoolId] : null;
        const amount     = parseFloat(inv.investedAmount) || 0;
        const rate       = parseFloat(srcPool?.returnPercentage) || 0;
        const poolName   = (typeof inv.pool === 'object' ? inv.pool?.name : null) || srcPool?.name || '';
        let matInstr = null;
        if (inv.maturityInstruction?.instruction) {
          matInstr = inv.maturityInstruction.instruction.toLowerCase()
            .replace(/\s+/g,'_').replace('payout_returns','payout_return').replace('payout_all_funds','payout_all');
        }
        await pool.query(`
          INSERT INTO investments
            (id, investor_id, pool_id, pool_name, product_type, amount,
             status, start_date, end_date, annual_rate,
             expected_return, maturity_instruction, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
          ON CONFLICT (id) DO UPDATE SET
            status=EXCLUDED.status, maturity_instruction=EXCLUDED.maturity_instruction, updated_at=NOW()
        `, [
          `INV-MIGR-${inv._id}`, inv.userAccountNumber,
          dbPoolId,
          poolName, PRODUCT_TYPE_MAP[inv.product?.name]||'other', amount,
          INVESTMENT_STATUS_MAP[inv.status]||'active',
          inv.dateInvested  ? new Date(inv.dateInvested)         : new Date(),
          srcPool?.maturityDate ? new Date(srcPool.maturityDate) : null,
          rate, Math.round(amount * rate * 100) / 100, matInstr,
        ]);
      }
    );
    counts.investments = invResult.ok;
    allErrors.push(...invResult.errors.slice(0, 10).map(e => `investment: ${e}`));

    /* ── 4. Transactions ── */
    const txResult = await inBatches(
      transactions.filter(tx => tx._id && tx.userAccountNumber),
      async tx => {
        await pool.query(`
          INSERT INTO transactions
            (id, investor_id, type, amount, status, reference, description, transaction_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (id) DO NOTHING
        `, [
          `TXN-MIGR-${tx._id}`, tx.userAccountNumber,
          TX_TYPE_MAP[tx.type]||'deposit', parseFloat(tx.amount)||0,
          TX_STATUS_MAP[tx.status]||'completed', tx.txRef||tx._id,
          `${tx.investment?.name||tx.type||''}`.trim()||'Migrated transaction',
          tx.dateCreated ? new Date(tx.dateCreated) : new Date(),
        ]);
      }
    );
    counts.transactions = txResult.ok;
    allErrors.push(...txResult.errors.slice(0, 10).map(e => `transaction: ${e}`));

    /* ── 5. KYC documents ── */
    const kycItems = [];
    users.forEach(u => {
      if (!u.documents?.length || !u.userAccountNumber) return;
      u.documents.forEach((doc, i) => kycItems.push({ u, doc, i }));
    });

    const kycResult = await inBatches(
      kycItems,
      async ({ u, doc, i }) => {
        const docType = KYC_DOC_TYPE_MAP[doc.Name] || 'other';
        const status  = doc.Approved || doc.status === 'Approved' ? 'approved' : 'pending';
        await pool.query(`
          INSERT INTO kyc_documents
            (id, investor_id, doc_type, status, file_url, submitted_at, reviewed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (id) DO NOTHING
        `, [
          `KYC-MIGR-${u.userAccountNumber}-${docType}-${i}`,
          u.userAccountNumber, docType, status, doc.URL||'',
          doc.Date ? new Date(doc.Date) : new Date(),
          doc.Approved ? new Date(doc.Date) : null,
        ]);
      }
    );
    counts.kyc = kycResult.ok;
    allErrors.push(...kycResult.errors.slice(0, 10).map(e => `kyc: ${e}`));

    res.json({ ok: true, counts, errors: allErrors });
  }
);

module.exports = router;
