'use strict';
/* ═══════════════════════════════════════════════════════════
   When a withdrawal becomes payable.
 *
 * Every wallet on this platform bears interest — credited from the 3PIM
 * import, not computed here. NOTICE IS NOT UNIVERSAL: the 48 hours applies
 * to STOKVEL wallets and to nothing else. A personal wallet, a trust, a
 * child's account all keep same-day access.
 *
 * That narrowness is the rule, not an omission. A stokvel's money belongs
 * to a group and leaves on a mandate, so a pause between asking and paying
 * is part of what the group is buying. An individual's own money is their
 * own, and making three thousand clients wait two days for it would be a
 * change nobody asked for.
 *
 * A SET WITHDRAWAL DATE still binds whoever set one, stokvel or not,
 * because it is opt-in: an account that has committed its money until the
 * first of December has said so itself, and honouring that cannot surprise
 * anybody.
 *
 * Where both apply, the LATER wins. A stokvel committed until the first of
 * December that asks on the thirtieth of November waits out the notice; it
 * does not get paid on the first. The date is a floor under the notice, not
 * a replacement for it.
 *
 * One definition, two callers — the request, which stamps available_at on
 * the transaction, and the approval, which refuses to pay before it. The
 * stamp is what makes the promise: a later change to the notice setting
 * moves the terms for new requests and cannot touch a date a client has
 * already been given.
   ═══════════════════════════════════════════════════════════ */

const DEFAULT_NOTICE_HOURS = 48;

/* Whether this wallet carries notice at all. Only a stokvel does.
   Decided from the row rather than passed in by the caller, so a new
   withdrawal path cannot forget to ask — the sub-account route and the
   personal route both hand over the holder and get the right answer. */
function noticeApplies(holder) {
  return !!(holder && holder.account_type === 'stokvel');
}

/* The notice, in hours. A setting rather than a constant so it can be
   shortened, or zeroed, without a deploy — which is the lever you want when
   a client is owed money and the terms were wrong. */
async function noticeHours(client) {
  try {
    const { rows } = await client.query(
      `SELECT value FROM platform_settings WHERE key = 'withdrawal_notice_hours'`);
    if (!rows.length) return DEFAULT_NOTICE_HOURS;
    const n = Number(rows[0].value);
    /* A missing or unparseable setting falls back to the default rather
       than to zero. Zero is a real answer and somebody has to type it. */
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_NOTICE_HOURS;
  } catch (_) {
    return DEFAULT_NOTICE_HOURS;
  }
}

/**
 * When money asked for now may be paid.
 *
 * `holder` is the investors or sub_accounts row — whichever wallet the money
 * is leaving. Returns a Date.
 */
async function availableAt(client, holder, now = new Date()) {
  const hours = noticeApplies(holder) ? await noticeHours(client) : 0;
  const afterNotice = new Date(now.getTime() + hours * 3600 * 1000);

  const set = holder && holder.withdrawal_date;
  if (!set) return afterNotice;

  /* A DATE column arrives as a Date from node-postgres and as a string from
     anything that built the row by hand. Both name a day; the money is
     payable from the start of it. */
  const day = set instanceof Date ? set : new Date(String(set));
  if (isNaN(day.getTime())) return afterNotice;

  return day > afterNotice ? day : afterNotice;
}

/* ══ Whether this wallet may pay out at all ══════════════════════
 *
 * Money may reach this platform before we have identified who sent it.
 * Money may not leave it. That is the whole rule, and it was written out
 * three times, slightly differently each time:
 *
 *   routes/withdrawals.js   fica = 'approved' OR kyc = 'verified'
 *   routes/withdrawals.js   (sub-account)  kyc = 'approved'
 *   routes/tables.js        fica IN (approved, verified) OR kyc IN (approved, verified)
 *
 * THE FIRST TWO DISAGREED WITH THE THIRD ABOUT A REAL CLIENT. A person
 * whose documents were approved carries kyc_status = 'approved', and the
 * personal route did not accept that value — it wanted fica_status
 * approved, or kyc_status 'verified'. The portal posts to that route, so
 * a FICA-approved client was told their verification was incomplete,
 * while the generic route would have paid them. That state is not
 * hypothetical: routes/manualCredit.js carries a backfill written to
 * repair investors whose fica_status is out of step with an approved
 * kyc_status, and its own comment says a NULL fica_status is the
 * commonest way for it to happen.
 *
 * AND THE THIRD TESTED FOR A VALUE NOTHING WRITES. fica_status is
 * constrained to pending / approved / rejected / not_started / submitted
 * / in_progress; 'verified' is not among them and appears nowhere in this
 * repository except in that test. It read as generosity and was dead.
 *
 * So: one predicate, and the union of what the three meant. kyc_status
 * carries both words because both are written — document approval writes
 * 'approved', the automated FICA check and a review decision write
 * 'verified' — and they mean the same thing about the same person.
 *
 * A SUB-ACCOUNT IS ASKED THE SAME QUESTION ABOUT ITSELF. sub_accounts has
 * a kyc_status and no fica_status, so the fica leg is simply absent and
 * the answer comes off its own column. A group's verification is the
 * group's: the chairperson being FICA-approved says nothing about the
 * stokvel's constitution and bank proof.
 * ═════════════════════════════════════════════════════ */
const FICA_CLEARED_FICA_STATUS = ['approved'];
const FICA_CLEARED_KYC_STATUS  = ['approved', 'verified'];

const _norm = v => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Whether `holder` — an investors row or a sub_accounts row — has been
 * identified well enough to take money out.
 *
 * READ AS TWO INDEPENDENT COLUMNS, not `fica_status || kyc_status`. That
 * idiom is how routes/agreements.js came to refuse an approved client:
 * a truthy 'pending' in the first column meant the second was never
 * looked at.
 */
function ficaCleared(holder) {
  if (!holder) return false;
  return FICA_CLEARED_FICA_STATUS.includes(_norm(holder.fica_status))
      || FICA_CLEARED_KYC_STATUS.includes(_norm(holder.kyc_status));
}

/**
 * Null when this wallet may pay out, or the sentence to refuse it with.
 *
 * Returning the message rather than a boolean is deliberate: three call
 * sites each wrote their own, and one of them ("Sub-account FICA/KYC
 * verification is required before withdrawing funds.") named neither
 * which account nor what to do about it. A caller cannot now test the
 * rule and then word the refusal its own way.
 *
 * `opts.accountName` names a sub-account, because its documents are its
 * own and telling its owner to go and check "your" verification sends
 * them to the wrong screen.
 */
function ficaRefusal(holder, opts) {
  if (ficaCleared(holder)) return null;
  const name = opts && opts.accountName ? String(opts.accountName).trim() : '';
  return name
    ? `Withdrawals from ${name} are not available until that account’s FICA / KYC `
      + 'verification is complete. Its documents are uploaded and reviewed separately '
      + 'from your own.'
    : 'Withdrawals are not available until your FICA / KYC verification is complete. '
      + 'Please ensure all required documents have been submitted and approved by the '
      + 'compliance team.';
}

/** Null when it may be paid, or a sentence saying when it may not. */
function blockedUntil(availableAtValue, now = new Date()) {
  if (!availableAtValue) return null;
  const when = availableAtValue instanceof Date ? availableAtValue : new Date(availableAtValue);
  if (isNaN(when.getTime()) || when <= now) return null;
  return `This withdrawal is payable from ${when.toISOString().slice(0, 16).replace('T', ' ')}.`;
}

module.exports = { DEFAULT_NOTICE_HOURS, noticeApplies, noticeHours, availableAt, blockedUntil,
                   FICA_CLEARED_FICA_STATUS, FICA_CLEARED_KYC_STATUS, ficaCleared, ficaRefusal };
