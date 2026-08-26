/* Which support tickets a KYC approval should act on.
 *
 * This was an enumerated list — fica_submission, kyc_submission, fica, kyc,
 * document_verification — repeated at each use site. The category space had
 * already outgrown it: the portal's own quick-ticket creates 'fica_kyc', which
 * is not in that list, so those tickets were never noted and never resolved.
 * Nothing failed; they simply stayed open forever.
 *
 * A list has to be updated every time someone adds a category, and nothing
 * makes them. A predicate does not: any category naming fica or kyc matches,
 * whatever it is called and whenever it was added.
 *
 * bank_verification is deliberately excluded. It is its own approval flow with
 * its own outcome, and closing it off the back of a KYC approval would claim
 * something that has not happened.
 */
'use strict';

/* Matched on whole underscore-separated tokens, not substrings.
   'bank_verification' contains the letters f-i-c-a — veri*fica*tion — so an
   ILIKE '%fica%' pulls in the bank flow, which has its own approval and its own
   outcome. Tokens keep fica_kyc and fica_upload while leaving that alone.

   SQL fragment. No parameters, so it is safe to interpolate — but it takes no
   input either, which is what makes that true. Keep it that way. */
const KYC_TOKEN = /(^|_)(fica|kyc)(_|$)/;
const KYC_TICKET_MATCH = `(
     category ~* '(^|_)(fica|kyc)(_|$)'
  OR category = 'document_verification'
)`;

/* Tickets still awaiting an outcome. */
const KYC_TICKET_OPEN = `status IN ('open', 'in_progress', 'under_review')`;

/* The same rule in JS, for callers that already hold a row. */
function isKycTicketCategory(category) {
  const c = String(category || '').toLowerCase();
  return KYC_TOKEN.test(c) || c === 'document_verification';
}

module.exports = { KYC_TICKET_MATCH, KYC_TICKET_OPEN, isKycTicketCategory };
