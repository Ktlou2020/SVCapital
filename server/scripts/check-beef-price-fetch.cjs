#!/usr/bin/env node
/* The weekly beef price, fetched from the RPO market report.
 *
 * The whole danger in this file is one sentence: the source page is the
 * weekly CATTLE AND SHEEP report, both animals are quoted in rands per
 * kilogram, and in South Africa their Class A bands overlap — beef around
 * R65–75, lamb around R70–100. A price range cannot tell them apart. Only
 * the label can, and only if it is read inside a beef section.
 *
 * So the checks below are mostly one check asked many ways: can a lamb price
 * reach a board pack labelled as beef? Everything else — the band, the date,
 * the duplicate guard — exists to make the answer no even when the page is
 * restructured under us.
 *
 * The extractor is exercised against saved HTML rather than the live site, so
 * these run anywhere and keep working when rpo.co.za changes or is down.
 *
 * Run: node server/scripts/check-beef-price-fetch.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SVC   = read('server/services/beefPriceFetch.js');
const SVCC  = strip(SVC);
const CRON  = strip(read('server/jobs/beefPriceCron.js'));
const ROUTE = strip(read('server/routes/directorReport.js'));
const INDEX = strip(read('server/index.js'));
const DIR   = read('team/js/director.js');
const SETUP = read('server/db/setup.js');

const fetcher = require(path.join(ROOT, 'server', 'services', 'beefPriceFetch.js'));
const FIXTURE = read('server/scripts/fixtures/rpo-week.html');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* A page shaped like the real one: a title naming both animals, a beef table,
   then a sheep table whose Class A is higher. */
const page = (body, week = '26 September 2026') =>
  `<html><head><title>Weeklikse bees- en skaap-markverslag</title></head><body>
   <h1>Weeklikse bees- en skaap-markverslag</h1><p>Week eindigend ${week}</p>${body}</body></html>`;
const BEEF = `<h2>Beesvleis</h2><table>
   <tr><td>Klas A</td><td>R 72,50/kg</td></tr>
   <tr><td>Klas C</td><td>R 61,20/kg</td></tr>
   <tr><td>Speenkalwers</td><td>R 36,80/kg</td></tr></table>`;
const SHEEP = `<h2>Skaapvleis</h2><table>
   <tr><td>Klas A</td><td>R 98,40/kg</td></tr>
   <tr><td>Klas C</td><td>R 84,10/kg</td></tr></table>`;

const classA = r => (r.prices || []).find(p => p.category === 'class_a');
const cat    = (r, k) => (r.prices || []).find(p => p.category === k) || {};
/* Guarded everywhere: a mutation that makes extraction return nothing must
   make this check FAIL, not throw before it reaches its own tally. */
const valOf  = (r, k) => cat(r, k).value;

console.log('\na lamb price must never become a beef price');
{
  const r = fetcher.extract(page(BEEF + SHEEP));
  ok('the beef table is read', r.ok && classA(r) && classA(r).value === 72.5,
     r.ok ? `class_a came back ${classA(r) && classA(r).value}` : `refused: ${r.detail}`);
  ok('and the sheep table below it is not',
     r.ok && !(r.prices || []).some(p => p.value === 98.4),
     'the sheep Class A is R98,40 and must not appear');
  ok('all three beef categories come through',
     r.ok && ['class_a', 'class_c', 'weaner'].every(k => (r.prices || []).some(p => p.category === k)));

  const flipped = fetcher.extract(page(SHEEP + BEEF));
  ok('and it still works when the sheep table is listed FIRST',
     flipped.ok && classA(flipped) && classA(flipped).value === 72.5,
     flipped.ok ? `got ${classA(flipped) && classA(flipped).value}` : `refused: ${flipped.detail}`);
  ok('with no lamb price in it',
     flipped.ok && !(flipped.prices || []).some(p => p.value === 98.4));

  /* The page title names both animals before any price. A boundary drawn at
     the first sheep word would cut the section to nothing; one drawn by
     skipping the first N characters leaves the sheep table inside it. */
  ok('the section boundary is anchored to the data, not to a character count',
     /every beef word is a CANDIDATE start/.test(SVC) && !/index > 60/.test(SVCC),
     'the title mentions both animals before any price');

  /* \bskaap\b does not match "Skaapvleis" — the v is a word character. That
     one missing match is what let the whole sheep table through. */
  ok('the anchors match Afrikaans compounds',
     /\/\\bskaap\/i/.test(SVC) && /\/\\bbees\/i/.test(SVC)
     && !/\\bskaap\\b/.test(SVCC),
     'a trailing \\b fails against Beesvleis and Skaapvleis');
}

console.log('\nwhen it is not sure, it stores nothing');
{
  const noBeef = fetcher.extract(page(SHEEP));
  ok('a page with no beef section is refused',
     !noBeef.ok && noBeef.reason === 'no_match', JSON.stringify(noBeef.reason));

  const perHead = fetcher.extract(page(`<h2>Beesvleis</h2><p>Klas A R 19500,00/kg</p>`));
  ok('a price per head is refused rather than filed per kilogram',
     !perHead.ok && perHead.reason === 'rejected',
     'R19 500 would be multiplied by 475 kilograms');

  const old = fetcher.extract(page(BEEF, '12 Januarie 2024'));
  ok('an archived or cached week is refused',
     !old.ok && /not a recent week/.test(old.detail || ''));

  const undated = fetcher.extract(`<html><body><h2>Beesvleis</h2><p>Klas A R 72,50/kg</p></body></html>`);
  ok('prices with no week are refused rather than filed under today',
     !undated.ok && /no date/.test(undated.detail || ''));

  const prose = fetcher.extract(page('<h2>Beesvleis</h2><p>The market was firm this week.</p>'));
  ok('a restructured page with no labelled prices is refused',
     !prose.ok, JSON.stringify(prose.reason));

  const dupe = fetcher.extract(page(BEEF + '<table><tr><td>Klas A</td><td>R 70,10/kg</td></tr></table>'));
  ok('two prices for one category refuse the WHOLE run',
     !dupe.ok && dupe.reason === 'rejected'
     && /Found a beef section but its boundary is wrong/.test(dupe.detail || ''),
     'the span itself must be refused, not salvaged further down');
  ok('and that is reported as distrust, not as a missing page',
     !dupe.ok && dupe.reason === 'rejected',
     '"the page moved" and "I did not trust it" need different answers');

  ok('and every refusal says what it saw, so it can be diagnosed',
     Array.isArray(dupe.candidates) && dupe.candidates.length > 0);
  ok('and that evidence is written to the log, not just returned',
     /candidates \? JSON\.stringify\(candidates\) : null/.test(SVCC),
     'a refusal nobody can diagnose is a refusal that never gets fixed');
}

console.log('\nreading the numbers the way the page writes them');
{
  const r = fetcher.extract(page(BEEF));
  ok('a comma is a decimal point, so R72,50 is not R7 250',
     valOf(r, 'class_a') === 72.5, `got ${valOf(r, 'class_a')} — R7 250 would also be out of band and vanish`);
  ok('a weaner is marked live and a class is marked carcass',
     cat(r, 'weaner').basis === 'live' && cat(r, 'class_a').basis === 'carcass',
     'the projection multiplies by the dressing percentage only for a carcass price');
  ok('the band is closed at both ends',
     fetcher.MIN_PER_KG > 0 && fetcher.MAX_PER_KG < 1000);
  ok('the saved page the checks run against is in the repository',
     FIXTURE.includes('Skaapvleis') && FIXTURE.includes('Beesvleis'),
     'the live site is not a dependency of this check');
}

console.log('\na run that fails must be visible, not silent');
{
  ok('every attempt is written down',
     /INSERT INTO beef_price_fetches/.test(SVCC));
  ok('including the ones that found nothing',
     /outcome = 'unreachable'/.test(SVCC) && /no_match/.test(SVCC) && /rejected/.test(SVCC));
  ok('and the report shows the last outcome',
     /function _rptFetchLine\(/.test(DIR)
     && (DIR.match(/_rptFetchLine\(/g) || []).length >= 3
     && /Last automatic fetch/.test(DIR),
     'a fetcher that quietly stopped is how a two-month-old price reads as this week’s');
  ok('a failed run is told apart from one that would not trust the page',
     /read the page but would not trust what it found/.test(DIR));
}

console.log('\nwhat the fetch may and may not overwrite');
{
  ok('a price somebody captured by hand is never silently replaced',
     /WHERE beef_market_prices\.captured_by IS NULL/.test(SVCC),
     'a hand entry is a judgement; the fetch fills gaps and its own rows');
  ok('and the report says how many it left alone',
     /left alone because somebody captured them by hand/.test(SVCC));
  ok('a fetched row records that nobody captured it',
     /captured_by\)\s*\n?\s*VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,NULL\)/.test(SVCC));
}

console.log('\nwhen it runs, and who may run it');
{
  ok('weekly, on a named timezone',
     /cron\.schedule\('[\d ]+\* \* 4'/.test(CRON) && /timezone: BUSINESS_TZ/.test(CRON)
     && /Africa\/Johannesburg/.test(CRON),
     'a cron on UTC fires at a different local hour and reads as a different day');
  ok('and it is started with the others', /startBeefPriceCron\(\)/.test(INDEX));
  ok('a director can run it on demand',
     /router\.post\('\/beef-prices\/fetch', requireDirector/.test(ROUTE));
  ok('and that is the only way to run it from outside',
     (ROUTE.match(/runBeefPriceFetch\(/g) || []).length === 1);
  ok('"I would not trust that page" answers 200, not 500',
     /Always 200/.test(read('server/routes/directorReport.js')),
     'refusing to publish is an answer, not a server fault');
  ok('the url is overridable, so the check can point it somewhere safe',
     /process\.env\.RPO_REPORT_URL/.test(SVCC));
  ok('and the request times out rather than hanging the job',
     /AbortController/.test(SVCC) && /TIMEOUT_MS/.test(SVCC));
}

console.log('\nthe log table');
{
  ok('beef_price_fetches exists', /CREATE TABLE IF NOT EXISTS beef_price_fetches/.test(SETUP));
  ok('and keeps what it saw, so a refusal can be diagnosed',
     /candidates  JSONB/.test(SETUP));
  ok('and who asked for the run', /triggered_by TEXT/.test(SETUP));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
