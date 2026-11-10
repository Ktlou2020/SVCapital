'use strict';
/* ═══════════════════════════════════════════════════════════
   /api/admin/notice-funds — the fund's managers run the 30-day notice fund.

   Create it (in draft), open or close it to new money, and declare each
   month's PROJECTED return before the month starts. The rate sets the unit
   price day by day (services/noticeFund.priceFrom) and is fixed once its
   month has begun.

   Staff never move a group's money here. Money into the fund needs the
   group's signatories; money out goes only to the group's own wallet when
   its notice has run. The only lever here is the rate, and a month that
   has started keeps the rate it started with.
   ═══════════════════════════════════════════════════════════ */

const router = require('express').Router();
const crypto = require('crypto');
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const noticeFund = require('../services/noticeFund');

router.use(requireAuth, requireRole('admin', 'director', 'fund_manager'));

const who = req => (req.user && (req.user.email || req.user.id)) || 'staff';

router.get('/', async (req, res) => {
  try {
    const { rows: funds } = await pool.query(`SELECT * FROM notice_funds ORDER BY created_at ASC`);
    const out = [];
    for (const f of funds) {
      const p = await noticeFund.priceOn(pool, f.id, noticeFund.sastDate(Date.now()));
      const price = p && p.unit_price ? p : null;
      const { rows: [t] } = await pool.query(
        `SELECT COUNT(*)::int AS groups, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(cost), 0) AS cost
           FROM notice_fund_holdings WHERE fund_id = $1 AND units > 0`, [f.id]);
      const { rows: pending } = await pool.query(
        `SELECT o.id, o.kind, o.amount, o.all_units, o.requested_at, o.payable_at, a.name AS group_name
           FROM notice_fund_orders o JOIN sub_accounts a ON a.id = o.sub_account_id
          WHERE o.fund_id = $1 AND o.status = 'pending' ORDER BY COALESCE(o.payable_at, o.requested_at) ASC`, [f.id]);
      const { rows: rateRows } = await pool.query(
        `SELECT to_char(month, 'YYYY-MM') AS month, monthly_rate, declared_by FROM notice_fund_rates
          WHERE fund_id = $1 ORDER BY month DESC LIMIT 14`, [f.id]);
      out.push({ ...f, price, missing: p && p.missing ? p.missing : null,
                 projected: await noticeFund.projected(pool, f.id),
                 groups: t.groups, units: Number(t.units), cost: Number(t.cost),
                 value: price ? Math.round(Number(t.units) * price.unit_price * 100) / 100 : null,
                 pending, rates: rateRows.map(r => ({ month: r.month,
                   monthly_rate_pct: Math.round(Number(r.monthly_rate) * 1e6) / 1e4, declared_by: r.declared_by })) });
    }
    return res.json({ data: out, live: await noticeFund.isLive(pool) });
  } catch (err) {
    console.error('[notice-funds] list failed:', err.message);
    return res.status(500).json({ error: 'Could not load the notice funds.' });
  }
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const days = parseInt(b.notice_days == null ? 30 : b.notice_days, 10);
  const min  = Math.round((parseFloat(b.min_deposit) || 0) * 100) / 100;
  if (!name) return res.status(400).json({ error: 'The fund needs a name.' });
  if (!(days >= 30)) return res.status(400).json({ error: 'The notice period is 30 days or more.' });
  if (!(min >= 0)) return res.status(400).json({ error: 'The minimum cannot be negative.' });
  const id = 'NF-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  try {
    await pool.query(
      `INSERT INTO notice_funds (id, name, notice_days, min_deposit, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`, [id, name, days, min, String(b.description || '').slice(0, 1000) || null, who(req)]);
    return res.status(201).json({ data: { id, name, notice_days: days, min_deposit: min, status: 'draft' } });
  } catch (err) {
    console.error('[notice-funds] create failed:', err.message);
    return res.status(500).json({ error: 'Could not create the fund.' });
  }
});

/* Open to new money, or closed to it. Closing never touches money already
   in it, or a withdrawal already asked for. Lowering the notice period is
   not offered: groups were told a period, and it is theirs. */
router.patch('/:id', async (req, res) => {
  const status = String((req.body && req.body.status) || '');
  if (!['open', 'closed', 'draft'].includes(status)) return res.status(400).json({ error: 'status must be open, closed or draft.' });
  try {
    if (status === 'open') {
      const p = await noticeFund.priceOn(pool, req.params.id, noticeFund.sastDate(Date.now()));
      if (!p || !p.unit_price) return res.status(400).json({ error: 'Declare this month\u2019s projected rate before opening the fund.' });
      const { rows: [other] } = await pool.query(
        `SELECT id FROM notice_funds WHERE status = 'open' AND id <> $1`, [req.params.id]);
      if (other) return res.status(409).json({ error: `Fund ${other.id} is already open. Close it first: groups are offered one.` });
    }
    const { rowCount } = await pool.query(
      `UPDATE notice_funds SET status = $2, updated_at = NOW() WHERE id = $1`, [req.params.id, status]);
    if (!rowCount) return res.status(404).json({ error: 'No such fund.' });
    return res.json({ data: { id: req.params.id, status } });
  } catch (err) {
    console.error('[notice-funds] status failed:', err.message);
    return res.status(500).json({ error: 'Could not change the fund.' });
  }
});

/* Declare a month's projected rate, as a percentage per month. */
router.post('/:id/rates', async (req, res) => {
  try {
    const out = await noticeFund.declareRate(pool, { fundId: req.params.id,
      month: req.body && req.body.month, ratePct: req.body && req.body.monthly_rate_pct, by: who(req) });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(201).json({ data: out });
  } catch (err) {
    console.error('[notice-funds] rate failed:', err.message);
    return res.status(500).json({ error: 'Could not declare that rate.' });
  }
});

module.exports = router;
