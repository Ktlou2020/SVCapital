/* ═══════════════════════════════════════════════════════
   Stitch — Bank Account Verification Client
   Docs: docs.stitch.money

   Env vars required:
     STITCH_CLIENT_ID      — from Stitch dashboard
     STITCH_CLIENT_SECRET  — from Stitch dashboard
     STITCH_SANDBOX        — 'true' (default) | 'false'
   ═══════════════════════════════════════════════════════ */
'use strict';

const CLIENT_ID     = process.env.STITCH_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.STITCH_CLIENT_SECRET || '';
const SANDBOX       = process.env.STITCH_SANDBOX !== 'false';

const TOKEN_URL = 'https://secure.stitch.money/connect/token';
const GQL_URL   = SANDBOX
  ? 'https://api.stitch.money/graphql/test'
  : 'https://api.stitch.money/graphql';

/* ─── Token cache (client credentials — not user-specific) ──────────── */
let _cachedToken  = null;
let _tokenExpiry  = 0;

async function _getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience:      'https://secure.stitch.money/connect/token',
      scope:         'accounts',
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || `Stitch token HTTP ${res.status}`);

  _cachedToken = data.access_token;
  // Expire 60 s before actual expiry to avoid edge cases
  _tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _cachedToken;
}

/* ─── Verify a bank account holder name against an account number ─────
   Returns: { verified: bool, matchScore: 0-100, accountName: string }
────────────────────────────────────────────────────────────────────────── */
async function verifyBankAccount({ accountNumber, bankId, accountHolder }) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[Stitch] No credentials — returning sandbox pass.');
    return _sandboxPass(accountHolder);
  }

  const token = await _getToken();

  /* Stitch normalises bank IDs to snake_case lowercase, e.g. "fnb", "standard_bank" */
  const normBankId = (bankId || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  const query = `
    mutation VerifyAccount($input: AccountVerificationInput!) {
      accountVerification(input: $input) {
        accountHolderName
        accountNumber
        bankId
        matchScore
        verified
      }
    }
  `;

  const res = await fetch(GQL_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          accountNumber:     accountNumber,
          bankId:            normBankId,
          accountHolderName: accountHolder,
        },
      },
    }),
  });

  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0]?.message || 'Stitch GraphQL error');
  return data.data?.accountVerification || {};
}

/* ─── Map a bank name string to Stitch bankId ─────────────────────────
   Stitch bank IDs: fnb, standard_bank, absa, nedbank, capitec,
                    discovery, investec, tyme_bank, african_bank
────────────────────────────────────────────────────────────────────────── */
function normaliseBankId(name) {
  const map = {
    fnb:            'fnb',
    'first national': 'fnb',
    standard:       'standard_bank',
    'standard bank': 'standard_bank',
    absa:           'absa',
    nedbank:        'nedbank',
    capitec:        'capitec',
    discovery:      'discovery',
    investec:       'investec',
    tyme:           'tyme_bank',
    tymebank:       'tyme_bank',
    african:        'african_bank',
    'african bank': 'african_bank',
  };
  const key = (name || '').toLowerCase().trim();
  for (const [k, v] of Object.entries(map)) {
    if (key.includes(k)) return v;
  }
  return key; // pass through and let Stitch handle the error
}

function _sandboxPass(accountHolder) {
  return {
    verified:          true,
    matchScore:        100,
    accountHolderName: accountHolder,
    sandbox:           true,
  };
}

module.exports = { verifyBankAccount, normaliseBankId };
