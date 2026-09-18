#!/usr/bin/env node
/* Own a beef animal, end to end.
 *
 * Unlike every other product here, this one has no target return: the client
 * owns one tagged animal and gets what it fetched. That makes three things
 * load-bearing that are decorative elsewhere.
 *
 *   The tag. One animal, one owner. Two certificates naming the same tag are
 *   both true documents saying incompatible things, and nothing downstream
 *   can tell which one to honour.
 *
 *   The date. "Within seven working days of the sale" is a promise about a
 *   day, so it is computed — weekends and South African public holidays
 *   included. An animal sold on 10 December does not pay out on the 21st.
 *
 *   The arithmetic. The purchase price and the feed are paid BEFORE the
 *   animal is placed. Deducting them again from the sale charges the client
 *   twice for the same animal, and it would look like a small rounding
 *   difference rather than the double charge it is.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-ownership.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Rendered text wraps across source lines and en-ZA groups thousands with a
   non-breaking space, so a phrase is matched against the document flattened
   to single ordinary spaces. Where the words are is formatting; that they are
   there is the assertion. */
const flat = s => String(s).replace(/[\s\u00a0]+/g, ' ');

const CO = require(path.join(ROOT, 'server', 'services', 'cattleOwnership.js'));
const { PLATFORM_FEE_PCT } = require(path.join(ROOT, 'server', 'services', 'poolFees.js'));

const INTAKE = { purchase_price: 12000, feed_cost: 4800, feed_days: 120, sale_deduction: 1450 };

console.log('\nthe 1% is charged on top, as it is everywhere else');
{
  const p = CO.priceFor(INTAKE);
  ok('the animal and its feed are what they are',
     p.purchase === 12000 && p.feed === 4800 && p.subtotal === 16800, JSON.stringify(p));
  ok('the fee is 1% of that', p.fee === 168, String(p.fee));
  /* CLAUDE.md: the amount a client enters is what reaches the pool, and the
     wallet pays that amount plus the fee. Here the price is what reaches the
     animal, and the wallet pays the price plus the fee. */
  ok('and the wallet pays the price PLUS the fee, not the price WITH the fee in it',
     p.total === 16968 && p.total > p.subtotal, String(p.total));
  ok('so the full price reaches the animal',
     p.total - p.fee === p.subtotal, `${p.total} - ${p.fee} ≠ ${p.subtotal}`);
  ok('the rate is the platform rate, not a second copy of it',
     Math.round(p.subtotal * PLATFORM_FEE_PCT * 100) / 100 === p.fee);

  /* Rand and cents, never a float tail: an invoice reading R168.00000000001
     is an invoice somebody queries. */
  const odd = CO.priceFor({ purchase_price: 10333.33, feed_cost: 4166.67 });
  ok('and it rounds to cents', odd.fee === 145 && odd.total === 14645,
     JSON.stringify(odd));
}

console.log('\nseven working days is seven working days');
{
  const due = d => CO.payoutDueFor(d).toISOString().slice(0, 10);

  /* Sold on a Monday in a clear week: seven working days is the Wednesday
     of the week after next, not seven calendar days. */
  ok('a clear week counts weekdays only', due('2026-11-02') === '2026-11-11', due('2026-11-02'));
  ok('the day of sale is not one of the seven',
     due('2026-11-02') !== '2026-11-10', 'counting starts the day after');

  /* 16 December is the Day of Reconciliation. An animal sold on the 10th
     pays on the 22nd, not the 21st. */
  ok('a public holiday does not count', due('2026-12-10') === '2026-12-22', due('2026-12-10'));

  /* Good Friday and Family Day move with Easter, and they sit in the middle
     of the autumn selling season. */
  ok('Easter moves with the year', CO.easterSunday(2026).toISOString().slice(0, 10) === '2026-04-05');
  ok('and Good Friday and Family Day are counted out',
     due('2026-04-01') === '2026-04-14', due('2026-04-01'));

  /* The Public Holidays Act: a holiday on a Sunday makes the Monday one. */
  const hol2027 = CO.publicHolidays(2027);
  ok('a Sunday holiday takes the Monday with it',
     hol2027.has('2027-12-26') && hol2027.has('2027-12-27'),
     '26 December 2027 is a Sunday');

  ok('weekends are never working days',
     !CO.isWorkingDay(new Date('2026-09-19T00:00:00Z')) &&
     !CO.isWorkingDay(new Date('2026-09-20T00:00:00Z')));
  ok('a due date never lands on a weekend or a holiday',
     [...Array(60).keys()].every(i => {
       const start = new Date(Date.UTC(2026, 11, 1)); start.setUTCDate(start.getUTCDate() + i);
       return CO.isWorkingDay(CO.payoutDueFor(start));
     }), 'a client would be told a date the bank is shut');

  /* A DATE column arrives as a Date object, and String(…).slice(0,10) on one
     produces "Mon Sep 21", which Date.parse rejects. That took the purchase
     down before it was caught. */
  ok('a Date object works as well as a string',
     due(new Date(Date.UTC(2026, 11, 10))) === '2026-12-22');
  ok('and rubbish is refused rather than guessed',
     CO.isoDate('Mon Sep 21 2026') === null && CO.isoDate(null) === null &&
     CO.payoutDueFor('not a date') === null);
}

console.log('\nwhat the sale returns, and what it does not deduct twice');
{
  const p = CO.proceedsFor({ sale_value: 21500, sale_deduction: 1450 });
  ok('proceeds are the sale less the cost of getting it to market',
     p.proceeds === 20050, JSON.stringify(p));
  /* The one that would look like rounding. */
  ok('the purchase price is NOT taken off again',
     p.proceeds !== 21500 - 1450 - INTAKE.purchase_price,
     'the client already paid for the animal before it was placed');
  ok('nor is the feed',
     p.proceeds !== 21500 - 1450 - INTAKE.feed_cost);

  /* Everything was paid up front precisely so that a bad sale cannot become a
     bill. A negative payout is not a smaller payment, it is a demand. */
  const bad = CO.proceedsFor({ sale_value: 900, sale_deduction: 1450 });
  ok('a sale that does not cover the costs pays nothing, not less than nothing',
     bad.proceeds === 0, JSON.stringify(bad));
}

console.log('\nthe documents say what was true when they were issued');
{
  const price = CO.priceFor(INTAKE);
  const bag = {
    invoice_no: 'INV-2026-000142', certificate_no: 'COW-2026-000142',
    investor_name: 'Thandiwe Mokoena', investor_id: 'SVC-0WKHOT',
    investor_email: 'thandiwe@example.co.za', tag_number: 'ZA 042 8817',
    intake_name: 'Feedlot Intake — September 2026', feedlot: 'Beefcor',
    feed_days: 120, placed_at: '2026-09-21', expected_sale_date: '2027-01-19',
    issued_at: '2026-09-18', price,
  };
  const inv  = CO.renderInvoice(bag);
  const cert = CO.renderCertificate(bag);

  const invFlat = flat(inv), certFlat = flat(cert);
  ok('the invoice itemises rather than showing one total',
     invFlat.includes('R 12 000,00') && invFlat.includes('R 4 800,00') &&
     invFlat.includes('R 168,00') && invFlat.includes('R 16 968,00'),
     'a single figure explains nothing');
  ok('and names the fee as a fee', /Platform fee \(1%\)/.test(invFlat));
  ok('insurance is shown as included, not left out',
     /Mortality cover[\s\S]{0,120}Included/.test(invFlat),
     'a client who cannot see the cover does not know they have it');
  ok('and it says nothing further is payable', /Nothing further is payable/.test(invFlat));

  ok('the certificate leads with the tag', cert.includes('ZA 042 8817'));
  ok('it names the owner', cert.includes('Thandiwe Mokoena'));
  /* The honest difference between this and every other product here. */
  ok('it says there is no target return',
     /There is no target return and none is implied/.test(certFlat),
     'the client is owed the truth that nobody is promising a number');
  ok('and that the animal can return less than was paid',
     /may return less than was paid/.test(certFlat));
  ok('it states the seven working days', /within seven working days of the sale/.test(certFlat));
  ok('it states who carries a shortfall',
     /shortfall is carried by[\s\S]{0,120}not recoverable from the owner/.test(certFlat));
  ok('and what happens if the animal dies',
     /insured[\s\S]{0,200}refunded in full/.test(certFlat));
  ok('it is not sold as a deposit',
     /not a deposit[\s\S]{0,120}not covered by any deposit insurance/.test(certFlat));

  ok('both documents stand alone, with no stylesheet to fetch',
     !/<link[^>]+stylesheet/.test(inv) && !/<link[^>]+stylesheet/.test(cert) &&
     inv.includes('<style>') && cert.includes('<style>'),
     'a document printed next year has to look like the one that was issued');

  /* A name is client-supplied and reaches both documents. */
  const hostile = CO.renderCertificate({
    ...bag, investor_name: '<script>alert(1)</script>', tag_number: '"><img src=x onerror=alert(1)>' });
  ok('a name cannot carry markup into the certificate',
     !hostile.includes('<script>alert') && !hostile.includes('<img src=x'),
     'the document is served as HTML to the client and to staff');
  ok('and it is escaped, not stripped',
     hostile.includes('&lt;script&gt;'), 'silently dropping it hides a tampered row');
}

console.log('\nthe things the database has to guarantee');
{
  const setup = read('server/db/setup.js');
  ok('one animal has at most one owner',
     /CREATE UNIQUE INDEX IF NOT EXISTS cattle_ownerships_animal_uniq[\s\S]{0,120}WHERE animal_id IS NOT NULL/.test(setup),
     'two clients could hold certificates for the same tag');
  ok('an invoice number is issued once', /invoice_no\s+TEXT UNIQUE/.test(setup));
  ok('and so is a certificate number', /certificate_no\s+TEXT UNIQUE/.test(setup));
  ok('the documents are stored on the row, not rebuilt on demand',
     /invoice_html\s+TEXT/.test(setup) && /certificate_html\s+TEXT/.test(setup),
     'a certificate rebuilt from today’s data quietly follows a corrected price');
  ok('what was charged is frozen beside what it bought',
     /purchase_price NUMERIC\(18,2\) NOT NULL[\s\S]{0,200}total_paid\s+NUMERIC\(18,2\) NOT NULL/.test(setup),
     'correcting an intake price would rewrite what somebody was charged');
  ok('an owned animal cannot be deleted out from under its owner',
     /investor_id TEXT NOT NULL REFERENCES investors\(id\) ON DELETE RESTRICT/.test(setup) &&
     /intake_id   TEXT NOT NULL REFERENCES cattle_intakes\(id\) ON DELETE RESTRICT/.test(setup));
}

console.log('\nan invoice number is never issued twice');
{
  const route = read('server/routes/cattleOwnership.js');
  const setup = read('server/db/setup.js');
  /* The first version read the highest number back out of the rows. That is a
     high-water mark, not a sequence: delete a row and the next purchase
     reissues a number that has already been on a tax invoice. It was found by
     the ledger refusing the duplicate reference, not by anybody noticing the
     invoice. */
  ok('the number comes from a counter, not from the rows',
     /INSERT INTO document_sequences[\s\S]{0,240}next_value = document_sequences\.next_value \+ 1/.test(route),
     'a deleted or archived row would reissue a used invoice number');
  ok('and nothing reads the maximum back off cattle_ownerships',
     !/ORDER BY \$\{column\} DESC|MAX\(invoice_no\)|MAX\(certificate_no\)/.test(route));
  ok('the counter exists', /CREATE TABLE IF NOT EXISTS document_sequences/.test(setup));
  ok('it is taken inside the purchase transaction, so a rollback gives it back',
     route.indexOf("await client.query('BEGIN')") < route.indexOf("nextNumber(client, 'INV')"),
     'a failed purchase would burn a number');
  ok('and the ledger reference is unique even if a number ever did repeat',
     /`COW-\$\{invoiceNo\}-\$\{id\}`/.test(route) && /`FEE-\$\{invoiceNo\}-\$\{id\}`/.test(route),
     'transactions.reference is uniquely indexed and the insert would fail');
}

console.log('\nthe money moves once, and in the right direction');
{
  const route = read('server/routes/cattleOwnership.js');
  const cron  = read('server/jobs/cattlePayoutCron.js');

  ok('the purchase is one transaction',
     /BEGIN[\s\S]{0,6000}INSERT INTO cattle_ownerships[\s\S]{0,2500}COMMIT/.test(route),
     'a client charged for an animal nobody allocated');
  ok('the animal is claimed by the statement that reads it',
     /NOT EXISTS \(SELECT 1 FROM cattle_ownerships o WHERE o\.animal_id = a\.id\)[\s\S]{0,200}FOR UPDATE OF a SKIP LOCKED/.test(route),
     'two tabs would be sold the same tag');
  ok('the fee is written negative, as every fee here must be',
     /'platform_fee',-price\.fee|-price\.fee/.test(route.replace(/\s+/g, '')),
     'it would read as money coming in on a statement');
  ok('FICA is checked before title passes',
     /fica !== 'approved' && fica !== 'verified'[\s\S]{0,200}ROLLBACK|ROLLBACK[\s\S]{0,200}fica_required/.test(route));

  ok('the payout pays only what is due',
     /status = 'sold' AND paid_at IS NULL AND payout_due_at <= /.test(cron),
     'a sale recorded late would pay late; one recorded twice would pay twice');
  ok('and claims each animal with the statement that pays it',
     /UPDATE cattle_ownerships[\s\S]{0,300}WHERE id = \$2 AND status = 'sold' AND paid_at IS NULL[\s\S]{0,120}RETURNING/.test(cron),
     'two instances racing the same morning would credit one wallet twice');
  ok('each animal is its own transaction',
     /for \(const row of due\)[\s\S]{0,300}BEGIN/.test(cron),
     'one bad row would hold up everybody else’s money');
  ok('the certificate is what sets the date, not when somebody got round to it',
     /payout_due_at/.test(route) && /CO\.payoutDueFor\(soldAt\)/.test(route));
}

console.log('\nthe test herd is only ever seeded where it was asked for');
{
  const setup = read('server/db/setup.js');
  const stepSrc = (setup.match(/await step\("18\. Seed cattle for testing[\s\S]*?\n    \}\);/) || [''])[0];
  ok('the seed step exists', stepSrc.length > 0);
  /* The same shape as the agreements switch, for the same reason: a seed that
     decides for itself whether it is in a test environment eventually decides
     wrongly, and the wrong answer is a fake herd in production. */
  ok('it returns unless the variable is the literal "true"',
     /String\(process\.env\.SEED_CATTLE_DEMO \|\| ''\)\.toLowerCase\(\) !== 'true'\) return;/.test(stepSrc),
     'a truthy-looking value would put test cattle in front of real clients');
  ok('and it is the first thing the step does',
     stepSrc.indexOf('SEED_CATTLE_DEMO') < stepSrc.indexOf('INSERT INTO'),
     'a row would be written before the guard was consulted');
  ok('the animals are tagged so they can be told apart and removed',
     /SVC-TEST-/.test(stepSrc), 'test animals indistinguishable from a real herd');
  ok('and it can be run twice without multiplying the herd',
     /ON CONFLICT \(id\) DO NOTHING/.test(stepSrc) &&
     (stepSrc.match(/ON CONFLICT \(id\) DO NOTHING/g) || []).length >= 2,
     'every redeploy would add another twelve animals and reopen the intake');
  ok('nothing else in the repository sets that variable',
     !/SEED_CATTLE_DEMO\s*[:=]\s*['"]true/.test(
       read('server/db/setup.js') + read('server/index.js')),
     'it has to be an environment decision, not a committed one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
