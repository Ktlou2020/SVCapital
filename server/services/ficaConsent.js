'use strict';
/* What a client is agreeing to when they tick the FICA box, and which
 * wording of it they ticked.
 *
 * The box used to say "I consent to FICA / FAIS identity verification as
 * required by the Financial Intelligence Centre Act" — one clause, naming
 * one check. What the platform actually runs is four: identity and photo,
 * bank account, address, and sanctions / crime / PEP screening. Three of
 * those were never named to the person agreeing to them, and a consent to
 * "identity verification" is not a consent to be screened against a
 * sanctions list.
 *
 * So the wording now names all four, which makes it a BROADER consent than
 * the one anybody ticked before today. That is the whole reason VERSION
 * exists and the whole reason it has moved: accepted_client_documents
 * records a version against each acceptance, and every FICA consent ever
 * taken was stamped '1.0'. Had the wording widened while the version stood
 * still, the row for somebody who agreed only to identity verification
 * would be indistinguishable from the row for somebody who agreed to be
 * screened — and the register would read as though everyone had consented
 * to everything. Anybody auditing it would have been reading a lie that
 * nobody wrote.
 *
 * Which means: if these scopes change again, move the version again.
 * check-fica-consent.cjs refuses a scope list that does not match the
 * wording on both signup pages, and refuses version '1.0' for this list.
 */

/* Bumped from '1.0' when the four checks below were first named, and from
   '2.0' when the opening sentence stopped claiming South African
   citizenship.

   It had read "I confirm that I am a South African citizen or permanent
   resident, and I consent to…". That was true of everybody who could reach
   the form, because international registration was closed. Opening it made
   the sentence a thing a foreign client would have to tick to proceed and
   could not truthfully tick — a false declaration as a condition of signing
   up, which is worse than no declaration at all.

   The claim is not lost, it has moved to where it belongs: an SA client
   gives a 13-digit ID number, an international client gives a passport, a
   nationality and a country of residence, and a non-resident signs a
   declaration of their own. None of that belongs in a consent to be
   screened. */
const VERSION = '2.1';

/* The checks themselves, worded as the person reads them. The check script
 * asserts each of these appears verbatim on both signup pages, so this list
 * and what somebody actually ticked cannot drift apart. */
const SCOPES = [
  'identity and photo verification',
  'bank account verification',
  'address verification',
  'sanctions, crime and politically exposed person (PEP) screening',
];

module.exports = { VERSION, SCOPES };
