/* ═══════════════════════════════════════════════════════
   Smile Identity — ID & Passport Verification Client
   Docs: docs.smileidentity.com/v1/id-verification

   Env vars required:
     SMILE_PARTNER_ID   — from Smile Identity dashboard
     SMILE_API_KEY      — from Smile Identity dashboard
     SMILE_SANDBOX      — 'true' (default) | 'false'
   ═══════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

const SANDBOX    = process.env.SMILE_SANDBOX === 'true';
console.log('[Smile] Running in', SANDBOX ? 'SANDBOX' : 'PRODUCTION', 'mode');
const PARTNER_ID = process.env.SMILE_PARTNER_ID || '';
const API_KEY    = process.env.SMILE_API_KEY    || '';

const BASE_URL = SANDBOX
  ? 'https://testapi.smileidentity.com/v1'
  : 'https://api.smileidentity.com/v1';

/* ─── Generate HMAC-SHA256 signature ─────────────────────────────────────
   Smile expects: Base64( HMAC-SHA256( timestamp + partner_id, api_key ) )
────────────────────────────────────────────────────────────────────────── */
function _sig(timestamp) {
  return Buffer.from(
    crypto.createHmac('sha256', API_KEY)
      .update(timestamp + PARTNER_ID)
      .digest()
  ).toString('base64');
}

function _basePayload() {
  const timestamp = new Date().toISOString();
  return { partner_id: PARTNER_ID, timestamp, signature: _sig(timestamp) };
}

/* ─── Verify an SA ID or international ID via Enhanced KYC ───────────── */
async function verifyID({ idNumber, idType = 'NATIONAL_ID', country = 'ZA', firstName, lastName, dob = '' }) {
  if (!PARTNER_ID || !API_KEY) {
    throw new Error('[Smile] SMILE_PARTNER_ID and SMILE_API_KEY are required. Set these env vars before processing KYC.');
  }

  const body = {
    ..._basePayload(),
    country,
    id_type:   idType,
    id_number: idNumber,
    first_name: firstName || '',
    last_name:  lastName  || '',
    dob:        dob || '',
    partner_params: {
      job_id:   `JOB-${Date.now()}`,
      user_id:  idNumber,
      job_type: 5,
    },
  };

  const res  = await fetch(`${BASE_URL}/id_verification`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || `Smile HTTP ${res.status}`);
  return data;
}

/* ─── Verify a passport (same endpoint, type=PASSPORT) ───────────────── */
async function verifyPassport({ passportNumber, country = 'ZW', firstName, lastName }) {
  return verifyID({
    idNumber:  passportNumber,
    idType:    'PASSPORT',
    country:   country.toUpperCase(),
    firstName,
    lastName,
  });
}

/* ─── Verify incoming webhook signature ──────────────────────────────── */
function verifyWebhook(body, receivedSig) {
  if (!API_KEY) return false;
  const ts       = body.timestamp;
  if (!ts) return false;
  const expected = _sig(ts);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(receivedSig || '', 'utf8')
    );
  } catch {
    return false;
  }
}

/* ─── Map Smile result codes to internal status ──────────────────────── */
function mapResult(data) {
  const code = String(data.ResultCode || data.result_code || '');
  if (code === '0810') return 'pass';            // Verified
  if (code === '0814') return 'manual_review';   // Partial / awaiting review
  if (code === '0811') return 'manual_review';   // Awaiting liveness
  if (code === '0813') return 'manual_review';   // Document review needed
  return 'fail';                                 // 0820/0821/0822/0823
}

/* ─── Sandbox pass stub (when credentials not configured) ────────────── */
function _sandboxPass(idType, idNumber) {
  return {
    ResultCode:  '0810',
    ResultText:  'Verified',
    SmileJobID:  `SANDBOX-${Date.now()}`,
    sandbox:     true,
    Actions: {
      Verify_ID_Number:    'Verified',
      Return_Personal_Info: 'Returned',
    },
    PartnerParams: { user_id: idNumber, job_type: 5 },
  };
}

module.exports = { verifyID, verifyPassport, verifyWebhook, mapResult };
