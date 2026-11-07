/* ═══════════════════════════════════════════════════════════
   What kind of client this is.

   The platform had no answer to that. investors held a natural person and
   nothing else: entities lived as sub_accounts beneath somebody, so the
   admin console could tell you a client HAD a trust without telling you the
   client WAS one. The Firebase export carries the answer in a field called
   investorType, and the import never read it — the mapping lists name,
   surname, kycStatus, status and a dozen others, and that one fell on the
   floor.

   It matters more now than it did. FICA verification differs by entity: a
   natural person is verified against Home Affairs, a company against CIPC,
   a trust against its deed and its trustees. A provider integration that
   cannot tell them apart will cheerfully run an ID check against a trust's
   registration number.

   ── WHY AN UNRECOGNISED VALUE IS null, NOT 'individual' ──────────────

   Because the costly mistake has a direction. Reading an unknown as
   "individual" turns every trust and company the mapper has not met into a
   natural person, silently and permanently, and the next FICA run verifies
   them as people. Reading it as nothing leaves a gap somebody can see and
   fill. One is a wrong answer, the other is an open question, and only the
   second can be noticed.

   So the column is NULLABLE with no default, this returns null for anything
   it does not recognise, and the import NAMES the values it could not map
   rather than defaulting them.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* The four the business actually distinguishes. `group` is the savings-group
   case — a stokvel, umgalelo, motshelo or society — named the way the rest
   of the platform now names it. */
const INVESTOR_TYPES = ['individual', 'business', 'trust', 'group'];

/* Every spelling worth accepting, because the export was written by another
   system and nobody here chose its vocabulary. Keys are compared after
   lower-casing and collapsing punctuation, so INDIVIDUAL, Individual and
   NATURAL_PERSON all arrive here as one word. */
const ALIASES = {
  individual: 'individual', person: 'individual', natural: 'individual',
  naturalperson: 'individual', personal: 'individual', retail: 'individual',
  sole: 'individual', soleproprietor: 'individual', single: 'individual',

  business: 'business', company: 'business', corporate: 'business',
  corporation: 'business', entity: 'business', juristic: 'business',
  juristicperson: 'business', pty: 'business', ptyltd: 'business',
  ltd: 'business', cc: 'business', closecorporation: 'business',
  partnership: 'business', smme: 'business', sme: 'business',

  trust: 'trust', trustee: 'trust', inter: 'trust', intervivos: 'trust',
  intervivostrust: 'trust', testamentary: 'trust', estate: 'trust',

  group: 'group', stokvel: 'group', savingsgroup: 'group', savings: 'group',
  club: 'group', investmentclub: 'group', society: 'group',
  burialsociety: 'group', umgalelo: 'group', motshelo: 'group',
  syndicate: 'group',
};

/* Lower-case and strip everything that is not a letter or digit, so
   "PTY_LTD", "Pty Ltd" and "pty-ltd" are the same key. */
function _key(raw) {
  return String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* The canonical type, or null when it is not recognised. Null is a real
   answer here and means "nobody has said" — never assume. */
function normaliseInvestorType(raw) {
  const k = _key(raw);
  if (!k) return null;
  if (INVESTOR_TYPES.includes(k)) return k;
  return ALIASES[k] || null;
}

/* What a person reads. An unset type says so rather than showing a dash that
   could equally mean "individual" — the whole point is that the two are
   different states. */
function investorTypeLabel(value) {
  const v = normaliseInvestorType(value);
  if (!v) return 'Not set';
  return { individual: 'Individual', business: 'Business',
           trust: 'Trust', group: 'Group' }[v];
}

/* For SQL that has to accept one. Returns the canonical value or null, so a
   caller can write `investor_type = $n` without validating separately. */
function investorTypeOrNull(raw) {
  return normaliseInvestorType(raw);
}

module.exports = {
  INVESTOR_TYPES, normaliseInvestorType, investorTypeLabel, investorTypeOrNull,
};
