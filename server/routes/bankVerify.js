/* ═══════════════════════════════════════════════════════════════
   Bank Document Auto-Verification
   POST /api/admin/bank-verify/:investorId
   Reads the investor's latest proof_of_bank KYC document, sends it
   to Claude, and compares the extracted details against the investor
   record. Requires ANTHROPIC_API_KEY env var.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL             = 'claude-haiku-4-5-20251001';

/* ── normalise a value for fuzzy comparison ─────────────────── */
function _norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_\.]/g, '');
}

function _namesMatch(a, b) {
  const na = _norm(a), nb = _norm(b);
  if (!na || !nb) return null; // unknown
  if (na === nb) return true;
  // partial: one contains the other (handles "Kagiso" vs "Kagiso Tloubatla")
  return na.includes(nb) || nb.includes(na);
}

/* ── call Claude API ────────────────────────────────────────── */
async function _claudeExtract(fileData, fileName) {
  if (!ANTHROPIC_API_KEY) return null;

  // Determine media type from data URL prefix
  let mediaType = 'application/pdf';
  let base64Data = fileData;
  const match = fileData.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    mediaType = match[1];
    base64Data = match[2];
  }

  const isImage = mediaType.startsWith('image/');
  const contentBlock = isImage
    ? { type: 'image',    source: { type: 'base64', media_type: mediaType, data: base64Data } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } };

  const prompt = `You are verifying a South African bank proof-of-account document.
Extract the following fields exactly as they appear in the document. If a field is not clearly visible, return null for that field.

Return ONLY a JSON object with these exact keys (no other text):
{
  "bank_name": string | null,
  "account_holder": string | null,
  "account_number": string | null,
  "account_type": string | null,
  "branch_code": string | null
}

Document: ${fileName || 'bank proof'}`;

  const body = {
    model: MODEL,
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: [contentBlock, { type: 'text', text: prompt }],
    }],
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error('[bank-verify] Claude API error:', err.slice(0, 300));
    return null;
  }

  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  // Strip markdown code fences if present
  const jsonStr = text.replace(/```(?:json)?\n?/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    console.error('[bank-verify] Could not parse Claude response:', text.slice(0, 300));
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   POST /api/admin/bank-verify/:investorId
══════════════════════════════════════════════════════════════ */
router.post('/bank-verify/:investorId', requireAuth, requireRole('admin', 'director', 'fund_manager'), async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI verification not configured — set ANTHROPIC_API_KEY.' });
  }

  const { investorId } = req.params;

  try {
    // 1. Fetch investor bank details
    const { rows: invRows } = await pool.query(
      'SELECT bank_name, bank_account_holder, bank_account_number, bank_account_type, bank_branch_code FROM investors WHERE id = $1',
      [investorId]
    );
    if (!invRows[0]) return res.status(404).json({ error: 'Investor not found.' });
    const inv = invRows[0];

    // 2. Fetch most recent proof_of_bank KYC document
    const { rows: docRows } = await pool.query(
      `SELECT id, file_name, file_data, file_url, submitted_at
       FROM kyc_documents
       WHERE investor_id = $1 AND doc_type = 'proof_of_bank'
       ORDER BY submitted_at DESC LIMIT 1`,
      [investorId]
    );
    if (!docRows[0]) {
      return res.status(404).json({ error: 'No proof-of-bank document found for this investor.' });
    }
    const doc = docRows[0];

    const rawData = doc.file_data || doc.file_url || '';
    if (!rawData) {
      return res.status(422).json({ error: 'Document has no file data — investor may need to re-upload.' });
    }

    // 3. Extract details via Claude
    const extracted = await _claudeExtract(rawData, doc.file_name || 'bank_proof');
    if (!extracted) {
      return res.status(422).json({ error: 'Could not extract details from document. The file may be unreadable or corrupted.' });
    }

    // 4. Compare extracted vs submitted
    const checks = {
      bank_name:      { label: 'Bank Name',       submitted: inv.bank_name,            extracted: extracted.bank_name },
      account_holder: { label: 'Account Holder',  submitted: inv.bank_account_holder,  extracted: extracted.account_holder },
      account_number: { label: 'Account Number',  submitted: inv.bank_account_number,  extracted: extracted.account_number },
      account_type:   { label: 'Account Type',    submitted: inv.bank_account_type,    extracted: extracted.account_type },
      branch_code:    { label: 'Branch Code',     submitted: inv.bank_branch_code,     extracted: extracted.branch_code },
    };

    const results = {};
    let matchCount = 0, checkCount = 0, unknownCount = 0;

    for (const [field, c] of Object.entries(checks)) {
      if (!c.extracted) {
        results[field] = { ...c, status: 'unknown' };
        unknownCount++;
        continue;
      }
      checkCount++;
      let match;
      if (field === 'account_holder') {
        match = _namesMatch(c.submitted, c.extracted);
      } else if (field === 'account_type') {
        // 'current' matches 'cheque', 'checking' etc — partial match ok
        match = _norm(c.submitted).includes(_norm(c.extracted)) || _norm(c.extracted).includes(_norm(c.submitted));
      } else {
        match = _norm(c.submitted) === _norm(c.extracted);
      }
      if (match === null) { unknownCount++; results[field] = { ...c, status: 'unknown' }; }
      else if (match)     { matchCount++;   results[field] = { ...c, status: 'match'   }; }
      else                {                 results[field] = { ...c, status: 'mismatch' }; }
    }

    // 5. Derive overall verdict
    const mismatches  = Object.values(results).filter(r => r.status === 'mismatch');
    const criticalMis = mismatches.filter(r => ['account_number', 'account_holder'].includes(
      Object.keys(results).find(k => results[k] === r)
    ));

    let verdict, confidence;
    if (checkCount === 0) {
      verdict    = 'unreadable';
      confidence = 0;
    } else if (mismatches.length === 0) {
      verdict    = 'match';
      confidence = Math.round((matchCount / (checkCount + unknownCount)) * 100);
    } else if (criticalMis.length > 0) {
      verdict    = 'mismatch';
      confidence = Math.round((matchCount / (checkCount + unknownCount)) * 100);
    } else {
      verdict    = 'partial';
      confidence = Math.round((matchCount / (checkCount + unknownCount)) * 100);
    }

    console.log(`[bank-verify] ${investorId} → ${verdict} (${confidence}%)`);

    res.json({ verdict, confidence, checks: results, docId: doc.id, docName: doc.file_name });
  } catch (err) {
    console.error('[bank-verify] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
