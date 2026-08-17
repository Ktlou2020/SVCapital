const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
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

// Normalize a 3PIM account reference for consistent matching:
// trims whitespace and upper-cases so "s-111581" == "S-111581 "
const normalizeRef = s => (s || '').trim().toUpperCase();

// Strip R prefix, commas and spaces from currency values ("R899.03" → 899.03)
const parseAmt = v => parseFloat((v || '').replace(/[R,\s]/g, '')) || 0;

// POST /api/admin/interest/preview
// Parse CSV, match sub-accounts AND investor wallets, return preview without writing anything
router.post('/interest/preview', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { csv_content, period } = req.body;
    if (!csv_content || !period) return res.status(400).json({ error: 'csv_content and period are required' });

    const rows = parsePimCsv(csv_content);
    if (!rows.length) return res.status(400).json({ error: 'No data rows found in CSV' });

    // Normalized ref list for DB lookup
    const refList = [...new Set(rows.map(r => normalizeRef(r['Account Reference'])).filter(Boolean))];

    // Match against sub-accounts AND investor main wallets using normalized pim_account_ref.
    // UPPER(TRIM(...)) on the DB side ensures mismatched casing or accidental spaces never
    // cause an account to go unmatched.
    const [saResult, invResult] = await Promise.all([
      pool.query(
        `SELECT id, wallet_balance, name, parent_investor_id, pim_account_ref
         FROM sub_accounts WHERE UPPER(TRIM(pim_account_ref)) = ANY($1::text[])`,
        [refList]
      ),
      pool.query(
        `SELECT id, first_name, last_name, wallet_balance, pim_account_ref
         FROM investors WHERE UPPER(TRIM(pim_account_ref)) = ANY($1::text[])`,
        [refList]
      ),
    ]);

    // Build lookup maps keyed by normalized ref.
    // Also detect if two records share the same ref — that is a configuration error and
    // must be flagged rather than silently crediting the wrong account.
    const saMap = {}, saDupes = new Set();
    saResult.rows.forEach(r => {
      const key = normalizeRef(r.pim_account_ref);
      if (saMap[key]) saDupes.add(key);
      else saMap[key] = r;
    });

    const invMap = {}, invDupes = new Set();
    invResult.rows.forEach(r => {
      const key = normalizeRef(r.pim_account_ref);
      if (invMap[key]) invDupes.add(key);
      else invMap[key] = r;
    });

    let totalInterest = 0, toCredit = 0, unmatched = 0, skipped = 0;

    const items = rows.map(row => {
      const ref        = normalizeRef(row['Account Reference']);
      const pimBalance = parseAmt(row['3PIM balance'] || row['Balance']);
      const clientName = (row['Client'] || '').trim();

      // Flag duplicate configuration errors before any credit logic
      const saDupe = saDupes.has(ref);
      const invDupe = !saDupe && invDupes.has(ref);
      if (saDupe || invDupe) {
        unmatched++;
        return {
          account_reference: row['Account Reference'] || ref,
          client_name_pim: clientName, pim_balance: pimBalance,
          platform_balance: null, interest_amount: null,
          status: 'duplicate_ref',
          match_type: null, sub_account_id: null, investor_id: null, platform_name: null,
          platform_account_id: null,
        };
      }

      // Prefer sub-account match; fall back to investor main wallet
      const sa  = saMap[ref];
      const inv = !sa ? invMap[ref] : null;

      if (!sa && !inv) {
        unmatched++;
        return {
          account_reference: row['Account Reference'] || ref,
          client_name_pim: clientName, pim_balance: pimBalance,
          platform_balance: null, interest_amount: null, status: 'unmatched',
          match_type: null, sub_account_id: null, investor_id: null, platform_name: null,
          platform_account_id: null,
        };
      }

      const platformBalance  = parseFloat(sa ? sa.wallet_balance : inv.wallet_balance) || 0;
      const interest         = Math.round((pimBalance - platformBalance) * 100) / 100;

      const matchType        = sa ? 'sub_account' : 'investor';
      const subAccountId     = sa ? sa.id : null;
      const investorId       = sa ? sa.parent_investor_id : inv.id;
      const platformName     = sa ? sa.name : `${inv.first_name} ${inv.last_name}`.trim();
      // platform_account_id lets the UI show the exact DB record ID for visual verification
      const platformAccountId = sa ? sa.id : inv.id;

      if (interest <= 0) {
        skipped++;
        return {
          account_reference: row['Account Reference'] || ref,
          client_name_pim: clientName, pim_balance: pimBalance,
          platform_balance: platformBalance, interest_amount: interest,
          status: interest < 0 ? 'negative' : 'zero',
          match_type: matchType, sub_account_id: subAccountId,
          investor_id: investorId, platform_name: platformName,
          platform_account_id: platformAccountId,
        };
      }

      totalInterest += interest;
      toCredit++;
      return {
        account_reference: row['Account Reference'] || ref,
        client_name_pim: clientName, pim_balance: pimBalance,
        platform_balance: platformBalance, interest_amount: interest, status: 'matched',
        match_type: matchType, sub_account_id: subAccountId,
        investor_id: investorId, platform_name: platformName,
        platform_account_id: platformAccountId,
      };
    });

    res.json({
      period,
      items,
      summary: {
        total_rows:       rows.length,
        to_credit:        toCredit,
        unmatched,
        skipped,
        total_interest:   Math.round(totalInterest * 100) / 100,
        duplicate_refs:   [...saDupes, ...invDupes],
      },
    });
  } catch (err) {
    console.error('[interest] preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/interest/apply
// Atomically credit matched sub-account wallets and/or investor main wallets
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

    const toCredit      = items.filter(i => i.status === 'matched' && i.interest_amount > 0);
    if (!toCredit.length) return res.status(400).json({ error: 'No accounts to credit' });

    // Guard: reject if any item lacks both sub_account_id and investor_id —
    // credits must always go to a specific DB record, never inferred from name alone.
    const badItems = toCredit.filter(i => !i.sub_account_id && !i.investor_id);
    if (badItems.length)
      return res.status(400).json({ error: `${badItems.length} item(s) are missing account IDs — re-run preview and try again.` });

    const appliedBy     = req.user?.id || req.user?.investor_id;
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
         items.filter(i => i.status === 'unmatched' || i.status === 'duplicate_ref').length, appliedBy]
      );
      const distId = distResult.rows[0].id;

      for (const item of toCredit) {
        const walletKey = item.sub_account_id || item.investor_id;
        const txRef     = `INT-${period}-${walletKey}`;
        const desc      = `Interest — ${period}`;

        const txResult = await client.query(
          `INSERT INTO transactions
             (id, investor_id, sub_account_id, type, amount, status, reference, description, transaction_date, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'interest', $3, 'completed', $4, $5, NOW(), NOW(), NOW())
           ON CONFLICT (reference) DO NOTHING RETURNING id`,
          [item.investor_id, item.sub_account_id || null, item.interest_amount, txRef, desc]
        );
        const txId = txResult.rows[0]?.id || null;

        // Credit the correct wallet by DB ID — never by name or reference string
        if (item.sub_account_id) {
          await client.query(
            'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
            [item.interest_amount, item.sub_account_id]
          );
        } else {
          await client.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
            [item.interest_amount, item.investor_id]
          );
        }

        await client.query(
          `INSERT INTO interest_distribution_items
             (distribution_id, sub_account_id, investor_id, account_reference, client_name_pim,
              pim_balance, platform_balance, interest_amount, transaction_id, status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'applied', $10)`,
          [distId, item.sub_account_id || null, item.investor_id, item.account_reference,
           item.client_name_pim, item.pim_balance, item.platform_balance,
           item.interest_amount, txId, item.match_type || null]
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

// GET /api/admin/interest/:id — items for a single distribution
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
