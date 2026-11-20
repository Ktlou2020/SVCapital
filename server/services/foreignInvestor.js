'use strict';
/* The foreign investor funds process, in one place.
 *
 * Source: "Foreign Investor Funds Process", SV Capital internal process,
 * effective 17 November 2026. Every rule in it is a rule about money leaving
 * or entering the country, so each one is written here once and read by the
 * signup, the portal, the console and the ledger rather than being retyped
 * into each of them. A banking detail or a BOP code that is right in three
 * places and stale in the fourth is the whole reason this file exists.
 *
 * WHAT THE PROCESS SAYS, and what each part of the platform does with it:
 *
 *  1. No US citizens or US persons. Refused at signup, before an account
 *     exists — see usPersonRefusal(). A declaration is kept for everyone
 *     else, because the point of a declaration is being able to produce it.
 *  2. Rands only. The investor converts on their side and sends ZAR.
 *  3. The investor pays all FX costs, in and out, and carries the rate risk,
 *     because returns are calculated in rands.
 *  4. Every payment's reference is the investor's account number.
 */

const RESIDENT     = 'resident';
const NON_RESIDENT = 'non_resident';

/* South Africa, by the country names the signup form offers. Residency is
   what the Reserve Bank's reporting turns on, NOT nationality: a South
   African living in London is a non-resident, and a Kenyan living in
   Johannesburg is not. The form asks both and this reads the right one. */
const SA_NAMES = ['south africa', 'south african', 'za', 'rsa'];

function countryIsSA(country) {
  return SA_NAMES.includes(String(country || '').trim().toLowerCase());
}

/* The one answer to "is this a foreign investor?".
 *
 * residency_status is the field staff set and can override. Where it has not
 * been set — every investor who signed up before this existed — country of
 * residence decides, and a blank country reads as resident, because the
 * platform was South-African-only and guessing the other way would put
 * existing clients into a process built for non-residents. */
function isNonResident(investor) {
  if (!investor) return false;
  const status = String(investor.residency_status || '').trim().toLowerCase();
  if (status === NON_RESIDENT) return true;
  if (status === RESIDENT)     return false;
  const country = investor.country_of_residence;
  if (!country) return false;
  return !countryIsSA(country);
}

/* ── The US person question ──────────────────────────────────────────── */

/* The wording the declaration is made against. It is stored with the
   declaration rather than only displayed, because a declaration is evidence
   and evidence has to say what was agreed to — the same reason the FICA
   consent carries its own version. */
const US_PERSON_VERSION = '1.0';
const US_PERSON_QUESTION =
  'Are you a US citizen (including a dual citizen) or a US person for tax '
  + 'purposes — a US resident, a green-card holder, or acting for a '
  + 'US-registered entity?';
const US_PERSON_DECLINE =
  'We are not able to accept investments from US citizens or US persons, '
  + 'including dual citizens, US residents, green-card holders and '
  + 'US-registered entities. Nothing has been saved and no account has been '
  + 'created.';

/* true  → they are a US person, and must be refused
   false → they have declared they are not
   null  → they have not answered, which is not the same as "no" */
function usPersonAnswer(value) {
  if (value === true  || value === 'true'  || value === 'yes') return true;
  if (value === false || value === 'false' || value === 'no')  return false;
  return null;
}

/* ── Where the money comes in ────────────────────────────────────────── */

/* South Africa has no IBAN. A foreign bank asking for one has to be given
   the account number and the SWIFT code instead, and the branch code where
   it asks for a sort code — so the panel says so rather than leaving a
   client to work out why a field cannot be filled. */
const INWARD_BANK = {
  bank:          'First National Bank (FNB)',
  accountName:   'SmartVest Financial Services',
  accountNumber: '63058190794',
  branchCode:    '250655',
  swift:         'FIRNZAJJ',
  noIban:        'South Africa does not use IBAN. Give your bank the account '
               + 'number and the SWIFT code, and the branch code if it asks '
               + 'for a sort code.',
};

/* The four rules a foreign investor has to be told BEFORE they pay, because
   each one is a way the payment goes wrong if they do not know it. */
const INWARD_RULES = [
  'Send rands (ZAR) only. Convert on your side — we cannot accept foreign '
  + 'currency, crypto or stablecoins.',
  'You pay all foreign exchange costs, both in and out. Returns are '
  + 'calculated in rands, so the exchange rate risk is yours.',
  'Pay from your own account or card. We cannot accept a payment from '
  + 'anybody else, and a third-party payment has to be sent back.',
  'Use your account number as the payment reference, every time.',
];

/* ── Balance of Payments ─────────────────────────────────────────────── */

/* The BOP category is how the Reserve Bank is told what a cross-border
   payment WAS. Coding an investment as a loan, a gift or "other" is not a
   filing error to tidy up later — it is a different transaction on the
   record, so the inflow category is fixed here and the console offers it
   rather than a free text box. */
const BOP_INFLOW = {
  code:  null,
  label: 'Investment by a non-resident individual',
};
const BOP_OUTFLOW = {
  code:  '510/02',
  label: 'Disinvestment by a non-resident individual – other',
};
const BOP_INFLOW_FORBIDDEN = ['loan', 'gift', 'other'];

function bopLabel(c) {
  return c && c.code ? `${c.code} – ${c.label}` : (c ? c.label : '');
}

/* ── What has to be on file for each inflow ──────────────────────────── */

const FILING_ITEMS = [
  { key: 'payment_confirmation', label: 'Payment confirmation or card record',
    hint: 'The SWIFT confirmation from the investor\'s bank, or the card transaction record.' },
  { key: 'inward_bop_record',    label: 'FNB inward BOP record',
    hint: 'The bank\'s record of how the inflow was reported.' },
  { key: 'signed_agreement',     label: 'Signed investment agreement',
    hint: 'The agreement for the investment this payment funds.' },
  { key: 'fica_documents',       label: 'FICA documents',
    hint: 'Passport, proof of address and source of funds.' },
];
const FILING_KEYS = FILING_ITEMS.map(i => i.key);

/* ── Paying them back ────────────────────────────────────────────────── */

const PAYOUT_COST_NOTE =
  'All conversion costs and bank charges are deducted from the payout.';

module.exports = {
  RESIDENT, NON_RESIDENT, countryIsSA, isNonResident,
  US_PERSON_VERSION, US_PERSON_QUESTION, US_PERSON_DECLINE, usPersonAnswer,
  INWARD_BANK, INWARD_RULES,
  BOP_INFLOW, BOP_OUTFLOW, BOP_INFLOW_FORBIDDEN, bopLabel,
  FILING_ITEMS, FILING_KEYS, PAYOUT_COST_NOTE,
};
