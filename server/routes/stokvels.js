'use strict';
/* ═══════════════════════════════════════════════════════════
   Stokvels — what a member of a group may see.

   A stokvel is a sub_accounts row of type 'stokvel'. Before this, the only
   person who could see one was the investor in parent_investor_id: the
   chairperson, who opened it. The generic table reader scopes an investor to
   sub_accounts.parent_investor_id and can express nothing else, because it
   filters on ONE column — and "the group I am a member of" is not a column,
   it is a join.

   That is why these are hand-written endpoints rather than another entry in
   that map. Every one of them resolves the caller's membership first and
   answers from the group it found, so there is no request shape in which a
   stokvel id supplied by the caller reaches a query without having been
   checked against them.

   Phase 1 was read-only. Phase 2 adds the mandate: a request to take money
   out, and the signatory votes against it. These endpoints write, but they
   write AUTHORITY, never money — the request is a permission slip and the
   existing withdrawal route is still the only thing that moves a rand. That
   separation is deliberate: the gate can be reasoned about on its own, and
   a bug here withholds money rather than releasing it.
   ═══════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const mandate = require('../services/stokvelMandate');
const crypto  = require('crypto');

router.use(requireAuth);

/* The caller's own investor id. Staff carry no investor_id, and a stokvel is
   a client-facing view — staff read the same data through the admin console,
   which has its own routes and its own audit. */
function callerInvestorId(req) {
  return req.user && req.user.investor_id ? String(req.user.investor_id) : null;
}

/* ─── The membership guard ─────────────────────────────────────────────
   One definition, used by every endpoint below that takes an :id. Returns
   the group when the caller may see it and null when they may not, and the
   two cases the caller may see it in are the two that exist:

     · they are an ACTIVE member of it, or
     · they opened it, which is the chairperson's row today.

   'invited' is not 'active'. Somebody who has been added but has not accepted
   can see nothing; somebody who has exited stops seeing it the moment their
   row says so. Both are the point of having a status at all.
   ──────────────────────────────────────────────────────────────────── */
async function groupForCaller(investorId, groupId) {
  if (!investorId || !groupId) return null;
  const { rows } = await pool.query(
    `SELECT s.*,
            m.role          AS my_role,
            m.is_signatory  AS my_is_signatory,
            (s.parent_investor_id = $1) AS i_opened_it
       FROM sub_accounts s
       LEFT JOIN stokvel_members m
              ON m.sub_account_id = s.id
             AND m.investor_id    = $1
             AND m.status         = 'active'
      WHERE s.id = $2
        AND s.account_type = 'stokvel'
        AND (m.id IS NOT NULL OR s.parent_investor_id = $1)`,
    [investorId, groupId]
  );
  return rows[0] || null;
}

/* ─── GET /api/stokvels — the groups I am in ─────────────────────────── */
router.get('/', async (req, res) => {
  const me = callerInvestorId(req);
  if (!me) return res.json({ data: [] });
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.stokvel_reg_number, s.status,
              s.wallet_balance, s.total_invested, s.total_returns,
              s.savings_goal, s.savings_goal_label,
              m.role         AS my_role,
              m.is_signatory AS my_is_signatory,
              (s.parent_investor_id = $1) AS i_opened_it,
              (SELECT COUNT(*)::int FROM stokvel_members x
                WHERE x.sub_account_id = s.id AND x.status = 'active') AS active_members
         FROM sub_accounts s
         LEFT JOIN stokvel_members m
                ON m.sub_account_id = s.id
               AND m.investor_id    = $1
               AND m.status         = 'active'
        WHERE s.account_type = 'stokvel'
          AND (m.id IS NOT NULL OR s.parent_investor_id = $1)
        ORDER BY s.name ASC`,
      [me]
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error('[stokvels] list failed:', err.message);
    return res.status(500).json({ error: 'Could not load your stokvels.' });
  }
});

/* ─── GET /api/stokvels/:id ──────────────────────────────────────────── */
router.get('/:id', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    /* 404, not 403. A caller who is not in this stokvel learns nothing from
       the answer — not even that the id names a real one. */
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    return res.json({
      data: {
        id: group.id,
        name: group.name,
        stokvel_reg_number: group.stokvel_reg_number,
        status: group.status,
        wallet_balance: group.wallet_balance,
        total_invested: group.total_invested,
        total_returns: group.total_returns,
        savings_goal: group.savings_goal,
        savings_goal_label: group.savings_goal_label,
        my_role: group.my_role || (group.i_opened_it ? 'chairperson' : null),
        i_opened_it: group.i_opened_it,
      },
    });
  } catch (err) {
    console.error('[stokvels] detail failed:', err.message);
    return res.status(500).json({ error: 'Could not load that stokvel.' });
  }
});

/* ─── GET /api/stokvels/:id/members ──────────────────────────────────
   The roster every member can see. Transparency is the product: a stokvel
   argument is almost always about who is in and who has paid, and a list
   everybody reads from settles the first half of that.

   What it does NOT return is the rest of a member's investor record. Being
   in a stokvel with somebody tells you their name and their role in it, and
   nothing else about them. ─────────────────────────────────────────── */
router.get('/:id/members', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const { rows } = await pool.query(
      `SELECT m.id, m.investor_id, m.role, m.is_signatory, m.status,
              m.joined_at, m.invited_at,
              i.first_name, i.last_name,
              (m.investor_id = $2) AS is_me
         FROM stokvel_members m
         JOIN investors i ON i.id = m.investor_id
        WHERE m.sub_account_id = $1
          AND m.status <> 'exited'
        ORDER BY CASE m.role WHEN 'chairperson' THEN 0 WHEN 'treasurer' THEN 1
                             WHEN 'secretary'   THEN 2 ELSE 3 END,
                 i.first_name ASC`,
      [group.id, me]
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error('[stokvels] members failed:', err.message);
    return res.status(500).json({ error: 'Could not load the members.' });
  }
});


/* ─── POST /api/stokvels/:id/withdrawal-requests ─────────────────────
   Ask the signatories for authority to take an amount out, to a named
   destination. Raising one moves nothing and reserves nothing.

   Any active member may ask. Only signatories may answer — the two are
   different on purpose: the person who needs the money is often not one of
   the people who authorise it, and a stokvel where only signatories can
   raise a request simply pushes the conversation off the platform.
   ──────────────────────────────────────────────────────────────────── */
router.post('/:id/withdrawal-requests', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const amount = Math.round((parseFloat(req.body && req.body.amount) || 0) * 100) / 100;
    if (!(amount > 0)) return res.status(400).json({ error: 'An amount is required.' });

    const bankName = String((req.body && req.body.bank_name) || '').trim();
    const bankAcct = String((req.body && req.body.bank_account_number) || '').trim();
    /* The destination is part of what is being approved. Without it the
       signatories authorise a sum and whoever carries it out chooses where
       it lands, which is a mandate in name only. */
    if (!bankName || !bankAcct) {
      return res.status(400).json({
        error: 'The bank name and account number must be part of the request — signatories approve a destination, not just an amount.' });
    }

    const quorum = Number(group.stokvel_quorum) || 0;
    if (quorum < mandate.MIN_QUORUM) {
      return res.status(400).json({
        error: 'This stokvel has no mandate on file. Capture the signatories and how many must approve before requesting a withdrawal.' });
    }

    const id = 'SWR-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
    await pool.query(
      `INSERT INTO stokvel_withdrawal_requests
         (id, sub_account_id, requested_by, amount, bank_name, bank_account_number,
          reason, quorum_required, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending', NOW() + INTERVAL '7 days')`,
      [id, group.id, me, amount, bankName, bankAcct,
       String((req.body && req.body.reason) || '').slice(0, 500) || null, quorum]
    );
    return res.status(201).json({ data: { id, amount, quorum_required: quorum } });
  } catch (err) {
    console.error('[stokvels] request failed:', err.message);
    return res.status(500).json({ error: 'Could not raise that request.' });
  }
});

/* ─── GET /api/stokvels/:id/withdrawal-requests ──────────────────────
   Every member sees every request and where it stands. A mandate that only
   the signatories can see is a committee, not a mandate. */
router.get('/:id/withdrawal-requests', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const { rows } = await pool.query(
      `SELECT r.*, i.first_name AS requested_by_name
         FROM stokvel_withdrawal_requests r
         JOIN investors i ON i.id = r.requested_by
        WHERE r.sub_account_id = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [group.id]
    );
    const out = [];
    for (const r of rows) {
      const state = await mandate.evaluate(pool, r, group);
      out.push({
        id: r.id, amount: r.amount, bank_name: r.bank_name, reason: r.reason,
        status: r.status, expires_at: r.expires_at,
        requested_by_name: r.requested_by_name,
        approvals: state.approvals, required: state.required,
        satisfied: state.satisfied, blocked_because: state.reason,
      });
    }
    return res.json({ data: out });
  } catch (err) {
    console.error('[stokvels] requests failed:', err.message);
    return res.status(500).json({ error: 'Could not load the requests.' });
  }
});

/* ─── POST /api/stokvels/:id/withdrawal-requests/:rid/vote ───────────
   A signatory approves or rejects. One vote each, enforced by the unique
   index rather than by a check-then-insert that two taps could race. */
router.post('/:id/withdrawal-requests/:rid/vote', async (req, res) => {
  const me = callerInvestorId(req);
  const decision = String((req.body && req.body.decision) || '').toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'decision must be approve or reject.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const group = await groupForCaller(me, req.params.id);
    if (!group) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such stokvel.' }); }

    /* Only a signatory votes. Membership got the caller this far; the mandate
       decides whether their answer counts for anything. */
    const signatories = await mandate.currentSignatories(client, group.id);
    if (!signatories.has(me)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only a signatory named in the mandate can approve a withdrawal.' });
    }

    const { rows: [request] } = await client.query(
      `SELECT * FROM stokvel_withdrawal_requests
        WHERE id = $1 AND sub_account_id = $2 FOR UPDATE`,
      [req.params.rid, group.id]
    );
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such request.' }); }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `That request is already ${request.status}.` });
    }

    try {
      await client.query(
        `INSERT INTO stokvel_request_approvals (id, request_id, investor_id, decision)
         VALUES ($1,$2,$3,$4)`,
        ['SRA-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase(),
         request.id, me, decision]);
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(409).json({ error: 'You have already voted on this request.' });
      throw e;
    }

    const state = await mandate.evaluate(client, request, group);
    /* A rejection ends it outright. A mandate is not a majority: a signatory
       who says no has said no, and the request is raised again rather than
       out-voted. */
    let status = request.status;
    if (decision === 'reject')      status = 'rejected';
    else if (state.satisfied)       status = 'approved';
    if (status !== request.status) {
      await client.query(
        `UPDATE stokvel_withdrawal_requests SET status = $2, updated_at = NOW() WHERE id = $1`,
        [request.id, status]);
    }
    await client.query('COMMIT');
    return res.json({ data: { id: request.id, status,
                              approvals: state.approvals, required: state.required,
                              satisfied: status === 'approved' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] vote failed:', err.message);
    return res.status(500).json({ error: 'Could not record that vote.' });
  } finally {
    client.release();
  }
});

module.exports = router;
