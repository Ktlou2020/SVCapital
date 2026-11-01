'use strict';
/* ═══════════════════════════════════════════════════════════
   Who gets told, when a stokvel's money is asked for.

   The mandate was built over three releases and then sat idle, because
   nothing told anybody it was waiting. A signatory found out that R10 000
   was pending by happening to open the app. A mandate is only as fast as its
   notifications, and a treasurer who has to phone three people to say
   "please go and tap approve" has a worse system than a bank form.

   Five moments, and no others:

     · ASKED      a request is raised        → the other signatories
     · PROGRESS   somebody voted, not yet carried → whoever raised it
     · CARRIED    the mandate is satisfied   → whoever raised it, and the signatories
     · REFUSED    a signatory said no        → whoever raised it, and the signatories
     · SPENT      the authority was used     → the signatories, and whoever raised it

   SPENT is the one that is easy to leave out and the one that matters most.
   An approval is a promise about money; a signatory who approves R10 000 and
   never learns where it went has been asked to trust the platform rather
   than to authorise something. It is also the only message that catches an
   authority used in a way nobody expected, while it is still recent.

   WHAT IS DELIBERATELY NOT HERE. A notification per vote to every signatory,
   which is three people told twice about a thing they are already doing; a
   notification when a contribution is paid, which is the normal case; and
   anything at all to staff, who have the console.

   RULES THIS FILE KEEPS.

   · IT CANNOT BREAK THE MONEY. Every function catches everything and returns
     a summary; none of them throws, and all of them are called AFTER the
     commit that moved the money. A failed email must never roll back a
     withdrawal.
   · IT RUNS OUTSIDE THE MONEY'S TRANSACTION, on the plain pool, so a slow
     mail provider cannot hold a row lock.
   · RECIPIENTS COME FROM THE MANDATE'S OWN DEFINITION of a signatory
     (active, named), so the people told are exactly the people whose
     approval counts. Reimplementing "who is a signatory" here is how the
     two drift, and the version that drifts is the one telling people.
   · THE PERSON WHO ACTED IS NOT TOLD WHAT THEY JUST DID.
   ═══════════════════════════════════════════════════════════ */

const defaultPool = require('../db/pool');
const mandate     = require('./stokvelMandate');

const fmtR = v => 'R' + Number(v || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* Lazily required so a missing mail key or push config cannot stop this file
   from loading inside the money path. */
function services() {
  let email = null, push = null;
  try { email = require('./email'); } catch (_) {}
  try { push  = require('./pushService'); } catch (_) {}
  return { email, push };
}

/* The authority, the group it belongs to and the pool it names, in one read.
   Returns null when any of it is missing — a notification about a request
   that is not there is worse than none. */
async function _load(db, groupId, authorityId) {
  const { rows } = await db.query(
    `SELECT r.*,
            a.name            AS stokvel_name,
            a.stokvel_quorum  AS stokvel_quorum,
            p.name            AS pool_name,
            i.first_name      AS raised_by_name
       FROM stokvel_withdrawal_requests r
       JOIN sub_accounts a ON a.id = r.sub_account_id
       LEFT JOIN investment_pools p ON p.id = r.pool_id
       LEFT JOIN investors i ON i.id = r.requested_by
      WHERE r.id = $1 AND r.sub_account_id = $2`,
    [authorityId, groupId]);
  return rows[0] || null;
}

/* Signatories who count right now, with what a message needs. The id set
   comes from the mandate; this only adds the names and addresses. */
async function _signatories(db, groupId) {
  const ids = await mandate.currentSignatories(db, groupId);
  if (!ids.size) return [];
  const { rows } = await db.query(
    `SELECT id, email, first_name FROM investors WHERE id = ANY($1::text[])`,
    [[...ids]]);
  return rows;
}

async function _person(db, investorId) {
  if (!investorId) return null;
  const { rows } = await db.query(
    'SELECT id, email, first_name FROM investors WHERE id = $1', [investorId]);
  return rows[0] || null;
}

/* What the request is for, in one phrase a person can act on. The
   DESTINATION is in it on purpose: "R10 000" tells a signatory nothing they
   can check, and the destination is the half of the request the mandate
   exists to pin down. */
function describe(authority) {
  const amount = fmtR(authority.amount);
  return String(authority.kind || 'withdrawal') === 'investment'
    ? `${amount} into ${authority.pool_name || 'a pool'}`
    : `${amount} to ${authority.bank_name || 'a bank account'}`;
}

/* One recipient, both channels. Push and email fail in different ways and
   for different people — a member who never granted push and a member whose
   address bounces are not the same member — so neither is a fallback for the
   other and a failure of one never stops the other. */
async function _tell(person, { title, body, email: mail }) {
  if (!person) return null;
  const { email, push } = services();
  if (push && person.id) {
    await push.sendPushToInvestor(person.id, {
      title, body, url: '/portal/', tag: 'sv-stokvel',
      icon: '/assets/logo.png', badge: '/assets/logo.png',
    }).catch(e => console.warn('[stokvelNotify] push failed:', e.message));
  }
  if (email && mail && person.email) {
    await Promise.resolve(email.sendStokvelMandate(person, mail))
      .catch(e => console.warn('[stokvelNotify] email failed:', e.message));
  }
  return person.id;
}

/* ─── ASKED ────────────────────────────────────────────────────────
   Everybody whose approval the request needs, except whoever raised it. */
async function approvalNeeded({ groupId, authorityId, db } = {}) {
  const pool = db || defaultPool;
  try {
    const a = await _load(pool, groupId, authorityId);
    if (!a) return { notified: [], reason: 'no such authority' };
    const required = Math.max(
      Number(a.quorum_required) || 0, Number(a.stokvel_quorum) || 0, mandate.MIN_QUORUM);
    const what = describe(a);
    const who  = a.raised_by_name || 'A member';
    const told = [];
    for (const s of await _signatories(pool, groupId)) {
      if (s.id === a.requested_by) continue;
      told.push(await _tell(s, {
        title: a.stokvel_name || 'Your stokvel',
        body:  `${who} asked for ${what}. It needs ${required} signatory approvals — yours is one of them.`,
        email: {
          subject: `${a.stokvel_name}: ${what} needs your approval`,
          heading: 'A request is waiting for you',
          lead: `${who} has asked for <strong>${what}</strong> out of <strong>${a.stokvel_name}</strong>. `
              + `It cannot go ahead until ${required} signatories approve it, and you are one of them.`,
          rows: _rows(a, required),
          note: a.reason ? `Reason given: ${a.reason}` : null,
          action: 'Open the stokvel in the app, read the request, and approve or reject it. '
                + 'A rejection ends it outright — a mandate is not a majority, so it would have to be raised again.',
        },
      }));
    }
    return { notified: told.filter(Boolean) };
  } catch (err) {
    console.error('[stokvelNotify] approvalNeeded failed:', err.message);
    return { notified: [], error: err.message };
  }
}

/* ─── PROGRESS · CARRIED · REFUSED ─────────────────────────────────
   One entry point, because the caller knows a vote happened and should not
   have to work out which of the three it was. */
async function decided({ groupId, authorityId, voterId, decision, db } = {}) {
  const pool = db || defaultPool;
  try {
    const a = await _load(pool, groupId, authorityId);
    if (!a) return { notified: [], reason: 'no such authority' };
    const what   = describe(a);
    const raiser = await _person(pool, a.requested_by);
    const voter  = await _person(pool, voterId);
    const byWhom = (voter && voter.first_name) || 'A signatory';
    const sigs   = await _signatories(pool, groupId);
    const told   = [];

    if (decision === 'reject') {
      /* The person who asked, and the rest of the mandate — a dead request
         that still looks pending to the other signatories is how three
         people go on waiting to vote on nothing. */
      if (raiser && raiser.id !== voterId) {
        told.push(await _tell(raiser, {
          title: a.stokvel_name,
          body:  `${byWhom} rejected your request for ${what}. It has been closed.`,
          email: {
            subject: `${a.stokvel_name}: your request for ${what} was rejected`,
            heading: 'Your request was rejected',
            lead: `${byWhom} rejected the request for <strong>${what}</strong>.`,
            rows: _rows(a, null),
            note: 'A mandate is not a majority: one rejection ends a request rather than being out-voted. '
                + 'If the group still wants this, it has to be raised again.',
          },
        }));
      }
      for (const s of sigs) {
        if (s.id === voterId || (raiser && s.id === raiser.id)) continue;
        told.push(await _tell(s, {
          title: a.stokvel_name,
          body:  `${byWhom} rejected the request for ${what}. Nothing more is needed from you.`,
          /* A final answer goes by email too. Push needs a permission this
             member may never have granted, and "stop waiting, it is dead"
             is not a message to deliver only to the people who happened to
             allow notifications. Progress, below, is push alone — an email
             per vote is the noise that gets the useful ones muted. */
          email: {
            subject: `${a.stokvel_name}: ${what} was rejected`,
            heading: 'The request was rejected',
            lead: `${byWhom} rejected the request for <strong>${what}</strong>, so nothing more is needed from you.`,
            rows: _rows(a, null),
            note: 'A mandate is not a majority: one rejection ends a request rather than being out-voted.',
          },
        }));
      }
      return { notified: told.filter(Boolean), outcome: 'rejected' };
    }

    const state = await mandate.evaluate(pool, a, { id: groupId, stokvel_quorum: a.stokvel_quorum });

    if (state.satisfied) {
      const next = String(a.kind || 'withdrawal') === 'investment'
        ? 'Any member can now place it from the marketplace.'
        : 'It will be paid out once the notice period has run.';
      if (raiser) {
        told.push(await _tell(raiser, {
          title: a.stokvel_name,
          body:  `Your request for ${what} has been approved. ${next}`,
          email: {
            subject: `${a.stokvel_name}: ${what} is approved`,
            heading: 'The signatories have approved it',
            lead: `The request for <strong>${what}</strong> has reached the ${state.required} approvals it needed.`,
            rows: _rows(a, state.required),
            note: next,
          },
        }));
      }
      for (const s of sigs) {
        if (raiser && s.id === raiser.id) continue;
        told.push(await _tell(s, {
          title: a.stokvel_name,
          body:  `${what} now has all ${state.required} approvals. ${next}`,
          email: {
            subject: `${a.stokvel_name}: ${what} is approved`,
            heading: 'The mandate is satisfied',
            lead: `<strong>${what}</strong> has the ${state.required} approvals it needed, `
                + 'so nothing more is needed from you.',
            rows: _rows(a, state.required),
            note: next,
          },
        }));
      }
      return { notified: told.filter(Boolean), outcome: 'approved' };
    }

    /* Still short. Only the person waiting on it hears about this — telling
       the signatories that a signatory voted is telling them what they are
       in the middle of doing. */
    if (raiser && raiser.id !== voterId) {
      told.push(await _tell(raiser, {
        title: a.stokvel_name,
        body:  `${byWhom} approved ${what}. ${state.approvals} of ${state.required} so far.`,
      }));
    }
    return { notified: told.filter(Boolean), outcome: 'pending' };
  } catch (err) {
    console.error('[stokvelNotify] decided failed:', err.message);
    return { notified: [], error: err.message };
  }
}

/* ─── SPENT ────────────────────────────────────────────────────────
   The money moved, under an authority these people granted. Everyone who
   approved it, and whoever raised it.

   This is the message that makes an approval mean something rather than
   being a step in a workflow: it closes the loop on a promise about money,
   and it is the only chance anybody has to notice an authority that was
   used in a way they did not expect while it is still recent. */
async function spent({ groupId, authorityId, reference, db } = {}) {
  const pool = db || defaultPool;
  try {
    const a = await _load(pool, groupId, authorityId);
    if (!a) return { notified: [], reason: 'no such authority' };
    const isInv = String(a.kind || 'withdrawal') === 'investment';
    const what  = describe(a);
    const line  = isInv
      ? `${fmtR(a.amount)} you approved has been invested in ${a.pool_name || 'the pool'}.`
      : `${fmtR(a.amount)} you approved is on its way to ${a.bank_name || 'the bank account'}.`;
    const raiser = await _person(pool, a.requested_by);
    const sigs   = await _signatories(pool, groupId);
    const seen   = new Set();
    const told   = [];
    for (const person of [...sigs, raiser].filter(Boolean)) {
      if (seen.has(person.id)) continue;
      seen.add(person.id);
      told.push(await _tell(person, {
        title: a.stokvel_name,
        body:  line,
        email: {
          subject: `${a.stokvel_name}: ${what} has gone through`,
          heading: 'The authority has been used',
          lead: line,
          rows: _rows(a, null, reference),
          note: 'This authority is now spent — it cannot be used a second time. '
              + 'If this is not what you approved, tell us straight away.',
        },
      }));
    }
    return { notified: told.filter(Boolean) };
  } catch (err) {
    console.error('[stokvelNotify] spent failed:', err.message);
    return { notified: [], error: err.message };
  }
}

/* The facts of the request, as label/value pairs. Every message carries the
   same ones, so a reader comparing two emails is comparing like with like. */
function _rows(a, required, reference) {
  const isInv = String(a.kind || 'withdrawal') === 'investment';
  const out = [
    ['Stokvel', a.stokvel_name],
    [isInv ? 'Into' : 'To', isInv ? (a.pool_name || a.pool_id || '—') : (a.bank_name || '—')],
    ['Amount', fmtR(a.amount)],
    ['Requested by', a.raised_by_name || '—'],
  ];
  if (isInv) {
    /* Said out loud, because it is the one number that differs from the one
       being approved: the fee is charged on top of what reaches the pool. */
    const spend = Math.round(Number(a.amount) * 1.01 * 100) / 100;
    out.push(['Leaves the wallet', `${fmtR(spend)} (including the 1% fee)`]);
  }
  if (required) out.push(['Approvals needed', String(required)]);
  if (reference) out.push(['Reference', reference]);
  return out;
}

module.exports = { approvalNeeded, decided, spent, describe };
