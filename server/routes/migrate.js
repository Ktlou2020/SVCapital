'use strict';
const express = require('express');
const multer  = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const pool    = require('../db/pool');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ─── Field mappings (same as CLI script) ─── */
const PRODUCT_TYPE_MAP = {
  'Delivery Bike Investment':   'delivery_bikes',
  'Short Term Investment':      'smme',
  'Cattle Investment':          'cattle',
  'Solar Investment - 5 Years': 'solar',
  'Solar Investment - 6 Years': 'solar',
  '12J Investment':             'cattle',
};
const POOL_STATUS_MAP       = { MATURED:'matured', ACTIVE:'active', OPEN:'open', CLOSED:'closed' };
const INVESTMENT_STATUS_MAP = { MATURED:'matured', ACTIVE:'active', PAID_OUT:'paid_out' };
const TX_TYPE_MAP = {
  'INVESTMENT':'investment', 'RE-INVESTMENT':'reinvestment', 'PAYOUT':'payout',
  'DEPOSIT':'deposit', 'WITHDRAWAL':'withdrawal', 'RETURN':'return',
};
const TX_STATUS_MAP  = { SUCCESSFUL:'completed', PENDING:'pending', FAILED:'failed' };
const KYC_STATUS_MAP = { Approved:'approved', Unverified:'pending', Outstanding:'pending', Pending:'pending' };

function extractPoolId(p) {
  if (!p) return null;
  const parts = p.split('/');
  return parts[parts.length - 1];
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
      users        = parse('users');
      pools        = parse('pools');
      investments  = parse('investments');
      transactions = parse('transactions');
      bankAccounts = parse('bankAccounts');
      addresses    = parse('addressDetails', false);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    /* ─── Build lookups ─── */
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

    const counts = { investors: 0, pools: 0, investments: 0, transactions: 0, kyc: 0 };
    const errors = [];

    /* ── 1. Investors ── */
    for (const u of users) {
      const id = u.userAccountNumber;
      if (!id) continue;
      const bank        = bankByUser[id];
      const addr        = addressByUser[id];
      const firstName   = u.name    || (u.display_name || '').split(' ')[0] || '';
      const lastName    = u.surname || (u.display_name || '').split(' ').slice(1).join(' ') || '';
      const totalInvested = investments
        .filter(i => i.userAccountNumber === id && ['ACTIVE','MATURED','PAID_OUT'].includes(i.status))
        .reduce((s, i) => s + (parseFloat(i.investedAmount) || 0), 0);
      const notes = bank ? JSON.stringify({
        bank_name: bank.bankName, account_holder: bank.accountHolderName,
        account_number: bank.accountNumber, branch_code: bank.branchNumber, bank_proof_url: bank.proof || null,
      }) : null;

      try {
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
          KYC_STATUS_MAP[u.kycStatus] || 'pending',
          u.status === 'ACTIVE' ? 'active' : 'inactive',
          parseFloat(u.wallet) || 0,
          Math.round(totalInvested * 100) / 100,
          (u.riskTolerence || 'Moderate').toLowerCase(),
          u.employmentStatus || null, notes,
          addr?.fullAddress || null, addr?.province?.trim() || null,
          u.created_time ? new Date(u.created_time) : new Date(),
        ]);
        counts.investors++;
      } catch (e) { errors.push(`investor ${id}: ${e.message}`); }
    }

    /* ── 2. Pools ── */
    for (const p of pools) {
      if (!p._id) continue;
      const pid = `POOL-MIGR-${p._id}`;
      let termMonths = null;
      if (p.launchDate && p.maturityDate) {
        termMonths = Math.round((new Date(p.maturityDate) - new Date(p.launchDate)) / (1000*60*60*24*30));
      }
      try {
        await pool.query(`
          INSERT INTO investment_pools
            (id, name, product_type, status, target_amount, annual_rate,
             term_months, start_date, end_date, description, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, status=EXCLUDED.status, annual_rate=EXCLUDED.annual_rate, updated_at=NOW()
        `, [
          pid, p.name, PRODUCT_TYPE_MAP[p.productName]||'other',
          POOL_STATUS_MAP[p.status]||'closed',
          parseFloat(p.maxTotal)||0, parseFloat(p.returnPercentage)||0, termMonths,
          p.launchDate   ? new Date(p.launchDate)   : null,
          p.maturityDate ? new Date(p.maturityDate) : null,
          `Migrated from previous platform. Product: ${p.productName}`,
        ]);
        counts.pools++;
      } catch (e) { errors.push(`pool ${p._id}: ${e.message}`); }
    }

    /* ── 3. Investments ── */
    for (const inv of investments) {
      if (!inv._id || !inv.userAccountNumber) continue;
      const origPoolId = extractPoolId(inv.pool?.path);
      const poolId     = origPoolId ? `POOL-MIGR-${origPoolId}` : null;
      const srcPool    = origPoolId ? poolById[origPoolId] : null;
      const amount     = parseFloat(inv.investedAmount) || 0;
      const rate       = parseFloat(srcPool?.returnPercentage) || 0;
      let matInstr = null;
      if (inv.maturityInstruction?.instruction) {
        matInstr = inv.maturityInstruction.instruction.toLowerCase()
          .replace(/\s+/g,'_').replace('payout_returns','payout_return').replace('payout_all_funds','payout_all');
      }
      try {
        await pool.query(`
          INSERT INTO investments
            (id, investor_id, pool_id, pool_name, product_type, amount,
             status, investment_date, maturity_date, expected_return_rate,
             expected_return_amount, maturity_instruction, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
          ON CONFLICT (id) DO UPDATE SET
            status=EXCLUDED.status, maturity_instruction=EXCLUDED.maturity_instruction, updated_at=NOW()
        `, [
          `INV-MIGR-${inv._id}`, inv.userAccountNumber, poolId,
          inv.pool?.name||'', PRODUCT_TYPE_MAP[inv.product?.name]||'other', amount,
          INVESTMENT_STATUS_MAP[inv.status]||'active',
          inv.dateInvested  ? new Date(inv.dateInvested)         : new Date(),
          srcPool?.maturityDate ? new Date(srcPool.maturityDate) : null,
          rate, Math.round(amount * rate * 100) / 100, matInstr,
        ]);
        counts.investments++;
      } catch (e) { errors.push(`investment ${inv._id}: ${e.message}`); }
    }

    /* ── 4. Transactions ── */
    for (const tx of transactions) {
      if (!tx._id || !tx.userAccountNumber) continue;
      try {
        await pool.query(`
          INSERT INTO transactions
            (id, investor_id, type, amount, status, reference, description, transaction_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (id) DO NOTHING
        `, [
          `TXN-MIGR-${tx._id}`, tx.userAccountNumber,
          TX_TYPE_MAP[tx.type]||'other', parseFloat(tx.amount)||0,
          TX_STATUS_MAP[tx.status]||'completed', tx.txRef||tx._id,
          `${tx.investment?.name||tx.type||''}`.trim()||'Migrated transaction',
          tx.dateCreated ? new Date(tx.dateCreated) : new Date(),
        ]);
        counts.transactions++;
      } catch (e) { errors.push(`transaction ${tx._id}: ${e.message}`); }
    }

    /* ── 5. KYC documents ── */
    for (const u of users) {
      if (!u.documents?.length || !u.userAccountNumber) continue;
      for (let i = 0; i < u.documents.length; i++) {
        const doc     = u.documents[i];
        const docType = doc.Name === 'ID Document'     ? 'identity'
                      : doc.Name === 'Banking Details'  ? 'bank'
                      : doc.Name === 'Proof of Address' ? 'address' : 'other';
        const status  = doc.Approved || doc.status === 'Approved' ? 'approved' : 'pending';
        try {
          await pool.query(`
            INSERT INTO kyc_documents
              (id, investor_id, type, status, file_url, uploaded_at, reviewed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (id) DO NOTHING
          `, [
            `KYC-MIGR-${u.userAccountNumber}-${docType}-${i}`,
            u.userAccountNumber, docType, status, doc.URL||'',
            doc.Date ? new Date(doc.Date) : new Date(),
            doc.Approved ? new Date(doc.Date) : null,
          ]);
          counts.kyc++;
        } catch (e) { errors.push(`KYC ${u.userAccountNumber} doc ${i}: ${e.message}`); }
      }
    }

    res.json({ ok: true, counts, errors: errors.slice(0, 50) });
  }
);

module.exports = router;
