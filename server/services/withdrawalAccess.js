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

/** Null when it may be paid, or a sentence saying when it may not. */
function blockedUntil(availableAtValue, now = new Date()) {
  if (!availableAtValue) return null;
  const when = availableAtValue instanceof Date ? availableAtValue : new Date(availableAtValue);
  if (isNaN(when.getTime()) || when <= now) return null;
  return `This withdrawal is payable from ${when.toISOString().slice(0, 16).replace('T', ' ')}.`;
}

module.exports = { DEFAULT_NOTICE_HOURS, noticeApplies, noticeHours, availableAt, blockedUntil };
