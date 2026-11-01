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
            i.first_name      AS raised_by_name,
            x.first_name      AS exit_name
       FROM stokvel_withdrawal_requests r
       JOIN sub_accounts a ON a.id = r.sub_account_id
       LEFT JOIN investment_pools p ON p.id = r.pool_id
       LEFT JOIN investors i ON i.id = r.requested_by
       LEFT JOIN investors x ON x.id = r.exit_investor_id
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
  const kind = String(authority.kind || 'withdrawal');
  if (kind === 'investment') return `${amount} into ${authority.pool_name || 'a pool'}`;
  /* An exit names the PERSON, not an account. "R4 200 to a bank account"
     would be the one description a signatory could not act on, because what
     they are being asked to authorise is somebody's membership ending. */
  if (kind === 'exit') return `${amount} to settle ${authority.exit_name || 'a member'}\u2019s exit`;
  return `${amount} to ${authority.bank_name || 'a bank account'}`;
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

/* ─── INVITED ──────────────────────────────────────────────────────
   Somebody has been asked to join. There is no link in the message, so this
   has to do two jobs: tell them it happened, and tell them how to find it —
   sign in as the person who holds the contact it was sent to, and the
   invitation is on the Sub-accounts screen.

   THREE CHANNELS, because this is the one message sent to somebody who may
   not be a user at all. Email where there is an address, SMS where there is
   a number, push where the contact already belongs to an account. A stokvel
   treasurer typing in a cousin's cell number has given us the only way to
   reach them. */
async function invited({ inviteId, db } = {}) {
  const pool = db || defaultPool;
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.*, a.name AS stokvel_name, i.first_name AS invited_by_name
         FROM stokvel_invites v
         JOIN sub_accounts a ON a.id = v.sub_account_id
         LEFT JOIN investors i ON i.id = v.invited_by
        WHERE v.id = $1`, [inviteId]);
    if (!v) return { reached: [], reason: 'no such invitation' };

    const who   = v.invited_by_name || 'A member';
    const group = v.stokvel_name || 'a stokvel';
    const line  = `${who} has invited you to join ${group} on SV Capital.`;
    const find  = 'Sign in to the app with this email address or cell number and the '
                + 'invitation is waiting on your Sub-accounts screen.';
    const reached = [];

    const { email, push } = services();
    if (email && v.email) {
      await Promise.resolve(email.sendStokvelInvite(v.email, {
        inviteeName: v.invitee_name, inviterName: who, stokvelName: group,
        expiresAt: v.expires_at, alreadyAUser: !!v.matched_investor_id,
      })).then(() => reached.push('email'))
        .catch(e => console.warn('[stokvelNotify] invite email failed:', e.message));
    }
    if (v.cell) {
      let sms = null;
      try { sms = require('./sms'); } catch (_) {}
      if (sms && sms.sendStokvelInvite) {
        /* Invitations store a cell as its LAST NINE DIGITS, the only form
           every South African way of writing a number agrees on. The SMS
           transport is generic and knows nothing about that convention —
           it turns a leading 0 into +27 and gives up on anything else — so
           nine bare digits would be dropped in silence, leaving the
           invitation recorded and the SMS never sent. Restored here, where
           the storage convention is known. */
        const dialable = /^\d{9}$/.test(String(v.cell)) ? '0' + v.cell : v.cell;
        await Promise.resolve(sms.sendStokvelInvite(dialable, { inviterName: who, stokvelName: group }))
          .then(() => reached.push('sms'))
          .catch(e => console.warn('[stokvelNotify] invite sms failed:', e.message));
      }
    }
    if (push && v.matched_investor_id) {
      await push.sendPushToInvestor(v.matched_investor_id, {
        title: group, body: `${line} Open Sub-accounts to accept it.`,
        url: '/portal/', tag: 'sv-stokvel-invite',
        icon: '/assets/logo.png', badge: '/assets/logo.png',
      }).then(() => reached.push('push'))
        .catch(e => console.warn('[stokvelNotify] invite push failed:', e.message));
    }
    return { reached, find };
  } catch (err) {
    console.error('[stokvelNotify] invited failed:', err.message);
    return { reached: [], error: err.message };
  }
}

/* ─── JOINED ───────────────────────────────────────────────────────
   They accepted. The person who invited them is told, because an invitation
   sent into silence is indistinguishable from one that went to the wrong
   address — and that distinction is the whole weakness of an addressed
   invitation. Nobody else is told: a roster that grows is on the roster. */
async function inviteAccepted({ groupId, investorId, invitedBy, db } = {}) {
  const pool = db || defaultPool;
  try {
    if (!invitedBy || invitedBy === investorId) return { notified: [] };
    const { rows: [row] } = await pool.query(
      `SELECT a.name AS stokvel_name, j.first_name AS joiner_name, j.last_name AS joiner_surname
         FROM sub_accounts a, investors j
        WHERE a.id = $1 AND j.id = $2`, [groupId, investorId]);
    if (!row) return { notified: [] };
    const inviter = await _person(pool, invitedBy);
    const name = [row.joiner_name, row.joiner_surname].filter(Boolean).join(' ') || 'Somebody you invited';
    const told = await _tell(inviter, {
      title: row.stokvel_name,
      body:  `${name} accepted your invitation and is now a member.`,
      email: {
        subject: `${row.stokvel_name}: ${name} has joined`,
        heading: 'Your invitation was accepted',
        lead: `<strong>${name}</strong> accepted your invitation to <strong>${row.stokvel_name}</strong> `
            + 'and is now an active member.',
        rows: [['Stokvel', row.stokvel_name], ['Joined', name]],
        note: 'They join as an ordinary member. Signing power is a change to the mandate \u2014 '
            + 'it is not something an invitation can grant, and it is not something one person '
            + 'can arrange alone. Talk to us if the group has elected a new signatory.',
      },
    });
    return { notified: [told].filter(Boolean) };
  } catch (err) {
    console.error('[stokvelNotify] inviteAccepted failed:', err.message);
    return { notified: [], error: err.message };
  }
}

/* ─── EXIT SETTLED ─────────────────────────────────────────────────
   Somebody has left and been paid. Told to them, because it is their money,
   and to the signatories, because they authorised it.

   The message says what was PAID and what is still OWED, separately. An exit
   can outrun the group's cash — the pot may be in an eighteen-month cattle
   pool — and "R600 paid, R3 600 to follow as investments mature" is the one
   thing the person leaving needs to know. A message that reported only the
   R600 would read as the whole settlement and start the argument this
   feature exists to end. */
async function exitSettled({ groupId, investorId, settlement, db } = {}) {
  const pool = db || defaultPool;
  try {
    const s = settlement || {};
    const { rows: [row] } = await pool.query(
      `SELECT a.name AS stokvel_name FROM sub_accounts a WHERE a.id = $1`, [groupId]);
    if (!row) return { notified: [] };
    const leaver = await _person(pool, investorId);
    const owed = Number(s.queued) || 0;
    const tail = owed > 0
      ? ` ${fmtR(owed)} is still owed to you and will be paid as the group's investments mature.`
      : '';

    const rows = [
      ['Stokvel', row.stokvel_name],
      ['Your share', fmtR(s.gross)],
    ];
    if (Number(s.arrears) > 0) rows.push(['Less contributions owed', fmtR(s.arrears)]);
    rows.push(['Settled', fmtR(s.net)]);
    rows.push(['Paid to your wallet', fmtR(s.paid)]);
    if (owed > 0) rows.push(['Still owed to you', fmtR(owed)]);

    const told = [await _tell(leaver, {
      title: row.stokvel_name,
      body:  `Your membership has ended. ${fmtR(s.paid)} is in your wallet.${tail}`,
      email: {
        subject: `${row.stokvel_name}: your exit has been settled`,
        heading: 'Your membership has ended',
        lead: `The signatories approved your exit from <strong>${row.stokvel_name}</strong> and it has been settled.`,
        rows,
        note: owed > 0
          ? 'The group holds part of its money in investments that have not matured. The balance '
            + 'owed to you is recorded against the stokvel and paid automatically as cash becomes '
            + 'available — it is not forgotten, and it does not need chasing.'
          : 'Contributions you still owed were kept by the group, as its constitution provides.',
      },
    })];

    for (const sig of await _signatories(pool, groupId)) {
      if (sig.id === investorId) continue;
      told.push(await _tell(sig, {
        title: row.stokvel_name,
        body:  `${(leaver && leaver.first_name) || 'A member'} has left. ${fmtR(s.paid)} paid out`
             + (owed > 0 ? `, ${fmtR(owed)} still owed to them.` : '.'),
      }));
    }
    return { notified: told.filter(Boolean) };
  } catch (err) {
    console.error('[stokvelNotify] exitSettled failed:', err.message);
    return { notified: [], error: err.message };
  }
}

/* The facts of the request, as label/value pairs. Every message carries the
   same ones, so a reader comparing two emails is comparing like with like. */
function _rows(a, required, reference) {
  const isInv = String(a.kind || 'withdrawal') === 'investment';
  const out = [
    ['Stokvel', a.stokvel_name],
    [isInv ? 'Into' : 'To',
     isInv ? (a.pool_name || a.pool_id || '—')
           : (String(a.kind) === 'exit' ? (a.exit_name || 'a member') : (a.bank_name || '—'))],
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

module.exports = { approvalNeeded, decided, spent, invited, inviteAccepted, exitSettled, describe };
