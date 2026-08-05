'use strict';
/* ═══════════════════════════════════════════════════════
   PE Document Extraction — POST /api/pe/extract-company
   Accepts a PDF (AFS, annual report, etc.), sends it to
   Claude, and returns structured company field data for
   pre-populating the Add Company form.
   ═══════════════════════════════════════════════════════ */

const router   = require('express').Router();
const multer   = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const { requireAuth } = require('../middleware/auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF, JPEG, PNG or WEBP files are accepted'), ok);
  },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `You are an expert financial analyst assistant. Carefully read the attached document (Annual Financial Statement, company profile, pitch deck, or similar) and extract the following company information.

Return ONLY a JSON object with these exact keys (omit any key you cannot find — do not guess):
{
  "name":                 "Company legal name",
  "sector":               "One of: Technology, Healthcare, Financial Services, Agriculture, Energy, Property, Retail, Manufacturing, Logistics, Media, Education, Mining, Other",
  "sub_sector":           "More specific industry niche (e.g. SaaS, Renewables, InsurTech)",
  "country":              "Country of incorporation or primary operations",
  "city":                 "City of headquarters",
  "description":          "1–3 sentence description of what the company does",
  "website":              "Company website URL",
  "registration_number":  "Company registration number",
  "vat_number":           "VAT registration number",
  "founded_year":         1234,
  "employee_count":       123,
  "contact_name":         "Primary contact full name",
  "contact_email":        "Primary contact email",
  "contact_phone":        "Primary contact phone number",
  "revenue":              123456.78,
  "ebitda":               123456.78,
  "net_profit":           123456.78,
  "total_assets":         123456.78,
  "total_equity":         123456.78,
  "financial_year_end":   "YYYY-MM-DD"
}

Rules:
- All monetary values must be numeric (no currency symbols or commas).
- founded_year and employee_count must be integers.
- For sector, map the company to the closest option in the list above.
- If the document is not in English, still return the JSON in English.
- Return ONLY the JSON — no markdown, no explanation.`;

router.post('/extract-company', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const b64    = req.file.buffer.toString('base64');
  const isPdf  = req.file.mimetype === 'application/pdf';
  const imgMap = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };

  try {
    let content;
    if (isPdf) {
      content = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: b64 },
        },
        { type: 'text', text: EXTRACTION_PROMPT },
      ];
    } else {
      content = [
        {
          type: 'image',
          source: { type: 'base64', media_type: imgMap[req.file.mimetype], data: b64 },
        },
        { type: 'text', text: EXTRACTION_PROMPT },
      ];
    }

    const response = await client.messages.create({
      model:      'claude-opus-5',
      max_tokens: 1024,
      thinking:   { type: 'adaptive' },
      messages:   [{ role: 'user', content }],
    });

    const raw = response.content.find(b => b.type === 'text')?.text || '{}';

    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const fields  = JSON.parse(cleaned);

    return res.json({ ok: true, fields });
  } catch (err) {
    console.error('[PE Extract]', err.message);
    return res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

/* ─────────────────────────────────────────────────────────
   POST /api/pe/extract-deal
   Extracts deal / pitch deck information to pre-fill the
   Add Deal form (company name, sector, amounts, thesis, etc.)
   ───────────────────────────────────────────────────────── */

const DEAL_EXTRACTION_PROMPT = `You are a private equity analyst. Carefully read the attached document (pitch deck, information memorandum, term sheet, or similar) and extract deal information.

Return ONLY a JSON object with these exact keys (omit any key you cannot find — do not guess):
{
  "company_name":        "Company or issuer name",
  "sector":              "One of: Technology, Healthcare, Financial Services, Agriculture, Energy, Property, Retail, Manufacturing, Logistics, Media, Education, Mining, Other",
  "deal_type":           "One of: equity, debt, hybrid, mezzanine, convertible",
  "target_amount":       123456.78,
  "committed_amount":    123456.78,
  "deal_description":    "2–4 sentence overview of the business and the transaction",
  "investment_thesis":   "2–3 sentence explanation of why this is a compelling investment",
  "key_risks":           "Main risks and mitigants in 2–3 sentences",
  "originator":          "Name of the person or firm that originated the deal",
  "source":              "How the deal was sourced (e.g. direct, referral, network)"
}

Rules:
- Monetary values must be numeric (no currency symbols or commas).
- deal_type must be one of the exact values listed.
- sector must be one of the exact values listed.
- Return ONLY the JSON — no markdown, no explanation.`;

router.post('/extract-deal', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const b64    = req.file.buffer.toString('base64');
  const isPdf  = req.file.mimetype === 'application/pdf';
  const imgMap = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };

  try {
    let content;
    if (isPdf) {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: DEAL_EXTRACTION_PROMPT },
      ];
    } else {
      content = [
        { type: 'image', source: { type: 'base64', media_type: imgMap[req.file.mimetype], data: b64 } },
        { type: 'text', text: DEAL_EXTRACTION_PROMPT },
      ];
    }

    const response = await client.messages.create({
      model:      'claude-opus-5',
      max_tokens: 1024,
      thinking:   { type: 'adaptive' },
      messages:   [{ role: 'user', content }],
    });

    const raw     = response.content.find(b => b.type === 'text')?.text || '{}';
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const fields  = JSON.parse(cleaned);

    return res.json({ ok: true, fields });
  } catch (err) {
    console.error('[PE Extract Deal]', err.message);
    return res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

/* ─────────────────────────────────────────────────────────
   POST /api/pe/extract-financials
   Reads an AFS PDF and returns structured financial data
   for pre-filling the Add Financials form.
   ───────────────────────────────────────────────────────── */

const FINANCIALS_EXTRACTION_PROMPT = `You are a chartered accountant and financial analyst. Carefully read the attached Annual Financial Statement (AFS) and extract the financial data.

Return ONLY a JSON object with these exact keys (omit any key where the value cannot be reliably determined — do not guess or derive values not explicitly stated):
{
  "financial_year":       2024,
  "audited":              true,
  "revenue":              123456.78,
  "gross_profit":         123456.78,
  "ebitda":               123456.78,
  "ebit":                 123456.78,
  "net_profit":           123456.78,
  "ebitda_margin":        0.2500,
  "net_margin":           0.1000,
  "revenue_growth":       0.1500,
  "total_assets":         123456.78,
  "total_liabilities":    123456.78,
  "equity":               123456.78,
  "cash":                 123456.78,
  "total_debt":           123456.78,
  "operating_cashflow":   123456.78,
  "free_cashflow":        123456.78,
  "capex":                123456.78
}

Rules:
- financial_year is the calendar year in which the financial period ENDS (integer).
- audited is true if the statements are audited, false if reviewed or unaudited.
- All monetary values must be plain numbers (no currency symbols, commas, or spaces). Use negative numbers for losses.
- Margins and growth rates must be expressed as decimals (e.g. 25% → 0.25).
- If EBITDA is not stated but EBIT is, do NOT estimate EBITDA — omit it.
- If a margin or growth rate is not stated, derive it only if BOTH inputs are present (e.g. ebitda_margin = ebitda / revenue when both are available).
- Return ONLY the JSON — no markdown fences, no explanation.`;

router.post('/extract-financials', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const b64    = req.file.buffer.toString('base64');
  const isPdf  = req.file.mimetype === 'application/pdf';
  const imgMap = { 'image/jpeg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };

  try {
    let content;
    if (isPdf) {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: FINANCIALS_EXTRACTION_PROMPT },
      ];
    } else {
      content = [
        { type: 'image', source: { type: 'base64', media_type: imgMap[req.file.mimetype], data: b64 } },
        { type: 'text', text: FINANCIALS_EXTRACTION_PROMPT },
      ];
    }

    const response = await client.messages.create({
      model:      'claude-opus-5',
      max_tokens: 1024,
      thinking:   { type: 'adaptive' },
      messages:   [{ role: 'user', content }],
    });

    const raw     = response.content.find(b => b.type === 'text')?.text || '{}';
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const fields  = JSON.parse(cleaned);

    return res.json({ ok: true, fields });
  } catch (err) {
    console.error('[PE Extract Financials]', err.message);
    return res.status(500).json({ error: err.message || 'Extraction failed' });
  }
});

module.exports = router;
