/* ═══════════════════════════════════════════════════════════
   Manual Wallet Credit — /api/admin/manual-credit
   Requires role: admin | director
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router  = require('express').Router();
const pool    = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const audit   = require('../services/audit');

router.use(requireAuth, requireRole('admin', 'director'));

router.post('/manual-credit', async (req, res) => {
  try {
    const { investorId, amount, notes } = req.body;
    const numAmount = parseFloat(amount);
    if (!investorId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'investorId and a positive amount are required.' });
    }

    const reference = 'MC-' + require('crypto').randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    const client = await pool.connect();
    let investor;
    try {
      await client.query('BEGIN');

      const { rows: [inv] } = await client.query(
        'SELECT id, first_name, last_name, email FROM investors WHERE id = $1 FOR UPDATE',
        [investorId]
      );
      if (!inv) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Investor not found.' });
      }
      investor = inv;

      await client.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, notes, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, 'Manual wallet credit', $4, NOW(), NOW())`,
        [investorId, numAmount, reference, notes || null]
      );

      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [numAmount, investorId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'wallet.manual_credit',
      entityType: 'investors',
      entityId:   investorId,
      description: `Manual wallet credit of R${numAmount} to investor ${investor.first_name} ${investor.last_name} (${investorId}). Ref: ${reference}. Notes: ${notes || 'none'}`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, reference });
  } catch (err) {
    console.error('/admin/manual-credit error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/reset-2fa ─── */
router.post('/reset-2fa', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, totp_enabled FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled on this account.' });
    }

    await pool.query(
      'UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE id = $1',
      [userId]
    );
    await pool.query(
      'DELETE FROM totp_recovery_codes WHERE user_id = $1',
      [userId]
    );

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'user.2fa_reset',
      entityType: 'users',
      entityId:   userId,
      description: `Admin reset 2FA for user ${user.first_name} ${user.last_name} (${user.email})`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true });
  } catch (err) {
    console.error('/admin/reset-2fa error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/investments/allocate-pools ──────────────────────────
   Matches investments to pools by name (case-insensitive, trimmed).
   Updates pool_id (and pool_name to the canonical pool name) on any
   investment whose pool_id is NULL but whose pool_name matches a known pool.
   Also updates investments that have a mismatched/stale pool_id.
   ─────────────────────────────────────────────────────────────────────── */
router.post('/investments/allocate-pools', async (req, res) => {
  try {
    const { rows: pools } = await pool.query(
      `SELECT id, name FROM investment_pools WHERE name IS NOT NULL`
    );

    // Build a case-insensitive name → pool map
    const poolByName = new Map();
    for (const p of pools) {
      if (p.name) poolByName.set(p.name.trim().toLowerCase(), p);
    }

    // Fetch investments that are unallocated (pool_id IS NULL) and have a pool_name
    const { rows: investments } = await pool.query(
      `SELECT id, pool_name, pool_id
         FROM investments
        WHERE pool_name IS NOT NULL AND pool_name <> ''`
    );

    let matched = 0;
    const unmatched = [];

    for (const inv of investments) {
      const key = (inv.pool_name || '').trim().toLowerCase();
      const matchedPool = poolByName.get(key);
      if (matchedPool && inv.pool_id !== matchedPool.id) {
        await pool.query(
          `UPDATE investments SET pool_id = $1, pool_name = $2, updated_at = NOW() WHERE id = $3`,
          [matchedPool.id, matchedPool.name, inv.id]
        );
        matched++;
      } else if (!matchedPool) {
        unmatched.push(inv.pool_name);
      }
    }

    const uniqueUnmatched = [...new Set(unmatched)].slice(0, 20);

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'investments.allocate_pools',
      entityType: 'investments',
      description: `Allocated ${matched} investments to pools by name matching. ${uniqueUnmatched.length} pool names had no match.`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, matched, unmatched: uniqueUnmatched });
  } catch (err) {
    console.error('/admin/investments/allocate-pools error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/pools/recalculate ───────────────────────────────────
   Recomputes investor_count, raised_amount, and current_invested for every
   pool from the live investments table.  Safe to run at any time.
   ─────────────────────────────────────────────────────────────────────── */
router.post('/pools/recalculate', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`
      UPDATE investment_pools ip
         SET investor_count   = sub.cnt,
             raised_amount    = sub.raised,
             current_invested = sub.active_amt,
             updated_at       = NOW()
        FROM (
          SELECT
            pool_id,
            COUNT(DISTINCT CASE WHEN sub_account_id IS NOT NULL
                                THEN 'sa:' || sub_account_id
                                ELSE 'inv:' || investor_id END) AS cnt,
            SUM(CASE WHEN status IN ('active','matured','paid_out') THEN amount ELSE 0 END) AS raised,
            SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END)                        AS active_amt
          FROM investments
          WHERE pool_id IS NOT NULL
          GROUP BY pool_id
        ) sub
       WHERE ip.id = sub.pool_id
    `);

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'pools.recalculate',
      entityType: 'investment_pools',
      description: `Recalculated stats for ${rowCount} pools`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, poolsUpdated: rowCount });
  } catch (err) {
    console.error('/admin/pools/recalculate error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/backfill/fica-from-kyc ──────────────────────────────
   One-shot backfill: any investor whose kyc_status is already 'approved'
   gets fica_status set to 'approved', fica_approved_at stamped (if not
   already set), and their account status promoted to 'active'.
   Also syncs the reverse: fica_status='approved' → kyc_status='approved'.
   Safe to run multiple times — the WHERE guards prevent double-writes.
   ─────────────────────────────────────────────────────────────────────── */
router.post('/backfill/fica-from-kyc', async (req, res) => {
  try {
    // kyc_status approved → set fica_status approved + activate
    const { rowCount: fromKyc } = await pool.query(`
      UPDATE investors
         SET fica_status      = 'approved',
             kyc_status       = 'approved',
             fica_approved_at = COALESCE(fica_approved_at, NOW()),
             status           = CASE WHEN status IN ('pending','pending_fica','fica_submitted','inactive') THEN 'active' ELSE status END,
             updated_at       = NOW()
       WHERE kyc_status = 'approved'
         AND fica_status <> 'approved'
    `);

    // fica_status approved → ensure kyc_status is also approved
    const { rowCount: fromFica } = await pool.query(`
      UPDATE investors
         SET kyc_status  = 'approved',
             status      = CASE WHEN status IN ('pending','pending_fica','fica_submitted','inactive') THEN 'active' ELSE status END,
             updated_at  = NOW()
       WHERE fica_status = 'approved'
         AND kyc_status <> 'approved'
    `);

    const total = fromKyc + fromFica;

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'investors.backfill_fica_from_kyc',
      entityType: 'investors',
      description: `Backfilled FICA approval for ${total} investors (${fromKyc} from KYC, ${fromFica} from FICA sync)`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, updated: total, fromKyc, fromFica });
  } catch (err) {
    console.error('/admin/backfill/fica-from-kyc error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/reconcile-wallet ────────────────────────────────────────
   Recomputes wallet_balance for one investor (or all investors) from their
   completed transactions so any deposits silently missed by the old PATCH
   credit bug are recovered.

   Body: { investor_id: 'S-XXXXXX' }  — single investor
         { all: true }                 — every investor (slow, use with care)
   ─────────────────────────────────────────────────────────────────────── */
router.post('/reconcile-wallet', async (req, res) => {
  const { investor_id, all, dry_run } = req.body || {};
  if (!investor_id && !all) {
    return res.status(400).json({ error: 'Provide investor_id or all:true' });
  }
  try {
    /* Compute correct wallet balance = sum of credits minus sum of debits
       across all completed transactions for the investor. */
    const whereClause = investor_id ? 'AND i.investor_id = $1' : '';
    const params      = investor_id ? [investor_id] : [];

    /* Credits: deposits, returns, payouts, referral bonuses.
       Debits: ONLY withdrawals (money actually leaving the system).
       investment/platform_fee transactions are NOT subtracted — wallet_balance
       is already decremented via direct SQL at invest time; subtracting them
       again from transaction history would double-count every investment. */
    const { rows } = await pool.query(`
      SELECT
        i.investor_id,
        COALESCE(SUM(
          CASE
            WHEN i.type IN ('deposit','return','payout','referral_bonus') AND i.status = 'completed'
              THEN  i.amount
            WHEN i.type = 'withdrawal' AND i.status = 'completed'
              THEN -i.amount
            ELSE 0
          END
        ), 0) AS computed_balance
      FROM transactions i
      WHERE i.sub_account_id IS NULL
        ${whereClause}
      GROUP BY i.investor_id
    `, params);

    let updated = 0;
    const diffs = [];
    for (const r of rows) {
      const computed = parseFloat(r.computed_balance);
      const { rows: cur } = await pool.query(
        'SELECT id, wallet_balance FROM investors WHERE id = $1', [r.investor_id]
      );
      if (!cur[0]) continue;
      const current = parseFloat(cur[0].wallet_balance);
      const diff    = Math.round((computed - current) * 100) / 100;
      diffs.push({ investor_id: r.investor_id, current, computed, diff });
      if (!dry_run && Math.abs(diff) >= 0.01) {
        await pool.query(
          'UPDATE investors SET wallet_balance = $1, updated_at = NOW() WHERE id = $2',
          [computed, r.investor_id]
        );
        updated++;
      }
    }

    res.json({ success: true, checked: rows.length, updated, diffs });
  } catch (err) {
    console.error('/admin/reconcile-wallet error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/pools/fix-product-type ──────────────────────────────────
   One-shot: renames product_type = 'smme' → 'short_term' across investment_pools,
   investments, and products tables immediately, without requiring a server restart.
   ─────────────────────────────────────────────────────────────────────── */
router.post('/pools/fix-product-type', async (req, res) => {
  try {
    const { rowCount: poolRows } = await pool.query(
      `UPDATE investment_pools SET product_type = 'short_term', updated_at = NOW() WHERE product_type = 'smme'`
    );
    const { rowCount: invRows } = await pool.query(
      `UPDATE investments SET product_type = 'short_term', updated_at = NOW() WHERE product_type = 'smme'`
    );
    const { rowCount: prodRows } = await pool.query(
      `UPDATE products SET product_type = 'short_term', updated_at = NOW() WHERE product_type = 'smme'`
    ).catch(() => ({ rowCount: 0 }));

    const total = poolRows + invRows + prodRows;

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'admin.fix_product_type_smme',
      entityType: 'investment_pools',
      description: `Renamed product_type smme→short_term: ${poolRows} pools, ${invRows} investments, ${prodRows} products.`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, poolRows, invRows, prodRows, total });
  } catch (err) {
    console.error('/admin/pools/fix-product-type error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/override-wallet ────────────────────────────────────────
   Directly sets wallet_balance to the specified value without creating any
   transaction record. Admin-only correction tool for balance discrepancies
   that cannot be resolved via normal reconciliation.

   Body: { investorId: 'S-XXXXXX', newBalance: 1234.56, notes: '...' }
   ─────────────────────────────────────────────────────────────────────── */
router.post('/override-wallet', async (req, res) => {
  try {
    const { investorId, newBalance, notes } = req.body;
    const nb = parseFloat(newBalance);
    if (!investorId || isNaN(nb) || nb < 0) {
      return res.status(400).json({ error: 'investorId and a non-negative newBalance are required.' });
    }

    const { rows: [inv] } = await pool.query(
      'SELECT id, first_name, last_name, wallet_balance FROM investors WHERE id = $1',
      [investorId]
    );
    if (!inv) return res.status(404).json({ error: 'Investor not found.' });

    const oldBalance = parseFloat(inv.wallet_balance) || 0;
    const diff = parseFloat((nb - oldBalance).toFixed(2));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE investors SET wallet_balance = $1, updated_at = NOW() WHERE id = $2',
        [nb, investorId]
      );

      if (diff !== 0) {
        const isDeposit = diff > 0;
        const txType    = isDeposit ? 'deposit' : 'debit';
        const txRef     = `OVR-${Date.now()}`;
        // Client-visible description is generic; admin reason stored in notes only
        const txDesc    = isDeposit ? 'Wallet balance adjusted' : 'Wallet balance adjusted';
        const adminNote = `Admin balance override — ${isDeposit ? 'deposit' : 'debit'} (R${Math.abs(diff).toFixed(2)} ${isDeposit ? 'added' : 'removed'}). Reason: ${notes || 'none'}`;

        await client.query(
          `INSERT INTO transactions
             (id, investor_id, type, amount, status, reference, description, notes, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'completed', $4, $5, $6, NOW(), NOW())`,
          [investorId, txType, diff, txRef, txDesc, adminNote]
        );
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'wallet.balance_override',
      entityType: 'investors',
      entityId:   investorId,
      description: `Admin set wallet balance to R${nb} (was R${oldBalance}) for ${inv.first_name} ${inv.last_name} (${investorId}). Notes: ${notes || 'none'}`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, oldBalance, newBalance: nb, diff });
  } catch (err) {
    console.error('/admin/override-wallet error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────
   POST /api/admin/invest-on-behalf
   Body: { investorId, poolId, amount, chargeFee: bool }
   Admin creates an investment for an investor, optionally charging
   the 1% platform fee. Deducts from investor's wallet.
   ──────────────────────────────────────────────────────── */
router.post('/invest-on-behalf', async (req, res) => {
  const { investorId, poolId, amount, chargeFee = false } = req.body || {};

  const amt = parseFloat(amount);
  if (!investorId || !poolId || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: 'investorId, poolId, and a positive amount are required.' });
  }

  const crypto = require('crypto');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock investor row
    const { rows: [inv] } = await client.query(
      'SELECT id, first_name, last_name, email, wallet_balance FROM investors WHERE id = $1 FOR UPDATE',
      [investorId]
    );
    if (!inv) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Investor not found.' });
    }

    // Fetch pool
    const { rows: [poolRow] } = await client.query(
      'SELECT id, name, product_type, annual_rate, min_investment, status, maturity_date FROM investment_pools WHERE id = $1',
      [poolId]
    );
    if (!poolRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pool not found.' });
    }
    if (!['open', 'active', 'filling'].includes(poolRow.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Pool is not accepting investments (status: ${poolRow.status}).` });
    }

    const minInv = parseFloat(poolRow.min_investment) || 0;
    if (minInv && amt < minInv) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Minimum investment for this pool is R${minInv.toLocaleString('en-ZA')}.` });
    }

    const fee      = chargeFee ? Math.round(amt * 0.01 * 100) / 100 : 0;
    const required = amt + fee;
    const balance  = parseFloat(inv.wallet_balance) || 0;

    if (balance < required - 0.001) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient wallet balance. Required: R${required.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} (R${amt.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} investment${chargeFee ? ` + R${fee.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} fee` : ''}), available: R${balance.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}.`,
      });
    }

    // Deduct from wallet
    await client.query(
      `UPDATE investors SET wallet_balance = wallet_balance - $1,
         total_invested = COALESCE(total_invested, 0) + $2,
         updated_at = NOW()
       WHERE id = $3`,
      [required, amt, investorId]
    );

    // Create investment record
    const invId  = 'INV-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
    const now    = new Date();
    const endDate = poolRow.maturity_date || null;
    await client.query(
      `INSERT INTO investments (id, investor_id, pool_id, pool_name, product_type, amount, annual_rate, status, start_date, end_date, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',NOW(),$8,NOW(),NOW())`,
      [invId, investorId, poolId, poolRow.name, poolRow.product_type, amt, poolRow.annual_rate || 0, endDate]
    );

    // Optional platform fee transaction
    if (chargeFee && fee > 0) {
      const feeRef = 'FEE-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
      await client.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,'platform_fee',$2,'completed',$3,$4,NOW(),NOW(),NOW())`,
        [investorId, -fee, feeRef, `Platform fee (1%) for investment in ${poolRow.name}`]
      );
    }

    // Deduct investment amount transaction
    const invTxRef = 'INV-TXN-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    await client.query(
      `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,'investment',$2,'completed',$3,$4,NOW(),NOW(),NOW())`,
      [investorId, -amt, invTxRef, `Investment in ${poolRow.name} (admin-created on behalf)`]
    );

    await client.query('COMMIT');

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'investment.admin_created',
      entityType: 'investments',
      entityId:   invId,
      description: `Admin created R${amt} investment in "${poolRow.name}" for ${inv.first_name} ${inv.last_name} (${investorId}). Fee charged: ${chargeFee ? `R${fee}` : 'none'}.`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({
      success: true,
      investmentId: invId,
      amount:       amt,
      fee,
      totalDeducted: required,
      poolName:     poolRow.name,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('/admin/invest-on-behalf error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ─── POST /api/admin/reimport-bank-accounts ──────────────────────────────────
   Accepts a bankAccounts JSON array (from the original Firebase export) and
   updates the dedicated bank columns on investor records.

   Body: { bankAccounts: [...] }
   ─────────────────────────────────────────────────────────────────────── */
router.post('/reimport-bank-accounts', async (req, res) => {
  const bankAccounts = req.body?.bankAccounts;
  if (!Array.isArray(bankAccounts) || !bankAccounts.length) {
    return res.status(400).json({ error: 'bankAccounts must be a non-empty array.' });
  }

  // Build map: userAccountNumber → best active bank account
  const bankByUser = {};
  for (const ba of bankAccounts) {
    if (!ba.userAccountNumber || ba.status !== 'ACTIVE') continue;
    const ex = bankByUser[ba.userAccountNumber];
    const newer = !ex
      || (!ex.defaultAccount && ba.defaultAccount)
      || (ex.defaultAccount === ba.defaultAccount && new Date(ba.dateUpdated || 0) > new Date(ex.dateUpdated || 0));
    if (newer) bankByUser[ba.userAccountNumber] = ba;
  }

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const [investorId, ba] of Object.entries(bankByUser)) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE investors
            SET bank_name           = $2,
                bank_account_holder = $3,
                bank_account_number = $4,
                bank_branch_code    = $5,
                bank_account_type   = $6,
                bank_account_status = COALESCE(NULLIF(bank_account_status, ''), 'pending'),
                updated_at          = NOW()
          WHERE id = $1`,
        [
          investorId,
          ba.bankName           || null,
          ba.accountHolderName  || null,
          ba.accountNumber      || null,
          ba.branchNumber       || null,
          (ba.accountType || '').toLowerCase() || null,
        ]
      );
      if (rowCount > 0) updated++;
      else skipped++;
    } catch (e) {
      errors.push(`${investorId}: ${e.message}`);
    }
  }

  setImmediate(() => audit.log({
    actorId:    req.user.id,
    actorEmail: req.user.email,
    action:     'investors.reimport_bank_accounts',
    entityType: 'investors',
    description: `Re-imported bank accounts from JSON upload: ${updated} updated, ${skipped} skipped (no match), ${errors.length} errors.`,
    ip: req.ip,
  }).catch(() => {}));

  res.json({ success: true, total: Object.keys(bankByUser).length, updated, skipped, errors: errors.slice(0, 20) });
});

/* ─── POST /api/admin/promote-bank-from-notes ─────────────────────────────────
   Promotes bank account data already stored in the investors.notes JSON column
   into the dedicated bank_name / bank_account_number / etc. columns.
   Safe to run multiple times — only fills nulls, never overwrites existing data.
   ─────────────────────────────────────────────────────────────────────── */
router.post('/promote-bank-from-notes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, notes FROM investors
        WHERE notes IS NOT NULL AND notes LIKE '{%'
          AND (bank_name IS NULL OR bank_account_number IS NULL)`
    );

    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const inv of rows) {
      let bd;
      try { bd = JSON.parse(inv.notes); } catch (_) { skipped++; continue; }

      const bankName   = bd.bank_name      || null;
      const acctNum    = bd.account_number || null;
      const holder     = bd.account_holder || null;
      const branchCode = bd.branch_code    || null;

      if (!bankName && !acctNum) { skipped++; continue; }

      try {
        const { rowCount } = await pool.query(
          `UPDATE investors
              SET bank_name           = COALESCE(bank_name,           $2),
                  bank_account_number = COALESCE(bank_account_number, $3),
                  bank_account_holder = COALESCE(bank_account_holder, $4),
                  bank_branch_code    = COALESCE(bank_branch_code,    $5),
                  bank_account_status = COALESCE(bank_account_status, 'pending'),
                  updated_at          = NOW()
            WHERE id = $1`,
          [inv.id, bankName, acctNum, holder, branchCode]
        );
        if (rowCount > 0) updated++;
        else skipped++;
      } catch (e) {
        errors.push(`${inv.id}: ${e.message}`);
      }
    }

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'investors.promote_bank_from_notes',
      entityType: 'investors',
      description: `Promoted bank account data from notes JSON: ${updated} updated, ${skipped} skipped, ${errors.length} errors.`,
      ip: req.ip,
    }).catch(() => {}));

    res.json({ success: true, checked: rows.length, updated, skipped, errors: errors.slice(0, 20) });
  } catch (err) {
    console.error('/admin/promote-bank-from-notes error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/bulk-reassign-investments ─── */
/* Moves selected investments from one pool to another */
router.post('/bulk-reassign-investments', async (req, res) => {
  try {
    const { source_pool_id, target_pool_id, investment_ids } = req.body || {};
    if (!source_pool_id)   return res.status(400).json({ error: 'source_pool_id required' });
    if (!target_pool_id)   return res.status(400).json({ error: 'target_pool_id required' });
    if (source_pool_id === target_pool_id) return res.status(400).json({ error: 'Source and target pools must differ' });
    if (!Array.isArray(investment_ids) || !investment_ids.length)
      return res.status(400).json({ error: 'investment_ids array required' });

    const { rows: poolCheck } = await pool.query(
      `SELECT id FROM investment_pools WHERE id = ANY($1)`,
      [[source_pool_id, target_pool_id]]
    );
    if (poolCheck.length < 2) return res.status(404).json({ error: 'One or both pools not found' });

    const { rowCount: moved } = await pool.query(
      `UPDATE investments SET pool_id = $1, pool_name = NULL
       WHERE id = ANY($2::text[])`,
      [target_pool_id, investment_ids]
    );

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'investments.bulk_reassign',
      entityType: 'investment_pools',
      entityId:   target_pool_id,
      description: `Bulk-reassigned ${moved} investment(s) from pool ${source_pool_id} to ${target_pool_id}`,
      ip: req.ip,
    }).catch(() => {}));

    res.json({ moved, source_pool_id, target_pool_id });
  } catch (err) {
    console.error('[bulk-reassign-investments]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/admin/tax-cert
   Fetch transaction data for an investor's tax certificate
   Tax year: 1 March (year-1) → last day of February (year)
   ════════════════════════════════════════════════════ */
router.get('/tax-cert', async (req, res) => {
  try {
    const { investor_id, year } = req.query;
    if (!investor_id || !year) return res.status(400).json({ error: 'investor_id and year required' });

    const taxYear = parseInt(year, 10);
    if (isNaN(taxYear) || taxYear < 2019 || taxYear > 2040)
      return res.status(400).json({ error: 'Invalid year' });

    // SA tax year: 1 March (taxYear-1) → last day of February (taxYear)
    const from = new Date(taxYear - 1, 2, 1, 0, 0, 0).toISOString();
    const to   = new Date(taxYear,     2, 0, 23, 59, 59).toISOString(); // day 0 of March = last Feb day

    const [invRes, returnsRes, depositsRes, subAccRes] = await Promise.all([
      pool.query('SELECT * FROM investors WHERE id = $1 LIMIT 1', [investor_id]),
      pool.query(
        `SELECT id, created_at, type, description, amount, reference
         FROM transactions
         WHERE investor_id = $1
           AND type IN ('return','payout')
           AND status = 'completed'
           AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at`,
        [investor_id, from, to]
      ),
      pool.query(
        `SELECT id, created_at, type, description, amount, reference
         FROM transactions
         WHERE investor_id = $1
           AND type = 'deposit'
           AND status = 'completed'
           AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at`,
        [investor_id, from, to]
      ),
      pool.query('SELECT id FROM sub_accounts WHERE parent_investor_id = $1', [investor_id]),
    ]);

    if (!invRes.rows[0]) return res.status(404).json({ error: 'Investor not found' });

    // Include sub-account transactions if any
    const subIds = subAccRes.rows.map(r => r.id);
    let saReturns = [], saDeposits = [];
    if (subIds.length) {
      const [saR, saD] = await Promise.all([
        pool.query(
          `SELECT id, created_at, type, description, amount, reference
           FROM transactions
           WHERE sub_account_id = ANY($1::text[])
             AND type IN ('return','payout')
             AND status = 'completed'
             AND created_at >= $2 AND created_at <= $3
           ORDER BY created_at`,
          [subIds, from, to]
        ),
        pool.query(
          `SELECT id, created_at, type, description, amount, reference
           FROM transactions
           WHERE sub_account_id = ANY($1::text[])
             AND type = 'deposit'
             AND status = 'completed'
             AND created_at >= $2 AND created_at <= $3
           ORDER BY created_at`,
          [subIds, from, to]
        ),
      ]);
      saReturns  = saR.rows;
      saDeposits = saD.rows;
    }

    const returns  = [...returnsRes.rows,  ...saReturns];
    const deposits = [...depositsRes.rows, ...saDeposits];

    // Sort merged arrays chronologically
    returns.sort((a, b)  => new Date(a.created_at) - new Date(b.created_at));
    deposits.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const totalReturns  = returns.reduce((s, t)  => s + Math.abs(parseFloat(t.amount) || 0), 0);
    const totalDeposits = deposits.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);

    const inv = invRes.rows[0];
    res.json({
      investor: {
        id: inv.id, first_name: inv.first_name, last_name: inv.last_name,
        email: inv.email, id_number: inv.id_number,
        street_address: inv.street_address, suburb: inv.suburb,
        address: inv.address, postal_code: inv.postal_code, province: inv.province,
      },
      taxYear, from, to,
      returns, totalReturns,
      deposits, totalDeposits,
    });
  } catch (err) {
    console.error('[admin/tax-cert]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/admin/account-statement
   Full account statement for an investor over any date range.
   Returns opening/closing balances, per-transaction running balance,
   and the current investment portfolio.
   ════════════════════════════════════════════════════ */
router.get('/account-statement', async (req, res) => {
  try {
    const { investor_id, from, to } = req.query;
    if (!investor_id || !from || !to)
      return res.status(400).json({ error: 'investor_id, from and to are required' });

    const fromDt = new Date(from + 'T00:00:00.000Z');
    const toDt   = new Date(to   + 'T23:59:59.999Z');
    if (isNaN(fromDt.getTime()) || isNaN(toDt.getTime()))
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });

    const [invRes, allTxnRes, invstRes] = await Promise.all([
      pool.query('SELECT * FROM investors WHERE id = $1 LIMIT 1', [investor_id]),
      pool.query(
        `SELECT id, created_at, type, amount, status, reference, description
         FROM transactions
         WHERE investor_id = $1 AND status = 'completed'
         ORDER BY created_at ASC`,
        [investor_id]
      ),
      pool.query(
        `SELECT i.id, i.amount, i.status, i.created_at, i.maturity_date,
                i.expected_return, i.actual_return,
                p.name AS pool_name, p.product_type, p.annual_rate
         FROM investments i
         LEFT JOIN pools p ON p.id = i.pool_id
         WHERE i.investor_id = $1
         ORDER BY i.created_at ASC`,
        [investor_id]
      ),
    ]);

    if (!invRes.rows[0]) return res.status(404).json({ error: 'Investor not found' });

    const inv     = invRes.rows[0];
    const allTxns = allTxnRes.rows;

    // Pre-period transactions → opening wallet balance
    const preTxns = allTxns.filter(t => new Date(t.created_at) < fromDt);
    const inTxns  = allTxns.filter(t => {
      const d = new Date(t.created_at);
      return d >= fromDt && d <= toDt;
    });

    const openingBalance = preTxns.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

    // Attach running balance to each in-period transaction
    let running = openingBalance;
    const transactions = inTxns.map(t => {
      running += parseFloat(t.amount) || 0;
      return { ...t, running_balance: parseFloat(running.toFixed(2)) };
    });
    const closingBalance = parseFloat(running.toFixed(2));

    const activeInvests = invstRes.rows.filter(i => i.status === 'active');
    const totalActive   = activeInvests.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

    res.json({
      investor: {
        id: inv.id, first_name: inv.first_name, last_name: inv.last_name,
        email: inv.email, id_number: inv.id_number,
        mobile: inv.mobile || inv.phone,
        wallet_balance: inv.wallet_balance,
        street_address: inv.street_address, suburb: inv.suburb,
        address: inv.address, postal_code: inv.postal_code, province: inv.province,
      },
      period: { from: fromDt.toISOString(), to: toDt.toISOString() },
      openingBalance: parseFloat(openingBalance.toFixed(2)),
      closingBalance,
      transactions,
      investments: invstRes.rows,
      portfolio: {
        totalActive: parseFloat(totalActive.toFixed(2)),
        activeCount: activeInvests.length,
      },
    });
  } catch (err) {
    console.error('[admin/account-statement]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
