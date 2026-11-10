'use strict';
/* ═══════════════════════════════════════════════════════════
   /api/admin/notice-funds — the fund's managers run the 30-day notice fund.

   Create it (in draft), open or close it to new money, and post its unit
   price. Posting a price settles every order that price covers in the same
   call (services/noticeFund.settle), so the people who know the fund's
   value are the ones who release money against it.

   Staff never move a group's money here. Money into the fund needs the
   group's signatories; money out goes only to the group's own wallet when
   its notice has run. The only lever here is the price, and a price once
   posted is not overwritten.
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
      const price = await noticeFund.latestPrice(pool, f.id);
      const { rows: [t] } = await pool.query(
        `SELECT COUNT(*)::int AS groups, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(cost), 0) AS cost
           FROM notice_fund_holdings WHERE fund_id = $1 AND units > 0`, [f.id]);
      const { rows: pending } = await pool.query(
        `SELECT o.id, o.kind, o.amount, o.all_units, o.requested_at, o.payable_at, a.name AS group_name
           FROM notice_fund_orders o JOIN sub_accounts a ON a.id = o.sub_account_id
          WHERE o.fund_id = $1 AND o.status = 'pending' ORDER BY COALESCE(o.payable_at, o.requested_at) ASC`, [f.id]);
      const { rows: prices } = await pool.query(
        `SELECT price_date, unit_price, posted_by FROM notice_fund_prices WHERE fund_id = $1
          ORDER BY price_date DESC LIMIT 12`, [f.id]);
      out.push({ ...f, latest_price: price, groups: t.groups, units: Number(t.units), cost: Number(t.cost),
                 value: price ? Math.round(Number(t.units) * price.unit_price * 100) / 100 : null,
                 pending, prices });
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
      const price = await noticeFund.latestPrice(pool, req.params.id);
      if (!price) return res.status(400).json({ error: 'Post a first unit price before opening the fund.' });
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

router.post('/:id/prices', async (req, res) => {
  try {
    const out = await noticeFund.postPrice(pool, { fundId: req.params.id,
      priceDate: req.body && req.body.price_date, unitPrice: req.body && req.body.unit_price, postedBy: who(req) });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(201).json({ data: out });
  } catch (err) {
    console.error('[notice-funds] price failed:', err.message);
    return res.status(500).json({ error: 'Could not post that price.' });
  }
});

module.exports = router;
