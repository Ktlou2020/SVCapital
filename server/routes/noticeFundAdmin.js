'use strict';
/* ═══════════════════════════════════════════════════════════
   /api/admin/notice-funds — the fund's managers run the 30-day notice fund.

   Create it (in draft), open or close it to new money, declare each
   month's PROJECTED return before the month starts (and amend it while the
   month is current), and post the ACTUAL return once the month has ended.
   The rate in force — actual where posted, projected until then — sets the
   unit price day by day (services/noticeFund.priceFrom). Every change is
   logged (notice_fund_rate_log).

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
const noticeFundRate = require('../services/noticeFundRate');

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
        `SELECT to_char(month, 'YYYY-MM') AS month, monthly_rate, actual_rate, declared_by, actual_posted_by
           FROM notice_fund_rates WHERE fund_id = $1 ORDER BY month DESC LIMIT 14`, [f.id]);
      const { rows: log } = await pool.query(
        `SELECT to_char(month, 'YYYY-MM') AS month, field, old_rate, new_rate, changed_by, changed_at
           FROM notice_fund_rate_log WHERE fund_id = $1 ORDER BY changed_at DESC LIMIT 15`, [f.id]);
      const thisMonth = noticeFund.sastDate(Date.now()).slice(0, 7);
      const pct = v => v == null ? null : Math.round(Number(v) * 1e6) / 1e4;
      out.push({ ...f, price, missing: p && p.missing ? p.missing : null,
                 projected: await noticeFund.projected(pool, f.id),
                 groups: t.groups, units: Number(t.units), cost: Number(t.cost),
                 value: price ? Math.round(Number(t.units) * price.unit_price * 100) / 100 : null,
                 pending,
                 rates: rateRows.map(r => ({ month: r.month, monthly_rate_pct: pct(r.monthly_rate),
                   actual_rate_pct: pct(r.actual_rate), declared_by: r.declared_by, actual_posted_by: r.actual_posted_by,
                   ended: r.month < thisMonth })),
                 /* Ended months still waiting for their actual return. */
                 needs_actual: rateRows.filter(r => r.month < thisMonth && r.actual_rate == null).map(r => r.month),
                 log: log.map(l => ({ month: l.month, field: l.field, old_pct: pct(l.old_rate), new_pct: pct(l.new_rate),
                   by: l.changed_by, at: l.changed_at })) });
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
/* THE MINIMUM WAS WRITE-ONCE, which nobody meant. It is asked for on the
   create form and then there was no way to change it: this route read
   `status` and ignored everything else, and notice_funds is not in
   ALLOWED_TABLES, so the generic editor could not reach it either.
   Changing a fund's minimum meant an UPDATE typed against production by
   hand, on a fund whose every rate change is otherwise logged.

   notice_days is still not editable, and that is a decision rather than
   the same oversight: groups were told a notice period and it is theirs.
   The minimum governs only money not yet in — what a group already holds,
   and any notice it has already given, are untouched by a change here. */
router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  const hasStatus = b.status !== undefined;
  const hasMin    = b.min_deposit !== undefined;
  if (!hasStatus && !hasMin) {
    return res.status(400).json({ error: 'Send a status, a min_deposit, or both.' });
  }

  const status = String(b.status || '');
  if (hasStatus && !['open', 'closed', 'draft'].includes(status)) {
    return res.status(400).json({ error: 'status must be open, closed or draft.' });
  }

  /* Rounded the way the create route rounds it, so a fund cannot be made
     under one rule and then amended under another. */
  let min = null;
  if (hasMin) {
    const raw = parseFloat(b.min_deposit);
    if (!Number.isFinite(raw) || raw < 0) {
      return res.status(400).json({ error: 'The minimum cannot be negative.' });
    }
    min = Math.round(raw * 100) / 100;
  }

  try {
    const { rows: [before] } = await pool.query(
      `SELECT id, name, status, min_deposit FROM notice_funds WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'No such fund.' });

    if (hasStatus && status === 'open') {
      const p = await noticeFund.priceOn(pool, req.params.id, noticeFund.sastDate(Date.now()));
      if (!p || !p.unit_price) return res.status(400).json({ error: 'Declare this month\u2019s projected rate before opening the fund.' });
      const { rows: [other] } = await pool.query(
        `SELECT id FROM notice_funds WHERE status = 'open' AND id <> $1`, [req.params.id]);
      if (other) return res.status(409).json({ error: `Fund ${other.id} is already open. Close it first: groups are offered one.` });
    }
    const sets = ['updated_at = NOW()'];
    const args = [req.params.id];
    if (hasStatus) { args.push(status); sets.push('status = $' + args.length); }
    if (hasMin)    { args.push(min);    sets.push('min_deposit = $' + args.length); }

    const { rows: [after] } = await pool.query(
      'UPDATE notice_funds SET ' + sets.join(', ') + ' WHERE id = $1'
      + ' RETURNING id, name, status, min_deposit', args);

    /* AUDITED BY NAME, like the switch that offers the fund to groups.
       The minimum decides what a group may put in, so "who changed it,
       from what, to what, and when" is the first question anybody asks
       afterwards — and until now the answer was a hand-typed UPDATE and
       no record at all. Logged only when the value actually moved: a
       panel that re-saves the same figure should not fill the audit
       trail with changes that were not changes. */
    const audit = require('../services/audit');
    const actor = {
      actorId: req.user && req.user.id, actorEmail: req.user && req.user.email,
      actorRole: req.user && req.user.role,
    };
    const prevMin = Number(before.min_deposit);
    if (hasMin && prevMin !== min) {
      audit.log(Object.assign({}, actor, {
        action: 'notice_fund.minimum_changed',
        entityType: 'notice_funds', entityId: before.id,
        description: before.name + ': minimum changed from R' + prevMin.toFixed(2)
                   + ' to R' + min.toFixed(2),
        /* Structured as well as in prose: a figure somebody will want to
           read back, or compare, should not have to be parsed out of a
           sentence. */
        before: { min_deposit: prevMin }, after: { min_deposit: min },
      })).catch(() => {});
    }
    if (hasStatus && before.status !== status) {
      audit.log(Object.assign({}, actor, {
        action: 'notice_fund.status_changed',
        entityType: 'notice_funds', entityId: before.id,
        description: before.name + ': ' + before.status + ' to ' + status,
      })).catch(() => {});
    }

    return res.json({ data: { id: after.id, status: after.status,
                              min_deposit: Number(after.min_deposit) } });
  } catch (err) {
    console.error('[notice-funds] patch failed:', err.message);
    return res.status(500).json({ error: 'Could not change the fund.' });
  }
});

/* WHAT THE MAIZE BOOK EARNED, as a rate this fund could declare.
 *
 * Read-only on purpose. It works the figure out and shows the arithmetic;
 * declaring it is still the POST below, pressed by a person. The loads come
 * from a spreadsheet somebody maintains by hand, and stl_facilities says in
 * its own header that such a document must not move what a client is paid —
 * so it does not, on its own. */
router.get('/:id/facility-rate', async (req, res) => {
  try {
    const out = await noticeFundRate.facilityMonth(pool, {
      facilityId: req.query && req.query.facility_id,
      month: req.query && req.query.month,
    });
    if (out.error) return res.status(400).json(out);
    return res.json({ data: out, facilities: await noticeFundRate.candidates(pool) });
  } catch (err) {
    console.error('[notice-funds] facility rate failed:', err.message);
    return res.status(500).json({ error: 'Could not work out a rate from the facility.' });
  }
});

/* Declare or amend a month's projected rate, as a percentage per month. */
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

/* Post a month's actual return, once the month has ended. Final. */
router.post('/:id/actuals', async (req, res) => {
  try {
    const out = await noticeFund.postActual(pool, { fundId: req.params.id,
      month: req.body && req.body.month, ratePct: req.body && req.body.actual_rate_pct, by: who(req) });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.status(201).json({ data: out });
  } catch (err) {
    console.error('[notice-funds] actual failed:', err.message);
    return res.status(500).json({ error: 'Could not post that actual return.' });
  }
});

module.exports = router;
