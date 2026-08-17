'use strict';
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const _admin = requireRole('admin', 'director', 'staff');

/* ── GET /api/analytics/revenue ─────────────────────────── */
router.get('/revenue', requireAuth, _admin, async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months, 10) || 12, 36);
    const [monthlyRows, productRows, allTimeRow, periodRow] = await Promise.all([
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month,
               COUNT(*) AS fee_count,
               SUM(ABS(amount)) AS fee_total
        FROM transactions
        WHERE type IN ('fee','platform_fee') AND status = 'completed'
          AND created_at >= NOW() - ($1 || ' months')::INTERVAL
        GROUP BY 1 ORDER BY 1
      `, [months]),
      pool.query(`
        SELECT COALESCE(i.product_type, 'unknown') AS product_type,
               COUNT(t.id) AS fee_count,
               SUM(ABS(t.amount)) AS fee_total
        FROM transactions t
        LEFT JOIN investments i ON i.id = t.investment_id
        WHERE t.type IN ('fee','platform_fee') AND t.status = 'completed'
          AND t.created_at >= NOW() - ($1 || ' months')::INTERVAL
        GROUP BY 1 ORDER BY fee_total DESC
      `, [months]),
      pool.query(`
        SELECT SUM(ABS(amount)) AS total_all_time
        FROM transactions WHERE type IN ('fee','platform_fee') AND status = 'completed'
      `),
      pool.query(`
        SELECT SUM(ABS(amount)) AS total_period, COUNT(*) AS count_period
        FROM transactions
        WHERE type IN ('fee','platform_fee') AND status = 'completed'
          AND created_at >= NOW() - ($1 || ' months')::INTERVAL
      `, [months]),
    ]);
    res.json({
      months,
      monthly:        monthlyRows.rows.map(r => ({ month: r.month, count: parseInt(r.fee_count), total: parseFloat(r.fee_total || 0) })),
      by_product:     productRows.rows.map(r => ({ product_type: r.product_type, count: parseInt(r.fee_count), total: parseFloat(r.fee_total || 0) })),
      total_all_time: parseFloat(allTimeRow.rows[0]?.total_all_time || 0),
      total_period:   parseFloat(periodRow.rows[0]?.total_period || 0),
      count_period:   parseInt(periodRow.rows[0]?.count_period || 0),
    });
  } catch (err) {
    console.error('[analytics-extra] revenue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/maturity-reinvestment ────────────── */
router.get('/maturity-reinvestment', requireAuth, _admin, async (req, res) => {
  try {
    const [maturedRow, reinvestRow, monthlyRows] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS total_matured,
               SUM(amount) AS total_capital,
               COUNT(*) FILTER (WHERE payout_option = 'reinvest') AS elected_reinvest
        FROM investments WHERE status = 'matured'
      `),
      pool.query(`
        SELECT COUNT(*) AS reinvested, SUM(amount) AS reinvested_capital
        FROM investments WHERE is_reinvestment = true AND status IN ('active','matured')
      `),
      pool.query(`
        SELECT DATE_TRUNC('month', updated_at) AS month,
               COUNT(*) AS matured,
               COUNT(*) FILTER (WHERE payout_option = 'reinvest') AS reinvested,
               SUM(amount) AS capital
        FROM investments
        WHERE status = 'matured' AND updated_at >= NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1
      `),
    ]);
    const m = maturedRow.rows[0];
    const r = reinvestRow.rows[0];
    const totalMatured  = parseInt(m?.total_matured || 0);
    const actualReinvested = parseInt(r?.reinvested || 0);
    res.json({
      total_matured:      totalMatured,
      total_capital:      parseFloat(m?.total_capital || 0),
      elected_reinvest:   parseInt(m?.elected_reinvest || 0),
      actual_reinvested:  actualReinvested,
      reinvested_capital: parseFloat(r?.reinvested_capital || 0),
      reinvestment_rate:  totalMatured > 0 ? parseFloat((actualReinvested / totalMatured).toFixed(3)) : 0,
      monthly: monthlyRows.rows.map(r => ({
        month: r.month, matured: parseInt(r.matured),
        reinvested: parseInt(r.reinvested), capital: parseFloat(r.capital || 0),
      })),
    });
  } catch (err) {
    console.error('[analytics-extra] maturity-reinvestment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/ifa-performance ──────────────────── */
router.get('/ifa-performance', requireAuth, _admin, async (req, res) => {
  try {
    const [ifaRows, totalRow] = await Promise.all([
      pool.query(`
        SELECT
          f.id, f.first_name, f.last_name, f.email, f.company_name,
          f.commission_rate, f.status,
          COUNT(DISTINCT i.id) AS client_count,
          COUNT(DISTINCT inv.id) FILTER (WHERE inv.status = 'active') AS active_investments,
          COALESCE(SUM(i.total_invested), 0) AS total_aum,
          COALESCE(SUM(i.wallet_balance), 0) AS total_wallet
        FROM ifas f
        LEFT JOIN investors i   ON i.ifa_id = f.id
        LEFT JOIN investments inv ON inv.investor_id = i.id
        GROUP BY f.id, f.first_name, f.last_name, f.email, f.company_name, f.commission_rate, f.status
        ORDER BY total_aum DESC
      `),
      pool.query(`
        SELECT COUNT(DISTINCT id) AS total_with_ifa, COALESCE(SUM(total_invested),0) AS total_aum_via_ifa
        FROM investors WHERE ifa_id IS NOT NULL
      `),
    ]);
    res.json({
      ifas: ifaRows.rows.map(r => ({
        id:                 r.id,
        name:               `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        email:              r.email,
        company:            r.company_name,
        commission_rate:    parseFloat(r.commission_rate || 0),
        status:             r.status,
        client_count:       parseInt(r.client_count || 0),
        active_investments: parseInt(r.active_investments || 0),
        total_aum:          parseFloat(r.total_aum || 0),
        total_wallet:       parseFloat(r.total_wallet || 0),
      })),
      total_investors_via_ifa: parseInt(totalRow.rows[0]?.total_with_ifa || 0),
      total_aum_via_ifa:       parseFloat(totalRow.rows[0]?.total_aum_via_ifa || 0),
    });
  } catch (err) {
    console.error('[analytics-extra] ifa-performance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/sub-accounts ────────────────────── */
router.get('/sub-accounts', requireAuth, _admin, async (req, res) => {
  try {
    const [summaryRow, byTypeRows, monthlyRows] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status != 'active') AS dormant,
          COUNT(*) FILTER (WHERE wallet_balance > 0) AS funded,
          COALESCE(SUM(wallet_balance), 0) AS total_balance,
          COALESCE(SUM(total_invested), 0) AS total_invested,
          COALESCE(SUM(total_returns), 0) AS total_returns,
          AVG(wallet_balance) FILTER (WHERE wallet_balance > 0) AS avg_balance
        FROM sub_accounts
      `),
      pool.query(`
        SELECT account_type,
               COUNT(*) AS count,
               COALESCE(SUM(wallet_balance), 0) AS balance,
               COALESCE(SUM(total_invested), 0) AS invested
        FROM sub_accounts
        GROUP BY account_type ORDER BY count DESC
      `),
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS new_accounts
        FROM sub_accounts WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1
      `),
    ]);
    const s = summaryRow.rows[0];
    res.json({
      total:          parseInt(s?.total || 0),
      active:         parseInt(s?.active || 0),
      dormant:        parseInt(s?.dormant || 0),
      funded:         parseInt(s?.funded || 0),
      total_balance:  parseFloat(s?.total_balance || 0),
      total_invested: parseFloat(s?.total_invested || 0),
      total_returns:  parseFloat(s?.total_returns || 0),
      avg_balance:    parseFloat(s?.avg_balance || 0),
      by_type:     byTypeRows.rows.map(r => ({ type: r.account_type, count: parseInt(r.count), balance: parseFloat(r.balance || 0), invested: parseFloat(r.invested || 0) })),
      monthly_new: monthlyRows.rows.map(r => ({ month: r.month, count: parseInt(r.new_accounts) })),
    });
  } catch (err) {
    console.error('[analytics-extra] sub-accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/interest-history ─────────────────── */
router.get('/interest-history', requireAuth, _admin, async (req, res) => {
  try {
    const [listRows, totalRow] = await Promise.all([
      pool.query(`
        SELECT period, total_interest, accounts_credited, accounts_skipped,
               accounts_unmatched, applied_at, status, pim_file_name
        FROM interest_distributions
        ORDER BY applied_at DESC NULLS LAST, created_at DESC
        LIMIT 24
      `),
      pool.query(`
        SELECT COUNT(*) AS distributions,
               COALESCE(SUM(total_interest), 0) AS grand_total,
               COALESCE(SUM(accounts_credited), 0) AS total_accounts_credited
        FROM interest_distributions WHERE status = 'applied'
      `),
    ]);
    res.json({
      distributions: listRows.rows.map(r => ({
        period:            r.period,
        total_interest:    parseFloat(r.total_interest || 0),
        accounts_credited: parseInt(r.accounts_credited || 0),
        accounts_skipped:  parseInt(r.accounts_skipped || 0),
        accounts_unmatched: parseInt(r.accounts_unmatched || 0),
        applied_at:        r.applied_at,
        status:            r.status,
        pim_file_name:     r.pim_file_name,
      })),
      summary: {
        distribution_count:      parseInt(totalRow.rows[0]?.distributions || 0),
        grand_total:             parseFloat(totalRow.rows[0]?.grand_total || 0),
        total_accounts_credited: parseInt(totalRow.rows[0]?.total_accounts_credited || 0),
      },
    });
  } catch (err) {
    console.error('[analytics-extra] interest-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/analytics/withdrawals ─────────────────────── */
router.get('/withdrawals', requireAuth, _admin, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const [monthlyRows, summaryRow, recentRows] = await Promise.all([
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month,
               COUNT(*) AS count,
               SUM(ABS(amount)) AS volume
        FROM transactions
        WHERE type = 'withdrawal'
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY 1 ORDER BY 1
      `, [days]),
      pool.query(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(ABS(amount)), 0) AS total_volume,
               COALESCE(AVG(ABS(amount)), 0) AS avg_amount,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed,
               COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
               COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected
        FROM transactions
        WHERE type = 'withdrawal'
          AND created_at >= NOW() - ($1 || ' days')::INTERVAL
      `, [days]),
      pool.query(`
        SELECT t.id, t.amount, t.status, t.created_at,
               COALESCE(i.first_name || ' ' || i.last_name, i.email) AS investor_name
        FROM transactions t
        LEFT JOIN investors i ON i.id = t.investor_id
        WHERE t.type = 'withdrawal'
          AND t.created_at >= NOW() - ($1 || ' days')::INTERVAL
        ORDER BY t.created_at DESC LIMIT 10
      `, [days]),
    ]);
    const s = summaryRow.rows[0];
    res.json({
      days,
      summary: {
        total:        parseInt(s?.total || 0),
        total_volume: parseFloat(s?.total_volume || 0),
        avg_amount:   parseFloat(s?.avg_amount || 0),
        completed:    parseInt(s?.completed || 0),
        pending:      parseInt(s?.pending || 0),
        rejected:     parseInt(s?.rejected || 0),
      },
      monthly: monthlyRows.rows.map(r => ({ month: r.month, count: parseInt(r.count), volume: parseFloat(r.volume || 0) })),
      recent:  recentRows.rows.map(r => ({ id: r.id, amount: parseFloat(r.amount || 0), status: r.status, investor_name: r.investor_name, created_at: r.created_at })),
    });
  } catch (err) {
    console.error('[analytics-extra] withdrawals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
