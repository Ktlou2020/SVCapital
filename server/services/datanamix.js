/* ═══════════════════════════════════════════════════════
   Datanamix Unified API — ID, bank account and sanctions checks
   Docs: https://api-docs.datanamix.com/docs/unified/oauth-overview

   Three products, all South African, all one request each:

     Real-Time IDV        POST /v1/id-verification/realtime
       SA ID number straight against Home Affairs (DHA): name, date of
       birth, deceased status, ID blocked.
     AVS                  POST /v1/bank/account-verification
       Bank account against the bank's own records: the account exists, is
       open, takes credits, and belongs to this ID number.
     Standard Sanctions   POST /v1/sanctions-standard/SanctionsIndividual
       Name (+ date of birth + ID number) against international sanctions,
       PEP and watch lists.

   Env vars:
     DATANAMIX_ENV            unset → Datanamix is OFF (Smile/Stitch as before)
                              'SANDBOX' → Datanamix's synthetic data, no keys
                              'LIVE'    → real checks, keys required
     DATANAMIX_CLIENT_ID      the Member Key   (veriid.com API Manager →
     DATANAMIX_CLIENT_SECRET  the API Password  User Management → API Information)
     DATANAMIX_BASE_URL       optional, default https://api.datanamix.com
     DATANAMIX_SANCTIONS_MIN_SCORE  optional, 0–100, default 75
     DATANAMIX_TIMEOUT_MS     optional, default 30000

   Auth: SANDBOX requests are anonymous. LIVE requests carry a bearer JWT
   from POST /v1/oauth/token (client_credentials), valid 14 399 s. It is
   cached here and refreshed five minutes early, and once more on a 401/403
   in case it was revoked.
   ═══════════════════════════════════════════════════════ */
'use strict';

const BASE_URL   = (process.env.DATANAMIX_BASE_URL || 'https://api.datanamix.com').replace(/\/+$/, '');
const TIMEOUT_MS = parseInt(process.env.DATANAMIX_TIMEOUT_MS, 10) || 30000;

/* Read per call, not at load: a check (or an operator changing a variable
   and restarting) should not have to fight a value frozen at require time. */
function env() {
  const raw = String(process.env.DATANAMIX_ENV || '').trim().toUpperCase();
  return raw === 'LIVE' || raw === 'SANDBOX' ? raw : null;
}

/* Is Datanamix the provider? Only when somebody chose it. An unset variable
   leaves the existing providers in charge, exactly as before this file. */
function enabled() { return env() !== null; }

/* SANDBOX answers from fifty synthetic people. A real client's ID number is
   not one of them, so in sandbox every real client comes back "No record
   found" — which this module maps to a FAILED ID check and the FICA service
   turns into a REJECTED client. On the production service that would reject
   everybody the sweep touched. So production refuses sandbox outright and
   says so, rather than trusting nobody ever sets it there. */
function _assertUsable() {
  const mode = env();
  if (!mode) throw new Error('[Datanamix] DATANAMIX_ENV is not set — Datanamix is not enabled.');
  const railwayEnv = String(process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase();
  if (mode === 'SANDBOX' && railwayEnv === 'production') {
    throw new Error('[Datanamix] DATANAMIX_ENV=SANDBOX on the production environment. Sandbox '
      + 'data would fail every real client. Set DATANAMIX_ENV=LIVE with keys, or unset it.');
  }
  if (mode === 'LIVE' && (!process.env.DATANAMIX_CLIENT_ID || !process.env.DATANAMIX_CLIENT_SECRET)) {
    throw new Error('[Datanamix] DATANAMIX_ENV=LIVE needs DATANAMIX_CLIENT_ID (Member Key) and '
      + 'DATANAMIX_CLIENT_SECRET (API Password).');
  }
  return mode;
}

/* ─── OAuth token ─────────────────────────────────────────────────────── */
let _token = null;          // { value, expiresAt }

async function _fetchJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { status: res.status, ok: res.ok, body, text };
}

async function getToken({ force = false } = {}) {
  if (!force && _token && Date.now() < _token.expiresAt) return _token.value;
  const r = await _fetchJson(`${BASE_URL}/v1/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({
      grant_type:    'client_credentials',
      client_id:     process.env.DATANAMIX_CLIENT_ID,
      client_secret: process.env.DATANAMIX_CLIENT_SECRET,
    }),
  });
  if (!r.ok || !r.body || !r.body.access_token) {
    _token = null;
    const why = (r.body && (r.body.error_description || r.body.error
      || (Array.isArray(r.body.Messages) && r.body.Messages.join('; ')))) || `HTTP ${r.status}`;
    throw new Error(`[Datanamix] could not get an access token: ${why}`);
  }
  const ttl = Number(r.body.expires_in) || 14399;
  _token = { value: r.body.access_token, expiresAt: Date.now() + Math.max(60, ttl - 300) * 1000 };
  return _token.value;
}

function _resetToken() { _token = null; }

/* ─── One product call ────────────────────────────────────────────────
   Datanamix answers business outcomes ("no record", "validation error")
   as HTTP 200 with Success:false and a ResponseCode, and transport/auth
   problems as 4xx/5xx with the same envelope. Callers get the envelope
   back either way; only "we could not get an answer" throws. */
async function _post(path, payload) {
  const mode = _assertUsable();
  const body = { EnvironmentType: mode, OutputFormat: 'JSON', ...payload };

  const send = async (forceToken) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (mode === 'LIVE') headers.Authorization = `Bearer ${await getToken({ force: forceToken })}`;
    return _fetchJson(`${BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  };

  let r = await send(false);
  if (mode === 'LIVE' && (r.status === 401 || r.status === 403)) {
    _resetToken();
    r = await send(true);
  }

  if (!r.body || typeof r.body !== 'object') {
    throw new Error(`[Datanamix] ${path}: HTTP ${r.status}, unreadable response`);
  }
  if (r.status === 401 || r.status === 403) {
    throw new Error(`[Datanamix] ${path}: access refused (HTTP ${r.status}) — check the Member Key / API Password`);
  }
  /* HTTP 404 is "this product is not activated on your account". Its sample
     body says "No record found", but a genuine no-record about a PERSON comes
     back as HTTP 200 with ResponseCode 4. Read a 404 as a no-record and an
     unactivated product would fail every client it touched; it is ours to
     fix, so it is an error. */
  if (r.status === 404) {
    throw new Error(`[Datanamix] ${path}: product not activated on this account (HTTP 404: ${_messages(r.body) || 'no message'})`);
  }
  if (r.status >= 500) {
    throw new Error(`[Datanamix] ${path}: ${_messages(r.body) || 'server error'} (HTTP ${r.status})`);
  }
  /* A PDF is never requested, but never store one if it comes back. */
  if ('PDFReport' in r.body) delete r.body.PDFReport;
  return r.body;
}

function _messages(body) {
  return body && Array.isArray(body.Messages) ? body.Messages.join('; ') : '';
}

/* ─── Normalisation for name comparison ───────────────────────────── */
function _norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}
function _tokens(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/* An ISO date, or null. investors.date_of_birth is free TEXT. */
function _isoDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/* ═══ Real-Time ID verification ═══════════════════════════════════ */
async function verifyIdRealtime({ idNumber }) {
  return _post('/v1/id-verification/realtime', { IdNumber: String(idNumber || '').replace(/\s+/g, '') });
}

/* → { status: 'pass'|'fail'|'manual_review'|'error', reasons: [] }

   Fails closed on anything Home Affairs says is wrong with the person, and
   sends to a human anything that is merely ours to doubt — a spelling
   difference in a name is a review, not a rejection. */
function mapIdResult(resp, investor = {}) {
  const reasons = [];
  if (!resp || typeof resp !== 'object') return { status: 'error', reasons: ['no response'] };

  const code = Number(resp.ResponseCode);
  if (resp.Success !== true || code !== 0) {
    const msg = _messages(resp);
    if (code === 4) return { status: 'fail',          reasons: ['No Home Affairs record for this ID number'] };
    if (code === 6) return { status: 'fail',          reasons: [`Invalid ID number${msg ? ': ' + msg : ''}`] };
    if (code === 8) return { status: 'manual_review', reasons: ['ID number belongs to a minor'] };
    /* 5 = DHA unavailable, 7 = Datanamix internal error, anything else:
       we did not get an answer about this person. */
    return { status: 'error', reasons: [msg || `ResponseCode ${resp.ResponseCode}`] };
  }

  const r = resp.Results && resp.Results.RealTimeIDVerification;
  if (!r) return { status: 'error', reasons: ['Success without a RealTimeIDVerification result'] };

  if (String(r.IDNOMatchStatus || '').toLowerCase() !== 'matched') {
    return { status: 'fail', reasons: [`ID number not matched at Home Affairs (${r.IDNOMatchStatus || 'no status'})`] };
  }
  if (String(r.DeceasedStatus || '').toLowerCase() !== 'alive') {
    return { status: 'fail', reasons: [`Home Affairs records this person as ${r.DeceasedStatus || 'not alive'}`] };
  }
  if (String(r.IDBlocked || '').toUpperCase() === 'YES') {
    return { status: 'fail', reasons: ['ID number is blocked at Home Affairs'] };
  }

  let review = false;
  const wantLast  = _norm(investor.last_name);
  const gotLast   = _norm(r.LastName);
  if (wantLast && gotLast && wantLast !== gotLast) {
    review = true;
    reasons.push(`Surname differs: client "${investor.last_name}", Home Affairs "${r.LastName}"`);
  }
  const firstWanted = _tokens(investor.first_name)[0];
  const namesHeld   = _tokens(`${r.Names || ''} ${r.FirstName || ''}`);
  if (firstWanted && namesHeld.length && !namesHeld.includes(firstWanted)) {
    review = true;
    reasons.push(`First name differs: client "${investor.first_name}", Home Affairs "${r.Names || r.FirstName}"`);
  }
  const dobWanted = _isoDate(investor.date_of_birth);
  const dobHeld   = _isoDate(r.DateOfBirth);
  if (dobWanted && dobHeld && dobWanted !== dobHeld) {
    review = true;
    reasons.push(`Date of birth differs: client ${dobWanted}, Home Affairs ${dobHeld}`);
  }

  return { status: review ? 'manual_review' : 'pass', reasons };
}

/* ═══ Bank account verification (AVS) ═════════════════════════════ */

/* Universal branch codes, for when the client gave a bank but no branch.
   AVS requires one. Only banks whose universal code is not in doubt. */
const UNIVERSAL_BRANCH = [
  [/absa/,                    '632005'],
  [/capitec/,                 '470010'],
  [/\bfnb\b|first ?national/, '250655'],
  [/\brmb\b|rand ?merchant/,  '250655'],
  [/nedbank/,                 '198765'],
  [/standard ?bank/,          '051001'],
  [/investec/,                '580105'],
  [/african ?bank/,           '430000'],
  [/discovery/,               '679000'],
  [/tyme|gotyme/,             '678910'],
  [/bidvest/,                 '462005'],
  [/bank ?zero/,              '888000'],
];

function universalBranchCode(bankName) {
  const n = String(bankName || '').toLowerCase();
  for (const [re, code] of UNIVERSAL_BRANCH) if (re.test(n)) return code;
  return null;
}

/* The public enum is Current | Savings | Transmission | Bond |
   SubscriptionShare | Unknown; "cheque" is a current account. */
function _accountType(t) {
  const s = String(t || '').toLowerCase();
  if (/cheque|check|current/.test(s)) return 'Current';
  if (/saving/.test(s))               return 'Savings';
  if (/transmission/.test(s))         return 'Transmission';
  return 'Unknown';
}

function _initials(first, last) {
  return [..._tokens(first), ..._tokens(last)].map(t => t[0].toUpperCase()).join('');
}

/* Only the formats AVS accepts: 0XX XXX XXXX. */
function _localMobile(m) {
  let d = String(m || '').replace(/\D/g, '');
  if (d.startsWith('27') && d.length === 11) d = '0' + d.slice(2);
  return /^0\d{9}$/.test(d) ? d : undefined;
}

async function verifyBankAccount({
  reference, idNumber, identityType = 'IDNumber', firstName, lastName,
  accountNumber, branchCode, accountType, mobile, email,
}) {
  return _post('/v1/bank/account-verification', {
    ClientReference:   String(reference || `SVC-AVS-${Date.now()}`).slice(0, 50),
    Initials:          _initials(firstName, lastName) || undefined,
    FirstName:         firstName || undefined,
    Surname:           lastName || undefined,
    IdentityType:      identityType,
    IdentityNumber:    String(idNumber || '').replace(/\s+/g, ''),
    BankAccountNumber: String(accountNumber || '').replace(/\s+/g, ''),
    BankBranchCode:    String(branchCode || '').replace(/\s+/g, ''),
    BankAccountType:   _accountType(accountType),
    MobileNumber:      _localMobile(mobile),
    EmailAddress:      email || undefined,
  });
}

/* → { status, reasons }. What we need from the account is that money we
   pay out lands with this client: it exists, it is theirs, it is open and
   it takes credits. Those failing is a fail. A name or account-type
   difference with the identity matched is a human's call. */
function mapAvsResult(resp) {
  if (!resp || typeof resp !== 'object') return { status: 'error', reasons: ['no response'] };
  const code = Number(resp.ResponseCode);
  if (resp.Success !== true || code !== 0) {
    const msg = _messages(resp);
    if (code === 4) return { status: 'fail',          reasons: ['Bank has no record of this account'] };
    if (code === 6) return { status: 'manual_review', reasons: [`Bank details rejected as invalid${msg ? ': ' + msg : ''}`] };
    /* 5 = the bank is not in AVS real-time or could not be reached. Not the
       client's fault, and not ours to fix by retrying tonight. */
    if (code === 5) return { status: 'manual_review', reasons: [msg || 'Bank could not be verified in real time'] };
    return { status: 'error', reasons: [msg || `ResponseCode ${resp.ResponseCode}`] };
  }
  const a = resp.Avs || {};
  const yes = v => String(v || '').toLowerCase() === 'yes';
  const no  = v => String(v || '').toLowerCase() === 'no';

  if (!yes(a.accountFound))  return { status: 'fail', reasons: ['Account not found at the bank'] };
  if (no(a.identityMatch))   return { status: 'fail', reasons: ['Account is not held under this ID number'] };
  if (no(a.accountOpen))     return { status: 'fail', reasons: ['Account is closed'] };
  if (no(a.acceptsCredits))  return { status: 'fail', reasons: ['Account does not accept credits'] };

  const reasons = [];
  if (!yes(a.identityMatch)) reasons.push(`Identity not confirmed by the bank (${a.identityMatch || 'not returned'})`);
  if (no(a.nameMatch))        reasons.push('Surname differs from the bank\'s record');
  if (no(a.initialsMatch))    reasons.push('Initials differ from the bank\'s record');
  if (no(a.accountTypeMatch)) reasons.push('Account type differs from the bank\'s record');
  return { status: reasons.length ? 'manual_review' : 'pass', reasons };
}

/* ═══ Sanctions / PEP screening ═══════════════════════════════════ */
async function screenIndividual({ reference, firstName, lastName, dateOfBirth, idNumber, country = 'ZA' }) {
  const minScore = Math.min(100, Math.max(1,
    parseInt(process.env.DATANAMIX_SANCTIONS_MIN_SCORE, 10) || 75));
  const payload = {
    ClientReference: String(reference || `SVC-SANC-${Date.now()}`).slice(0, 50),
    Name:            `${firstName || ''} ${lastName || ''}`.trim(),
    Country:         country || 'ZA',
    MinScore:        minScore,
    Page:            1,
  };
  const dob = _isoDate(dateOfBirth);
  if (dob) payload.DateOfBirth = dob;
  if (idNumber) {
    payload.Identifier = String(idNumber).replace(/\s+/g, '');
    payload.IdentifierMatchBoostingThreshold = 90;
  }
  return _post('/v1/sanctions-standard/SanctionsIndividual', payload);
}

/* → { status: 'clear'|'hit'|'error', matches: [], reasons: [] }

   Only matches on a PERSON count. A search with Country: ZA also returns
   South Africa itself, from the FATF grey list — that is a fact about the
   country, true of every South African client, and flagging it would put
   the whole book into review. Any individual match is a hit: whether it is
   really this client is a compliance officer's decision, never ours. */
function mapSanctionsResult(resp) {
  if (!resp || typeof resp !== 'object') return { status: 'error', matches: [], reasons: ['no response'] };
  const code = Number(resp.ResponseCode);
  /* "No Record Found" is how a clean search can come back. */
  if (resp.Success === false && code === 4) {
    return { status: 'clear', matches: [], reasons: [] };
  }
  if (resp.Success === false || (resp.ResponseCode !== undefined && code !== 0)) {
    return { status: 'error', matches: [], reasons: [_messages(resp) || `ResponseCode ${resp.ResponseCode}`] };
  }
  const results = (resp.PossibleMatches && Array.isArray(resp.PossibleMatches.Results))
    ? resp.PossibleMatches.Results : [];
  const people = results.filter(m => String(m.EntityType || '').toLowerCase() === 'individual');
  const matches = people.map(m => ({
    name:       m.Name,
    score:      m.ConfidenceScore,
    list:       m.DataSource && (m.DataSource.ShortName || m.DataSource.Name),
    programmes: m.Program || [],
    dob:        m.DateOfBirth || [],
    nationality: m.Nationality || [],
    remarks:    m.Remarks || null,
    id:         m.SiIdentifier || (m.EntityNumber != null ? String(m.EntityNumber) : null),
  }));
  return {
    status:  matches.length ? 'hit' : 'clear',
    matches,
    reasons: matches.map(m => `Possible match on ${m.list || 'a watch list'}: ${m.name}`),
  };
}

/* ─── What an operator needs to know, without the secret ──────────── */
function describe() {
  const mode = env();
  let problem = null;
  if (mode) { try { _assertUsable(); } catch (e) { problem = e.message.replace(/^\[Datanamix\]\s*/, ''); } }
  return {
    enabled:     !!mode,
    environment: mode,
    baseUrl:     BASE_URL,
    credentials: !!(process.env.DATANAMIX_CLIENT_ID && process.env.DATANAMIX_CLIENT_SECRET),
    usable:      !!mode && !problem,
    problem,
  };
}

module.exports = {
  enabled, describe, getToken,
  verifyIdRealtime, mapIdResult,
  verifyBankAccount, mapAvsResult, universalBranchCode,
  screenIndividual, mapSanctionsResult,
  _resetToken,
};
