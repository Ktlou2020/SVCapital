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
const contributions = require('../services/stokvelContributions');
const invites       = require('../services/stokvelInvites');
const shares        = require('../services/stokvelShares');
/* Lazily required, and never awaited in a way that can fail a request: a
   mandate that cannot send an email must still record the vote. */
let _notify = null;
function notify() {
  if (!_notify) { try { _notify = require('../services/stokvelNotify'); } catch (_) {} }
  return _notify;
}

router.use(requireAuth);

/* The caller's own investor id. Staff carry no investor_id, and a stokvel is
   a client-facing view — staff read the same data through the admin console,
   which has its own routes and its own audit. */
function callerInvestorId(req) {
  /* investorId, camelCase, is what signToken actually puts in the JWT.
     This read investor_id alone, which is undefined on every real token —
     so every endpoint in this file answered "no stokvels" to everybody,
     and the checks passed because they signed a token shape the platform
     does not issue. Both spellings are accepted, as everywhere else in
     server/routes, because a token minted before a rename is still a
     token somebody is holding. */
  const id = req.user && (req.user.investorId || req.user.investor_id);
  return id ? String(id) : null;
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
      /* AND HAS NOT LEFT. parent_investor_id grants access on its own,
         which is right while the person who opened the account is still in
         the group and wrong the moment they are not: a chairperson could
         exit, be paid out, and keep seeing the wallet, the roster, every
         member's share — and keep inviting people, because mayInvite reads
         the same column. Ownership moves on exit (stokvelShares.settleExit),
         so this is belt and braces; it is here because the cost of the
         belt failing is somebody who left watching the group's money. */
      WHERE s.id = $2
        AND s.account_type = 'stokvel'
        AND (m.id IS NOT NULL OR (s.parent_investor_id = $1 AND NOT EXISTS (
              SELECT 1 FROM stokvel_members x
               WHERE x.sub_account_id = s.id AND x.investor_id = $1
                 AND x.status = 'exited')))`,
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
                WHERE x.sub_account_id = s.id AND x.status = 'active') AS active_members,
              /* What this member has to DO, on the card, before they open
                 anything. Push and email both fail silently and for
                 different people — one never granted permission, the other's
                 address bounces — and the app is the one surface that
                 cannot. A request waiting on somebody who is holding the
                 phone should be visible on it.

                 Counted only where their vote would count (a signatory who
                 has not yet voted on a live request), so the number is
                 always something they can act on rather than news. */
              (SELECT COUNT(*)::int
                 FROM stokvel_withdrawal_requests r
                WHERE r.sub_account_id = s.id
                  AND r.status = 'pending'
                  AND r.expires_at > NOW()
                  AND m.is_signatory = true
                  AND NOT EXISTS (SELECT 1 FROM stokvel_request_approvals v
                                   WHERE v.request_id = r.id AND v.investor_id = $1)
              ) AS awaiting_my_vote,
              (SELECT COALESCE(SUM(c.amount_due - c.amount_paid), 0)
                 FROM stokvel_contributions c
                WHERE c.sub_account_id = s.id
                  AND c.investor_id = $1
                  AND c.status = 'due'
                  AND (c.amount_due - c.amount_paid) > 0
              ) AS my_outstanding
         FROM sub_accounts s
         LEFT JOIN stokvel_members m
                ON m.sub_account_id = s.id
               AND m.investor_id    = $1
               AND m.status         = 'active'
        WHERE s.account_type = 'stokvel'
          AND (m.id IS NOT NULL OR (s.parent_investor_id = $1 AND NOT EXISTS (
                SELECT 1 FROM stokvel_members x
                 WHERE x.sub_account_id = s.id AND x.investor_id = $1
                   AND x.status = 'exited')))
        ORDER BY s.name ASC`,
      [me]
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error('[stokvels] list failed:', err.message);
    return res.status(500).json({ error: 'Could not load your stokvels.' });
  }
});

/* ═══ Invitations ═══════════════════════════════════════════════════
   Declared BEFORE the /:id routes below. Express matches in order, and
   '/invites/mine' would otherwise be a candidate for anything shaped like
   '/:id/...' as those patterns grow — a bug that would present as "my
   invitations endpoint returns a stokvel".

   The flow has no link in it. An invitation is ADDRESSED to an email or a
   cell number, and the invitee finds it by signing in as the person who
   holds that contact; see services/stokvelInvites.js for why a forwardable
   link was the wrong shape for money.
   ═══════════════════════════════════════════════════════════════════ */

/* The signed-in investor, with the contacts an invitation is matched on. */
async function callerContacts(req) {
  const me = callerInvestorId(req);
  if (!me) return null;
  const { rows } = await pool.query(
    'SELECT id, first_name, email, phone FROM investors WHERE id = $1', [me]);
  return rows[0] || null;
}

/* ─── GET /api/stokvels/invites/mine ─────────────────────────────────
   What has been asked of me. The only way an invitation is discovered, so
   it has to be on a screen the invitee already opens. */
router.get('/invites/mine', async (req, res) => {
  try {
    const investor = await callerContacts(req);
    if (!investor) return res.json({ data: [] });
    const rows = await invites.forInvestor(pool, investor);
    return res.json({ data: rows.map(v => ({
      id: v.id, stokvel_name: v.stokvel_name, stokvel_reg_number: v.stokvel_reg_number,
      invited_by_name: v.invited_by_name, active_members: v.active_members,
      invitee_name: v.invitee_name, expires_at: v.expires_at, created_at: v.created_at,
    })) });
  } catch (err) {
    console.error('[stokvels] invites/mine failed:', err.message);
    return res.status(500).json({ error: 'Could not load your invitations.' });
  }
});

/* ─── POST /api/stokvels/invites/:vid/accept ──────────────────────────
   Accepting is the invitee's own act. Being added to a savings club by
   somebody else, silently, is not joining one.

   What comes out of this is always an ordinary member: never a signatory,
   never an office. The rule lives in the service, where there is no
   parameter that could change it. */
router.post('/invites/:vid/accept', async (req, res) => {
  const client = await pool.connect();
  try {
    const investor = await callerContacts(req);
    /* No release here: the finally below owns it. Releasing twice is an
       error pg throws on the SECOND release, which surfaces as a failure in
       whatever ran next rather than here. */
    if (!investor) return res.status(403).json({ error: 'Investor accounts only.' });
    await client.query('BEGIN');
    const { rows: [invite] } = await client.query(
      'SELECT * FROM stokvel_invites WHERE id = $1 FOR UPDATE', [req.params.vid]);
    if (!invite) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No such invitation.' });
    }
    const out = await invites.accept(client, invite, investor);
    if (out.error) {
      await client.query('ROLLBACK');
      return res.status(out.status || 400).json({ error: out.error });
    }
    await client.query('COMMIT');

    const n = notify();
    if (n) n.inviteAccepted({ groupId: invite.sub_account_id, investorId: investor.id,
                              invitedBy: invite.invited_by })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

    return res.json({ data: { id: invite.sub_account_id, joined: true } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] accept failed:', err.message);
    return res.status(500).json({ error: 'Could not accept that invitation.' });
  } finally {
    client.release();
  }
});

/* ─── POST /api/stokvels/invites/:vid/decline ─────────────────────── */
router.post('/invites/:vid/decline', async (req, res) => {
  try {
    const investor = await callerContacts(req);
    if (!investor) return res.status(403).json({ error: 'Investor accounts only.' });
    const { rows: [invite] } = await pool.query(
      'SELECT * FROM stokvel_invites WHERE id = $1', [req.params.vid]);
    if (!invite) return res.status(404).json({ error: 'No such invitation.' });
    const out = await invites.decline(pool, invite, investor);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json({ data: { declined: true } });
  } catch (err) {
    console.error('[stokvels] decline failed:', err.message);
    return res.status(500).json({ error: 'Could not decline that invitation.' });
  }
});

/* ─── POST /api/stokvels/:id/invites ─────────────────────────────────
   The committee asks somebody to join, by name and contact rather than by
   investor id. The staff console path still exists and still works; this is
   what stops onboarding being a staff typing job. */
router.post('/:id/invites', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    await client.query('BEGIN');
    const out = await invites.create(client, group, me, {
      name:  (req.body && req.body.name)  || '',
      email: (req.body && req.body.email) || '',
      cell:  (req.body && req.body.cell)  || '',
    });
    if (out.error) {
      await client.query('ROLLBACK');
      return res.status(out.status || 400).json({ error: out.error });
    }
    await client.query('COMMIT');

    /* Sent after the commit, so an invitation that is recorded is never one
       nobody was told about and an invitation somebody was told about is
       never one that rolled back. */
    const n = notify();
    if (n) n.invited({ inviteId: out.invite.id })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

    return res.status(201).json({ data: {
      id: out.invite.id,
      invitee_name: out.invite.invitee_name,
      contact: invites.maskContact(out.invite),
      already_on_the_platform: !!out.matched,
      expires_at: out.invite.expires_at,
    } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] invite failed:', err.message);
    return res.status(500).json({ error: 'Could not send that invitation.' });
  } finally {
    client.release();
  }
});

/* ─── GET /api/stokvels/:id/invites ──────────────────────────────────
   Who has been asked, visible to every member. The same reason the
   contribution list is: a group that cannot see who was invited cannot see
   who is about to have a say in its money.

   Contacts are MASKED for everyone — the roster being public is not a
   reason to publish an address. The committee sees whether an invitation
   can still be acted on, which is what lets them notice that somebody was
   invited at an address they do not use. */
router.get('/:id/invites', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    const { rows } = await pool.query(
      `SELECT v.id, v.invitee_name, v.email, v.cell, v.status, v.expires_at, v.created_at,
              v.matched_investor_id IS NOT NULL AS already_on_the_platform,
              i.first_name AS invited_by_name
         FROM stokvel_invites v
         LEFT JOIN investors i ON i.id = v.invited_by
        WHERE v.sub_account_id = $1
        ORDER BY (v.status = 'pending') DESC, v.created_at DESC
        LIMIT 100`, [group.id]);
    return res.json({ data: rows.map(v => ({
      id: v.id, invitee_name: v.invitee_name,
      contact: invites.maskContact(v),
      status: new Date(v.expires_at) <= new Date() && v.status === 'pending' ? 'expired' : v.status,
      already_on_the_platform: v.already_on_the_platform,
      invited_by_name: v.invited_by_name,
      expires_at: v.expires_at, created_at: v.created_at,
    })), can_invite: invites.mayInvite(group) });
  } catch (err) {
    console.error('[stokvels] invites failed:', err.message);
    return res.status(500).json({ error: 'Could not load the invitations.' });
  }
});

/* ─── DELETE /api/stokvels/:id/invites/:vid ──────────────────────── */
router.delete('/:id/invites/:vid', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    const out = await invites.revoke(pool, group, req.params.vid);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json({ data: { revoked: true } });
  } catch (err) {
    console.error('[stokvels] revoke failed:', err.message);
    return res.status(500).json({ error: 'Could not withdraw that invitation.' });
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

    /* Two kinds of money leaving the group wallet, one mandate. A
       withdrawal names a bank account; an investment names a pool. Either
       way the DESTINATION is part of what is approved — without it the
       signatories authorise a sum and whoever carries it out chooses where
       it lands, which is a mandate in name only. */
    const kind = String((req.body && req.body.kind) || 'withdrawal');
    if (!['withdrawal', 'investment', 'exit', 'payout'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be withdrawal, investment, exit or payout.' });
    }

    let bankName = '', bankAcct = '', poolId = null, exitInvestorId = null, payoutId = null;
    if (kind === 'investment') {
      poolId = String((req.body && req.body.pool_id) || '').trim();
      if (!poolId) {
        return res.status(400).json({
          error: 'The pool must be part of the request — signatories approve a product, not just an amount.' });
      }
      const { rows: pool_ } = await pool.query(
        `SELECT id, name FROM investment_pools WHERE id = $1`, [poolId]);
      if (!pool_.length) return res.status(400).json({ error: 'No such pool.' });
    } else if (kind === 'payout') {
      /* What is approved is the DISTRIBUTION, named by its id. The amount on
         the request is the pot as it stood when it was raised, shown to the
         signatories so they know the order of what they are agreeing to;
         what is actually paid is worked out on the day. */
      payoutId = String((req.body && req.body.payout_id) || '').trim();
      const { rows: po } = await pool.query(
        `SELECT 1 FROM stokvel_payouts
          WHERE id = $1 AND sub_account_id = $2 AND status = 'planned'`,
        [payoutId, group.id]);
      if (!po.length) return res.status(400).json({ error: 'No such payout is planned for this stokvel.' });
    } else if (kind === 'exit') {
      /* The member being settled is the destination of an exit, the way a
         bank account is the destination of a withdrawal — so it is part of
         what the signatories approve. A member may ask to leave themselves;
         the committee may also raise it for somebody. Either way the
         signatories decide, because an exit takes money out of the pot. */
      exitInvestorId = String((req.body && req.body.exit_investor_id) || me);
      const { rows: m } = await pool.query(
        `SELECT 1 FROM stokvel_members
          WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
        [group.id, exitInvestorId]);
      if (!m.length) return res.status(400).json({ error: 'That person is not an active member of this stokvel.' });
      if (exitInvestorId !== me && !invites.mayInvite(group)) {
        return res.status(403).json({
          error: 'Only the chairperson, secretary or treasurer can raise an exit for somebody else.' });
      }
    } else {
      bankName = String((req.body && req.body.bank_name) || '').trim();
      bankAcct = String((req.body && req.body.bank_account_number) || '').trim();
      if (!bankName || !bankAcct) {
        return res.status(400).json({
          error: 'The bank name and account number must be part of the request — signatories approve a destination, not just an amount.' });
      }
    }

    const quorum = Number(group.stokvel_quorum) || 0;
    if (quorum < mandate.MIN_QUORUM) {
      return res.status(400).json({
        error: 'This stokvel has no mandate on file. Capture the signatories and how many must approve before the group\u2019s money can move.' });
    }

    const id = 'SWR-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
    await pool.query(
      `INSERT INTO stokvel_withdrawal_requests
         (id, sub_account_id, requested_by, amount, kind, bank_name, bank_account_number,
          pool_id, exit_investor_id, payout_id, reason, quorum_required, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending', NOW() + INTERVAL '7 days')`,
      [id, group.id, me, amount, kind, bankName || null, bankAcct || null, poolId,
       exitInvestorId, payoutId,
       String((req.body && req.body.reason) || '').slice(0, 500) || null, quorum]
    );
    /* The signatories are told now. Until this existed the mandate was a
       queue nobody was watching: a treasurer raised a request and then had
       to phone three people to ask them to go and tap approve. Fired after
       the insert and never awaited, so a mail outage cannot lose the
       request that is already recorded. */
    const n = notify();
    if (n) n.approvalNeeded({ groupId: group.id, authorityId: id })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

    return res.status(201).json({ data: { id, amount, kind, quorum_required: quorum } });
  } catch (err) {
    console.error('[stokvels] request failed:', err.message);
    return res.status(500).json({ error: 'Could not raise that request.' });
  }
});

/* ─── GET /api/stokvels/:id/withdrawal-requests ──────────────────────
   Every member sees every request and where it stands. A mandate that only
   the signatories can see is a committee, not a mandate.

   AND WHO VOTED. The register was stored from the first release and never
   shown: members saw "2 of 3" and never which two. For a product whose
   whole claim is that several named people must agree, that is the wrong
   way round — and an anonymous rejection is worse than a named one,
   because a request dies and nobody can talk about why. Shown to every
   member, rejections included. */
router.get('/:id/withdrawal-requests', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    /* The pool's NAME, not only its id. An authority that reads
       "R10 000 · POOL-7Q2F" asks a signatory to approve a primary key;
       the name is what they actually recognise. */
    const { rows } = await pool.query(
      `SELECT r.*, i.first_name AS requested_by_name, p.name AS pool_name,
              x.first_name AS exit_name, po.label AS payout_label
         FROM stokvel_withdrawal_requests r
         JOIN investors i ON i.id = r.requested_by
         LEFT JOIN investment_pools p ON p.id = r.pool_id
         LEFT JOIN investors x ON x.id = r.exit_investor_id
         LEFT JOIN stokvel_payouts po ON po.id = r.payout_id
        WHERE r.sub_account_id = $1
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [group.id]
    );
    /* One query for the whole register rather than one per request. */
    const { rows: votes } = await pool.query(
      `SELECT v.request_id, v.investor_id, v.decision, v.decided_at,
              i.first_name, i.last_name,
              EXISTS (SELECT 1 FROM stokvel_members m
                       WHERE m.sub_account_id = $1 AND m.investor_id = v.investor_id
                         AND m.status = 'active' AND m.is_signatory = true) AS still_counts
         FROM stokvel_request_approvals v
         JOIN investors i ON i.id = v.investor_id
        WHERE v.request_id IN (SELECT id FROM stokvel_withdrawal_requests WHERE sub_account_id = $1)
        ORDER BY v.decided_at ASC`, [group.id]);
    const register = new Map();
    for (const v of votes) {
      if (!register.has(v.request_id)) register.set(v.request_id, []);
      register.get(v.request_id).push({
        investor_id: v.investor_id,
        name: [v.first_name, v.last_name].filter(Boolean).join(' '),
        decision: v.decision, at: v.decided_at,
        /* A vote from somebody who is no longer a signatory is kept on the
           record and stops counting. Showing it without saying so would
           make the tally look wrong to anybody adding the names up. */
        counts: v.still_counts,
        is_me: v.investor_id === me,
      });
    }

    const out = [];
    for (const r of rows) {
      const state = await mandate.evaluate(pool, r, group);
      out.push({
        id: r.id, amount: r.amount, kind: r.kind || 'withdrawal',
        bank_name: r.bank_name, pool_id: r.pool_id, pool_name: r.pool_name,
        exit_investor_id: r.exit_investor_id, exit_name: r.exit_name,
        payout_id: r.payout_id, payout_label: r.payout_label,
        reason: r.reason,
        status: r.status, expires_at: r.expires_at,
        requested_by_name: r.requested_by_name,
        approvals: state.approvals, required: state.required,
        satisfied: state.satisfied, blocked_because: state.reason,
        votes: register.get(r.id) || [],
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

    /* After the commit, on the plain pool. Whoever is waiting on this hears
       what happened: the person who raised it either way, and the other
       signatories when the answer is final — a dead or carried request that
       still reads as pending to them is how three people go on waiting to
       vote on nothing. */
    const n = notify();
    if (n) n.decided({ groupId: group.id, authorityId: request.id, voterId: me, decision })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

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


/* ─── Fines ──────────────────────────────────────────────────────────
   Effectively every stokvel constitution has them and the platform had
   none. A fine is an OBLIGATION, carried on stokvel_contributions with
   kind = 'fine', so arrears, the chase, paying in oldest-first and the
   deduction at exit or payout all work on it unchanged.

   Levied by the committee, never by us: a penalty is a thing the group's
   own rules provide for, and a platform that could impose one would be
   enforcing somebody else's constitution. Reversible while unpaid, because
   a committee that fined the wrong member must be able to say so.
   ──────────────────────────────────────────────────────────────────── */
router.post('/:id/fines', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    if (!invites.mayInvite(group)) {
      return res.status(403).json({ error: 'Only the chairperson, secretary or treasurer can levy a fine.' });
    }
    const investorId = String((req.body && req.body.investor_id) || '').trim();
    const amount = Math.round((parseFloat(req.body && req.body.amount) || 0) * 100) / 100;
    const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
    if (!(amount > 0)) return res.status(400).json({ error: 'An amount is required.' });
    if (!note) {
      /* Required. A fine a member cannot see the reason for is the thing
         that ends stokvels, and the reason has to be on the row rather than
         in somebody's memory of the meeting. */
      return res.status(400).json({ error: 'Say what the fine is for \u2014 the member will see it.' });
    }
    const { rows: m } = await pool.query(
      `SELECT 1 FROM stokvel_members
        WHERE sub_account_id = $1 AND investor_id = $2 AND status = 'active'`,
      [group.id, investorId]);
    if (!m.length) return res.status(400).json({ error: 'That person is not an active member of this stokvel.' });

    const id = 'SCF-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
    await pool.query(
      `INSERT INTO stokvel_contributions
         (id, sub_account_id, investor_id, period_label, amount_due, amount_paid,
          due_date, status, kind, note, levied_by)
       VALUES ($1,$2,$3,$4,$5,0,CURRENT_DATE,'due','fine',$6,$7)`,
      [id, group.id, investorId, 'FINE-' + id.slice(4), amount, note, me]);

    const n = notify();
    if (n) n.fined({ groupId: group.id, investorId, amount, note })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

    return res.status(201).json({ data: { id, amount, note } });
  } catch (err) {
    console.error('[stokvels] fine failed:', err.message);
    return res.status(500).json({ error: 'Could not record that fine.' });
  }
});

/* Called off. Only while unpaid — a fine the member has settled is history,
   and reversing it would take money the group has already shared out. */
router.delete('/:id/fines/:fid', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    if (!invites.mayInvite(group)) {
      return res.status(403).json({ error: 'Only the chairperson, secretary or treasurer can withdraw a fine.' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM stokvel_contributions
        WHERE id = $1 AND sub_account_id = $2 AND kind = 'fine'
          AND status = 'due' AND amount_paid = 0`,
      [req.params.fid, group.id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'No unpaid fine with that id. A fine that has been paid cannot be withdrawn.' });
    }
    return res.json({ data: { withdrawn: true } });
  } catch (err) {
    console.error('[stokvels] withdraw fine failed:', err.message);
    return res.status(500).json({ error: 'Could not withdraw that fine.' });
  }
});

/* ─── POST /api/stokvels/:id/pay-in ──────────────────────────────────
   Extra money into the pot, from the member's own wallet.

   This exists so that there is no OTHER way for a member to put money in.
   The ordinary deposit flow credits a sub-account wallet with nothing
   recording whose money it was, and stokvelShares.reconcile then shares the
   increase across every member pro-rata — correct for interest and for a
   maturity, badly wrong for a treasurer banking R5 000 of their own, who
   would get back their share of it and no more. Routing a member's money
   through their own wallet keeps the attribution, and keeps it in the same
   transaction as the money.

   Any active member may pay in; nobody needs approval to make the group
   better off. Taking money OUT is what the mandate guards. */
router.post('/:id/pay-in', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const amount = Math.round((parseFloat(req.body && req.body.amount) || 0) * 100) / 100;
    if (!(amount > 0)) return res.status(400).json({ error: 'An amount is required.' });

    await client.query('BEGIN');
    const out = await contributions.payIn(client, {
      subAccount: group, investorId: me, amount,
      note: (req.body && req.body.note) || '',
    });
    await client.query('COMMIT');
    return res.json({ data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    /* The service throws sentences a member can act on — not enough in your
       wallet, an amount is required — so they are passed through rather
       than flattened into a 500. */
    const known = /Not enough in your wallet|An amount is required|No such member/.test(err.message || '');
    if (!known) console.error('[stokvels] pay-in failed:', err.message);
    return res.status(known ? 400 : 500)
      .json({ error: known ? err.message : 'Could not pay that in.' });
  } finally {
    client.release();
  }
});

/* ─── GET /api/stokvels/:id/shares ───────────────────────────────────
   What everybody's share is, visible to everybody — the same rule as the
   contribution list. A share each member can see only their own of is a
   treasurer's spreadsheet with extra steps; the point of putting it here is
   that the whole group reads the same numbers.

   Reconciled on read, so opening the screen cannot show a share that has
   fallen behind the wallet. It is idempotent — a reconcile with nothing to
   place writes nothing. */
router.get('/:id/shares', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    await client.query('BEGIN');
    await shares.reconcile(client, group.id, { reason: 'Shared out on read' });
    const out = await shares.sharesOf(client, group.id);
    const { rows: names } = await client.query(
      `SELECT m.investor_id, i.first_name, i.last_name
         FROM stokvel_members m JOIN investors i ON i.id = m.investor_id
        WHERE m.sub_account_id = $1 AND m.status = 'active'`, [group.id]);
    const { rows: debts } = await client.query(
      `SELECT d.investor_id, i.first_name,
              (d.amount_owed - d.amount_paid) AS owed
         FROM stokvel_exit_debts d JOIN investors i ON i.id = d.investor_id
        WHERE d.sub_account_id = $1 AND d.status = 'owing'`, [group.id]);
    await client.query('COMMIT');

    const byId = new Map(names.map(n => [n.investor_id, n]));
    return res.json({
      data: {
        basis: out.basis,
        net_assets: out.assets.total,
        wallet: out.assets.wallet,
        invested: out.assets.invested,
        owed_to_former_members: out.assets.owed,
        my_share: (out.shares.find(x => x.investor_id === me) || {}).share || 0,
        shares: out.shares.map(x => ({
          investor_id: x.investor_id,
          first_name: (byId.get(x.investor_id) || {}).first_name || '',
          last_name:  (byId.get(x.investor_id) || {}).last_name  || '',
          is_me: x.investor_id === me,
          share: x.share, gross: x.gross, arrears: x.arrears,
        })),
        exit_debts: debts.map(d => ({ first_name: d.first_name, owed: d.owed })),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] shares failed:', err.message);
    return res.status(500).json({ error: 'Could not work out the shares.' });
  } finally {
    client.release();
  }
});

/* ─── GET /api/stokvels/:id/transactions ─────────────────────────────
   The group's own ledger, for the group's own screen.

   NOT through the generic table reader: routes/tables.js scopes both
   transactions and investments by investor_id, and a stokvel's rows carry
   the CHAIRPERSON's id, so an ordinary member cannot read them there — and
   should not be handed a way to. Members read their group through this
   router, where groupForCaller decides.

   The running balance is computed with the ledger's own definition of what
   moves cash, so the group's ledger and its statement cannot disagree about
   a platform fee the way two hand-written lists once did. */
router.get('/:id/transactions', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const { cashMovementSQL } = require('../services/ledger');
    const { rows } = await pool.query(
      `SELECT id, type, amount, status, reference, description,
              COALESCE(transaction_date, created_at) AS at,
              ${cashMovementSQL()} AS cash_effect
         FROM transactions
        WHERE sub_account_id = $1 AND status = 'completed'
        ORDER BY COALESCE(transaction_date, created_at) DESC, created_at DESC
        LIMIT 300`, [group.id]);

    /* ANCHORED TO THE WALLET, not accumulated from zero.
    
       Not every movement on a group wallet writes a row against the group.
       A payout debits sub_accounts.wallet_balance and writes the
       transaction against each MEMBER; so do an exit settlement and the
       paying down of an exit debt. Summing this table from zero therefore
       does not reach the wallet, and a treasurer reading a closing balance
       that disagrees with the balance above it would be right to stop
       trusting the screen.
    
       So the newest row IS the wallet, and each older row is the wallet
       with the movements since it unwound — the same anchoring
       services/accountStatement.js does, and for the same reason. */
    let running = Math.round(Number(group.wallet_balance || 0) * 100) / 100;
    for (const r of rows) {
      r.running_balance = running;
      running = Math.round((running - Number(r.cash_effect)) * 100) / 100;
    }

    return res.json({ data: rows, wallet: group.wallet_balance });
  } catch (err) {
    console.error('[stokvels] transactions failed:', err.message);
    return res.status(500).json({ error: 'Could not load the transactions.' });
  }
});

/* ─── GET /api/stokvels/:id/investments ──────────────────────────────
   What the group holds, and where. Same reasoning as above: scoped by
   sub_account_id, behind the membership guard. */
router.get('/:id/investments', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const { rows } = await pool.query(
      `SELECT i.id, i.amount, i.status, i.annual_rate, i.term_months,
              i.expected_return, i.actual_return,
              COALESCE(i.start_date, i.created_at::date) AS start_date,
              i.end_date AS maturity_date,
              COALESCE(i.pool_name, p.name) AS pool_name,
              COALESCE(i.product_type, p.product_type) AS product_type
         FROM investments i
         LEFT JOIN investment_pools p ON p.id = i.pool_id
        WHERE i.sub_account_id = $1
        ORDER BY (i.status = 'active') DESC, i.created_at DESC
        LIMIT 200`, [group.id]);

    const sum = (f, only) => Math.round(rows
      .filter(r => !only || r.status === only)
      .reduce((n, r) => n + (Number(r[f]) || 0), 0) * 100) / 100;

    return res.json({
      data: rows,
      totals: { active: sum('amount', 'active'), all: sum('amount'),
                returns: sum('actual_return') },
    });
  } catch (err) {
    console.error('[stokvels] investments failed:', err.message);
    return res.status(500).json({ error: 'Could not load the investments.' });
  }
});

/* ─── Payouts ────────────────────────────────────────────────────────
   The December payout: the group pays itself out on a date, everybody at
   once, and carries on afterwards. Planned by the committee, approved by
   the signatories as ONE distribution rather than one withdrawal per
   member, and then run. ──────────────────────────────────────────────── */

/* GET — what is planned, and what has been paid before. Every member sees
   it: a distribution the group has decided on is the single most important
   thing on a member's screen, and the line they care about is their own. */
router.get('/:id/payouts', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const { rows } = await client.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM stokvel_payout_lines l WHERE l.payout_id = p.id) AS members
         FROM stokvel_payouts p
        WHERE p.sub_account_id = $1
        ORDER BY (p.status = 'planned') DESC, p.pay_on DESC
        LIMIT 20`, [group.id]);

    /* What this member would receive if the planned one ran now. Worked out
       rather than stored, because it moves with every credit the group
       takes until the day it runs. */
    let mine = null;
    const planned = rows.find(r => r.status === 'planned');
    if (planned) {
      await client.query('BEGIN');
      await shares.reconcile(client, group.id, { reason: 'Shared out on read' });
      const basis   = await shares.sharesOf(client, group.id);
      const arrears = await shares.arrearsOf(client, group.id);
      await client.query('COMMIT');
      const row = basis.shares.find(x => x.investor_id === me);
      if (row) {
        mine = Math.round(Math.max(0, row.gross - (arrears.get(me) || 0)) * 100) / 100;
      }
    }

    const { rows: lines } = await client.query(
      `SELECT l.payout_id, l.share, l.arrears, l.net, l.paid, l.queued
         FROM stokvel_payout_lines l
         JOIN stokvel_payouts p ON p.id = l.payout_id
        WHERE p.sub_account_id = $1 AND l.investor_id = $2`, [group.id, me]);
    const byPayout = new Map(lines.map(l => [l.payout_id, l]));

    return res.json({ data: rows.map(r => ({
      id: r.id, label: r.label, pay_on: r.pay_on, status: r.status,
      authority_id: r.authority_id, members: r.members, paid_at: r.paid_at,
      my_line: byPayout.get(r.id) || null,
    })), my_share_now: mine, can_plan: invites.mayInvite(group) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] payouts failed:', err.message);
    return res.status(500).json({ error: 'Could not load the payouts.' });
  } finally {
    client.release();
  }
});

/* POST — plan one. The committee decides there will be a distribution and
   when; the signatories then approve it. */
router.post('/:id/payouts', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    if (!invites.mayInvite(group)) {
      return res.status(403).json({ error: 'Only the chairperson, secretary or treasurer can plan a payout.' });
    }
    const label = String((req.body && req.body.label) || '').trim().slice(0, 80);
    const payOn = String((req.body && req.body.pay_on) || '').trim();
    if (!label) return res.status(400).json({ error: 'Give the payout a name, such as \u201cDecember 2026\u201d.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payOn)) return res.status(400).json({ error: 'A pay-on date is required (YYYY-MM-DD).' });

    const id = 'SPO-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase();
    try {
      await pool.query(
        `INSERT INTO stokvel_payouts (id, sub_account_id, label, pay_on, created_by)
         VALUES ($1,$2,$3,$4,$5)`, [id, group.id, label, payOn, me]);
    } catch (e) {
      /* The partial unique index. A group with two open distributions has
         not decided anything, and the second would be approved against a
         pot the first is about to empty. */
      if (e.code === '23505') {
        return res.status(409).json({ error: 'This stokvel already has a payout planned. Run or cancel that one first.' });
      }
      throw e;
    }
    return res.status(201).json({ data: { id, label, pay_on: payOn } });
  } catch (err) {
    console.error('[stokvels] plan payout failed:', err.message);
    return res.status(500).json({ error: 'Could not plan that payout.' });
  }
});

/* DELETE — call it off. Only while it is still planned; a distribution that
   has run is history, not a decision. */
router.delete('/:id/payouts/:pid', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });
    if (!invites.mayInvite(group)) {
      return res.status(403).json({ error: 'Only the chairperson, secretary or treasurer can cancel a payout.' });
    }
    const { rowCount } = await pool.query(
      `UPDATE stokvel_payouts SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND sub_account_id = $2 AND status = 'planned'`,
      [req.params.pid, group.id]);
    if (!rowCount) return res.status(404).json({ error: 'No payout is planned with that id.' });
    return res.json({ data: { cancelled: true } });
  } catch (err) {
    console.error('[stokvels] cancel payout failed:', err.message);
    return res.status(500).json({ error: 'Could not cancel that payout.' });
  }
});

/* POST /run — carry out an approved distribution. The authority does the
   deciding; any member may press it, as with an approved investment. */
router.post('/:id/payouts/:pid/run', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    await client.query('BEGIN');
    const { authority, error } = await mandate.authorityFor(
      client, group, req.body && req.body.authority_id,
      { kind: 'payout', payoutId: req.params.pid });
    if (error) {
      await client.query('ROLLBACK');
      return res.status(/No such authority/.test(error) ? 404 : 403).json({ error });
    }
    await client.query(
      `UPDATE stokvel_payouts SET authority_id = $2, updated_at = NOW() WHERE id = $1`,
      [req.params.pid, authority.id]);

    const out = await shares.payOut(client, { payoutId: req.params.pid });
    if (out.error) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: out.error });
    }
    await mandate.consume(client, authority, out.reference);
    await client.query('COMMIT');

    const n = notify();
    if (n) n.paidOut({ groupId: group.id, payout: out })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

    return res.json({ data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] run payout failed:', err.message);
    return res.status(500).json({ error: 'Could not run that payout.' });
  } finally {
    client.release();
  }
});

/* ─── POST /api/stokvels/:id/exits ───────────────────────────────────
   Settle an approved exit. The authority does the deciding; this carries it
   out, and will not do so without one — an exit takes money out of the pot,
   so no single person ends a membership and draws the share.

   Any member may execute an approved authority, exactly as with an approved
   investment. The approval is the control, not who taps the button. */
router.post('/:id/exits', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    await client.query('BEGIN');
    /* Reconciled first: a share settled against a stale ledger pays out the
       wrong number, and this is the one place that number becomes cash. */
    await shares.reconcile(client, group.id, { reason: 'Shared out before an exit' });

    const authorityId = req.body && req.body.authority_id;
    const { rows: [auth] } = await client.query(
      `SELECT exit_investor_id FROM stokvel_withdrawal_requests WHERE id = $1`,
      [authorityId || null]);
    const leaving = auth ? auth.exit_investor_id : null;

    const settleAmount = await shares.shareFor(client, group.id, leaving || '');
    const { authority, error } = await mandate.authorityFor(
      client, group, authorityId,
      { kind: 'exit', amount: settleAmount, investorId: leaving });
    if (error) {
      await client.query('ROLLBACK');
      return res.status(/No such authority/.test(error) ? 404 : 403).json({ error });
    }

    const out = await shares.settleExit(client, {
      subAccountId: group.id, investorId: leaving,
      authorityId: authority.id,
    });
    /* settleExit refuses when the person leaving opened the account and
       there is nobody to hand it to. Nothing has been written at that
       point, but the mandate authority must not be consumed either. */
    if (out.error) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: out.error });
    }
    await mandate.consume(client, authority, out.reference);
    await client.query('COMMIT');

    const n = notify();
    if (n) n.exitSettled({ groupId: group.id, investorId: leaving, settlement: out })
            .catch(e => console.warn('[stokvels] notify failed:', e.message));

    return res.json({ data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] exit failed:', err.message);
    return res.status(500).json({ error: 'Could not settle that exit.' });
  } finally {
    client.release();
  }
});

/* ─── GET /api/stokvels/:id/contributions ────────────────────────────
   Who owes what, for everybody, visible to everybody.

   This is the dispute-killer and the reason the endpoint does not filter to
   the caller. A stokvel argument is almost always some version of "I paid
   and you did not", and it is settled by one list that every member reads
   from rather than by the treasurer's memory. Keeping it private to each
   member would reproduce the problem it exists to end.
   ──────────────────────────────────────────────────────────────────── */
router.get('/:id/contributions', async (req, res) => {
  const me = callerInvestorId(req);
  try {
    const group = await groupForCaller(me, req.params.id);
    if (!group) return res.status(404).json({ error: 'No such stokvel.' });

    const { rows } = await pool.query(
      `SELECT c.id, c.investor_id, c.period_label, c.amount_due, c.amount_paid,
              c.due_date, c.status, c.paid_at, c.kind, c.note,
              i.first_name, i.last_name,
              (c.investor_id = $2) AS is_me,
              (c.status = 'due' AND c.due_date < CURRENT_DATE) AS overdue
         FROM stokvel_contributions c
         JOIN investors i ON i.id = c.investor_id
        WHERE c.sub_account_id = $1
        ORDER BY c.period_label DESC, i.first_name ASC
        LIMIT 500`,
      [group.id, me]
    );

    /* Arrears per member, which is the number anybody actually wants. */
    const arrears = {};
    for (const r of rows) {
      if (r.status !== 'due') continue;
      const owed = Math.round((Number(r.amount_due) - Number(r.amount_paid)) * 100) / 100;
      if (owed <= 0) continue;
      const k = r.investor_id;
      arrears[k] = arrears[k] || { investor_id: k, name: r.first_name, owed: 0, periods: 0 };
      arrears[k].owed = Math.round((arrears[k].owed + owed) * 100) / 100;
      arrears[k].periods += 1;
    }
    return res.json({ data: rows, arrears: Object.values(arrears) });
  } catch (err) {
    console.error('[stokvels] contributions failed:', err.message);
    return res.status(500).json({ error: 'Could not load the contributions.' });
  }
});

/* ─── POST /api/stokvels/:id/contributions/:cid/pay ──────────────────
   Pay your own, from your own wallet.

   Only your own: a member paying somebody else's contribution would move
   money between two people's records on one person's say-so, and the row
   would then say the other member had paid when they had not. If a stokvel
   wants that, it is a gift between members followed by a payment, and both
   halves should be visible.
   ──────────────────────────────────────────────────────────────────── */
router.post('/:id/contributions/:cid/pay', async (req, res) => {
  const me = callerInvestorId(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const group = await groupForCaller(me, req.params.id);
    if (!group) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such stokvel.' }); }

    const { rows: [contribution] } = await client.query(
      `SELECT * FROM stokvel_contributions
        WHERE id = $1 AND sub_account_id = $2 FOR UPDATE`,
      [req.params.cid, group.id]);
    if (!contribution) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such contribution.' }); }
    if (contribution.investor_id !== me) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only pay your own contribution.' });
    }

    const amount = req.body && req.body.amount != null
      ? parseFloat(req.body.amount)
      : Number(contribution.amount_due) - Number(contribution.amount_paid);

    let result;
    try {
      result = await contributions.pay(client, {
        contribution, investorId: me, subAccount: group, amount });
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: e.message });
    }
    await client.query('COMMIT');
    return res.json({ data: result });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[stokvels] pay failed:', err.message);
    return res.status(500).json({ error: 'Could not record that payment.' });
  } finally {
    client.release();
  }
});

module.exports = router;
