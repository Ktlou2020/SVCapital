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
const ROOT = path.join(__dirname, '..', '..');

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
  const a = ACCOUNTS[b.BankAccountNumber];
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
    Success: true, ResponseCode: 0,
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
  const a = (acc, id) => dnx.mapAvsResult(avsAnswer({ BankAccountNumber: acc, IdentityNumber: id }));
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

(async () => {
  try {
    await unitPart();
    await dbPart();
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
