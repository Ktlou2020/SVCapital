const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// Parse the 3PIM CSV export — handles simple comma-delimited format
function parsePimCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

// POST /api/admin/interest/preview
// Parse CSV, match sub-accounts, return preview without writing anything
router.post('/interest/preview', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { csv_content, period } = req.body;
    if (!csv_content || !period) return res.status(400).json({ error: 'csv_content and period are required' });

    const rows = parsePimCsv(csv_content);
    if (!rows.length) return res.status(400).json({ error: 'No data rows found in CSV' });

    // Fetch all relevant sub-accounts in one query
    const refList = [...new Set(rows.map(r => r['Account Reference']).filter(Boolean))];
    const saResult = await pool.query(
      `SELECT sa.id, sa.wallet_balance, sa.name, sa.parent_investor_id
       FROM sub_accounts sa WHERE sa.id = ANY($1::text[])`,
      [refList]
    );
    const saMap = {};
    saResult.rows.forEach(r => { saMap[r.id] = r; });

    let totalInterest = 0, toCredit = 0, unmatched = 0, skipped = 0;

    const items = rows.map(row => {
      const ref         = (row['Account Reference'] || '').trim();
      const pimBalance  = parseFloat(row['Balance']) || 0;
      const clientName  = (row['Client'] || '').trim();
      const sa          = saMap[ref];

      if (!sa) {
        unmatched++;
        return { account_reference: ref, client_name_pim: clientName, pim_balance: pimBalance,
                 platform_balance: null, interest_amount: null, status: 'unmatched',
                 sub_account_id: null, investor_id: null, platform_name: null };
      }

      const platformBalance = parseFloat(sa.wallet_balance) || 0;
      const interest        = Math.round((pimBalance - platformBalance) * 100) / 100;

      if (interest <= 0) {
        skipped++;
        return { account_reference: ref, client_name_pim: clientName, pim_balance: pimBalance,
                 platform_balance: platformBalance, interest_amount: interest,
                 status: interest < 0 ? 'negative' : 'zero',
                 sub_account_id: sa.id, investor_id: sa.parent_investor_id, platform_name: sa.name };
      }

      totalInterest += interest;
      toCredit++;
      return { account_reference: ref, client_name_pim: clientName, pim_balance: pimBalance,
               platform_balance: platformBalance, interest_amount: interest, status: 'matched',
               sub_account_id: sa.id, investor_id: sa.parent_investor_id, platform_name: sa.name };
    });

    res.json({
      period,
      items,
      summary: {
        total_rows:   rows.length,
        to_credit:    toCredit,
        unmatched,
        skipped,
        total_interest: Math.round(totalInterest * 100) / 100,
      },
    });
  } catch (err) {
    console.error('[interest] preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/interest/apply
// Atomically credit all matched sub-account wallets and record the distribution
router.post('/interest/apply', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { period, items, csv_filename } = req.body;
    if (!period || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'period and items are required' });

    // Prevent double-applying the same period
    const existing = await pool.query(
      `SELECT id FROM interest_distributions WHERE period = $1 AND status = 'applied'`, [period]
    );
    if (existing.rows.length)
      return res.status(409).json({ error: `Interest for period "${period}" has already been applied.` });

    const toCredit = items.filter(i => i.status === 'matched' && i.interest_amount > 0);
    if (!toCredit.length) return res.status(400).json({ error: 'No accounts to credit' });

    const appliedBy    = req.user?.id || req.user?.investor_id;
    const totalInterest = Math.round(toCredit.reduce((s, i) => s + i.interest_amount, 0) * 100) / 100;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const distResult = await client.query(
        `INSERT INTO interest_distributions
           (period, pim_file_name, total_interest, accounts_credited, accounts_skipped, accounts_unmatched, applied_by, applied_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'applied') RETURNING id`,
        [period, csv_filename || null, totalInterest, toCredit.length,
         items.filter(i => i.status === 'zero' || i.status === 'negative').length,
         items.filter(i => i.status === 'unmatched').length, appliedBy]
      );
      const distId = distResult.rows[0].id;

      for (const item of toCredit) {
        const txRef = `INT-${period}-${item.sub_account_id}`;

        const txResult = await client.query(
          `INSERT INTO transactions
             (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'interest', $3, 'completed', $4, $5, NOW(), NOW(), NOW())
           ON CONFLICT (reference) DO NOTHING RETURNING id`,
          [item.investor_id, item.sub_account_id, item.interest_amount,
           txRef, `3PIM interest — ${period}`]
        );
        const txId = txResult.rows[0]?.id || null;

        await client.query(
          'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
          [item.interest_amount, item.sub_account_id]
        );

        await client.query(
          `INSERT INTO interest_distribution_items
             (distribution_id, sub_account_id, investor_id, account_reference, client_name_pim,
              pim_balance, platform_balance, interest_amount, transaction_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'applied')`,
          [distId, item.sub_account_id, item.investor_id, item.account_reference,
           item.client_name_pim, item.pim_balance, item.platform_balance,
           item.interest_amount, txId]
        );
      }

      await client.query('COMMIT');
      res.json({ success: true, distribution_id: distId, accounts_credited: toCredit.length,
                 total_interest: totalInterest });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[interest] apply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/interest — list past distributions
router.get('/interest', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, period, pim_file_name, total_interest, accounts_credited, accounts_skipped,
              accounts_unmatched, applied_by, applied_at, status, created_at
       FROM interest_distributions ORDER BY created_at DESC LIMIT 36`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[interest] list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/interest/:id — single distribution items
router.get('/interest/:id', requireAuth, requireRole('admin', 'director', 'staff'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM interest_distribution_items WHERE distribution_id = $1 ORDER BY interest_amount DESC NULLS LAST`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
