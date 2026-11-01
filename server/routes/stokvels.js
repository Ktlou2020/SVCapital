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

   READ ONLY, deliberately. Seeing the group is this phase. Moving its money
   needs the mandate — N-of-M signatory approval — and until that exists no
   endpoint here writes anything, and none reads is_signatory to decide
   whether somebody may do something. The column records what the
   constitution says; it does not yet grant.
   ═══════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

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

module.exports = router;
