'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   WHICH FICA CHECK A CLIENT IS DUE, IF ANY

   Four callers ask this same question — the nightly sweep's queries, the
   console's manual trigger, the hook that fires when an investment is
   placed, and runFicaCheck itself, which refuses whatever this says is
   not due. The non-resident refusal lives inside runFicaCheck for exactly
   this reason, and says so: "a predicate repeated in four SELECTs is
   three places to forget it". So the rules are here, once.

   1. THE AUTOMATED ROUTE STARTS AT R2 000. An automated check is three or
      four paid provider calls per client — Home Affairs, a bank, a
      sanctions list, a credit bureau. Below R2 000 the client submits an
      ID, a proof of address and a proof of bank, and a person reads them;
      that path already exists and already ends in kyc_status 'approved'.

      THE AMOUNT TESTED IS WHAT REACHES THE POOL. The 1% platform fee
      rides on top of the investment, so a R2 000 placement costs R2 020
      from the wallet — and it is the R2 000 that is the investment, the
      same way a pool minimum is tested against the pool amount and never
      against the wallet spend.

   2. A DEPOSIT IS NOT AN INVESTMENT. Money arriving in a wallet used to
      fire the automated check and placing it fired nothing, because
      nothing watched investments at all. The investment is the trigger
      now. A client who deposits and never invests is not checked
      automatically — they have bought nothing, and whoever handles their
      first placement will.

   3. AN APPROVED CLIENT WHO WAS NEVER SCREENED GETS THE SCREEN, AND ONLY
      THE SCREEN. fica_checks.sanctions_check_status defaults to 'skipped'
      and every row written before that column existed carries it, so
      there is a population of approved clients who went through ID and
      bank and never past a sanctions or PEP list. Re-running their whole
      check to close that is four provider calls to answer one question.
      ficaReview already refuses to approve a review whose screen did not
      run; this is the same conviction applied to the clients who were
      approved before it was held.

      This one is NOT held behind the twelve months. A screen that never
      ran is a hole, not a repeat, and leaving a known-unscreened approved
      client for up to a year is the thing being fixed. A screen that HAS
      run is inside the window like everything else.

   4. AND NOTHING IS RE-RUN INSIDE TWELVE MONTHS. Each step carries its own
      stamp — last_auto_fica_check for the full check, last_sanctions_check
      for the screen — because a sanctions-only run must not push the
      annual full re-check out by a year. That is the whole reason the
      second column exists.
   ═══════════════════════════════════════════════════════════════════════ */

const FOREIGN = require('./foreignInvestor');

/* What reaches the pool, not what leaves the wallet. */
const AUTO_MIN_INVESTMENT = 2000;
const RECHECK_MONTHS = 12;

const MANUAL_UNDER_THRESHOLD_REASON =
  `Under R${AUTO_MIN_INVESTMENT.toLocaleString('en-ZA')} — FICA is submitted and `
  + 'reviewed manually. The automated check is reserved for investments of '
  + `R${AUTO_MIN_INVESTMENT.toLocaleString('en-ZA')} and up; below it the client `
  + 'sends an ID, a proof of address and a proof of bank, and a person reads them.';

const NEVER_SCREENED_REASON =
  'Approved before sanctions screening was held, so the screen has never run '
  + 'for this client. Running the screen on its own rather than the whole '
  + 'check again.';

const SCREEN_AGED_OUT_REASON =
  `The sanctions screen is more than ${RECHECK_MONTHS} months old while the rest `
  + 'of the check is still inside its window, so the screen runs on its own.';

/* ── FICA APPROVED, BY EITHER ROUTE ───────────────────────────────────
 * The automated path writes kyc_status 'verified' and the manual document
 * path writes 'approved'; fica_status 'approved' is what the older records
 * and the analytics queries read. All three mean the same thing — a client
 * who has been through FICA — and a rule about approved clients that knows
 * only one of them silently exempts the others. */
function ficaApproved(investor) {
  const kyc  = String((investor && investor.kyc_status)  || '').toLowerCase();
  const fica = String((investor && investor.fica_status) || '').toLowerCase();
  return kyc === 'approved' || kyc === 'verified' || fica === 'approved';
}

/* Due when it has never run, or ran longer ago than the window. */
function isDue(stamp, now) {
  if (!stamp) return true;
  const when = new Date(stamp);
  if (isNaN(when.getTime())) return true;
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - RECHECK_MONTHS);
  return when <= cutoff;
}

/* ── THE DECISION ─────────────────────────────────────────────────────
 *
 * Returns { scope, reason }, where scope is one of:
 *
 *   'full'           run the whole check: ID, bank, sanctions, address
 *   'sanctions_only' run the sanctions/PEP screen and nothing else
 *   'manual'         do not call a provider; the client submits documents
 *   'none'           nothing is due; everything is inside its window
 *
 * opts.investedAmount — what reaches the pool, when an investment is what
 *   is asking. Left out (the annual sweep, a manual trigger from the
 *   console) there is no amount to test and the threshold does not apply:
 *   it decides which route a client's FIRST check takes, and a client
 *   already on the automated route is re-checked on the automated route.
 * opts.now — for the checks; defaults to this moment.
 * opts.force — a person asked for this one. The twelve months and the
 *   threshold are rules about what runs on its own; a staff member who
 *   clicks "run check" after a client corrects their bank details is not
 *   an automated sweep, and leaving them no way to re-run inside the
 *   window would mean telling a client to wait a year. Residency is NOT
 *   overridden: Home Affairs still does not hold their ID number, so the
 *   check would record a failure that means nothing.
 */
function scope(investor, opts) {
  const o = opts || {};
  const now = o.now ? new Date(o.now) : new Date();
  const amount = o.investedAmount == null || o.investedAmount === ''
    ? null : Number(o.investedAmount);

  /* A non-resident is read by a person whatever the amount, and for a
     reason that has nothing to do with money: the automated path reads
     Home Affairs, which holds South African ID numbers only. */
  if (!FOREIGN.automatedFicaAllowed(investor))
    return { scope: 'manual', reason: FOREIGN.MANUAL_FICA_REASON };

  /* A person asked. Residency still stands, above. */
  if (o.force) return { scope: 'full', reason: 'Run by hand.' };

  const approved     = ficaApproved(investor);
  const fullDue      = isDue(investor && investor.last_auto_fica_check, now);
  const sanctionsDue = isDue(investor && investor.last_sanctions_check, now);

  /* ── TWO POPULATIONS OF APPROVED CLIENT, AND THE DIFFERENCE IS ONE
   *    COLUMN BEING NULL ──────────────────────────────────────────
   *
   * A client approved through the MANUAL document route has no
   * last_auto_fica_check at all: a person read their ID, their proof of
   * address and their proof of bank, and approved them. Nothing
   * automated has ever run for them, and "the full check is due" is
   * technically true of every one of them forever.
   *
   * Sending them for a full automated check would be four paid provider
   * calls to re-answer what a person already answered — and it is not
   * what is missing. What is missing is the sanctions screen. So for
   * them the screen runs on its own, which is rule 3 exactly as it was
   * asked for.
   *
   * A client with an automated check on record is the other population,
   * and when theirs has aged out they get the annual re-check, in full.
   * Reading those two the same way would end the annual re-check
   * entirely — every candidate for it is approved, so an
   * approved-means-screen-only rule would catch all of them. */
  const everAutoChecked = !!(investor && investor.last_auto_fica_check);

  if (approved && sanctionsDue && !(everAutoChecked && fullDue))
    return { scope: 'sanctions_only',
             reason: investor && investor.last_sanctions_check
               ? SCREEN_AGED_OUT_REASON : NEVER_SCREENED_REASON };

  /* Rule 4: inside the window, nothing runs. */
  if (!fullDue)
    return { scope: 'none', reason: `Checked within the last ${RECHECK_MONTHS} months.` };

  /* Rule 1. Only when an amount is what is asking. */
  if (amount != null && !isNaN(amount) && amount < AUTO_MIN_INVESTMENT)
    return { scope: 'manual', reason: MANUAL_UNDER_THRESHOLD_REASON,
             threshold: AUTO_MIN_INVESTMENT };

  return { scope: 'full' };
}

/* The SQL the sweep's queries use, so the window is one definition there
   too rather than a second interval literal in a query somebody edits. */
const RECHECK_INTERVAL_SQL = `INTERVAL '${RECHECK_MONTHS} months'`;

module.exports = {
  AUTO_MIN_INVESTMENT, RECHECK_MONTHS, RECHECK_INTERVAL_SQL,
  MANUAL_UNDER_THRESHOLD_REASON, NEVER_SCREENED_REASON, SCREEN_AGED_OUT_REASON,
  ficaApproved, isDue, scope,
};
