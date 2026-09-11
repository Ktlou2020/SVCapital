#!/usr/bin/env node
/* The tax-year picker on the Investment Income Certificate.
 *
 * It was three hard-coded <option> tags, newest 2025. A South African tax
 * year runs 1 March to the last day of February and is named for the year it
 * ENDS in, so by September 2026 the newest year a client could ask for had
 * ended nineteen months earlier and was simply not on the list — and it would
 * have fallen another year behind every March.
 *
 * Derived from the date now, so the thing this file really guards is the
 * boundary: 28 February and 1 March, where getting it wrong either hides a
 * year that has ended or offers one that has not.
 *
 * Run: node server/scripts/check-tax-year-options.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CORE  = read('js/portal-core.js');
const ADMIN = read('admin/js/admin.js');
const WEB   = read('portal/index.html');
const MOB   = read('mobile/src/index.html');

/* The shipped functions, lifted and run. */
function lift() {
  const names = ['svcTaxYearOf', 'svcLatestCompleteTaxYear', 'svcTaxYears', 'svcTaxYearEndLabel'];
  let src = '';
  for (const n of names) {
    const m = CORE.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}`, 'm'));
    if (!m) throw new Error(`could not lift ${n} from js/portal-core.js`);
    src += m[0] + '\n';
  }
  const ctx = { Date, isNaN, Number, String };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.api = { ' + names.join(', ') + ' };', ctx);
  return ctx.api;
}
const A = lift();

console.log('\nit knows where a tax year ends');
{
  ok('1 March 2025 is in the year ending February 2026',
     A.svcTaxYearOf(new Date('2025-03-01')) === 2026);
  ok('28 February 2026 is still that year',
     A.svcTaxYearOf(new Date('2026-02-28')) === 2026);
  ok('1 March 2026 has moved on to the next',
     A.svcTaxYearOf(new Date('2026-03-01')) === 2027);
  ok('and January belongs to the year ending that February',
     A.svcTaxYearOf(new Date('2026-01-15')) === 2026);
}

console.log('\nit offers the years that have ended, and not the one running');
{
  ok('in September 2026 the newest offered is 2026',
     A.svcLatestCompleteTaxYear(new Date('2026-09-11')) === 2026,
     'this is the year the request was about');
  ok('on 28 February 2026 it is still 2025',
     A.svcLatestCompleteTaxYear(new Date('2026-02-28')) === 2025,
     'the 2026 year has not ended until that day is over');
  ok('on 1 March 2026 it becomes 2026',
     A.svcLatestCompleteTaxYear(new Date('2026-03-01')) === 2026,
     'the boundary the hard-coded list could never cross on its own');
  ok('in January 2027 it is still 2026',
     A.svcLatestCompleteTaxYear(new Date('2027-01-20')) === 2026);
}

console.log('\nthe list it builds is right for the client looking at it');
{
  const now = new Date('2026-09-11');
  const list = A.svcTaxYears(now, null);
  ok('the newest is first', list[0].value === 2026, JSON.stringify(list[0]));
  ok('and reads as the span it covers',
     list[0].label === 'March 2025 – February 2026', list[0].label);
  ok('the years run downwards without gaps',
     list.every((y, i) => i === 0 || y.value === list[i - 1].value - 1),
     JSON.stringify(list.map(y => y.value)));
  ok('the year still running is not offered',
     !list.some(y => y.value === 2027), JSON.stringify(list.map(y => y.value)));

  /* Somebody who joined last year should not be offered five certificates
     that are all empty. */
  /* June 2025 falls in the year ending February 2026, and that is the only
     one of their years that has ended. */
  const recent = A.svcTaxYears(now, '2025-06-01');
  ok('a client who joined in June 2025 is offered exactly one year',
     recent.length === 1 && recent[0].value === 2026,
     JSON.stringify(recent.map(y => y.value)));
  ok('a client who joined in January 2024 gets three',
     A.svcTaxYears(now, '2024-01-10').map(y => y.value).join() === '2026,2025,2024',
     JSON.stringify(A.svcTaxYears(now, '2024-01-10').map(y => y.value)));
  /* Capped: eight entries is clutter, and SARS asks for five years of
     records. Staff can generate any year from the console. */
  ok('and a client since 2019 gets a capped list, not eight years',
     A.svcTaxYears(now, '2019-01-01').length === 6,
     JSON.stringify(A.svcTaxYears(now, '2019-01-01').map(y => y.value)));
  ok('never before 2019, which the server will not build',
     A.svcTaxYears(now, '2005-01-01').every(y => y.value >= 2019),
     JSON.stringify(A.svcTaxYears(now, '2005-01-01').map(y => y.value)));
  /* This used to assert the opposite — that a future join date still filled
     the list. That WAS the bug: a client who has not lived through a full tax
     year was handed certificates for years before they existed. */
  ok('a join date after the last completed year empties the list',
     A.svcTaxYears(now, '2030-01-01').length === 0,
     JSON.stringify(A.svcTaxYears(now, '2030-01-01')));
}

console.log('\na client with no completed tax year is offered none');
{
  const now = new Date('2026-09-11');   // latest complete year: 2026

  /* April 2026 falls in the year ending February 2027, which has not ended.
     This returned SIX certificates — every year from 2021 — because the test
     for "joined after the last completed year" fell through to the branch
     meant for "we do not know when they joined". */
  ok('a client who joined in April 2026 gets nothing',
     A.svcTaxYears(now, '2026-04-15').length === 0,
     JSON.stringify(A.svcTaxYears(now, '2026-04-15').map(y => y.value)));
  ok('nor one who joined on 1 March 2026, the first day of that year',
     A.svcTaxYears(now, '2026-03-01').length === 0,
     JSON.stringify(A.svcTaxYears(now, '2026-03-01').map(y => y.value)));
  ok('but one who joined on 27 February 2026 gets that year',
     A.svcTaxYears(now, '2026-02-27').map(y => y.value).join() === '2026',
     JSON.stringify(A.svcTaxYears(now, '2026-02-27').map(y => y.value)));
  ok('and one who joined on the last day of it does too',
     A.svcTaxYears(now, '2026-02-28').map(y => y.value).join() === '2026',
     JSON.stringify(A.svcTaxYears(now, '2026-02-28').map(y => y.value)));

  /* An unknown join date still gets the fallback span — the two cases were
     conflated, and separating them must not have silenced the other one. */
  ok('an unknown join date still gets the full span',
     A.svcTaxYears(now, null).length === 6,
     JSON.stringify(A.svcTaxYears(now, null).map(y => y.value)));
  ok('and so does an unparseable one',
     A.svcTaxYears(now, 'not a date').length === 6,
     JSON.stringify(A.svcTaxYears(now, 'not a date').map(y => y.value)));

  ok('the date they are told to wait for is the end of February',
     A.svcTaxYearEndLabel(2027) === '28 February 2027', A.svcTaxYearEndLabel(2027));
  ok('and it knows February has 29 days in a leap year',
     A.svcTaxYearEndLabel(2028) === '29 February 2028', A.svcTaxYearEndLabel(2028));
}

console.log('\nthe screen and the endpoint both refuse it');
{
  const CORE_SRC = CORE;
  ok('the picker is emptied and disabled rather than left blank',
     /if \(!years\.length\) \{[\s\S]{0,400}sel\.disabled = true;[\s\S]{0,200}btns\.forEach\(b => \{ b\.disabled = true; \}\);/.test(CORE_SRC),
     'an empty picker beside a live button invites a press');
  ok('and the client is told when theirs will be ready',
     /Your first certificate will be available after/.test(CORE_SRC));
  ok('the generator refuses to build one without a year',
     /if \(!Number\.isFinite\(taxYear\)\) \{/.test(CORE_SRC),
     'a disabled button is a UI state, not a guard');

  const SVC = read('server/services/incomeReference.js');
  ok('the endpoint refuses a tax year that has not ended',
     /if \(taxYear > latest\) \{/.test(SVC),
     'the endpoint is reachable without the portal');
  ok('and says which year is the most recent one available',
     /most recent certificate available is for the year ending February/.test(SVC));
  ok('its rule for a completed year matches the portal\u2019s',
     /return d\.getMonth\(\) >= 2 \? d\.getFullYear\(\) : d\.getFullYear\(\) - 1;/.test(SVC),
     'two definitions of the same boundary drift');
}

console.log('\nnothing is hard-coded any more');
{
  for (const [label, html] of [['the web portal', WEB], ['the mobile shell', MOB]]) {
    ok(`${label} no longer ships a fixed year list`,
       !/<option value="2025">March 2024/.test(html),
       'the list goes stale again the moment a tax year turns over');
    ok(`${label} still has the picker to fill`, /id="taxYearSelect"/.test(html));
  }
  ok('the statement view fills it on open',
     /function initStatementView\(\)[\s\S]{0,600}svcFillTaxYearSelect\(/.test(CORE),
     'the picker would sit on its placeholder');
  ok('and a year the client already picked survives a refill',
     /if \(keep && years\.some\(y => String\(y\.value\) === String\(keep\)\)\) sel\.value = keep;/.test(CORE));

  ok('the console offers completed years too',
     /const latest = n\.getMonth\(\) >= 2 \? n\.getFullYear\(\) : n\.getFullYear\(\) - 1;/.test(ADMIN),
     'it listed the current calendar year, which in Jan and Feb has not ended');
  ok('and labels them as the span, not as a pair of numbers',
     /March \$\{y-1\} &ndash; February \$\{y\}/.test(ADMIN),
     '"2025 / 2026" does not say which months it covers');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
