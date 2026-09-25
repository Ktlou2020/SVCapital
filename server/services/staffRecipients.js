/* ═══════════════════════════════════════════════════════════
   Who to tell.

   Four places needed a list of staff to email — a pending withdrawal, a FICA
   document arriving, a leave request, the monthly director report — and all
   four asked the same question the same wrong way:

       SELECT … FROM users WHERE role IN ('director','admin')

   In this platform `users` holds INVESTORS. There are 4 598 of them and they
   are all role 'investor'. Staff live in `employees`, and their privilege is
   not stored at all: issueStaffJwt derives it at login from the job title and
   the granted apps (empToJwtRole / elevateRoleByApps in routes/auth.js). So
   that query returns nothing, and has always returned nothing.

   It failed silently in every one of the four. The clearest evidence was in
   production, three times a day, at info level:

       [withdrawalAlertCron] Alerted 0 admin(s) — 3 pending withdrawal(s).

   Three clients waiting on their money and no email sent. The FICA one is
   worse in kind: a client uploads their identity documents, nobody is told,
   and the documents sit unreviewed while the client waits for the email the
   signup screen promised them.

   One resolver, used by all four, so the next person to need a staff list
   does not write a fifth copy of the same mistake.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const pool = require('../db/pool');

/* Every role the rest of the codebase treats as staff. fund_manager is in
   STAFF_ROLES in routes/agreements.js and ADMIN_ROLES in routes/tables.js and
   was missing from all four of these queries. */
const STAFF_USER_ROLES = ['admin', 'director', 'fund_manager'];

/* Seniority in `employees`. Levels below this are staff, not the people who
   action a withdrawal or a FICA review. */
const SENIOR_LEVELS = ['executive', 'lead'];

const FALLBACK = () => process.env.OPS_ALERT_EMAIL || 'kagiso@svcapital.co.za';

/**
 * Resolve who should receive an operational notification.
 *
 * Sources are tried in order and the FIRST that yields anybody wins — not the
 * union. Senior staff usually appear in both, and mailing both would send them
 * the same withdrawal alert two or three times a day.
 *
 * The list is never empty. A notification that reaches nobody is worse than
 * one that goes to the wrong person, because nothing in the logs distinguishes
 * it from one that was delivered.
 *
 * @returns {Promise<{to: Array<{id, email, first_name, last_name, role}>, source: string}>}
 */
async function staffRecipients() {
  const { rows: users } = await pool.query(
    `SELECT id, email, first_name, last_name, role
       FROM users
      WHERE role = ANY($1::text[])
        AND email IS NOT NULL AND btrim(email) <> ''
        AND COALESCE(is_active, true) = true
      ORDER BY first_name`, [STAFF_USER_ROLES]);
  if (users.length) return { to: users, source: 'users' };

  const { rows: staff } = await pool.query(
    `SELECT id, email, first_name, last_name, role
       FROM employees
      WHERE level = ANY($1::text[])
        AND COALESCE(status, '') = 'active'
        AND email IS NOT NULL AND btrim(email) <> ''
      ORDER BY first_name`, [SENIOR_LEVELS]);
  if (staff.length) return { to: staff, source: 'employees' };

  return {
    to: [{ id: null, email: FALLBACK(), first_name: null, last_name: null, role: null }],
    source: 'fallback',
  };
}

/* ─── Standing copies ─────────────────────────────────────────────────
   People who must receive a particular notification whether or not they
   hold a staff account.

   Kept apart from staffRecipients() on purpose. That function answers "who
   are the staff", and its sources are tried in order so that senior people
   appearing in both are not mailed twice. This answers a different question
   — "who else always wants this one" — and the answer is additive.

   Set WITHDRAWAL_ALERT_ALSO to a comma-separated list to change it without a
   deploy; the names below are the default, not a hard-coded ceiling. An
   empty value means nobody, which is how the copy is switched off.
   ─────────────────────────────────────────────────────────────────── */
const ALWAYS_COPY = {
  withdrawal: () => process.env.WITHDRAWAL_ALERT_ALSO !== undefined
    ? process.env.WITHDRAWAL_ALERT_ALSO
    : 'Odireleng@svcapital.co.za, Balepi@svcapital.co.za',
};

const normalise = e => String(e || '').trim().toLowerCase();

/* "Odireleng@svcapital.co.za" greets as Odireleng rather than "there".

   Only a single run of letters is used. A local part like finance.team or
   ops-2 would produce "Finance.team" in a greeting, which reads worse than
   the neutral fallback the template already has. */
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  if (!/^[A-Za-z]{2,}$/.test(local)) return null;
  return local[0].toUpperCase() + local.slice(1).toLowerCase();
}

/* The resolved staff list plus the standing copies for `kind`, with anybody
   already on it left where they are.

   Deduplicated on the lowercased address, because a standing copy written
   with a capital and a staff record written without it are one person, and
   two copies of "3 withdrawals are waiting" three times a day is how an
   alert becomes something people filter. */
function withStandingCopies(list, kind) {
  const out  = (list || []).slice();
  const seen = new Set(out.map(r => normalise(r.email)).filter(Boolean));

  const extra = String((ALWAYS_COPY[kind] || (() => ''))() || '')
    .split(',').map(e => e.trim()).filter(Boolean);

  for (const email of extra) {
    const key = normalise(email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: null, email, first_name: nameFromEmail(email), last_name: null, role: null, standingCopy: true });
  }
  return out;
}

/* Says so, once, and loudly enough to find. Called by every site so that a
   silent fallback cannot look like a successful delivery in a log. */
function warnIfNotUsers(source, label) {
  if (source === 'users') return;
  console.error(
    `[${label}] No user has role ${STAFF_USER_ROLES.join(', ')} — fell back to ${source}. ` +
    `Staff privilege is derived at login from employees, so the users table may legitimately ` +
    `hold none; check that the fallback reaches the right people.`);
}

module.exports = {
  staffRecipients, warnIfNotUsers, withStandingCopies, nameFromEmail,
  STAFF_USER_ROLES, SENIOR_LEVELS, ALWAYS_COPY,
};
