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

console.log('\nthe version moved with the wording');
{
  /* Pinned deliberately. When the wording changes again this check FAILS, and
     the fix is to bump the template and then this line — which is the moment
     somebody is forced to ask whether the version was bumped. */
  const EXPECTED = { standard: 'v3', eif_murabaha: 'v4', eif_ijara: 'v4', eif_mudarabah: 'v4' };
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
