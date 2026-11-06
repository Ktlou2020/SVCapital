#!/usr/bin/env node
/* Datanamix as the FICA provider: what it sends, and what the answers do to a client.
 *
 * Datanamix cannot be reached from where checks run, so fetch is stood in
 * front of it and answers with the documented sandbox personas — the same
 * payloads api-docs.datanamix.com publishes for Arthur Pendragon, the
 * deceased Elaine Astolat, the closed account SB5345, and so on. What is
 * asserted is ours: the request we build, how each answer is read, and what
 * the real runFicaCheck then writes to a client's record.
 *
 * The cases that matter are the ones that would hurt somebody:
 *   - a sandbox setting on production would fail every real client
 *   - an unactivated product (HTTP 404) must not read as "no such person"
 *   - South Africa on the FATF grey list must not flag every SA client
 *   - a possible sanctions match goes to a person, never auto-passes
 *   - Datanamix being down is an error, never a rejection
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-datanamix.cjs
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const ROOT = path.join(__dirname, '..', '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-datanamix-secret';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ─── The stand-in for api.datanamix.com ─────────────────────────────── */
const PERSONAS = {
  '7603219452087': { FirstName: 'Arthur',    LastName: 'Pendragon', Names: 'Arthur',    DateOfBirth: '1976-03-21', DeceasedStatus: 'Alive' },
  '7906124223083': { FirstName: 'Guinevere', LastName: 'Pendragon', Names: 'Guinevere', DateOfBirth: '1979-06-12', DeceasedStatus: 'Alive' },
  '8802142683086': { FirstName: 'Elaine',    LastName: 'Astolat',   Names: 'Elaine',    DateOfBirth: '1988-02-14', DeceasedStatus: 'Deceased' },
  '8304019799087': { FirstName: 'Loki',      LastName: 'Laufeyson', Names: 'Loki',      DateOfBirth: '1983-04-01', DeceasedStatus: 'Alive' },
  '8205199001089': { FirstName: 'Lancelot',  LastName: 'Du Lac',    Names: 'Lancelot',  DateOfBirth: '1982-05-19', DeceasedStatus: 'Alive' },
  '6811017954086': { FirstName: 'Merlin',    LastName: 'Ambrosius', Names: 'Merlin',    DateOfBirth: '1968-11-01', DeceasedStatus: 'Alive' },
  '8604091870080': { FirstName: 'Nimue',     LastName: 'Avalon',    Names: 'Nimue',     DateOfBirth: '1986-04-09', DeceasedStatus: 'Alive' },
};
const DHA_DOWN = '8012257259082';   // answered as "DHA unavailable"

function idvAnswer(idNo) {
  if (idNo === DHA_DOWN) return { Success: false, Messages: ['DHA Unavailable'], ResponseCode: 5 };
  const p = PERSONAS[idNo];
  if (!p) return { Success: false, Messages: ['No record found'], ResponseCode: 4 };
  return {
    Header: { ReportReference: 'DX-SANDBOX', ClientReference: idNo, ReportType: 'CONSUMER' },
    Results: { RealTimeIDVerification: {
      InputIDNO: idNo, IDNO: idNo, IDNOMatchStatus: 'Matched', Gender: 'Male',
      MaritalStatus: 'SINGLE', IdentityDocumentType: 'ID Card', IDBlocked: 'NO',
      Citizenship: 'South African', CountryOfBirth: 'SOUTH AFRICA', ...p,
    } },
    PDFReport: 'should-never-be-stored',
    Success: true, Messages: ['Success'], ResponseCode: 0,
  };
}

const ACCOUNTS = {
  SB1233: { id: '7603219452087', open: true  },   // Arthur, open
  SB5345: { id: '8304019799087', open: false },   // Loki, closed
};
function avsAnswer(b) {
  /* Exact on account AND branch, as the sandbox is: its accounts are
     seeded at branch 250655 and found under no other code. */
  const a = b.BankBranchCode === '250655' ? ACCOUNTS[b.BankAccountNumber] : null;
  if (!a) return { Success: false, Messages: ['No record found'], ResponseCode: 4 };
  const y = v => (v ? 'Yes' : 'No');
  return {
    Header: { ReportReference: 'DX-SANDBOX-BA', ClientReference: b.ClientReference },
    Avs: {
      Status: 'VerifiedNoErrors', accountFound: 'Yes',
      accountOpen: y(a.open), acceptsCredits: y(a.open), acceptsDebits: y(a.open), lengthOpen: 'Yes',
      identityMatch: y(b.IdentityNumber === a.id), accountTypeMatch: 'Yes',
      initialsMatch: 'Yes', nameMatch: 'Yes', emailMatch: 'NotChecked', phoneMatch: 'NotChecked',
    },
    Success: true, ResponseCode: 0,
  };
}

const FATF_ZA = { ConfidenceScore: 1, Name: 'South Africa', EntityType: 'Country',
  DataSource: { Name: 'Financial Action Task Force', ShortName: 'FATF' }, Program: ['GREY-LIST'] };
function sanctionsAnswer(b) {
  const hits = {
    'Arthur Pendragon': [{ ConfidenceScore: 0.97, Name: 'Arthur Pendragon', EntityType: 'Individual',
      DataSource: { Name: 'Politically Exposed Persons', ShortName: 'PEP' }, Program: ['PEP'],
      DateOfBirth: ['1976-03-21'], SiIdentifier: 'PEP-P001', EntityNumber: 4294967297 }],
  }[b.Name] || [];
  const results = [...hits, FATF_ZA];     // a ZA search always carries the country row
  return {
    Header: { ClientReference: b.ClientReference },
    SearchResults: { InputName: b.Name, Found: true, RecordCount: results.length },
    PossibleMatches: { Found: true, HasNextPage: false, Results: results },
    /* Exactly as the published sample: the sanctions product answers 200
       for success, where ID verification and AVS answer 0. */
    Success: true, Messages: ['Items found'], ResponseCode: 200,
  };
}

const calls = [];
let tokenIssued = 0, forceStatus = null;
function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const headers = init.headers || {};
  calls.push({ path: u.pathname, body, auth: headers.Authorization || null });
  const reply = (status, obj) => Promise.resolve({
    status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(obj),
  });
  if (u.pathname === '/v1/oauth/token') {
    tokenIssued++;
    if (body.client_id !== 'member-key' || body.client_secret !== 'api-password') {
      return reply(401, { error: 'access_denied', error_description: null });
    }
    return reply(200, { access_token: `jwt-${tokenIssued}`, token_type: 'Bearer', expires_in: 14399 });
  }
  if (forceStatus) { const s = forceStatus; forceStatus = null; return reply(s.status, s.body); }
  if (u.pathname === '/v1/id-verification/realtime') return reply(200, idvAnswer(body.IdNumber));
  if (u.pathname === '/v1/bank/account-verification') return reply(200, avsAnswer(body));
  if (u.pathname === '/v1/sanctions-standard/SanctionsIndividual') return reply(200, sanctionsAnswer(body));
  return reply(404, { Success: false, Messages: ['unknown route'], ResponseCode: 404 });
}
global.fetch = fakeFetch;

function freshDatanamix() {
  const p = require.resolve(path.join(ROOT, 'server', 'services', 'datanamix.js'));
  delete require.cache[p];
  return require(p);
}

async function unitPart() {
  delete process.env.DATANAMIX_ENV;
  let dnx = freshDatanamix();

  console.log('\noff unless somebody turns it on');
  ok('with DATANAMIX_ENV unset it is not enabled', dnx.enabled() === false);
  let threw = null;
  try { await dnx.verifyIdRealtime({ idNumber: '7603219452087' }); } catch (e) { threw = e.message; }
  ok('and refuses to make a call', threw && /not set/.test(threw), threw);
  ok('and nothing was sent', calls.length === 0, JSON.stringify(calls));

  console.log('\nsandbox is anonymous, and never on production');
  process.env.DATANAMIX_ENV = 'SANDBOX';
  dnx = freshDatanamix();
  const idv = await dnx.verifyIdRealtime({ idNumber: '760321 9452087' });
  const sent = calls[calls.length - 1];
  ok('it posts to /v1/id-verification/realtime', sent.path === '/v1/id-verification/realtime');
  ok('with EnvironmentType SANDBOX and JSON output',
     sent.body.EnvironmentType === 'SANDBOX' && sent.body.OutputFormat === 'JSON', JSON.stringify(sent.body));
  ok('the ID number without spaces', sent.body.IdNumber === '7603219452087', sent.body.IdNumber);
  ok('and no Authorization header — sandbox needs no token', sent.auth === null);
  ok('no token was requested', tokenIssued === 0);
  ok('a PDF in the answer is never kept', !('PDFReport' in idv));

  process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
  threw = null;
  try { await dnx.verifyIdRealtime({ idNumber: '7603219452087' }); } catch (e) { threw = e.message; }
  ok('SANDBOX on the production environment is refused',
     threw && /production/.test(threw),
     `${threw} — sandbox does not know real ID numbers, so every real client would fail`);
  ok('and describe() says why', /production/.test(dnx.describe().problem || ''), JSON.stringify(dnx.describe()));
  delete process.env.RAILWAY_ENVIRONMENT_NAME;

  console.log('\nlive takes a token, once, and renews it when refused');
  process.env.DATANAMIX_ENV = 'LIVE';
  delete process.env.DATANAMIX_CLIENT_ID; delete process.env.DATANAMIX_CLIENT_SECRET;
  dnx = freshDatanamix();
  threw = null;
  try { await dnx.verifyIdRealtime({ idNumber: '7603219452087' }); } catch (e) { threw = e.message; }
  ok('LIVE without keys is refused before anything is sent', threw && /CLIENT_ID/.test(threw), threw);

  process.env.DATANAMIX_CLIENT_ID = 'member-key';
  process.env.DATANAMIX_CLIENT_SECRET = 'api-password';
  dnx = freshDatanamix();
  calls.length = 0;
  await dnx.verifyIdRealtime({ idNumber: '7603219452087' });
  await dnx.verifyIdRealtime({ idNumber: '7906124223083' });
  const tokenCalls = calls.filter(c => c.path === '/v1/oauth/token');
  ok('one token serves both calls', tokenCalls.length === 1, `${tokenCalls.length} token requests`);
  ok('requested with client_credentials',
     tokenCalls[0] && tokenCalls[0].body.grant_type === 'client_credentials');
  const live = calls.filter(c => c.path === '/v1/id-verification/realtime');
  ok('and sent as a bearer token with EnvironmentType LIVE',
     live.every(c => c.auth === 'Bearer jwt-1' && c.body.EnvironmentType === 'LIVE'),
     JSON.stringify(live.map(c => [c.auth, c.body.EnvironmentType])));

  forceStatus = { status: 403, body: { Success: false, Messages: ['Forbidden'], ResponseCode: 403 } };
  const retried = await dnx.verifyIdRealtime({ idNumber: '7603219452087' });
  ok('a 403 fetches a new token and retries once', retried.Success === true && tokenIssued === 2,
     `tokens issued: ${tokenIssued}`);

  forceStatus = { status: 404, body: { Success: false, Messages: ['No record found'], ResponseCode: 4 } };
  threw = null;
  try { await dnx.verifyIdRealtime({ idNumber: '7603219452087' }); } catch (e) { threw = e.message; }
  ok('HTTP 404 (product not activated) throws, despite its "No record found" body',
     threw && /not activated/.test(threw),
     `${threw} — read as no-such-person it would fail every client while the fault is our account`);

  process.env.DATANAMIX_CLIENT_SECRET = 'wrong';
  dnx = freshDatanamix();
  threw = null;
  try { await dnx.verifyIdRealtime({ idNumber: '7603219452087' }); } catch (e) { threw = e.message; }
  ok('a refused token request is an error naming the token', threw && /access token/.test(threw), threw);
  process.env.DATANAMIX_CLIENT_SECRET = 'api-password';

  console.log('\nreading an ID answer');
  const m = dnx.mapIdResult;
  const arthur = { first_name: 'Arthur', last_name: 'Pendragon', date_of_birth: '1976-03-21' };
  ok('a matched, living person with the same name passes',
     m(idvAnswer('7603219452087'), arthur).status === 'pass');
  ok('accents and case in the name do not matter',
     m(idvAnswer('7603219452087'), { first_name: 'ARTHUR', last_name: 'Péndragon' }).status === 'pass');
  ok('a deceased person fails', m(idvAnswer('8802142683086'), { first_name: 'Elaine', last_name: 'Astolat' }).status === 'fail');
  ok('no Home Affairs record fails', m(idvAnswer('0000000000000'), arthur).status === 'fail');
  ok('a blocked ID fails', m({ ...idvAnswer('7603219452087'), Results: { RealTimeIDVerification: {
     ...idvAnswer('7603219452087').Results.RealTimeIDVerification, IDBlocked: 'YES' } } }, arthur).status === 'fail');
  ok('an invalid ID number fails', m({ Success: false, Messages: ['Invalid South African ID number.'], ResponseCode: 6 }, arthur).status === 'fail');
  const other = m(idvAnswer('7603219452087'), { first_name: 'Arthur', last_name: 'Smith' });
  ok('a different surname is a review, not a rejection', other.status === 'manual_review', JSON.stringify(other));
  ok('and says which name differed', /Surname differs/.test(other.reasons.join(' ')));
  ok('a different date of birth is a review',
     m(idvAnswer('7603219452087'), { ...arthur, date_of_birth: '1977-03-21' }).status === 'manual_review');
  ok('Home Affairs being down is an error — we did not check them',
     m(idvAnswer(DHA_DOWN), arthur).status === 'error');
  ok('a Datanamix internal error is an error',
     m({ Success: false, Messages: ['Internal System Error.'], ResponseCode: 7 }, arthur).status === 'error');

  console.log('\nreading a bank answer');
  const a = (acc, id) => dnx.mapAvsResult(avsAnswer({ BankAccountNumber: acc, IdentityNumber: id, BankBranchCode: '250655' }));
  ok('an open account held under this ID passes', a('SB1233', '7603219452087').status === 'pass');
  ok('a closed account fails', a('SB5345', '8304019799087').status === 'fail');
  ok('an account held under somebody else\'s ID fails', a('SB1233', '7906124223083').status === 'fail');
  ok('an account the bank does not know fails', a('NOPE', '7603219452087').status === 'fail');
  const nameOff = dnx.mapAvsResult({ Success: true, ResponseCode: 0, Avs: { accountFound: 'Yes', identityMatch: 'Yes',
    accountOpen: 'Yes', acceptsCredits: 'Yes', nameMatch: 'No' } });
  ok('the right ID but a different surname is a review', nameOff.status === 'manual_review', JSON.stringify(nameOff));
  ok('a bank outside AVS real-time is a review, not a failure',
     dnx.mapAvsResult({ Success: false, Messages: ['This bank is not a participate of AVS Real Time.'], ResponseCode: 5 }).status === 'manual_review');
  ok('universal branch codes for the big banks',
     dnx.universalBranchCode('FNB') === '250655' && dnx.universalBranchCode('Capitec Bank') === '470010'
     && dnx.universalBranchCode('ABSA') === '632005' && dnx.universalBranchCode('Standard Bank') === '051001');
  ok('and none invented for a bank it does not know', dnx.universalBranchCode('Mystery Bank') === null);

  calls.length = 0;
  await dnx.verifyBankAccount({ idNumber: '7603219452087', firstName: 'Arthur', lastName: 'Pendragon',
    accountNumber: 'SB 1233', branchCode: '250655', accountType: 'cheque', mobile: '+27 83 100 0137' });
  const av = calls.find(c => c.path === '/v1/bank/account-verification').body;
  ok('AVS gets initials, surname and the ID', av.Initials === 'AP' && av.Surname === 'Pendragon'
     && av.IdentityType === 'IDNumber' && av.IdentityNumber === '7603219452087', JSON.stringify(av));
  ok('a cheque account is sent as Current', av.BankAccountType === 'Current', av.BankAccountType);
  ok('an international mobile is sent in the 0XX form AVS accepts', av.MobileNumber === '0831000137', av.MobileNumber);

  console.log('\nreading a sanctions answer');
  const clean = dnx.mapSanctionsResult(sanctionsAnswer({ Name: 'Guinevere Pendragon' }));
  ok('South Africa on the FATF grey list is not a hit on a South African',
     clean.status === 'clear', `${JSON.stringify(clean)} — it would put every SA client into review`);
  const hit = dnx.mapSanctionsResult(sanctionsAnswer({ Name: 'Arthur Pendragon' }));
  ok('a match on a person is a hit', hit.status === 'hit');
  ok('naming the list', hit.matches[0] && hit.matches[0].list === 'PEP', JSON.stringify(hit.matches));
  ok('an EntityNumber beyond 32 bits is kept exactly, as a string',
     hit.matches[0] && hit.matches[0].id === 'PEP-P001');
  ok('a completed screen is read as completed, though it says ResponseCode 200 rather than 0',
     dnx.mapSanctionsResult({ Success: true, Messages: ['Items found'], ResponseCode: 200,
       PossibleMatches: { Found: false, Results: [] } }).status === 'clear',
     'staging\'s first real sandbox screen came back "could not run: Items found"');
  ok('a failed screen is an error, never a clear',
     dnx.mapSanctionsResult({ Success: false, Messages: ['Internal System Error.'], ResponseCode: 7 }).status === 'error');

  calls.length = 0;
  await dnx.screenIndividual({ firstName: 'Arthur', lastName: 'Pendragon', dateOfBirth: '1976-03-21', idNumber: '7603219452087' });
  const sc = calls.find(c => c.path === '/v1/sanctions-standard/SanctionsIndividual').body;
  ok('the screen sends full name, DOB, ID and country',
     sc.Name === 'Arthur Pendragon' && sc.DateOfBirth === '1976-03-21' && sc.Identifier === '7603219452087'
     && sc.Country === 'ZA' && sc.MinScore === 75, JSON.stringify(sc));
}

/* ─── The real runFicaCheck against a database ──────────────────────── */
async function dbPart() {
  if (!process.env.DATABASE_URL) {
    console.log('\n  SKIP  database half — DATABASE_URL not set');
    return;
  }
  const { Pool } = require('pg');
  const SSL = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  const DB_NAME = 'chk_datanamix_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
  let pool;
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
    const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + DB_NAME;
    process.env.DATABASE_URL = u.toString();
    for (const mod of ['db/pool.js', 'db/setup.js', 'services/ficaService.js', 'services/incidents.js']) {
      delete require.cache[require.resolve(path.join(ROOT, 'server', mod))];
    }
    const q = console.log; console.log = () => {};
    try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
    pool.on('error', () => {});

    const add = (id, first, last, idNo, dob, extra = {}) => pool.query(`
      INSERT INTO investors (id, first_name, last_name, email, status, kyc_status, id_number,
          date_of_birth, nationality, notes, bank_name, bank_account_number, bank_branch_code, bank_account_type)
      VALUES ($1,$2,$3,$1 || '@example.test','active','pending',$4,$5,'South African',$6,$7,$8,$9,$10)`,
      [id, first, last, idNo, dob, extra.notes || null, extra.bank || null, extra.acct || null,
       extra.branch || null, extra.type || null]);

    await add('DX-GUIN',  'Guinevere', 'Pendragon', '7906124223083', '1979-06-12');
    await add('DX-ART',   'Arthur',    'Pendragon', '7603219452087', '1976-03-21',
              { bank: 'FNB', acct: 'SB1233', type: 'cheque' });          // branch from the universal code
    await add('DX-ELA',   'Elaine',    'Astolat',   '8802142683086', '1988-02-14');
    /* The same account, no branch code on file: Standard Bank's universal
       code is filled in, and the bank does not find it there. */
    await add('DX-GUESS', 'Merlin',    'Ambrosius', '6811017954086', '1968-11-01',
              { bank: 'Standard Bank', acct: 'SB1233', type: 'current' });
    /* And the client's OWN branch code, wrong. */
    await add('DX-WRONG', 'Nimue',     'Avalon',    '8604091870080', '1986-04-09',
              { bank: 'Standard Bank', acct: 'SB1233', branch: '051001', type: 'current' });
    await add('DX-LOKI2', 'Loki',      'Laufeyson', '8304019799087', '1983-04-01',
              { bank: 'FNB', acct: 'SB5345', type: 'current' });   // branch filled in, account closed
    await add('DX-LOKI',  'Loki',      'Laufeyson', '8304019799087', '1983-04-01',
              { bank: 'Standard Bank', acct: 'SB5345', branch: '250655', type: 'current' });
    await add('DX-DOWN',  'Gawain',    'Green',     DHA_DOWN,        '1980-12-25');
    await add('DX-LANCE', 'Lance',     'Smith',     '8205199001089', '1982-05-19');
    await add('DX-PASS',  'Ama',       'Mensah',    'G1234567',      '1990-01-01',
              { notes: 'DocType: Passport. Nationality: Ghanaian.' });

    /* Passports still go to Smile: stand a passing Smile in front of it. */
    const smilePath = require.resolve(path.join(ROOT, 'server', 'services', 'smileIdentity.js'));
    let smileCalls = 0;
    require.cache[smilePath] = { id: smilePath, filename: smilePath, loaded: true, children: [], paths: [],
      exports: {
        verifyID:       async () => { smileCalls++; return { ResultCode: '0810' }; },
        verifyPassport: async () => { smileCalls++; return { ResultCode: '0810' }; },
        mapResult: () => 'pass', verifyWebhook: () => true,
      } };

    process.env.DATANAMIX_ENV = 'SANDBOX';
    freshDatanamix();
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'services', 'ficaService.js'))];
    const { runFicaCheck } = require(path.join(ROOT, 'server', 'services', 'ficaService.js'));

    const run = async id => {
      const { rows: [inv] } = await pool.query('SELECT * FROM investors WHERE id = $1', [id]);
      const quiet = console.log, quietE = console.error;
      console.log = () => {}; console.error = () => {};
      try { return await runFicaCheck(inv, 'manual'); } finally { console.log = quiet; console.error = quietE; }
    };
    const inv = async id => (await pool.query(
      'SELECT kyc_status, fica_auto_status, last_auto_fica_check FROM investors WHERE id = $1', [id])).rows[0];
    const row = async id => (await pool.query(
      'SELECT * FROM fica_checks WHERE investor_id = $1 ORDER BY check_date DESC LIMIT 1', [id])).rows[0];

    console.log('\na clean South African is verified end to end');
    const g = await run('DX-GUIN');
    ok('ID passes, no bank on file, screen is clear → pass',
       g.idStatus === 'pass' && g.bankStatus === 'skipped' && g.sanctionsStatus === 'clear' && g.overallStatus === 'pass',
       JSON.stringify(g));
    const gi = await inv('DX-GUIN');
    ok('the client is marked verified and stamped as checked',
       gi.kyc_status === 'verified' && gi.last_auto_fica_check !== null, JSON.stringify(gi));
    const gr = await row('DX-GUIN');
    ok('the row records Datanamix as the provider', gr.id_result.provider === 'datanamix');
    ok('and the screen result is stored', gr.sanctions_check_status === 'clear' && gr.sanctions_result.provider === 'datanamix');
    ok('without the PDF', !JSON.stringify(gr.id_result).includes('should-never-be-stored'));

    console.log('\na possible PEP match is held for a person');
    const ar = await run('DX-ART');
    ok('ID and bank both pass', ar.idStatus === 'pass' && ar.bankStatus === 'pass', JSON.stringify(ar));
    ok('but the PEP hit holds the check for review', ar.sanctionsStatus === 'hit' && ar.overallStatus === 'manual_review',
       JSON.stringify(ar));
    ok('and the client stays pending, not verified', (await inv('DX-ART')).kyc_status === 'pending');
    const avsSent = calls.filter(c => c.path === '/v1/bank/account-verification').pop();
    ok('the FNB account was checked under the universal branch code', avsSent && avsSent.body.BankBranchCode === '250655',
       JSON.stringify(avsSent && avsSent.body));
    const { rows: inc } = await pool.query(
      `SELECT severity, message FROM platform_incidents WHERE source = 'fica' AND message LIKE '%DX-ART%'`);
    ok('the hit is raised as a critical incident naming the client',
       inc.length === 1 && inc[0].severity === 'critical', JSON.stringify(inc));

    console.log('\nwhat Home Affairs and the bank say is wrong, fails');
    const el = await run('DX-ELA');
    ok('a deceased person fails and is rejected',
       el.overallStatus === 'fail' && (await inv('DX-ELA')).kyc_status === 'rejected', JSON.stringify(el));
    const lo = await run('DX-LOKI');
    ok('a closed bank account fails the check', lo.bankStatus === 'fail' && lo.overallStatus === 'fail', JSON.stringify(lo));

    console.log('\na branch code we filled in is ours to doubt, not the client\'s');
    const gu = await run('DX-GUESS');
    const guSent = calls.filter(c => c.path === '/v1/bank/account-verification').pop();
    ok('with no branch code on file, Standard Bank\'s universal code is sent',
       guSent && guSent.body.BankBranchCode === '051001', JSON.stringify(guSent && guSent.body));
    ok('and the bank not finding the account there is a review, not a failure',
       gu.bankStatus === 'manual_review' && gu.overallStatus === 'manual_review', JSON.stringify(gu));
    ok('the client is left pending, not rejected', (await inv('DX-GUESS')).kyc_status === 'pending');
    const guRow = await row('DX-GUESS');
    ok('and the reason says the branch code was filled in, and which',
       /filled in/.test(guRow.bank_result.reasons.join(' ')) && /051001/.test(guRow.bank_result.reasons.join(' '))
       && guRow.bank_result.branchCodeFilledIn === true, JSON.stringify(guRow.bank_result.reasons));
    const wr = await run('DX-WRONG');
    ok('the client\'s own branch code, not found, still fails',
       wr.bankStatus === 'fail' && wr.overallStatus === 'fail', JSON.stringify(wr));
    const lo2 = await run('DX-LOKI2');
    ok('a closed account still fails when we filled in the branch',
       lo2.bankStatus === 'fail' && lo2.overallStatus === 'fail', `${JSON.stringify(lo2)} — only "not found" depends on the branch code`);

    console.log('\nwhat is only doubtful, goes to a person');
    const la = await run('DX-LANCE');
    ok('a surname that differs from Home Affairs is a review',
       la.idStatus === 'manual_review' && la.overallStatus === 'manual_review'
       && (await inv('DX-LANCE')).kyc_status === 'pending', JSON.stringify(la));

    console.log('\nwhat we could not check, is not a check');
    const dn = await run('DX-DOWN');
    ok('Home Affairs down is an error', dn.overallStatus === 'error', JSON.stringify(dn));
    const di = await inv('DX-DOWN');
    ok('the client is left pending, not rejected', di.kyc_status === 'pending', JSON.stringify(di));
    ok('and not stamped, so the sweep tries them again', di.last_auto_fica_check === null);

    console.log('\npassports still go to Smile, and are still screened');
    const before = smileCalls;
    const idvBefore = calls.filter(c => c.path === '/v1/id-verification/realtime').length;
    const pp = await run('DX-PASS');
    ok('the passport was verified by Smile', smileCalls === before + 1 && pp.idStatus === 'pass', JSON.stringify(pp));
    ok('not sent to Home Affairs, which only knows SA IDs',
       calls.filter(c => c.path === '/v1/id-verification/realtime').length === idvBefore);
    const lastScreen = calls.filter(c => c.path === '/v1/sanctions-standard/SanctionsIndividual').pop();
    ok('but screened against the watch lists, under their own country',
       pp.sanctionsStatus === 'clear' && lastScreen.body.Name === 'Ama Mensah' && lastScreen.body.Country === 'GH',
       JSON.stringify(lastScreen && lastScreen.body));

    console.log('\nstaff can read what the checks found; the client cannot');
    const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'fica.js'))];
    const router = require(path.join(ROOT, 'server', 'routes', 'fica.js'));
    const call = (method, url, user) => new Promise(resolve => {
      const token = jwt.sign(user, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
      const req = { method, url, originalUrl: url, baseUrl: '', body: {}, query: {}, cookies: {},
        headers: { authorization: 'Bearer ' + token }, ip: '198.51.100.7',
        get(h) { return this.headers[String(h).toLowerCase()]; } };
      let code = 200;
      const res = { statusCode: 200, status(c) { code = c; this.statusCode = c; return this; }, set() { return this; },
        json(b) { resolve({ status: code, body: b }); return this; },
        send(b) { resolve({ status: code, body: b }); return this; },
        sendStatus(c) { resolve({ status: c, body: null }); return this; } };
      router(req, res, () => resolve({ status: 404, body: null }));
    });
    const ADMIN = { role: 'admin' }, OWNER = { role: 'investor', investorId: 'DX-ART' };
    const quietE = console.error; console.error = () => {};
    let staff, own, status, prov;
    try {
      staff  = await call('GET', '/checks/DX-ART', ADMIN);
      own    = await call('GET', '/checks/DX-ART', OWNER);
      status = await call('GET', '/status/DX-ART', OWNER);
      prov   = await call('GET', '/providers', ADMIN);
    } finally { console.error = quietE; }
    const latest = staff.body && staff.body.checks && staff.body.checks[0];
    ok('staff get the checks', staff.status === 200 && latest, JSON.stringify(staff).slice(0, 300));
    ok('with each step, its provider and outcome',
       latest && latest.id_check.provider === 'datanamix' && latest.id_check.status === 'pass'
       && latest.bank.status === 'pass' && latest.sanctions.status === 'hit', JSON.stringify(latest));
    ok('and the watch-list match itself, named',
       latest && latest.sanctions.matches[0] && latest.sanctions.matches[0].list === 'PEP'
       && latest.sanctions.matches[0].name === 'Arthur Pendragon', JSON.stringify(latest && latest.sanctions));
    ok('but never the raw provider response',
       !JSON.stringify(staff.body).includes('"response"'), 'reasons and matches are what a reviewer needs');
    ok('a review shows its reason',
       ((await call('GET', '/checks/DX-LANCE', ADMIN)).body.checks[0].id_check.reasons.join(' ')).includes('Surname differs'));
    ok('the client cannot read their own check detail', own.status === 403, JSON.stringify(own));
    ok('and their status page says nothing about a watch-list match',
       status.status === 200 && !/PEP|Pendragon"|matches/.test(JSON.stringify(status.body.checks)),
       JSON.stringify(status.body && status.body.checks));
    ok('the provider strip is told Datanamix runs every step but passports',
       prov.body && prov.body.steps.sa_id === 'datanamix' && prov.body.steps.passport === 'smile'
       && prov.body.steps.sanctions === 'datanamix' && prov.body.datanamix.environment === 'SANDBOX',
       JSON.stringify(prov.body));
    ok('and never a key', !JSON.stringify(prov.body).includes('api-password'));

    const { rows: [ann] } = await pool.query(
      `SELECT where_to_find, area FROM feature_announcements WHERE id = 'datanamix-fica-checks-2026-11'`);
    ok('staff are told the feature exists, and where',
       ann && ann.area === 'admin' && /FICA Pipeline/.test(ann.where_to_find) && /Checks button/.test(ann.where_to_find),
       JSON.stringify(ann));

    console.log('\na review is closed by a person, with a reason');
    const callR = (rtr, method, url, user, body) => new Promise(resolve => {
      const token = jwt.sign(user, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
      const req = { method, url, originalUrl: url, baseUrl: '', body: body || {}, query: {}, cookies: {},
        headers: { authorization: 'Bearer ' + token, 'user-agent': 'check-datanamix' }, ip: '198.51.100.7',
        get(h) { return this.headers[String(h).toLowerCase()]; } };
      let code = 200;
      const res = { statusCode: 200, status(c) { code = c; this.statusCode = c; return this; }, set() { return this; },
        setHeader() {}, json(b) { resolve({ status: code, body: b }); return this; },
        send(b) { resolve({ status: code, body: b }); return this; },
        sendStatus(c) { resolve({ status: c, body: null }); return this; } };
      rtr(req, res, () => resolve({ status: 404, body: null }));
    });
    const DIRECTOR = { role: 'director', id: 'U-DIR', email: 'dir@example.test', firstName: 'Dee', lastName: 'Rector' };
    const ADMIN2   = { role: 'admin',    id: 'U-ADM', email: 'adm@example.test', firstName: 'Ada', lastName: 'Min' };
    const STAFF    = { role: 'staff',    id: 'U-STF', email: 'stf@example.test' };
    const dec = (who, checkId, body) => callR(router, 'POST', `/checks/${checkId}/decision`, who, body);
    const quietE2 = console.error; console.error = () => {};
    try {
      const artAdmin = await callR(router, 'GET', '/checks/DX-ART', ADMIN2);
      const artDir   = await callR(router, 'GET', '/checks/DX-ART', DIRECTOR);
      const artCheck = artAdmin.body.checks[0];
      ok('the panel is told which check is waiting on a decision',
         artAdmin.body.openReviewId === artCheck.id, JSON.stringify({ open: artAdmin.body.openReviewId, latest: artCheck.id }));
      ok('and that an admin may not approve a possible PEP match, but a director may',
         artAdmin.body.viewer.canApproveMatch === false && artDir.body.viewer.canApproveMatch === true);

      ok('the banner shows a possible match, review pending',
         artAdmin.body.watchlist && artAdmin.body.watchlist.status === 'possible' && artAdmin.body.watchlist.kind === 'pep',
         JSON.stringify(artAdmin.body.watchlist));
      const flagOwn = await callR(router, 'GET', '/flags/DX-ART', OWNER);
      ok('the PEP flag is staff only — the client cannot read it', flagOwn.status === 403, JSON.stringify(flagOwn));
      const { rows: [artRow] } = await pool.query(`SELECT * FROM investors WHERE id = 'DX-ART'`);
      ok('and it is not written onto the investor row the client\'s portal reads',
         !Object.keys(artRow).some(k => /pep|watchlist/i.test(k)), Object.keys(artRow).filter(k => /pep|watch/i.test(k)).join(','));

      /* While the review is open, nothing else may approve the client. */
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'tables.js'))];
      const tables = require(path.join(ROOT, 'server', 'routes', 'tables.js'));
      const patched = await callR(tables, 'PATCH', '/investors/DX-ART', ADMIN2, { kyc_status: 'approved', fica_status: 'approved', status: 'active' });
      ok('approving the client through the profile is refused while the review is open',
         patched.status === 409 && patched.body.code === 'fica_review_open' && /Checks/.test(patched.body.error),
         JSON.stringify(patched));
      ok('and so is the old "Verified" spelling', (await callR(tables, 'PUT', '/investors/DX-ART', ADMIN2, { kyc_status: 'verified' })).status === 409);
      ok('an update that approves nothing still goes through',
         (await callR(tables, 'PATCH', '/investors/DX-ART', ADMIN2, { phone: '0831000137' })).status === 200);
      for (const t of ['id_document', 'proof_of_address', 'proof_of_bank']) {
        await pool.query(`INSERT INTO kyc_documents (id, investor_id, doc_type, status) VALUES ($1,'DX-ART',$2,'approved')`, ['KD-' + t, t]);
      }
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'jobs', 'kycReconcileCron.js'))];
      const { runKycReconcile } = require(path.join(ROOT, 'server', 'jobs', 'kycReconcileCron.js'));
      const qL = console.log, qW = console.warn; console.log = () => {}; console.warn = () => {};
      try { await runKycReconcile(); } finally { console.log = qL; console.warn = qW; }
      ok('and the hourly reconcile does not promote them from their documents',
         (await inv('DX-ART')).kyc_status === 'pending', JSON.stringify(await inv('DX-ART')));

      ok('a decision needs a reason', (await dec(ADMIN2, artCheck.id, { decision: 'approve', note: '', matchOutcome: 'false_positive' })).status === 400);
      ok('a possible match needs to be called: this client, or not',
         (await dec(DIRECTOR, artCheck.id, { decision: 'approve', note: 'Looks fine to me' })).status === 400);
      const admApprove = await dec(ADMIN2, artCheck.id, { decision: 'approve', note: 'PEP accepted after EDD', matchOutcome: 'confirmed' });
      ok('an admin cannot approve a possible PEP match', admApprove.status === 403 && /director/.test(admApprove.body.error), JSON.stringify(admApprove));
      ok('staff without FICA access cannot decide at all',
         (await dec(STAFF, artCheck.id, { decision: 'decline', note: 'Not allowed', matchOutcome: 'confirmed' })).status === 403);
      const dirApprove = await dec(DIRECTOR, artCheck.id, { decision: 'approve',
        note: 'Confirmed PEP — provincial MEC. Source of funds verified, EDD on file.', matchOutcome: 'confirmed' });
      ok('a director can approve it', dirApprove.status === 200 && dirApprove.body.decision === 'approved', JSON.stringify(dirApprove));
      const ai = await inv('DX-ART');
      ok('the client is now KYC verified, approved after review',
         ai.kyc_status === 'verified' && ai.fica_auto_status === 'approved', JSON.stringify(ai));
      const { rows: [rec] } = await pool.query(`SELECT * FROM fica_checks WHERE id = $1`, [artCheck.id]);
      ok('who, when, which way, why and what the match was are recorded on the check',
         rec.review_decision === 'approved' && rec.reviewed_by === 'Dee Rector' && rec.reviewed_by_role === 'director'
         && rec.reviewed_at && /provincial MEC/.test(rec.review_note) && rec.match_outcome === 'confirmed', JSON.stringify(rec));
      ok('a decision is made once', (await dec(DIRECTOR, artCheck.id, { decision: 'decline', note: 'Changed my mind', matchOutcome: 'confirmed' })).status === 409);

      const after = await callR(router, 'GET', '/checks/DX-ART', ADMIN2);
      ok('the panel shows the decision and nothing left to decide',
         after.body.openReviewId === null && after.body.checks[0].review && after.body.checks[0].review.by === 'Dee Rector'
         && after.body.checks[0].review.matchOutcome === 'confirmed', JSON.stringify(after.body.checks[0].review));
      const flag = (await callR(router, 'GET', '/flags/DX-ART', ADMIN2)).body.watchlist;
      ok('the profile banner now says confirmed PEP, by whom',
         flag && flag.status === 'confirmed' && flag.kind === 'pep' && flag.decidedBy === 'Dee Rector', JSON.stringify(flag));
      ok('and the guard has lifted', (await require(path.join(ROOT, 'server', 'services', 'ficaReview.js'))
         .guardInvestorUpdate('DX-ART', { kyc_status: 'approved' })) === null);

      /* A later screen that comes back clear does not take a confirmed PEP's banner away. */
      await pool.query(`INSERT INTO fica_checks (id, investor_id, trigger, overall_status, sanctions_check_status, check_date)
                        VALUES ('FC-LATER-CLEAR','DX-ART','annual_recheck','pass','clear', NOW() + INTERVAL '1 minute')`);
      ok('a confirmed PEP stays flagged after a later clear screen',
         ((await callR(router, 'GET', '/flags/DX-ART', ADMIN2)).body.watchlist || {}).status === 'confirmed');

      console.log('\nother reviews, and the ones that cannot be decided');
      const la = (await callR(router, 'GET', '/checks/DX-LANCE', ADMIN2)).body;
      ok('a name difference with no watch-list match needs no match question, and an admin may decide it',
         (await dec(ADMIN2, la.openReviewId, { decision: 'decline', note: 'Surname does not match Home Affairs; asked for documents' })).status === 200);
      const li = await inv('DX-LANCE');
      ok('declined: the client is KYC rejected', li.kyc_status === 'rejected' && li.fica_auto_status === 'declined', JSON.stringify(li));
      ok('and has no PEP banner', (await callR(router, 'GET', '/flags/DX-LANCE', ADMIN2)).body.watchlist === null);

      const gNow = (await callR(router, 'GET', '/checks/DX-GUIN', ADMIN2)).body;
      ok('a check that passed has nothing to decide', gNow.openReviewId === null
         && (await dec(ADMIN2, gNow.checks[0].id, { decision: 'approve', note: 'Nothing to decide here' })).status === 409);

      await pool.query(`INSERT INTO investors (id, first_name, last_name, email, kyc_status) VALUES ('DX-NOSCR','No','Screen','noscr@example.test','pending')`);
      await pool.query(`INSERT INTO fica_checks (id, investor_id, trigger, overall_status, id_check_status, sanctions_check_status, check_date)
                        VALUES ('FC-NOSCR','DX-NOSCR','manual','manual_review','pass','error', NOW())`);
      const ns = await dec(DIRECTOR, 'FC-NOSCR', { decision: 'approve', note: 'Approving anyway' });
      ok('a client whose sanctions screen did not run cannot be approved, even by a director',
         ns.status === 409 && /not been screened/.test(ns.body.error), JSON.stringify(ns));

      const oldGuess = (await row('DX-GUESS')).id;
      await run('DX-GUESS');
      ok('only the latest check can be decided — an older one is refused',
         (await dec(ADMIN2, oldGuess, { decision: 'approve', note: 'Branch code confirmed with client' })).status === 409);

      /* A false match leaves no banner. */
      await pool.query(`INSERT INTO investors (id, first_name, last_name, email, kyc_status) VALUES ('DX-FP','Fal','Sepos','fp@example.test','pending')`);
      await pool.query(`INSERT INTO fica_checks (id, investor_id, trigger, overall_status, id_check_status, sanctions_check_status, sanctions_result, check_date)
                        VALUES ('FC-FP','DX-FP','manual','manual_review','pass','hit', $1, NOW())`,
                       [JSON.stringify({ matches: [{ name: 'Fal Sepos', list: 'PEP', programmes: ['PEP'] }] })]);
      ok('an undecided match shows as possible', ((await callR(router, 'GET', '/flags/DX-FP', ADMIN2)).body.watchlist || {}).status === 'possible');
      ok('an admin still cannot approve it, even called a false match',
         (await dec(ADMIN2, 'FC-FP', { decision: 'approve', note: 'Different person: DOB 1951 vs client 1990', matchOutcome: 'false_positive' })).status === 403,
         'approving a possible match is still a director\'s, whatever the outcome');
      ok('a director approves it as not this person',
         (await dec(DIRECTOR, 'FC-FP', { decision: 'approve', note: 'Different person: DOB 1951 vs client 1990', matchOutcome: 'false_positive' })).status === 200);
      ok('and the client carries no banner', (await callR(router, 'GET', '/flags/DX-FP', ADMIN2)).body.watchlist === null);

      const { rows: [ann2] } = await pool.query(
        `SELECT where_to_find FROM feature_announcements WHERE id = 'fica-review-decisions-2026-11'`);
      ok('staff are told how to decide a review, and where the banner is',
         ann2 && /Review decision/.test(ann2.where_to_find) && /profile/.test(ann2.where_to_find), JSON.stringify(ann2));
    } finally { console.error = quietE2; }

    console.log('\nand with Datanamix off, nothing changes');
    delete process.env.DATANAMIX_ENV;
    const n0 = calls.length;
    const off = await run('DX-GUIN');
    ok('no call reaches Datanamix', calls.length === n0, `${calls.length - n0} calls`);
    ok('the screen is recorded as skipped', off.sanctionsStatus === 'skipped');
    ok('and the SA ID went to Smile, as before', smileCalls === before + 2);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
  }
}

function uiPart() {
  console.log('\nthe admin console shows it');
  const js   = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8');
  ok('each FICA Pipeline row has a Checks button', /onclick='openFicaChecks\(\$\{_esc\(JSON\.stringify\(inv\.id\)\)\}\)'/.test(js));
  ok('which reads the staff-only endpoint', /API\._fetch\('GET', `fica\/checks\/\$\{encodeURIComponent/.test(js));
  ok('the modal it opens exists', /id="ficaChecksModal"/.test(html) && /id="ficaChecksContent"/.test(html));
  ok('a check can be run from it, after a confirmation', /async function runFicaCheckNow[\s\S]{0,600}Confirm\.ask/.test(js));
  ok('the provider strip has somewhere to render', /id="ficaProviderStrip"/.test(html) && /fica\/providers/.test(js));
  ok('match names are escaped before they are shown', /_esc\(m\.name \|\| 'Unnamed'\)/.test(js));

  /* Found on staging: a client held on a possible PEP match still showed
     "Not Started" — the stage was worked out from uploaded documents only. */
  const stageFn = (js.match(/function _ficaStageOf\(inv\) \{[\s\S]*?\n\}/) || [''])[0];
  let stageOf = null;
  try { stageOf = new Function('STATE', stageFn + '; return _ficaStageOf;')({ kyc: [] }); } catch (_) {}
  ok('a client whose automated check needs review is In Review, not Not Started',
     stageOf && stageOf({ id: 'X', kyc_status: 'pending', fica_auto_status: 'manual_review' }) === 'in_review');
  ok('a client the check rejected is under Rejected / Issues',
     stageOf && stageOf({ id: 'X', kyc_status: 'rejected', fica_auto_status: 'fail' }) === 'rejected');
  ok('a verified client is still Approved', stageOf && stageOf({ id: 'X', kyc_status: 'verified', fica_auto_status: 'pass' }) === 'approved');
  ok('and one never checked, with no documents, is still Not Started', stageOf && stageOf({ id: 'X', kyc_status: 'pending' }) === 'not_started');
  ok('each row shows the last automated result under its stage', /\$\{stageBadge\}\$\{_fcAutoLine\(inv\)\}/.test(js));
  ok('the panel opens with the client\'s KYC status and stage',
     /el\.innerHTML = summary \+ checks\.map/.test(js) && /cell\('KYC status'/.test(js) && /cell\('FICA stage'/.test(js));
  ok('and a check run from it updates the row behind it',
     /Object\.assign\(local, \{ kyc_status: d\.investor\.kyc_status, fica_auto_status/.test(js));

  console.log('\nreview decisions and the PEP banner, in the console');
  const viewInv = (js.match(/async function viewInvestor\(id\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('the client profile has a banner slot above its tabs',
     /<div id="invWatchlistBanner"><\/div>\s*<div class="tab-bar"/.test(viewInv));
  ok('and fills it from the staff-only flag every time a profile opens', /_loadInvestorWatchlistBanner\(inv\.id\);/.test(viewInv)
     && /API\._fetch\('GET', `fica\/flags\/\$\{encodeURIComponent\(investorId\)\}`\)/.test(js));
  ok('a confirmed PEP banner says who confirmed it', /Politically Exposed Person' : 'Sanctions \/ watch-list match'/.test(js)
     && /Confirmed by \$\{_esc\(flag\.decidedBy/.test(js));
  ok('the decision box asks whether a possible match is the client', /name="fcMatchOutcome" value="false_positive"/.test(js)
     && /name="fcMatchOutcome" value="confirmed"/.test(js));
  ok('and sends the answer with the decision', /\{ decision, note, matchOutcome \}/.test(js));
  ok('Approve is disabled, with the reason, for an admin facing a possible match',
     /isMatch && !viewer\.canApproveMatch \? 'A possible sanctions or PEP match can only be approved by a director/.test(js));
  ok('a client verified by the automated check reads KYC Verified on their profile',
     /\(inv\.kyc_status==='approved'\|\|inv\.kyc_status==='verified'\)/.test(js));
  ok('approving documents while a review is open says the client is held, not that it failed',
     /if \(result\.held\) Toast\.warning/.test(js));

  /* Found on staging: the confirmation opened BEHIND the checks panel, a
     click on the panel's backdrop closed it and cleared the remembered
     investor, and the confirm then sent POST /fica/trigger/null. */
  const zOf = id => { const m = html.match(new RegExp(`id="${id}"[^>]*z-index:\\s*(\\d+)`)); return m ? +m[1] : null; };
  const overlays = [...html.matchAll(/class="modal-overlay" id="([^"]+)"[^>]*z-index:\s*(\d+)/g)]
    .map(m => ({ id: m[1], z: +m[2] })).filter(o => o.id !== 'confirmModal');
  const above = overlays.filter(o => o.z >= zOf('confirmModal'));
  ok('the confirmation dialog sits above every other dialog, the checks panel included',
     zOf('confirmModal') > zOf('ficaChecksModal') && above.length === 0,
     `confirm ${zOf('confirmModal')}; at or above it: ${JSON.stringify(above)}`);
  const run = (js.match(/async function runFicaCheckNow\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('Run check now holds the investor before it waits for the confirmation',
     /const investorId = _ficaChecksInvestor;[\s\S]*await Confirm\.ask/.test(run)
     && /fica\/trigger\/\$\{encodeURIComponent\(investorId\)\}/.test(run),
     'reading _ficaChecksInvestor after the await sends null if the panel was closed meanwhile');
}

(async () => {
  try {
    await unitPart();
    uiPart();
    await dbPart();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
