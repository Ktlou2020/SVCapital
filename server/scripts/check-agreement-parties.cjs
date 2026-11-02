#!/usr/bin/env node
/* Who the agreement says it is between.
 *
 * The document named the provider as "SmartVest Financial Services (Pty) Ltd
 * t/a SV Capital". That is not the relationship. SV Capital is its own
 * company managing the fund under SmartVest's licence, not a trading name
 * SmartVest operates under, and a contract that misdescribes the counterparty
 * is the one document where that cannot be waved through — it is the name a
 * client would have to sue, and the name their bank statement shows when they
 * pay the wallet.
 *
 * So the parties table names both, in their own roles: SmartVest Financial
 * Services (Pty) Ltd as the provider carrying FSP 52449, SV Capital as the
 * fund manager.
 *
 * The other thing this holds is the version. Wording that changed and a
 * version that did not is how a signed agreement stops being explicable: the
 * stored number is what a complaint is answered from years later, and it has
 * to point at the words that were actually on the page. TEMPLATES says "Never
 * edit a version in place", and this is what makes that more than a comment.
 *
 * No database — the renderer is pure.
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const A    = require(path.join(ROOT, 'server', 'services', 'agreements.js'));
const SRC  = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agreements.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const PRODUCTS = ['cattle', 'eif_murabaha', 'eif_ijara', 'eif_mudarabah'];

const draw = product_type => A.renderAgreement({
  agreement_no: 'AGR-000123',
  investor_id: 'INV-001', investor_name: 'A Client', investor_email: 'a@example.com',
  product_type, pool_id: 'POOL-001', pool_name: 'Test Pool',
  pool_amount_cents: 50000, fee_cents: 500, amount_cents: 50500,
  term_months: 6, rate_label: '14.83%',
  start_date: '2026-10-01', maturity_date: '2027-04-01',
  drawn_at: '2026-09-30T09:00:00Z',
});

console.log('\nthe provider is the licensed entity, under its own name');
{
  for (const p of PRODUCTS) {
    const html = draw(p);
    ok(`${p}: no "t/a SV Capital" anywhere in the document`,
       !/t\/a\s+SV Capital/i.test(html),
       'SV Capital is not a trading name of SmartVest');
    ok(`${p}: the Provider row is the SmartVest entity alone`,
       /<th>Provider<\/th><td>SmartVest Financial Services \(Pty\) Ltd<\/td>/.test(html));
    ok(`${p}: and FSP 52449 sits against it`, /<th>FSP number<\/th><td>52449<\/td>/.test(html));
  }
  ok('the source carries no "t/a SV Capital" for a future document to pick up',
     !/t\/a SV Capital/.test(SRC));
}

console.log('\nand SV Capital is named as what it actually is');
{
  for (const p of PRODUCTS) {
    const html = draw(p);
    ok(`${p}: a Fund manager row naming SV Capital`,
       /<th>Fund manager<\/th><td>SV Capital<\/td>/.test(html));
    ok(`${p}: the footer names both, in their roles`,
       /SmartVest Financial Services \(Pty\) Ltd · authorised financial services provider, FSP 52449 · SV Capital, fund manager/.test(html));
  }
  const html = draw('cattle');
  ok('and the general terms say which one holds the money',
     /places the Investment Amount with SmartVest Financial Services \(Pty\) Ltd, an authorised financial services provider/.test(html)
     && /SV Capital is the fund manager of the Pool/.test(html));
  ok('the risk clause says neither of them guarantees it',
     /not guaranteed by SmartVest Financial\s+Services, by SV Capital or by any third party/.test(html),
     'naming only one of the two leaves the other looking like a guarantor');
}

console.log('\nand the Investor is the account when the money is not the signer\u2019s own');
{
  const facts = {
    product_type: 'standard', agreement_no: 'AGR-T-1',
    investor_id: 'INV-9', investor_name: 'Nomsa Dlamini',
    investor_email: 'nomsa@example.test',
    pool_name: 'Cattle November', pool_amount_cents: 100000,
    fee_cents: 1000, amount_cents: 101000, drawn_at: new Date('2026-03-01'),
  };
  const personal = A.renderAgreement(facts);
  const group = A.renderAgreement({ ...facts, account: {
    id: 'SA-7', name: 'Vukuzenzele Stokvel', type: 'stokvel',
    reg_number: 'NAS-12345',
    authority: 'Mandate of the signatories \u2014 authority SWR-ABC, 2 approval(s) required',
  } });

  ok('an individual\u2019s agreement still names the individual',
     /<th>Investor<\/th><td>Nomsa Dlamini<\/td>/.test(personal), 'the common case must not move');
  ok('and carries no capacity paragraph', !/class="capacity"/.test(personal));

  ok('a stokvel\u2019s agreement names the STOKVEL as the Investor',
     /<th>Investor<\/th><td>Vukuzenzele Stokvel<\/td>/.test(group),
     'a contract that misdescribes the counterparty is the one document where that '
     + 'cannot be waved through \u2014 it cuts both ways');
  ok('the member appears as the person signing for it, not as the investor',
     /Signed for the account by<\/th><td>Nomsa Dlamini</.test(group)
     && !/<th>Investor<\/th><td>Nomsa Dlamini<\/td>/.test(group), 'both halves have to hold');
  ok('the account type is stated in words a client would recognise',
     /Stokvel \(community savings group\)/.test(group));
  ok('and its registration number where there is one', /NAS-12345/.test(group));
  ok('the mandate that authorised it is on the document',
     /authority SWR-ABC/.test(group),
     'the document and the mandate have to be readable against each other years later');
  ok('the signer is said not to be personally liable',
     /not in their personal capacity/.test(group) && /not personally\s+liable/.test(group),
     'a member who taps Invest for a fifteen-person group is not the borrower');
  ok('and the group is said to need more than one member to commit it',
     /no single member may commit the group/.test(group));

  /* A trust and a minor's account had exactly the same defect. */
  const trust = A.renderAgreement({ ...facts, account: {
    id: 'SA-8', name: 'Dlamini Family Trust', type: 'trust', reg_number: 'IT1234/2020' } });
  ok('a trust is the investor on its own agreement, not its trustee',
     /<th>Investor<\/th><td>Dlamini Family Trust<\/td>/.test(trust) && /Trust/.test(trust));
  ok('and a stokvel-only mandate line is not put on it',
     !/no single member may commit/.test(trust),
     'a trust is bound by its deed, not by a stokvel mandate');
}

console.log('\nthe version moved with the wording');
{
  /* Pinned deliberately. When the wording changes again this check FAILS, and
     the fix is to bump the template and then this line — which is the moment
     somebody is forced to ask whether the version was bumped. */
  /* Bumped when the parties table learned to name an ACCOUNT as the
     Investor. That is wording on the one section that says who the contract
     is with, so every template moved — the pin is here so the next change
     to it has to be deliberate too. */
  const EXPECTED = { standard: 'v4', eif_murabaha: 'v5', eif_ijara: 'v5', eif_mudarabah: 'v5' };
  for (const [key, want] of Object.entries(EXPECTED)) {
    ok(`${key} is at ${want}`, A.TEMPLATES[key] && A.TEMPLATES[key].version === want,
       `found ${A.TEMPLATES[key] && A.TEMPLATES[key].version}`);
  }
  ok('every template still declares a version',
     Object.values(A.TEMPLATES).every(t => /^v\d+$/.test(String(t.version || ''))));
  ok('and the rule against editing one in place is still written down',
     /Never edit a version in place/.test(SRC));
}

console.log('\nthe fee is still described as charged on top');
{
  /* Touching this file is the easiest way to reintroduce the inclusive-fee
     wording the platform spent a release removing. */
  for (const p of PRODUCTS) {
    const acks = A.acknowledgementsFor(p).map(a => a.text).join(' ');
    ok(`${p}: the investor ticks that the fee is charged on top`,
       /charged on top of the amount I am investing/.test(acks));
    ok(`${p}: and is never asked to tick that it comes out of it`,
       !/taken from the amount I am investing/.test(acks));
  }
  ok('no live template uses the superseded inclusive acknowledgement',
     !Object.values(A.TEMPLATES).some(t => (t.acks || []).includes('fee_inclusive')),
     'fee_inclusive is kept only to explain agreements already signed under it');

  /* Where a template carries a fee clause it must say IN ADDITION. Ijara and
     Mudarabah carry none — the fee reaches those documents through the fee
     table and the figures, which every agreement renders. */
  for (const [key, t] of Object.entries(A.TEMPLATES)) {
    const feeClause = (t.clauses || []).find(([h]) => /platform fee/i.test(h));
    if (!feeClause) continue;
    ok(`${key}: its fee clause says IN ADDITION`,
       /charged IN ADDITION to the Investment Amount/.test(feeClause[1]));
  }

  /* R500 into a R500-minimum pool: R500 reaches the pool, R5,00 is the fee,
     R505,00 leaves the wallet. Rendered in en-ZA, so the decimal is a comma. */
  for (const p of PRODUCTS) {
    const html = draw(p);
    ok(`${p}: the figures on the page are 500 / 5 / 505`,
       /<th>Amount invested<\/th><td>R500,00<\/td>/.test(html)
       && /<th>Platform fee \(1%\)<\/th><td>R5,00<\/td>/.test(html)
       && /<th>Total from wallet<\/th><td>R505,00<\/td>/.test(html),
       'the fee must never be shown as coming out of the 500');
    ok(`${p}: and the fee table lists the platform fee`,
       /Platform fee/.test(html.slice(html.indexOf('<table class="fees">'))));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
