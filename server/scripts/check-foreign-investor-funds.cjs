#!/usr/bin/env node
/* The Foreign Investor Funds Process, as the platform runs it.
 *
 * Source: SV Capital internal process, effective 17 November 2026. Four
 * hard rules — no US persons, rands only, the investor pays all FX costs,
 * and the reference is always their account number — plus a banking detail,
 * two BOP categories and a four-item file per inflow.
 *
 * EVERY ONE OF THOSE IS A FACT THAT NOW LIVES IN MORE THAN ONE PLACE. The
 * server holds it in services/foreignInvestor.js; the portal has to draw it
 * without being able to require() that file, and the console has to offer
 * the same filing items the server will accept. A bank account number that
 * is right in two of three places is money sent somewhere else, and a filing
 * key that is right in the console and wrong on the server is a tick
 * recorded against nothing. So the copies are held to the original here
 * rather than the duplication being wished away.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-foreign-investor-funds.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments stripped before any assertion: the comment above each copy
   explains what it must agree with and therefore quotes the very value
   being looked for. Three times this week. */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const F = require(path.join(ROOT, 'server', 'services', 'foreignInvestor.js'));

/* Is <div id="inner"> nested inside <div id="outer">?
 *
 * A proximity regex cannot answer this — "within 6000 characters of" is
 * true of a block that sits well after the one it is being compared to,
 * which is how the first version of this passed while asserting nothing.
 * So the div depth is actually counted. */
function insideBlock(html, outerId, innerId) {
  const open = html.indexOf(`id="${outerId}"`);
  const inner = html.indexOf(`id="${innerId}"`);
  if (open < 0 || inner < 0) return false;
  const start = html.lastIndexOf('<div', open);
  let depth = 0, end = html.length;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  return inner > start && inner < end;
}



/* ── Who the process applies to ──────────────────────────────────────── */
console.log('\nresidency decides, not nationality');
{
  ok('a South African living in London is a NON-RESIDENT',
     F.isNonResident({ nationality: 'South African', country_of_residence: 'United Kingdom' }),
     'nationality is not what the Reserve Bank\'s reporting turns on');
  ok('and a Kenyan living here is NOT',
     !F.isNonResident({ nationality: 'Kenyan', country_of_residence: 'South Africa' }),
     'the opposite mistake, and the more expensive one — it would put a local '
     + 'client through a cross-border process');
  ok('the status staff set beats the country',
     F.isNonResident({ residency_status: 'non_resident', country_of_residence: 'South Africa' })
     && !F.isNonResident({ residency_status: 'resident', country_of_residence: 'Germany' }),
     'an override that the data overrules back is not an override');
  ok('and an investor with neither reads as resident',
     !F.isNonResident({}) && !F.isNonResident({ country_of_residence: '' }),
     'every client who signed up before this existed has neither, and the '
     + 'platform was South-African-only — guessing the other way would show '
     + 'them all a panel about sending money from abroad');
}

/* ── The US person question ──────────────────────────────────────────── */
console.log('\nand the US person answer has three states, not two');
{
  ok('yes is yes', F.usPersonAnswer(true) === true && F.usPersonAnswer('yes') === true);
  ok('no is no',  F.usPersonAnswer(false) === false && F.usPersonAnswer('no') === false);
  ok('AND NO ANSWER IS NOT A NO',
     F.usPersonAnswer(undefined) === null && F.usPersonAnswer('') === null,
     'the declaration IS the control — an account opened without one has '
     + 'nothing behind it, so a missing answer must not read as a negative one');
}

/* ── The copies ──────────────────────────────────────────────────────── */
console.log('\nand the portal draws the SERVER\'S banking details, not its own');
{
  const CORE = strip(read('js/portal-core.js'));
  const at   = CORE.indexOf('function _svcForeignFunding');
  const blk  = at < 0 ? '' : CORE.slice(at, CORE.indexOf('\n}', at));
  ok('the portal\'s copy was found', at > 0 && blk.length > 200,
     'a slice that missed it would assert nothing while passing');
  ok('and the slice is code, not its comment',
     !/check-foreign-investor-funds asserts/.test(blk), blk.slice(0, 120));

  for (const [field, value] of Object.entries(F.INWARD_BANK)) {
    if (field === 'noIban') continue;
    ok(`${field} agrees with the server (${value})`,
       blk.includes(`'${value}'`),
       `${value} is not in the portal's copy — a bank account number that is `
       + 'right in one of two places is money sent somewhere else');
  }
  /* The four rules are what a client is told BEFORE they pay, and each one
     is a way the payment goes wrong if they are not. */
  for (const rule of F.INWARD_RULES) {
    const head = rule.slice(0, 34);
    ok(`the portal carries the rule "${head}…"`, blk.includes(head), head);
  }
  ok('and says South Africa has no IBAN',
     /does not use IBAN/.test(blk),
     'a foreign bank asks for one and a client cannot fill it; saying so is '
     + 'the difference between a stuck payment and a sent one');

  /* And it is shown to the right people. */
  ok('THE PANEL IS FOR NON-RESIDENTS ONLY',
     /function svcIsNonResident/.test(CORE)
     && /svcIsNonResident\(PORTAL\.investor\)/.test(CORE),
     'a South African paying from a South African bank does not need a SWIFT code');
  for (const file of ['portal/index.html', 'mobile/www/index.html'])
    ok(`${file.split('/')[0]} has somewhere to draw it`,
       read(file).includes('id="walletForeignPanel"'), file);
}

console.log('\nand the console offers the filing items the server will accept');
{
  const ADMIN = strip(read('admin/js/admin.js'));
  for (const key of F.FILING_KEYS)
    ok(`the console knows ${key}`, ADMIN.includes(`'${key}'`),
       'the server refuses an item it does not know, so a key that is right '
       + 'in one place and wrong in the other is a tick recorded against nothing');
  ok('and it uses the server\'s outflow code verbatim',
     ADMIN.includes('510/02'), F.bopLabel(F.BOP_OUTFLOW));
  ok('the panel knows who is a non-resident',
     /function _isNonResidentInvestor/.test(ADMIN)
     && /_isNonResidentInvestor\(inv\)/.test(ADMIN));
  /* THE BUG THIS CATCHES, which shipped once. The panel returned nothing
     for a resident, so the only control that could make somebody a
     non-resident was hidden behind their already being one — staff could
     never mark the first one. */
  ok('AND A RESIDENT STILL GETS THE CONTROL THAT MARKS THEM',
     /Mark as non-resident/.test(ADMIN),
     'hidden from residents, the control can only be used on people who do '
     + 'not need it');
  ok('the panel does not bail out for a resident',
     !/_isNonResidentInvestor\(inv\)\) return '';/.test(ADMIN),
     'an early return here is exactly how the control disappeared');
  ok('and the control opens the editor',
     /Mark as non-resident[\s\S]{0,40}?<\/button>/.test(ADMIN)
     || /editForeignFunds\([\s\S]{0,220}?Mark as non-resident/.test(ADMIN),
     'a button that opens nothing is a label');
  ok('and only money in and out can carry a BOP category',
     /\['deposit', 'withdrawal'\]\.includes\(t\.type\)/.test(ADMIN),
     'an internal transfer or a fee never crosses a border and has no '
     + 'category to carry');
}

/* ── The BOP categories ──────────────────────────────────────────────── */
console.log('\nand a cross-border investment is never a loan, a gift or other');
{
  ok('the inflow category is the one the process names',
     F.BOP_INFLOW.label === 'Investment by a non-resident individual', F.BOP_INFLOW.label);
  ok('AND THE PAYOUT IS 510/02',
     F.BOP_OUTFLOW.code === '510/02'
     && /Disinvestment by a non-resident individual/.test(F.BOP_OUTFLOW.label),
     F.bopLabel(F.BOP_OUTFLOW));
  ok('the three forbidden codings are written down',
     ['loan', 'gift', 'other'].every(w => F.BOP_INFLOW_FORBIDDEN.includes(w)),
     JSON.stringify(F.BOP_INFLOW_FORBIDDEN));

  /* The endpoint takes a KEY and looks the label up, so a category cannot be
     typed in at all. */
  const ROUTE = strip(read('server/routes/foreignFunds.js'));
  ok('the endpoint maps a key to a label rather than taking one',
     /const ALLOWED = \{/.test(ROUTE) && /if \(!\(key in ALLOWED\)\)/.test(ROUTE),
     'a free text box here is exactly how an investment gets filed as a loan');
  ok('and the investor update is a named whitelist',
     /const fields = \{/.test(ROUTE) && !/Object\.assign\(.*req\.body/.test(ROUTE),
     'spreading req.body into an UPDATE turns this into a way to set a '
     + 'wallet balance');
}

/* ── The ledger carries it ───────────────────────────────────────────── */
console.log('\nand the transaction row remembers how it was reported');
{
  const L = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
  ok('bop_category is a transaction column', L.TX_COLUMNS.includes('bop_category'),
     L.TX_COLUMNS.join(', '));
  ok('and so is payout_currency', L.TX_COLUMNS.includes('payout_currency'));
  ok('so every fixture built from the column list has them too',
     /bop_category/.test(L.transactionsFixtureDDL()) && /payout_currency/.test(L.transactionsFixtureDDL()),
     'a check whose fixture lacks the column would pass while the real insert fails');
}

/* ── The signup gate ─────────────────────────────────────────────────── */
console.log('\nand the signup form asks before it can be submitted');
{
  const SIGNUP = strip(read('signup.html'));
  ok('the declaration is on the form', /name="usPerson"/.test(SIGNUP));
  ok('with both answers', /value="yes"/.test(SIGNUP) && /value="no"/.test(SIGNUP));
  ok('IT IS NOT A TICK BOX',
     !/id="usPersonCheck"/.test(SIGNUP) && /type="radio"/.test(SIGNUP),
     'a box you tick to confirm you are NOT something is read as consent and '
     + 'clicked through');
  ok('an unanswered question is refused',
     /us === null/.test(SIGNUP) && /Please answer the US citizen/.test(SIGNUP),
     'a missing declaration is not a negative one');
  ok('and a yes stops the signup there',
     /us === true/.test(SIGNUP) && /showUsPersonBlock\(\)/.test(SIGNUP), 'signup.html');
  ok('country of residence is sent as a field, not buried in a note',
     /countryOfResidence:/.test(SIGNUP), 'signup.html');
}

/* ── The declaration ─────────────────────────────────────────────────── */
console.log('\nand the declaration says what the process requires a signature for');
{
  const text = F.NON_RESIDENT_DECLARATION_CLAUSES.join(' ').toLowerCase();
  ok('THE US CLAUSE IS FIRST, because it is the one that can refuse somebody',
     /us citizen/.test(F.NON_RESIDENT_DECLARATION_CLAUSES[0].toLowerCase()),
     F.NON_RESIDENT_DECLARATION_CLAUSES[0]);
  for (const [what, re] of [
    ['green card',          /green card/],
    ['rands only',          /rands \(zar\) only/],
    ['the FX costs are theirs', /all foreign exchange costs/],
    ['the rate risk is theirs', /exchange rate risk is mine/],
    ['their own account',   /own bank account or card/],
    ['the reference',       /account number as the reference/],
    ['and telling us if it changes', /stops being true/],
  ]) ok(`it covers ${what}`, re.test(text), what);

  ok('it is versioned', !!F.NON_RESIDENT_DECLARATION_VERSION,
     'a declaration matched against wording nobody can produce is not evidence');
  ok('and an unsigned non-resident owes one',
     F.needsDeclaration({ residency_status: 'non_resident' }, []), 'true expected');
  ok('a resident never does',
     !F.needsDeclaration({ residency_status: 'resident' }, []), 'false expected');
  ok('a current signature settles it',
     !F.needsDeclaration({ residency_status: 'non_resident' },
       [{ document_type: F.NON_RESIDENT_DECLARATION_TYPE,
          document_version: F.NON_RESIDENT_DECLARATION_VERSION }]));
  ok('AND AN OLD ONE DOES NOT',
     F.needsDeclaration({ residency_status: 'non_resident' },
       [{ document_type: F.NON_RESIDENT_DECLARATION_TYPE, document_version: '0.9' }]),
     'the version is the whole reason the wording can change');

  /* It has to reach them. */
  const CORE = strip(read('js/portal-core.js'));
  ok('the portal asks for it at boot',
     /async function svcCheckNonResidentDeclaration/.test(CORE)
     && /foreign-funds\/my-declaration/.test(CORE), 'js/portal-core.js');
  ok('THE WORDING COMES FROM THE SERVER, not from the portal',
     !CORE.includes(F.NON_RESIDENT_DECLARATION_CLAUSES[0]),
     'a client must not be shown one version while another is recorded '
     + 'against their name');
  for (const f of ['portal/js/portal.js', 'mobile/src/js/portal.js'])
    ok(`${f.split('/')[0]} calls it on sign-in`,
       /svcCheckNonResidentDeclaration\(\)/.test(read(f)), f);
}

/* ── FICA ────────────────────────────────────────────────────────────── */
console.log('\nand a non-resident is never checked by the automated FICA');
{
  ok('the rule says so', !F.automatedFicaAllowed({ residency_status: 'non_resident' })
     && F.automatedFicaAllowed({ residency_status: 'resident' }));
  ok('and says why, in terms somebody can act on',
     /Home Affairs/.test(F.MANUAL_FICA_REASON) && /manually/.test(F.MANUAL_FICA_REASON),
     F.MANUAL_FICA_REASON);

  /* The refusal is in the RUNNER's path, not only in the queries that feed
     it: the sweep, the console button and the investment hook all arrive
     through runFicaCheck, and a predicate repeated in their SELECTs is
     several places to forget it.

     IT MOVED, and this asserts the behaviour rather than the line. The
     decision now belongs to services/ficaPolicy.js, which runFicaCheck
     asks before it does anything — the same rule now also carries the
     R2 000 threshold and the twelve-month window, so a non-resident and a
     R500 investment are one decision instead of two shapes of it. What
     must stay true is that the answer is 'manual' and that no provider is
     reached first. */
  const POLICY = require(path.join(ROOT, 'server', 'services', 'ficaPolicy.js'));
  ok('the policy refuses a non-resident, whatever is asking',
     POLICY.scope({ residency_status: 'non_resident' }).scope === 'manual'
     && POLICY.scope({ residency_status: 'non_resident' },
                     { investedAmount: 1000000 }).scope === 'manual',
     'an amount cannot buy past it: Home Affairs still does not hold their '
     + 'ID number: ' + JSON.stringify(POLICY.scope({ residency_status: 'non_resident' })));
  ok('and a staff member running one by hand cannot override that either',
     POLICY.scope({ residency_status: 'non_resident' }, { force: true }).scope === 'manual',
     'the check would record a failure that means nothing, on a client '
     + 'whose documents are in order');
  const SVC = strip(read('server/services/ficaService.js'));
  const at  = SVC.indexOf('async function runFicaCheck');
  const head = SVC.slice(at, at + 1800);
  ok('runFicaCheck asks before it does any work',
     /ficaPolicy/.test(head) && /policy\.scope\(investor/.test(head)
     && head.indexOf('policy.scope') < head.indexOf('datanamix'),
     'every caller arrives through this function, so the decision is taken '
     + 'here and before any provider is reached');
  ok('and the refusal is recorded rather than silent',
     /fica_auto_status = 'manual'/.test(head), head.slice(0, 200));
  ok('AND IT DOES NOT STAMP last_auto_fica_check',
     !/last_auto_fica_check\s*=/.test(head),
     'stamping it would read as a check that ran and passed, and would push '
     + 'the next one out by a year');

  /* And the batches do not waste their slots on people it will refuse. */
  const CRON = strip(read('server/jobs/ficaCron.js'));
  const excl = (CRON.match(/residency_status, 'resident'\) <> 'non_resident'/g) || []).length;
  /* COUNTED AGAINST THE BATCHES THAT FEED THE RUNNER, not against every
     query in the file and not against a number typed here. There were two
     such batches; the sanctions backfill makes three.

     runFicaExpiryAlerts also selects from investors and correctly has NO
     exclusion — it emails clients whose approval is ageing out to resubmit
     their documents, and a non-resident needs that reminder like anybody
     else. Counting every "FROM investors" would demand the exclusion there
     and be wrong. Each batch is identified by the limit it takes. */
  const feeders = ['[BATCH_LIMIT]', '[remainingSlots, POLICY.AUTO_MIN_INVESTMENT]',
                   '[BACKFILL_LIMIT]'];
  const missing = feeders.filter(tag => {
    const at = CRON.indexOf(tag);
    if (at < 0) return true;
    const stmt = CRON.slice(Math.max(0, at - 900), at);
    return !/residency_status, 'resident'\) <> 'non_resident'/.test(stmt);
  });
  ok('every batch that feeds the runner excludes them',
     missing.length === 0 && excl >= feeders.length,
     `${excl} exclusions; missing from: ${missing.join(', ') || 'none'} — a `
     + 'batch without it spends its limited slots on clients the runner '
     + 'will refuse');
}

/* ── The terms ───────────────────────────────────────────────────────── */
console.log('\nand the terms of use say all of it');
{
  const TERMS = read('terms.html');
  ok('there is a non-resident clause', /id="s27"/.test(TERMS) && /Non-resident/.test(TERMS));
  ok('and it is in the contents', /href="#s27"/.test(TERMS),
     'a clause nobody can navigate to is a clause nobody reads');
  for (const [what, re] of [
    ['US persons',        /do not accept investments from US citizens or US persons/],
    ['residence not nationality', /where the Client <strong>resides<\/strong>, not by their nationality/],
    ['rands only',        /South African rands \(ZAR\) only/],
    ['the FX costs',      /all foreign exchange costs/],
    ['the rate risk',     /exchange rate risk is the Client/],
    ['own name only',     /in the Client&rsquo;s own\s*name/],
    ['the reference',     /account number as its reference/],
    ['exchange control',  /South African\s+Reserve Bank/],
    ['manual verification', /verified <strong>manually/],
  ]) ok(`the terms cover ${what}`, re.test(TERMS), what);
  ok('and the page says it changed',
     /Last updated: November 2026/.test(TERMS),
     'a terms page that does not say it moved is not an updated one');

  /* The version recorded against a client has to be the wording they read. */
  const AUTH = strip(read('server/routes/auth.js'));
  ok('A NEW REGISTRATION RECORDS 1.1',
     /type: 'terms_of_service', flag: termsAccepted, version: '1\.1'/.test(AUTH),
     'recording 1.0 while showing the 1.1 text makes the consent record wrong');
}

/* ── Getting in at all ───────────────────────────────────────────────── */
console.log('\nand there is ONE form, with residency and the document asked separately');
{
  const SIGNUP = strip(read('signup.html'));
  const RAW    = read('signup.html');

  /* THE SPLIT THIS REPLACED. A tab said "South African / SA Resident" or
     "International Client" and switched the identity document, the address
     block and the residency recorded against the account, all at once —
     so a South African living in London was filed as a resident because
     they hold an SA ID, with no declaration and no BOP coding, and a
     foreign national living here was pointed at an ID field they may not
     have. */
  ok('THE CITIZENSHIP TABS ARE GONE',
     !/id="btnCitizenSA"/.test(RAW) && !/id="btnCitizenIntl"/.test(RAW),
     'one control cannot answer two different questions without being wrong '
     + 'at the edges');
  ok('and nothing still calls the old toggle',
     !/toggleCitizenship/.test(SIGNUP), 'signup.html');

  ok('COUNTRY OF RESIDENCE IS ASKED OF EVERYBODY',
     /id="countryResidence"/.test(RAW)
     && !insideBlock(RAW, 'passportGroup', 'countryResidence'),
     'inside the passport block it was only asked of people who said they '
     + 'were international, and assumed for everybody else');
  ok('and the identity document is its own question',
     /id="btnDocSaId"/.test(RAW) && /id="btnDocPassport"/.test(RAW), 'signup.html');
  ok('which decides the fields and nothing else',
     /function setIdDocument/.test(SIGNUP)
     && /saIdGroup/.test(SIGNUP) && /passportGroup/.test(SIGNUP), 'signup.html');
  ok('while the country decides residency and the address block',
     /function onCountryChange/.test(SIGNUP)
     && /saProvinceGroup/.test(SIGNUP) && /intlRegionGroup/.test(SIGNUP), 'signup.html');

  /* The bug the merge exists to fix. */
  const sub = SIGNUP.slice(SIGNUP.indexOf('const country    = v(\'countryResidence\')'),
                           SIGNUP.indexOf('usPerson:'));
  ok('the submitted country is ANSWERED, NEVER ASSUMED',
     !/countryOfResidence: isSA \? 'South Africa'/.test(SIGNUP)
     && /countryOfResidence: country/.test(SIGNUP),
     'it was hardcoded to South Africa on the SA tab, which is how a South '
     + 'African abroad was recorded as a resident');
  ok('and the ID comes from the DOCUMENT, not from the country',
     /hasSaId \? v\('idNumber'\) : v\('passportNumber'\)/.test(SIGNUP),
     'an expat holds a 13-digit ID and lives abroad — those are not the '
     + 'same answer');
  ok('and the address block comes from the COUNTRY, not from the document',
     /livesInSA \? v\('province'\)/.test(SIGNUP), 'signup.html');

  ok('THE US QUESTION IS ASKED OF EVERYBODY',
     /usPerson:\s+usPersonValue\(\)/.test(SIGNUP)
     && !/usPerson:\s+isSA \? undefined/.test(SIGNUP),
     'the rule has no residency qualifier, and asking only non-residents '
     + 'left a US citizen living in Cape Town never asked at all');
  ok('and it is outside the passport block, so it is on screen either way',
     !insideBlock(RAW, 'passportGroup', 'usPersonGroup'),
     'inside it, the question only exists for people who chose a passport');

  /* And the waitlist it replaced is gone cleanly — markup, handler and the
     listener that would throw at boot without it. */
  ok('the waitlist panel is gone', !/intlWaitlistPanel/.test(RAW));
  ok('and nothing is left binding to it',
     !/btnWaitlistSubmit/.test(SIGNUP) && !/submitIntlWaitlist/.test(SIGNUP),
     'a listener that binds to a removed element throws at boot and takes '
     + 'the rest of the page\'s JavaScript with it');
}

console.log('\nand the form offers every country, from one list');
{
  const COUNTRIES = require(path.join(ROOT, 'server', 'services', 'countries.js'));
  const RAW = read('signup.html');

  const optionsOf = id => {
    const at = RAW.indexOf(`id="${id}"`);
    if (at < 0) return [];
    const end = RAW.indexOf('</select>', at);
    return [...RAW.slice(at, end).matchAll(/<option[^>]*>([^<]+)<\/option>/g)]
      .map(m => m[1].replace(/&amp;/g, '&').trim())
      .filter(t => !/^Select /.test(t));
  };

  const residence   = optionsOf('countryResidence');
  const nationality = optionsOf('nationality');

  ok('the list is the whole world, not a shortlist',
     COUNTRIES.NAMES.length > 240, String(COUNTRIES.NAMES.length));
  ok('COUNTRY OF RESIDENCE OFFERS ALL OF IT',
     residence.length === COUNTRIES.NAMES.length,
     `${residence.length} of ${COUNTRIES.NAMES.length} — it offered about thirty, `
     + 'grouped by region, so most of the world could not say where they live');
  ok('AND SO DOES NATIONALITY',
     nationality.length === COUNTRIES.NAMES.length,
     `${nationality.length} of ${COUNTRIES.NAMES.length} — a client who can pick `
     + 'their country of residence and not their nationality cannot finish the form');
  ok('and both are the same list, not two that happen to agree today',
     residence.join('|') === nationality.join('|'), 'they differ');

  /* Countries somebody actually lives in that the old shortlist left out. */
  for (const c of ['Angola', 'Malawi', 'Mauritius', 'Ireland', 'Japan', 'Brazil'])
    ok(`${c} can be chosen`, residence.includes(c), c);

  ok('SOUTH AFRICA IS THE DEFAULT',
     /<option selected>South Africa<\/option>/.test(RAW),
     'the list opens on "Select country", so the commonest answer is a '
     + 'scroll through two hundred and fifty options');
  ok('and only one option is preselected',
     (RAW.match(/<option selected>/g) || []).length === 1,
     String((RAW.match(/<option selected>/g) || []).length));
  ok('the page settles from it at boot',
     /onCountryChange\(\);\n  _initSignupAddressSearch/.test(RAW),
     'otherwise the address block and the banner show whatever the markup '
     + 'happened to carry, not what the default country means');

  /* A non-resident is visible without opening anything, and findable. */
  ok('THE CLIENT HEADER CARRIES A NON-RESIDENT TAG',
     /NON-RESIDENT\$\{inv\.country_of_residence/.test(read('admin/js/admin.js')),
     'everything that follows from it — manual FICA, BOP coding, the '
     + 'declaration — was invisible until somebody scrolled to a panel');
  ok('and the clients list shows it on the row',
     /Non-resident<\/span><\/div>` : ''\}/.test(read('admin/js/admin.js')),
     'a tag you can only see after opening the client is not a tag');
  ok('AND IT CAN BE FILTERED ON',
     /id="investorResidencyFilter"/.test(read('admin/index.html')),
     'admin/index.html');
  ok('the filter reads residency the same way everything else does',
     /matchRs[\s\S]{0,160}_isNonResidentInvestor\(inv\)/.test(strip(read('admin/js/admin.js'))),
     'filtering on the column alone misses every client who registered '
     + 'before the column existed');
  ok('and the choice is remembered with the other filters',
     /\{ q, st, ky, ty, pv, lo, rs, so \}/.test(read('admin/js/admin.js')),
     'a filter that resets on every visit is one nobody uses twice');

  /* The console offers the same list, and does not carry its own. */
  const ADMIN2 = strip(read('admin/js/admin.js'));
  ok('THE CONSOLE ASKS THE SERVER FOR THE COUNTRIES',
     /foreign-funds\/reference/.test(ADMIN2) && /_foreignCountries/.test(ADMIN2),
     'a console offering countries the form does not, or missing ones it '
     + 'does, is two answers to where somebody lives');
  ok('and does not keep a list of its own',
     !/'Zimbabwe'[\s\S]{0,200}'Namibia'/.test(ADMIN2)
     && (ADMIN2.match(/'United Kingdom'/g) || []).length < 3,
     'a second copy is the thing this is avoiding');
  ok('the country of residence is a dropdown, not a text box',
     /countryField\('ff-country'/.test(ADMIN2),
     'it was a free text field, so "UK", "U.K." and "United Kingdom" were '
     + 'three different countries to anything reading the column');
  ok('and so is the bank country',
     /countryField\('ff-bank-country'/.test(ADMIN2), 'admin/js/admin.js');
  ok('with a text box kept for when the list cannot be fetched',
     /if \(!countries\) return field\(/.test(ADMIN2),
     'an empty dropdown is worse than typing it by hand');
  ok('and the endpoint really serves it',
     /countries:\s+COUNTRIES\.NAMES/.test(strip(read('server/routes/foreignFunds.js'))),
     'server/routes/foreignFunds.js');

  /* THE DRIFT THIS IS REALLY FOR. The FICA mapper used to be a hand-kept
     mirror of the old thirty, so a nationality added to the form and not to
     the map throws on a client whose documents are fine. */
  const fica = require(path.join(ROOT, 'server', 'services', 'ficaService.js'));
  const unmappable = nationality.filter(n => {
    try { return !fica.nationalityToCode(n); } catch (_) { return true; }
  });
  ok('EVERY NATIONALITY THE FORM OFFERS CAN BE VERIFIED',
     unmappable.length === 0,
     `${unmappable.length} cannot be mapped to a country code: `
     + unmappable.slice(0, 5).join(', '));

  /* And the records written before the field became a country still work. */
  for (const old of ['Zimbabwean', 'South African', 'British'])
    ok(`a stored "${old}" still resolves`, (() => {
      try { return !!fica.nationalityToCode(old); } catch (_) { return false; }
    })(), old);
}

console.log('\nand the FICA consent is one an international client can truthfully tick');
{
  const CONSENT = require(path.join(ROOT, 'server', 'services', 'ficaConsent.js'));
  for (const f of ['signup.html', 'mobile/www/signup.html']) {
    const t = read(f);
    ok(`${f.split('/')[0]}: IT NO LONGER CLAIMS SOUTH AFRICAN CITIZENSHIP`,
       !/I confirm that I am a South African citizen or permanent resident/.test(t),
       'opening international registration made that a false declaration a '
       + 'foreign client has to tick to proceed, which is worse than none');
    ok(`${f.split('/')[0]}: and still consents to the checks`,
       /carrying out the FICA checks required/.test(t), f);
  }
  ok('and the version moved with the wording',
     CONSENT.VERSION !== '2.0' && CONSENT.VERSION !== '1.0', CONSENT.VERSION
     + ' — a changed sentence under an unchanged version makes the register '
     + 'read as though everyone agreed to the same thing');
}

console.log('\nand the same passport cannot open two accounts');
{
  const AUTH = strip(read('server/routes/auth.js'));
  const at  = AUTH.indexOf('if (idNumber) {');
  const blk = AUTH.slice(at, AUTH.indexOf('const hash = await bcrypt', at));
  ok('the duplicate check was found', at > 0 && blk.length > 80);
  ok('IT NO LONGER COMPARES DIGITS ALONE',
     /UPPER\(REPLACE/.test(blk),
     'it stripped every non-digit, so "A12345678" was looked up as "12345678" '
     + 'while the row stored the raw value — a passport could never match an '
     + 'existing one');
  ok('and the message names a passport too',
     /ID or passport number already exists/.test(blk), blk.slice(-200));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.foreign_inflow_files') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  schema not applied in this database'); return; }

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/auth',          require(path.join(ROOT, 'server', 'routes', 'auth.js')));
    app.use('/api/foreign-funds', require(path.join(ROOT, 'server', 'routes', 'foreignFunds.js')));
    srv = await new Promise(x => { const s = app.listen(0, () => x(s)); });

    const call = (method, p, body, token) => new Promise(res => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ port: srv.address().port, path: p, method,
        headers: Object.assign(token ? { Authorization: `Bearer ${token}` } : {},
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      if (payload) q.write(payload);
      q.end();
    });
    const staff = jwt.sign({ id: 'u-ff', email: 'ops@example.test', role: 'admin' },
                           process.env.JWT_SECRET, { expiresIn: '1h' });

    const signup = extra => call('POST', '/api/auth/register', Object.assign({
      email: `ff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`,
      password: 'Abcdefgh12', firstName: 'Foreign', lastName: 'Applicant',
      termsAccepted: true, popiaAccepted: true, ficaConsent: true,
    }, extra));

    console.log('\nand the server refuses a US person before an account exists');
    {
      const before = (await db.query(`SELECT COUNT(*)::int AS n FROM investors`)).rows[0].n;
      const res = await signup({ countryOfResidence: 'United States', usPerson: true });
      ok('THE REGISTRATION IS REFUSED', res.status === 403,
         `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      ok('and says why, in the process\'s own terms',
         /US citizens or US persons/.test(res.body.error || ''), res.body.error);
      const after = (await db.query(`SELECT COUNT(*)::int AS n FROM investors`)).rows[0].n;
      ok('AND NOTHING WAS WRITTEN', after === before,
         `${before} → ${after} — declining after the account exists leaves a US `
         + 'person on the platform, which is the thing the rule avoids');
    }

    console.log('\nand a US person living IN South Africa is refused just the same');
    {
      /* The rule has no residency qualifier. While the question was asked
         only of non-residents, this person was never asked at all — they
         picked the South African tab and walked straight through. */
      const before = (await db.query(`SELECT COUNT(*)::int AS n FROM investors`)).rows[0].n;
      const res = await signup({ countryOfResidence: 'South Africa', usPerson: true });
      ok('THE REGISTRATION IS REFUSED', res.status === 403,
         `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`
         + ' — "we strictly do not accept investments from US citizens or US '
         + 'persons" says nothing about where they live');
      const after = (await db.query(`SELECT COUNT(*)::int AS n FROM investors`)).rows[0].n;
      ok('and nothing was written', after === before, `${before} → ${after}`);
    }

    console.log('\nand a South African who lives abroad is a NON-RESIDENT');
    {
      /* The case the merged form exists for. They hold a 13-digit ID and
         would have picked the South African tab, which hardcoded their
         country and skipped the question. */
      const email = `ff-expat-${Date.now()}@example.test`;
      const res = await signup({ email, idNumber: '8001015009087',
                                 nationality: 'South African',
                                 countryOfResidence: 'United Kingdom', usPerson: false });
      ok('the registration succeeds', res.status === 200 || res.status === 201,
         `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      const { rows: [inv] } = await db.query(
        `SELECT i.residency_status, i.country_of_residence, i.us_person, i.nationality
           FROM investors i JOIN users u ON u.investor_id = i.id
          WHERE lower(u.email) = lower($1)`, [email]);
      ok('THEY ARE MARKED A NON-RESIDENT', inv && inv.residency_status === 'non_resident',
         inv && String(inv.residency_status)
         + ' — residency is where they live, not which passport they hold');
      ok('with the country they actually gave',
         inv && inv.country_of_residence === 'United Kingdom',
         inv && String(inv.country_of_residence));
      ok('their nationality is still South African',
         inv && inv.nationality === 'South African', inv && String(inv.nationality));
      ok('and their declaration is on file',
         inv && inv.us_person === false, inv && String(inv.us_person));
    }

    console.log('\nand a non-resident who does not answer is refused too');
    {
      const res = await signup({ countryOfResidence: 'Germany' });
      ok('it is refused', res.status === 400, `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      ok('and asks for the answer', /US citizen/.test(res.body.error || ''), res.body.error);
    }

    console.log('\nand a non-resident who declares is accepted and recorded');
    {
      const email = `ff-ok-${Date.now()}@example.test`;
      const res = await signup({ email, countryOfResidence: 'United Kingdom', usPerson: false });
      ok('the registration succeeds', res.status === 200 || res.status === 201,
         `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      const { rows: [inv] } = await db.query(
        `SELECT i.* FROM investors i JOIN users u ON u.investor_id = i.id
          WHERE lower(u.email) = lower($1)`, [email]);
      ok('the investor exists', !!inv);
      if (inv) {
        ok('country of residence is a COLUMN now', inv.country_of_residence === 'United Kingdom',
           String(inv.country_of_residence) + ' — it used to live only inside a notes string');
        ok('and they are marked non-resident', inv.residency_status === 'non_resident',
           String(inv.residency_status));
        ok('THE DECLARATION IS KEPT, not just acted on',
           inv.us_person === false, String(inv.us_person));
        ok('with when it was made', !!inv.us_person_declared_at, String(inv.us_person_declared_at));
        ok('and the wording it was made against',
           inv.us_person_declaration_version === F.US_PERSON_VERSION,
           String(inv.us_person_declaration_version)
           + ' — a declaration is evidence, and evidence has to say what was agreed to');
      }
    }

    console.log('\nand a South African is asked the same question');
    {
      /* THIS USED TO ASSERT THE OPPOSITE — that a South African was not
         asked and no declaration was recorded. That was the behaviour while
         the question lived inside the international branch, and it is the
         hole the merged form closes: the rule has no residency qualifier. */
      const unanswered = await signup({ countryOfResidence: 'South Africa' });
      ok('A SOUTH AFRICAN WHO DOES NOT ANSWER IS REFUSED', unanswered.status === 400,
         `${unanswered.status} ${JSON.stringify(unanswered.body).slice(0, 140)}`);

      const email = `ff-sa-${Date.now()}@example.test`;
      const res = await signup({ email, countryOfResidence: 'South Africa', usPerson: false });
      ok('and one who answers is accepted',
         res.status === 200 || res.status === 201, `${res.status}`);
      const { rows: [inv] } = await db.query(
        `SELECT residency_status, us_person, country_of_residence FROM investors i
           JOIN users u ON u.investor_id = i.id WHERE lower(u.email) = lower($1)`, [email]);
      ok('they are marked resident', inv && inv.residency_status === 'resident',
         inv && String(inv.residency_status));
      ok('with the country they gave, not one assumed for them',
         inv && inv.country_of_residence === 'South Africa',
         inv && String(inv.country_of_residence));
      ok('AND THEIR DECLARATION IS RECORDED TOO',
         inv && inv.us_person === false, inv && String(inv.us_person)
         + ' — a US citizen living in Cape Town is refused like any other, '
         + 'so the answer has to be kept for everybody who gives one');
    }

    console.log('\nbut a caller too old to ask is not locked out');
    {
      /* The installed app cannot ask the question and cannot update until
         the next release. Requiring the answer from it would stop every
         sign-up from an existing phone — a far bigger hole than the one it
         closes. countryOfResidence is the tell: a build that asks the US
         question always sends one, and no build before it sends either.
         TEMPORARY, and it goes when 5.3 is out. */
      const email = `ff-old-${Date.now()}@example.test`;
      const res = await signup({ email });     // neither field, as an old page sends
      ok('an old client can still register', res.status === 200 || res.status === 201,
         `${res.status} ${JSON.stringify(res.body).slice(0, 140)}`);
      const { rows: [inv] } = await db.query(
        `SELECT us_person FROM investors i JOIN users u ON u.investor_id = i.id
          WHERE lower(u.email) = lower($1)`, [email]);
      ok('and no declaration is invented for them', inv && inv.us_person === null,
         inv && String(inv.us_person)
         + ' — "was never asked" must not be recorded as "declared they are not"');
    }

    console.log('\nand an inflow cannot be coded as something it was not');
    {
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                                residency_status, country_of_residence)
         VALUES ('INV-FF-1','Nadia','Abroad','ff-1@example.test','active',0,
                 'non_resident','United Kingdom')
         ON CONFLICT (id) DO NOTHING`);
      await db.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, actor_kind)
         VALUES ('TXN-FF-1','INV-FF-1','deposit',25000,'completed','FF-REF-1','staff')
         ON CONFLICT (id) DO NOTHING`);

      for (const bad of F.BOP_INFLOW_FORBIDDEN) {
        const res = await call('PATCH', '/api/foreign-funds/transactions/TXN-FF-1/bop',
                               { category: bad }, staff);
        ok(`"${bad}" is refused`, res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
      }
      const good = await call('PATCH', '/api/foreign-funds/transactions/TXN-FF-1/bop',
                              { category: 'inflow' }, staff);
      ok('and the one real category is accepted', good.status === 200, JSON.stringify(good.body));
      const { rows: [t] } = await db.query(
        `SELECT bop_category FROM transactions WHERE id = 'TXN-FF-1'`);
      ok('and stored verbatim', t.bop_category === F.bopLabel(F.BOP_INFLOW), String(t.bop_category));
    }

    console.log('\nand the file for an inflow is recorded, item by item');
    {
      const bad = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                             { items: ['payment_confirmation', 'something_else'] }, staff);
      ok('an item the server does not know is refused', bad.status === 400,
         `${bad.status} ${JSON.stringify(bad.body)}`);

      const part = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                              { items: ['payment_confirmation'] }, staff);
      ok('a partial file is accepted', part.status === 200, JSON.stringify(part.body));
      ok('and reported as incomplete', part.body.complete === false, String(part.body.complete));

      const full = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                              { items: F.FILING_KEYS }, staff);
      ok('ALL FOUR MAKES IT COMPLETE', full.body.complete === true, JSON.stringify(full.body));

      /* Unticking has to be as recordable as ticking, or the checklist only
         ever grows and stops describing anything. */
      const undo = await call('PUT', '/api/foreign-funds/transactions/TXN-FF-1/files',
                              { items: [] }, staff);
      ok('and removing everything is recorded too', undo.status === 200 && undo.body.complete === false,
         JSON.stringify(undo.body));
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM foreign_inflow_files WHERE transaction_id = 'TXN-FF-1'`);
      ok('with nothing left behind', rows[0].n === 0, String(rows[0].n));
    }

    console.log('\nand marking a resident as a non-resident is what starts all of it');
    {
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance,
                                residency_status, country_of_residence)
         VALUES ('INV-FF-2','Sipho','Local','ff-2@example.test','active',0,
                 'resident','South Africa')
         ON CONFLICT (id) DO NOTHING`);
      const client2 = jwt.sign({ id: 'u-2', role: 'investor', investorId: 'INV-FF-2' },
                               process.env.JWT_SECRET, { expiresIn: '1h' });

      const before = await call('GET', '/api/foreign-funds/my-declaration', null, client2);
      ok('a resident owes no declaration', before.body.required === false,
         JSON.stringify(before.body).slice(0, 120));

      const made = await call('PATCH', '/api/foreign-funds/investors/INV-FF-2',
                              { residencyStatus: 'non_resident',
                                countryOfResidence: 'United Kingdom' }, staff);
      ok('STAFF CAN MARK A RESIDENT AS A NON-RESIDENT', made.status === 200,
         `${made.status} ${JSON.stringify(made.body)}`
         + ' — this is the control the whole process hangs off');

      const after = await call('GET', '/api/foreign-funds/my-declaration', null, client2);
      ok('and the declaration becomes due immediately', after.body.required === true,
         JSON.stringify(after.body).slice(0, 120));
      ok('with the server\'s own wording, not the portal\'s',
         Array.isArray(after.body.clauses) && after.body.clauses.length === F.NON_RESIDENT_DECLARATION_CLAUSES.length,
         String(after.body.clauses && after.body.clauses.length));

      /* A POST that does not agree must not be recorded as agreement. */
      const empty = await call('POST', '/api/foreign-funds/my-declaration', {}, client2);
      ok('A POST THAT DOES NOT AGREE IS REFUSED', empty.status === 400,
         `${empty.status} — that is how a consent record ends up describing a `
         + 'click nobody made');

      const signed = await call('POST', '/api/foreign-funds/my-declaration',
                                { agreed: true }, client2);
      ok('agreeing is accepted', signed.status === 200, JSON.stringify(signed.body));

      const settled = await call('GET', '/api/foreign-funds/my-declaration', null, client2);
      ok('and it stops being asked for', settled.body.required === false,
         JSON.stringify(settled.body).slice(0, 120));

      /* A second tab, a refresh — neither may write a second row, or the
         record stops saying when they agreed. */
      await call('POST', '/api/foreign-funds/my-declaration', { agreed: true }, client2);
      const { rows: [n] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM accepted_client_documents
          WHERE investor_id = 'INV-FF-2' AND document_type = $1`,
        [F.NON_RESIDENT_DECLARATION_TYPE]);
      ok('SIGNING TWICE WRITES ONE ROW', n.n === 1, String(n.n));

      const { rows: [row] } = await db.query(
        `SELECT document_version, accepted_at FROM accepted_client_documents
          WHERE investor_id = 'INV-FF-2' AND document_type = $1`,
        [F.NON_RESIDENT_DECLARATION_TYPE]);
      ok('stored with the version it was made against',
         row.document_version === F.NON_RESIDENT_DECLARATION_VERSION,
         String(row.document_version));
      ok('and when', !!row.accepted_at, String(row.accepted_at));

      /* And it lands in the table the console already reads, rather than a
         second home for the same kind of record. */
      const state = await call('GET', '/api/foreign-funds/investors/INV-FF-2/declaration',
                               null, staff);
      ok('the console can see it is signed', state.body.signed === true,
         JSON.stringify(state.body).slice(0, 140));
    }

    console.log('\nand a resident cannot sign a declaration that is not theirs to make');
    {
      await db.query(
        `UPDATE investors SET residency_status = 'resident' WHERE id = 'INV-FF-2'`);
      const client2 = jwt.sign({ id: 'u-2', role: 'investor', investorId: 'INV-FF-2' },
                               process.env.JWT_SECRET, { expiresIn: '1h' });
      const res = await call('POST', '/api/foreign-funds/my-declaration',
                             { agreed: true }, client2);
      ok('it is refused', res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);
    }

    console.log('\nand a client cannot reach any of it');
    {
      const tok = jwt.sign({ id: 'u-c', role: 'investor', investorId: 'INV-FF-1' },
                           process.env.JWT_SECRET, { expiresIn: '1h' });
      const res = await call('PATCH', '/api/foreign-funds/investors/INV-FF-1',
                             { residencyStatus: 'resident' }, tok);
      ok('the role is refused', res.status === 403 || res.status === 401, String(res.status));
    }

    await db.query(`DELETE FROM transactions WHERE id = 'TXN-FF-1'`);
    await db.query(`DELETE FROM investors WHERE id IN ('INV-FF-1','INV-FF-2')`);
    await db.query(`DELETE FROM users WHERE email LIKE 'ff-%@example.test'`);
    await db.query(`DELETE FROM investors WHERE email LIKE 'ff-%@example.test'`);
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
