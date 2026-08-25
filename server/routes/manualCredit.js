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

/* Cash-movement definition — single source in services/ledger.js */
const { cashMovementSQL } = require('../services/ledger');

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
/* ─── POST /api/admin/reconcile-wallet ───────────────────────────────────
   Compares wallet_balance against the ledger. READ-ONLY unless the caller
   explicitly opts in to a write for one named investor.

   Three things were wrong with the previous behaviour:

     · dry_run was opt-in, so omitting it wrote. The safe call was the longer
       one to type.
     · all:true without dry_run rewrote EVERY investor's wallet in a single
       request, with no audit trail.
     · it overwrote using a from-zero sum of the ledger, which cannot
       reconstruct a balance whose opening figure was imported rather than
       accumulated - see services/ledger.js and the wallet audit.

   Now: reporting is the default, writes require apply:true plus a single
   investor_id, mass writes are refused outright, and a write is blocked when
   the investor carries migrated rows, because their wallet_balance already
   contains an imported opening figure that the ledger does not restate.
   ──────────────────────────────────────────────────────────────────────── */
router.post('/reconcile-wallet', async (req, res) => {
  const { investor_id, all, apply } = req.body || {};
  if (!investor_id && !all) {
    return res.status(400).json({ error: 'Provide investor_id or all:true' });
  }
  // Writing is never implied. dry_run is accepted and ignored so that a stale
  // admin client sending dry_run:true still gets a report, and one omitting it
  // no longer writes by accident.
  const wantsWrite = apply === true;
  if (wantsWrite && !investor_id) {
    return res.status(400).json({
      error: 'apply:true requires a single investor_id. Mass reconciliation is not permitted.',
    });
  }

  try {
    const whereClause = investor_id ? 'AND i.investor_id = $1' : '';
    const params      = investor_id ? [investor_id] : [];

    /* Shared cash-movement definition — services/ledger.js */
    const { rows } = await pool.query(`
      SELECT
        i.investor_id,
        COALESCE(SUM(${cashMovementSQL('i.')}), 0) AS computed_balance,
        COUNT(*) FILTER (WHERE i.id LIKE 'TXN-MIGR-%')::int AS migrated_rows
      FROM transactions i
      WHERE i.sub_account_id IS NULL
        AND i.status = 'completed'
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
      const current  = parseFloat(cur[0].wallet_balance);
      const diff     = Math.round((computed - current) * 100) / 100;
      const migrated = r.migrated_rows > 0;

      // Shape kept as { investor_id, current, computed, diff } — the admin
      // console reads diffs[0] and would break otherwise.
      const row = { investor_id: r.investor_id, current, computed, diff, migrated_rows: r.migrated_rows };

      if (wantsWrite && Math.abs(diff) >= 0.01) {
        if (migrated) {
          row.applied = false;
          row.blocked = 'This investor has migrated transactions, so wallet_balance includes '
                      + 'an imported opening figure the ledger does not restate. Overwriting '
                      + 'would discard it.';
        } else {
          await pool.query(
            'UPDATE investors SET wallet_balance = $1, updated_at = NOW() WHERE id = $2',
            [computed, r.investor_id]
          );
          updated++;
          row.applied = true;
          setImmediate(() => audit.log({
            actorId:     req.user && req.user.id,
            actorEmail:  req.user && req.user.email,
            action:      'wallet.reconciled',
            entityType:  'investors',
            entityId:    r.investor_id,
            description: `Wallet reconciled from ledger: ${current} -> ${computed} (${diff >= 0 ? '+' : ''}${diff})`,
            ip:          req.ip,
          }).catch(() => {}));
        }
      } else {
        row.applied = false;
      }
      diffs.push(row);
    }

    res.json({
      success:   true,
      read_only: !wantsWrite,
      checked:   rows.length,
      updated,
      diffs,
      note: wantsWrite
        ? 'wallet_balance is maintained incrementally by each write path. A ledger sum is a '
        + 'cross-check, not a source of truth; apply it only when the difference is understood.'
        : 'Report only — nothing was changed. Send apply:true with a single investor_id to write.',
    });
  } catch (err) {
    console.error('/admin/reconcile-wallet error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ─── POST /api/admin/backfill-matured-funds ─────────────────────────────────
   One-shot: creates missing "Matured Funds" credit transactions for all
   historical reinvestments that were processed before this bookkeeping entry
   was introduced. Each reinvestment transaction (reference REINV-*) gets a
   paired matured_funds credit (reference MATF-*) if one doesn't already exist.

   Body: { dry_run: true }  — preview only, no writes
         {}                 — apply the backfill
   ─────────────────────────────────────────────────────────────────────── */
router.post('/backfill-matured-funds', async (req, res) => {
  const { dry_run } = req.body || {};
  try {
    // Find all reinvestment transactions that have no paired matured_funds entry.
    const { rows: missing } = await pool.query(`
      SELECT
        t.id                                           AS reinv_txn_id,
        t.investor_id,
        t.sub_account_id,
        t.amount,
        t.transaction_date,
        t.created_at,
        REPLACE(t.reference, 'REINV-', '')             AS original_inv_id,
        'MATF-' || REPLACE(t.reference, 'REINV-', '') AS matf_ref,
        COALESCE(
          (SELECT pool_name FROM investments
            WHERE id = REPLACE(t.reference, 'REINV-', '')),
          'previous investment'
        )                                              AS pool_name
      FROM transactions t
      WHERE t.type = 'reinvestment'
        AND t.reference LIKE 'REINV-%'
        AND NOT EXISTS (
          SELECT 1 FROM transactions t2
          WHERE t2.reference = 'MATF-' || REPLACE(t.reference, 'REINV-', '')
        )
      ORDER BY t.created_at
    `);

    if (dry_run || !missing.length) {
      return res.json({
        dry_run: !!dry_run,
        would_insert: missing.length,
        rows: missing.map(r => ({
          investor_id:     r.investor_id,
          sub_account_id:  r.sub_account_id,
          amount:          parseFloat(r.amount),
          original_inv_id: r.original_inv_id,
          matf_ref:        r.matf_ref,
          pool_name:       r.pool_name,
          date:            r.transaction_date || r.created_at,
        })),
      });
    }

    // Apply backfill — each INSERT is idempotent via ON CONFLICT.
    let inserted = 0;
    for (const r of missing) {
      const { rowCount } = await pool.query(`
        INSERT INTO transactions
          (id, investor_id, sub_account_id, type, amount, status, reference,
           description, investment_id, transaction_date, created_at, updated_at)
        VALUES
          (gen_random_uuid(), $1, $2, 'matured_funds', $3, 'completed', $4,
           $5, $6, $7, $7, NOW())
        ON CONFLICT (reference) DO NOTHING
      `, [
        r.investor_id,
        r.sub_account_id || null,
        parseFloat(r.amount),
        r.matf_ref,
        `Matured Funds — ${r.pool_name}`,
        r.original_inv_id,
        r.transaction_date || r.created_at,
      ]);
      if (rowCount) inserted++;
    }

    setImmediate(() => audit.log({
      actorId:    req.user.id,
      actorEmail: req.user.email,
      action:     'admin.backfill_matured_funds',
      entityType: 'transactions',
      description: `Backfilled ${inserted} missing matured_funds credit transactions for historical reinvestments.`,
      ip:         req.ip,
    }).catch(() => {}));

    res.json({ success: true, inserted, skipped: missing.length - inserted });
  } catch (err) {
    console.error('/admin/backfill-matured-funds error:', err.message);
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

    const [invRes, invstRes, txnRes, openingRes] = await Promise.all([
      pool.query('SELECT * FROM investors WHERE id = $1 LIMIT 1', [investor_id]),
      pool.query(
        `SELECT i.id, i.amount, i.status, i.created_at,
                COALESCE(i.start_date, i.created_at::date) AS start_date,
                i.end_date AS maturity_date,
                i.expected_return, i.actual_return,
                COALESCE(i.annual_rate, p.annual_rate) AS annual_rate,
                i.payout_option,
                p.name AS pool_name, p.product_type,
                p.start_date AS pool_start_date, p.end_date AS pool_end_date,
                mi.instruction AS maturity_instruction
         FROM investments i
         LEFT JOIN investment_pools p ON p.id = i.pool_id
         LEFT JOIN LATERAL (
           SELECT instruction FROM maturity_instructions
           WHERE investment_id = i.id ORDER BY created_at DESC LIMIT 1
         ) mi ON true
         WHERE i.investor_id = $1
           AND COALESCE(i.start_date, i.created_at::date) >= $2
           AND COALESCE(i.start_date, i.created_at::date) <= $3
         ORDER BY i.created_at ASC`,
        [investor_id, fromDt.toISOString().slice(0,10), toDt.toISOString().slice(0,10)]
      ),
      // All completed transactions in the period, ordered chronologically
      pool.query(
        `SELECT type, amount, description, reference,
                COALESCE(transaction_date, created_at) AS txn_date
         FROM transactions
         WHERE investor_id = $1
           AND status = 'completed'
           AND COALESCE(transaction_date, created_at) >= $2
           AND COALESCE(transaction_date, created_at) <= $3
         ORDER BY COALESCE(transaction_date, created_at) ASC, created_at ASC`,
        [investor_id, fromDt, toDt]
      ),
      // Opening balance = net cash effect of all completed transactions before the
      // period, using the shared CASH_MOVEMENT definition above.
      pool.query(
        `SELECT COALESCE(SUM(${cashMovementSQL()}), 0) AS opening_balance
         FROM transactions
         WHERE investor_id = $1
           AND status = 'completed'
           AND COALESCE(transaction_date, created_at) < $2`,
        [investor_id, fromDt]
      ),
    ]);

    if (!invRes.rows[0]) return res.status(404).json({ error: 'Investor not found' });

    const inv = invRes.rows[0];

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
      investments: invstRes.rows,
      transactions: txnRes.rows,
      opening_balance: parseFloat(openingRes.rows[0]?.opening_balance) || 0,
    });
  } catch (err) {
    console.error('[admin/account-statement]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/admin/backfill/investor-demographics ──────────────────────
   Backfills gender (from SA ID number) and heard_about_us (parsed from
   the notes column) for any investor missing those values.
   Safe to run multiple times — only rows where the column is NULL are touched.
   ─────────────────────────────────────────────────────────────────────────── */
router.post('/backfill/investor-demographics', async (req, res) => {
  try {
    const { rows: investors } = await pool.query(`
      SELECT id, id_number, notes, gender, heard_about_us
      FROM investors
      WHERE gender IS NULL OR heard_about_us IS NULL
    `);

    if (!investors.length) {
      return res.json({ gender_updated: 0, heard_updated: 0, message: 'Nothing to backfill' });
    }

    let genderUpdated = 0;
    let heardUpdated  = 0;

    for (const inv of investors) {
      let newGender = null;
      let newHeard  = null;

      // ── Derive gender from SA ID (13 digits, digit at index 6: 0-4 = Female, 5-9 = Male)
      if (inv.gender === null && inv.id_number) {
        const id = String(inv.id_number).replace(/\s/g, '');
        if (/^\d{13}$/.test(id)) {
          const d = parseInt(id[6], 10);
          newGender = d >= 5 ? 'Male' : 'Female';
        }
      }

      // ── Parse heard_about_us from notes column
      // Format written by signup: "... Heard: <value>. FICA docs: ..."
      // or "... Heard: other (<free text>). FICA docs: ..."
      if (inv.heard_about_us === null && inv.notes) {
        const match = inv.notes.match(/Heard:\s*([^.]+?)(?:\s*\.|$)/i);
        if (match) {
          newHeard = match[1].trim();
        }
      }

      if (newGender !== null || newHeard !== null) {
        await pool.query(
          `UPDATE investors
           SET gender         = COALESCE($2, gender),
               heard_about_us = COALESCE($3, heard_about_us)
           WHERE id = $1`,
          [inv.id, newGender, newHeard]
        );
        if (newGender !== null) genderUpdated++;
        if (newHeard  !== null) heardUpdated++;
      }
    }

    res.json({ gender_updated: genderUpdated, heard_updated: heardUpdated, total_checked: investors.length });
  } catch (err) {
    console.error('[admin/backfill/investor-demographics]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/admin/import/heard-about-us ───────────────────────────────
   Accepts the same `users` JSON array from the old platform export and
   ONLY updates heard_about_us for matching investors — nothing else is touched.
   Safe to run multiple times — COALESCE means existing values are never overwritten.
   ─────────────────────────────────────────────────────────────────────────── */
router.post('/import/heard-about-us', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { users } = req.body;
    if (!Array.isArray(users) || !users.length) {
      return res.status(400).json({ error: 'Body must contain a non-empty `users` array' });
    }

    let updated = 0, skipped = 0, notFound = 0;

    for (const u of users) {
      const id = u.userAccountNumber;
      if (!id) { skipped++; continue; }

      const heard = (
        u.WhereDidYouHearAboutUs ||
        u.heardAboutUs || u.heard_about_us || u.howDidYouHearAboutUs ||
        u.how_did_you_hear || u.referralSource || u.referral_source ||
        u.acquisitionSource || u.acquisition_source || null
      );

      if (!heard) { skipped++; continue; }

      const { rowCount } = await pool.query(
        `UPDATE investors
         SET heard_about_us = $2
         WHERE id = $1 AND heard_about_us IS NULL`,
        [id, heard]
      );

      if (rowCount > 0) updated++;
      else skipped++;  // either not found or already had a value
    }

    await audit.log(req.user, 'import_heard_about_us', 'investors', null,
      { updated, skipped, total: users.length });

    res.json({ updated, skipped, total: users.length,
      message: `Updated heard_about_us for ${updated} investor(s). ${skipped} skipped (already set or no value in export).` });
  } catch (err) {
    console.error('[import/heard-about-us]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/admin/reverse/migration-demographics ──────────────────────
   Clears gender and heard_about_us for ALL investors, undoing what the
   re-import set. Does NOT restore other fields (notes, address, occupation)
   — those require a database backup restore if they were manually edited.
   ─────────────────────────────────────────────────────────────────────────── */
router.post('/reverse/migration-demographics', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE investors
      SET heard_about_us = NULL
      WHERE heard_about_us IS NOT NULL
      RETURNING id
    `);
    const count = rows.length;
    await audit.log(req.user, 'reverse_migration_demographics', 'investors', null,
      { cleared: count });
    res.json({ cleared: count, message: `Cleared heard_about_us for ${count} investor(s).` });
  } catch (err) {
    console.error('[reverse/migration-demographics]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /api/admin/restore/investor-statuses ───────────────────────────
   Recovers kyc_status, fica_status, and investor status from tables that
   were NOT overwritten by the migration re-import:
     - kyc_documents: if any document is 'approved' → mark investor approved
     - investments + wallet: if investor has activity → mark status active
   Safe to run multiple times (only upgrades, never downgrades statuses).
   Body: { dry_run: true } — preview counts without writing
   ─────────────────────────────────────────────────────────────────────────── */
router.post('/restore/investor-statuses', async (req, res) => {
  try {
    const dryRun = !!req.body?.dry_run;

    // Count investors with approved KYC docs whose kyc/fica status is not yet approved
    const { rows: kycRows } = await pool.query(`
      SELECT i.id
      FROM investors i
      WHERE (i.kyc_status != 'approved' OR i.fica_status != 'approved')
        AND EXISTS (
          SELECT 1 FROM kyc_documents kd
          WHERE kd.investor_id = i.id AND kd.status = 'approved'
        )
    `);

    // Count investors with activity (positive wallet/investment) whose status is not active
    const { rows: statusRows } = await pool.query(`
      SELECT i.id
      FROM investors i
      WHERE i.status != 'active'
        AND (
          i.wallet_balance > 0
          OR i.total_invested > 0
          OR EXISTS (SELECT 1 FROM investments inv WHERE inv.investor_id = i.id)
          OR EXISTS (SELECT 1 FROM transactions tx WHERE tx.investor_id = i.id AND tx.status = 'completed')
        )
    `);

    let kycRestored = 0, statusRestored = 0;

    if (!dryRun) {
      // Restore kyc_status and fica_status from approved kyc_documents
      const { rowCount: kc } = await pool.query(`
        UPDATE investors i
        SET
          kyc_status       = 'approved',
          fica_status      = 'approved',
          fica_approved_at = COALESCE(i.fica_approved_at,
            (SELECT MAX(reviewed_at) FROM kyc_documents WHERE investor_id = i.id AND status = 'approved'),
            NOW()
          ),
          updated_at = NOW()
        WHERE (i.kyc_status != 'approved' OR i.fica_status != 'approved')
          AND EXISTS (
            SELECT 1 FROM kyc_documents kd
            WHERE kd.investor_id = i.id AND kd.status = 'approved'
          )
      `);
      kycRestored = kc;

      // Restore status to active for investors with any completed activity
      const { rowCount: sc } = await pool.query(`
        UPDATE investors i
        SET status = 'active', updated_at = NOW()
        WHERE i.status != 'active'
          AND (
            i.wallet_balance > 0
            OR i.total_invested > 0
            OR EXISTS (SELECT 1 FROM investments inv WHERE inv.investor_id = i.id)
            OR EXISTS (SELECT 1 FROM transactions tx WHERE tx.investor_id = i.id AND tx.status = 'completed')
          )
      `);
      statusRestored = sc;

      setImmediate(() => audit.log({
        actorId:    req.user.id,
        actorEmail: req.user.email,
        action:     'investors.restore_statuses',
        entityType: 'investors',
        description: `Restored investor statuses from KYC docs and activity: ${kycRestored} KYC/FICA restored, ${statusRestored} status set to active`,
        ip:         req.ip,
      }).catch(() => {}));
    } else {
      kycRestored  = kycRows.length;
      statusRestored = statusRows.length;
    }

    res.json({
      dry_run: dryRun,
      kyc_fica_restored: kycRestored,
      status_restored:   statusRestored,
      message: dryRun
        ? `Preview: ${kycRestored} investor(s) would have KYC/FICA restored, ${statusRestored} would be set active`
        : `Done: ${kycRestored} investor(s) had KYC/FICA restored from documents, ${statusRestored} had status set to active`,
    });
  } catch (err) {
    console.error('[restore/investor-statuses]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
