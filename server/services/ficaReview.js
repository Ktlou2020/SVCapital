/* ═══════════════════════════════════════════════════════
   FICA review decisions — the human half of an automated check

   An automated check that cannot decide on its own (a possible sanctions
   or PEP match, a name that differs from Home Affairs, a bank that could
   not confirm the account) ends at overall_status 'manual_review' and the
   client at kyc_status 'pending'. This is how that review is closed:
   somebody approves or declines it, with a reason, and the decision is
   recorded on the check itself — who, when, which way and why — because
   that record is what a FICA audit asks for.

   Rules:
     - only the LATEST check for a client can be decided, and only once
     - a reason is always required
     - approving a possible sanctions/PEP match is a director's decision
     - a check whose sanctions screen did not run cannot be approved: the
       client has not been screened, so run the check again
   ═══════════════════════════════════════════════════════ */
'use strict';

const pool = require('../db/pool');

const STAFF_ROLES = ['admin', 'director', 'fund_manager'];

class ReviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const WHERE_TO_DECIDE = 'KYC / FICA → FICA Pipeline → Checks';

/* The latest check for a client, if it is waiting on a decision. */
async function openReview(investorId, db = pool) {
  const { rows: [c] } = await db.query(
    `SELECT id, overall_status, review_decision, sanctions_check_status
       FROM fica_checks WHERE investor_id = $1
      ORDER BY check_date DESC, created_at DESC LIMIT 1`, [investorId]);
  return c && c.overall_status === 'manual_review' && !c.review_decision ? c : null;
}

/* A declined review that no director has reversed. It holds the client
   rejected — through later automated checks, document approvals and the
   hourly reconcile — until a director reverses it, with a reason. Newest
   first, so the decline the panel shows is the latest one standing. */
async function standingDecline(investorId, db = pool) {
  const { rows: [c] } = await db.query(
    `SELECT id, reviewed_by, reviewed_by_role, reviewed_at, review_note, match_outcome, check_date
       FROM fica_checks
      WHERE investor_id = $1 AND review_decision = 'declined' AND reversed_at IS NULL
      ORDER BY reviewed_at DESC NULLS LAST, check_date DESC LIMIT 1`, [investorId]);
  return c || null;
}

/* What the viewer may do — returned with the checks so the panel shows the
   right buttons. The server enforces the same rules in decide(). */
function permissions(user) {
  const role = (user && user.role) || '';
  return {
    role,
    canDecide:        STAFF_ROLES.includes(role),
    canApproveMatch:  role === 'director',
    canReverse:       role === 'director',
  };
}

const _approves = v => ['approved', 'verified'].includes(String(v || '').toLowerCase());

/* Called by the generic investor update routes. Returns a refusal message
   when an update would approve a client whose automated check is waiting
   on a review decision — the document and profile approvals know nothing
   about a possible PEP match, and must not clear one by accident. */
async function guardInvestorUpdate(investorId, body) {
  if (!body || !(_approves(body.kyc_status) || _approves(body.fica_status))) return null;
  let open, declined;
  try { [open, declined] = await Promise.all([openReview(investorId), standingDecline(investorId)]); }
  catch (err) {
    /* A broken guard must not stop every client update; say so and allow. */
    console.error('[ficaReview] guard could not read fica_checks:', err.message);
    return null;
  }
  if (declined) {
    return `This client's FICA review was declined${declined.reviewed_by ? ' by ' + declined.reviewed_by : ''}. `
         + `They cannot be approved until a director reverses the decline in ${WHERE_TO_DECIDE}.`;
  }
  if (!open) return null;
  const what = open.sanctions_check_status === 'hit' ? 'a possible sanctions/PEP match' : 'a review';
  return `This client's automated FICA check is waiting on ${what}. `
       + `Approve or decline it in ${WHERE_TO_DECIDE} first.`;
}

/* Approve or decline a check held for review. */
async function decide({ checkId, decision, note, matchOutcome, user }) {
  const perms = permissions(user);
  if (!perms.canDecide) throw new ReviewError(403, 'Only admin, director or fund manager staff can decide a FICA review.');
  if (!['approve', 'decline'].includes(decision)) throw new ReviewError(400, 'Decision must be approve or decline.');
  const reason = String(note || '').trim();
  if (reason.length < 5) throw new ReviewError(400, 'Give the reason for the decision — it is recorded on the check.');
  if (reason.length > 2000) throw new ReviewError(400, 'Keep the reason under 2 000 characters.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [c] } = await client.query(
      `SELECT id, investor_id, overall_status, review_decision, sanctions_check_status
         FROM fica_checks WHERE id = $1 FOR UPDATE`, [checkId]);
    if (!c) throw new ReviewError(404, 'Check not found.');
    if (c.review_decision) throw new ReviewError(409, `This check was already ${c.review_decision}.`);
    if (c.overall_status !== 'manual_review') {
      throw new ReviewError(409, 'Only a check that needs review can be decided.');
    }
    const latest = await openReview(c.investor_id, client);
    if (!latest || latest.id !== c.id) {
      throw new ReviewError(409, 'A newer check has run for this client — decide that one instead.');
    }
    /* A possible match is decided on two questions, not one: is it this
       client, and do we take them on. The first is what marks a client as
       a PEP; approving without answering it would leave that unknown. */
    const isMatch = c.sanctions_check_status === 'hit';
    if (isMatch && !['false_positive', 'confirmed'].includes(matchOutcome)) {
      throw new ReviewError(400, 'Say whether the possible match is this client: not this person, or confirmed.');
    }
    if (decision === 'approve' && isMatch && !perms.canApproveMatch) {
      throw new ReviewError(403, 'A possible sanctions or PEP match can only be approved by a director.');
    }
    if (decision === 'approve') {
      const declined = await standingDecline(c.investor_id, client);
      if (declined && declined.id !== c.id) {
        throw new ReviewError(409, 'An earlier review of this client was declined'
          + (declined.reviewed_by ? ' by ' + declined.reviewed_by : '')
          + '. A director must reverse that decline before this client can be approved.');
      }
    }
    if (decision === 'approve' && c.sanctions_check_status === 'error') {
      throw new ReviewError(409, 'The sanctions screen did not run on this check, so the client has not been '
        + 'screened. Run the check again before approving.');
    }

    const reviewer = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'Staff';
    const outcome  = decision === 'approve' ? 'approved' : 'declined';
    await client.query(
      `UPDATE fica_checks
          SET review_decision = $2, review_note = $3, reviewed_by = $4,
              reviewed_by_role = $5, reviewed_at = NOW(), match_outcome = $6
        WHERE id = $1`,
      [c.id, outcome, reason, reviewer, user.role || null, isMatch ? matchOutcome : null]);
    /* The same fields an automated pass or fail writes. fica_status and the
       account status belong to the document process and are left alone. */
    await client.query(
      `UPDATE investors
          SET kyc_status = $2, fica_auto_status = $3, updated_at = NOW()
        WHERE id = $1`,
      [c.investor_id, decision === 'approve' ? 'verified' : 'rejected', outcome]);
    await client.query('COMMIT');

    setImmediate(() => {
      Promise.resolve().then(() => require('./audit').log({
          actorId: user.id, actorEmail: user.email, actorRole: user.role,
          action: `fica_review.${outcome}`, entityType: 'fica_checks', entityId: c.id,
          description: `${reviewer} ${outcome} the automated FICA check for ${c.investor_id}`
                     + (isMatch ? ` (possible sanctions/PEP match: ${matchOutcome === 'confirmed' ? 'confirmed as the client' : 'not this person'})` : '')
                     + `: ${reason}`,
          platform: 'admin',
        })).catch(() => {});
    });

    return { checkId: c.id, investorId: c.investor_id, decision: outcome, reviewedBy: reviewer,
             matchOutcome: isMatch ? matchOutcome : null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* Reverse a declined review. A director's decision, with a reason, and
   recorded on the check beside the decline it reverses. The client goes
   back to pending: reversing a decline is not approving them — they are
   approved afterwards in the ordinary way, by a fresh check or their
   documents. */
async function reverse({ checkId, note, user }) {
  if (!permissions(user).canReverse) throw new ReviewError(403, 'Only a director can reverse a declined FICA review.');
  const reason = String(note || '').trim();
  if (reason.length < 5) throw new ReviewError(400, 'Give the reason for reversing the decline — it is recorded on the check.');
  if (reason.length > 2000) throw new ReviewError(400, 'Keep the reason under 2 000 characters.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [c] } = await client.query(
      `SELECT id, investor_id, review_decision, reversed_at, match_outcome
         FROM fica_checks WHERE id = $1 FOR UPDATE`, [checkId]);
    if (!c) throw new ReviewError(404, 'Check not found.');
    if (c.review_decision !== 'declined') throw new ReviewError(409, 'Only a declined review can be reversed.');
    if (c.reversed_at) throw new ReviewError(409, 'This decline was already reversed.');

    const by = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'Director';
    await client.query(
      `UPDATE fica_checks SET reversed_by = $2, reversed_by_role = $3, reversed_at = NOW(), reversal_note = $4
        WHERE id = $1`, [c.id, by, user.role || null, reason]);
    /* Back to pending — unless another decline still stands, in which case
       the client stays held by that one. */
    const other = await standingDecline(c.investor_id, client);
    if (!other) {
      await client.query(
        `UPDATE investors SET kyc_status = 'pending', fica_auto_status = 'reversed', updated_at = NOW()
          WHERE id = $1`, [c.investor_id]);
    }
    await client.query('COMMIT');

    setImmediate(() => {
      Promise.resolve().then(() => require('./audit').log({
        actorId: user.id, actorEmail: user.email, actorRole: user.role,
        action: 'fica_review.reversed', entityType: 'fica_checks', entityId: c.id,
        description: `${by} reversed the declined FICA review for ${c.investor_id}: ${reason}`,
        platform: 'admin',
      })).catch(() => {});
    });
    return { checkId: c.id, investorId: c.investor_id, reversedBy: by, stillHeld: !!other };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* Is this client on a watch list, as far as we know? Drawn for the banner
   on their profile, and for staff only — never stored on the investor row,
   which the client's own portal reads.

     confirmed  a reviewer found a match to BE this client. It stands until
                a later review finds a match on them to be a false one.
     possible   the latest screen found a match nobody has decided yet.
     null       never matched, or every match was found not to be them. */
const _isPepMatch = m => /pep|politically/i.test([m.list, ...(m.programmes || []), m.remarks].join(' '));

async function watchlistFlag(investorId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, check_date, sanctions_check_status, sanctions_result, review_decision,
            review_note, reviewed_by, reviewed_by_role, reviewed_at, match_outcome
       FROM fica_checks
      WHERE investor_id = $1 AND sanctions_check_status IN ('hit', 'clear')
      ORDER BY check_date DESC, created_at DESC`, [investorId]);
  if (!rows.length) return null;

  const describe = (c, status) => {
    const matches = (c.sanctions_result && Array.isArray(c.sanctions_result.matches)) ? c.sanctions_result.matches : [];
    return {
      status,
      kind:    matches.some(_isPepMatch) || !matches.length ? 'pep' : 'sanctions',
      lists:   [...new Set(matches.map(m => m.list).filter(Boolean))],
      names:   [...new Set(matches.map(m => m.name).filter(Boolean))],
      checkId: c.id, checkedAt: c.check_date,
      decidedBy: c.reviewed_by || null, decidedRole: c.reviewed_by_role || null,
      decidedAt: c.reviewed_at || null, decision: c.review_decision || null, note: c.review_note || null,
    };
  };

  /* Newest first: a confirmation stands until a later false-positive. */
  for (const c of rows) {
    if (c.match_outcome === 'false_positive') break;
    if (c.match_outcome === 'confirmed') return describe(c, 'confirmed');
  }
  const latest = rows[0];
  if (latest.sanctions_check_status === 'hit' && !latest.match_outcome) return describe(latest, 'possible');
  return null;
}

/* For the statements that promote a client straight from approved
   documents — the document-approval hook, the hourly reconcile, the
   backfills. Appended to their WHERE so a client whose latest automated
   check is waiting on a decision is never promoted behind its back.
   `alias` is the investors table's name or alias in that statement. */
function noOpenReviewSql(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('noOpenReviewSql: bad alias');
  /* Two holds, either of which keeps the client from being promoted: a
     latest check waiting on a decision, or a declined review no director
     has reversed. */
  return `NOT EXISTS (
    SELECT 1 FROM fica_checks fd
     WHERE fd.investor_id = ${alias}.id AND fd.review_decision = 'declined' AND fd.reversed_at IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT fc.overall_status, fc.review_decision FROM fica_checks fc
       WHERE fc.investor_id = ${alias}.id
       ORDER BY fc.check_date DESC, fc.created_at DESC LIMIT 1
    ) latest_fica
    WHERE latest_fica.overall_status = 'manual_review' AND latest_fica.review_decision IS NULL)`;
}

module.exports = { openReview, standingDecline, permissions, guardInvestorUpdate, decide, reverse, watchlistFlag, noOpenReviewSql, ReviewError, WHERE_TO_DECIDE };
