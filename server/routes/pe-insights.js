'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   PE Monitor — everything the console cannot work out for itself.

   GET    /api/pe/company/:id/summary     financial position, fees, AFS, BEE
   GET    /api/pe/afs-due                 AFS reminders across the book
   GET    /api/pe/company/:id/fee-schedule escalating fee, gross and SVC share
   POST   /api/pe/company/:id/archive     take a client off the list
   POST   /api/pe/company/:id/unarchive
   DELETE /api/pe/company/:id             permanent, and refuses if it would
                                          take history with it
   POST   /api/pe/xero-invoices           import a Xero invoice export

   The arithmetic is all in services/peFinance.js so the console, these routes
   and the check suite cannot disagree about a number.
   ═══════════════════════════════════════════════════════════════════════════ */

const router = require('express').Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const F = require('../services/peFinance');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ── GET /company/:id/summary ─────────────────────────────────────────────── */
router.get('/company/:id/summary', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const [coRes, finRes, feeRes, beeRes, afsRes] = await Promise.all([
      pool.query('SELECT * FROM pe_companies WHERE id = $1', [id]),
      pool.query('SELECT * FROM pe_financials WHERE company_id = $1 ORDER BY financial_year DESC', [id]),
      pool.query('SELECT * FROM pe_fees WHERE company_id = $1 ORDER BY COALESCE(invoice_date, period_start) DESC', [id]),
      pool.query('SELECT * FROM pe_bee_verifications WHERE company_id = $1 ORDER BY verification_year DESC', [id]),
      pool.query('SELECT * FROM pe_afs_requests WHERE company_id = $1', [id]),
    ]);
    const company = coRes.rows[0];
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const financials = finRes.rows;
    const latest = financials[0] || null;
    const prior  = financials[1] || null;

    /* The position is read off the most recent year on file, compared with the
       one before it. With nothing on file there is no position to read — and
       saying so is different from saying everything is fine. */
    const assessment = latest ? F.assessFinancials(latest, prior) : {
      verdict: 'unknown', flags: [], metrics: {},
      summary: 'No financial statements on file — nothing to assess.',
    };

    /* EBITDA per year, so the trend is visible and each derived figure can be
       audited against the lines it came from. */
    const ebitdaByYear = financials.map(f => {
      const e = F.computeEbitda(f);
      return {
        financial_year: f.financial_year,
        ebitda: e.value, source: e.source, complete: e.complete,
        missing: e.missing, components: e.components,
      };
    });

    const revenue = F.lifetimeRevenue(feeRes.rows, company);
    const schedule = F.feeSchedule(company, { years: 5 });

    /* AFS: one entry per financial year we would expect statements for, with
       what somebody has actually done about it merged in. */
    const afsByYear = new Map(afsRes.rows.map(r => [Number(r.financial_year), r]));
    const afsYears = F.financialYearOptions(company, null, 4, 0).map(year => {
      const sched = F.afsSchedule(company, year);
      const tracked = afsByYear.get(year) || null;
      const onFile = financials.some(f => Number(f.financial_year) === year);
      return {
        financial_year: year,
        ...(sched || {}),
        tracked_status: tracked ? tracked.status : null,
        requested_date: tracked ? tracked.requested_date : null,
        received_date:  tracked ? tracked.received_date : null,
        /* Statements on file settle it regardless of what the tracker says —
           a reminder that keeps firing after the AFS arrived is a reminder
           people learn to ignore. */
        settled: onFile || (tracked && ['received', 'waived'].includes(tracked.status)),
      };
    });

    const bee = beeRes.rows.map(r => ({
      ...r,
      expired: r.expiry_date ? new Date(r.expiry_date) < new Date() : null,
    }));

    res.json({
      ok: true,
      company,
      assessment,
      ebitda_by_year: ebitdaByYear,
      financials,
      lifetime_revenue: revenue,
      fee_schedule: schedule,
      afs: afsYears,
      bee,
      financial_year_options: F.financialYearOptions(company),
    });
  } catch (err) {
    console.error('[pe-insights summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /company/:id/fee-schedule?years=N ───────────────────────────────── */
router.get('/company/:id/fee-schedule', requireAuth, async (req, res) => {
  const years = Math.max(1, Math.min(30, parseInt(req.query.years, 10) || 5));
  try {
    const { rows } = await pool.query('SELECT * FROM pe_companies WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, ...F.feeSchedule(rows[0], { years }) });
  } catch (err) {
    console.error('[pe-insights fee-schedule]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /afs-due ─────────────────────────────────────────────────────────
   Statements are requested three months after year end. The reminder is only
   useful if it stops once the statements arrive, so a year with financials on
   file, or marked received or waived, never appears here. */
router.get('/afs-due', requireAuth, async (req, res) => {
  try {
    const [coRes, finRes, afsRes] = await Promise.all([
      pool.query(`SELECT id, name, financial_year_end_month, status
                    FROM pe_companies
                   WHERE COALESCE(archived, false) = false
                     AND financial_year_end_month IS NOT NULL`),
      pool.query('SELECT company_id, financial_year FROM pe_financials'),
      pool.query('SELECT company_id, financial_year, status FROM pe_afs_requests'),
    ]);
    const onFile  = new Set(finRes.rows.map(r => `${r.company_id}:${r.financial_year}`));
    const tracked = new Map(afsRes.rows.map(r => [`${r.company_id}:${r.financial_year}`, r.status]));

    const due = [];
    for (const co of coRes.rows) {
      for (const year of F.financialYearOptions(co, null, 3, 0)) {
        const key = `${co.id}:${year}`;
        if (onFile.has(key)) continue;
        const state = tracked.get(key);
        if (state === 'received' || state === 'waived') continue;
        const sched = F.afsSchedule(co, year);
        if (!sched || sched.status === 'not_yet') continue;
        due.push({
          company_id: co.id, company_name: co.name, company_status: co.status,
          ...sched, tracked_status: state || 'outstanding',
        });
      }
    }
    /* Oldest year end first — the one that has been outstanding longest is the
       one to chase. */
    due.sort((a, b) => (a.year_end < b.year_end ? -1 : a.year_end > b.year_end ? 1 : 0));
    res.json({ ok: true, due, overdue_count: due.filter(d => d.status === 'overdue').length });
  } catch (err) {
    console.error('[pe-insights afs-due]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Archive / unarchive / delete ─────────────────────────────────────────
   The book had a client entered twice. Deleting one is the obvious move and
   the wrong one: pe_financials, pe_fees, pe_updates and pe_reviews all cascade
   on delete, so removing the duplicate takes its history with it — and on a
   duplicate you cannot always tell in advance which of the two rows the
   invoices were filed against. Archiving is therefore the default, and delete
   refuses when it would destroy anything. */
router.post('/company/:id/archive', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE pe_companies
          SET archived = true, archived_at = NOW(), archived_by = $2, archived_reason = $3, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id, (req.user && (req.user.email || req.user.id)) || null, req.body?.reason || null]
    );
    if (!rowCount) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, archived: true });
  } catch (err) {
    console.error('[pe-insights archive]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/company/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE pe_companies
          SET archived = false, archived_at = NULL, archived_by = NULL, archived_reason = NULL, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Company not found' });
    res.json({ ok: true, archived: false });
  } catch (err) {
    console.error('[pe-insights unarchive]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/company/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows } = await pool.query('SELECT id, name FROM pe_companies WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Company not found' });

    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM pe_financials       WHERE company_id = $1) AS financials,
        (SELECT COUNT(*) FROM pe_fees             WHERE company_id = $1) AS fees,
        (SELECT COUNT(*) FROM pe_updates          WHERE company_id = $1) AS updates,
        (SELECT COUNT(*) FROM pe_reviews          WHERE company_id = $1) AS reviews,
        (SELECT COUNT(*) FROM pe_documents        WHERE company_id = $1) AS documents,
        (SELECT COUNT(*) FROM pe_meeting_notes    WHERE company_id = $1) AS meeting_notes,
        (SELECT COUNT(*) FROM pe_bee_verifications WHERE company_id = $1) AS bee`, [id]);
    const c = counts.rows[0];
    const attached = Object.entries(c)
      .map(([k, v]) => [k, Number(v)])
      .filter(([, v]) => v > 0);

    /* force is deliberately not a query-string flag the console sets by
       default: destroying a fee history is a decision, and it should read like
       one at the call site. */
    if (attached.length && String(req.body?.force) !== 'true') {
      return res.status(409).json({
        error: 'This company has records attached. Archive it instead, or repeat with force to delete it and everything filed against it.',
        attached: Object.fromEntries(attached),
        suggestion: 'archive',
      });
    }

    await pool.query('DELETE FROM pe_documents WHERE company_id = $1', [id]);
    await pool.query('DELETE FROM pe_companies WHERE id = $1', [id]);
    res.json({ ok: true, deleted: id, removed: Object.fromEntries(attached) });
  } catch (err) {
    console.error('[pe-insights delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Xero invoice import ──────────────────────────────────────────────────
   Xero exports invoices as CSV. The column names differ between the Sales
   Invoices export, the Invoices list export and an accountant's saved layout,
   so headers are matched by meaning rather than by position, and the parse
   reports what it could not find instead of silently importing zeros.

   Each invoice becomes a pe_fees row with source='xero', keyed on the Xero
   invoice number so re-importing the same export updates rather than
   duplicates — an operator will re-upload, and a doubled revenue figure is
   worse than no revenue figure. */

/* RFC 4180: quoted fields, doubled quotes inside them, newlines inside
   quotes. A split on commas gets every Xero export with a comma in a contact
   name wrong, and gets it wrong quietly. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');   // Excel writes a BOM
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const XERO_FIELDS = {
  invoice_number: ['invoicenumber', 'invoiceno', 'number', 'reference', 'invoicereference'],
  contact:        ['contactname', 'contact', 'customer', 'client', 'to'],
  invoice_date:   ['invoicedate', 'date', 'issuedate'],
  due_date:       ['duedate', 'datedue'],
  total:          ['total', 'invoicetotal', 'grosstotal', 'totalincltax', 'amount'],
  subtotal:       ['subtotal', 'netamount', 'totalexcltax'],
  amount_paid:    ['amountpaid', 'paid', 'totalpaid'],
  amount_due:     ['amountdue', 'balance', 'outstanding'],
  status:         ['status', 'invoicestatus'],
  currency:       ['currency', 'currencycode'],
  paid_date:      ['paiddate', 'datepaid', 'fullypaiddate'],
};

function mapHeaders(headers) {
  const seen = headers.map(norm);
  const layout = {};
  for (const [key, aliases] of Object.entries(XERO_FIELDS)) {
    /* Exact alias first, then a prefix match, so "Total (ZAR)" still lands on
       total but "Total Tax" does not land on it ahead of "Total". */
    let idx = seen.findIndex(h => aliases.includes(h));
    if (idx < 0) idx = seen.findIndex(h => aliases.some(a => h === a + 'zar' || h.startsWith(a) && h.length <= a.length + 4));
    if (idx >= 0) layout[key] = idx;
  }
  return layout;
}

function cell(row, layout, key) {
  const i = layout[key];
  return i === undefined ? '' : String(row[i] ?? '').trim();
}

/* Xero writes dates as dd/mm/yyyy in most South African organisations and as
   yyyy-mm-dd in the API export. Guessing wrong turns March into a different
   month, so an ambiguous dd/mm value is only read as dd/mm — the org setting
   this is exported under — and anything else is left null rather than
   invented. */
function parseXeroDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0');
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `${m[3]}-${mo}-${d}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseAmount(v) {
  const s = String(v || '').replace(/[^0-9.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function xeroStatus(raw, amountDue, paidDate) {
  const s = String(raw || '').toUpperCase();
  if (s.includes('PAID')) return 'paid';
  if (s.includes('VOID') || s.includes('DELET')) return 'waived';
  if (s.includes('DRAFT')) return 'projected';
  if (paidDate) return 'paid';
  if (amountDue !== null && amountDue <= 0) return 'paid';
  return 'invoiced';
}

router.post('/xero-invoices', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const companyId = req.body.company_id;
  if (!companyId) return res.status(400).json({ error: 'company_id required' });
  const dryRun = String(req.body.dry_run) === 'true';

  try {
    const coRes = await pool.query('SELECT * FROM pe_companies WHERE id = $1', [companyId]);
    const company = coRes.rows[0];
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const name = String(req.file.originalname || '');
    if (!/\.csv$/i.test(name) && !String(req.file.mimetype).includes('csv') && !String(req.file.mimetype).includes('text')) {
      return res.status(400).json({
        error: 'Upload the Xero export as CSV. In Xero: Business → Invoices → Export. An .xlsx workbook cannot be read here — save it as CSV first.',
      });
    }

    const rows = parseCsv(req.file.buffer.toString('utf8'));
    if (rows.length < 2) return res.status(400).json({ error: 'The file has no data rows.' });

    const layout = mapHeaders(rows[0]);
    if (layout.invoice_number === undefined || layout.total === undefined) {
      return res.status(400).json({
        error: 'Could not find an invoice number and a total in this export.',
        headers_seen: rows[0],
        need: 'Columns named something like "Invoice Number" and "Total".',
      });
    }

    const svcPct = F.num(company.svc_share_pct) === null ? 0.51 : F.num(company.svc_share_pct);
    const parsed = [], skipped = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const number = cell(r, layout, 'invoice_number');
      const total  = parseAmount(cell(r, layout, 'total'));
      if (!number) { skipped.push({ line: i + 1, reason: 'no invoice number' }); continue; }
      if (total === null) { skipped.push({ line: i + 1, invoice: number, reason: 'no total' }); continue; }

      const invDate  = parseXeroDate(cell(r, layout, 'invoice_date'));
      const dueDate  = parseXeroDate(cell(r, layout, 'due_date'));
      const paidDate = parseXeroDate(cell(r, layout, 'paid_date'));
      const due      = parseAmount(cell(r, layout, 'amount_due'));
      const status   = xeroStatus(cell(r, layout, 'status'), due, paidDate);

      /* An invoice line with no date cannot be placed in a period, and a
         pe_fees row needs one. The invoice date is the period it belongs to
         when nothing better is on the export. */
      const periodStart = invDate || dueDate;
      if (!periodStart) { skipped.push({ line: i + 1, invoice: number, reason: 'no usable date' }); continue; }

      parsed.push({
        invoice_number: number,
        contact: cell(r, layout, 'contact') || null,
        invoice_date: invDate,
        due_date: dueDate || F.invoiceDueDate(invDate, company),
        paid_date: status === 'paid' ? (paidDate || invDate) : null,
        gross_amount: F.round2(total),
        svc_share_amount: F.round2(total * svcPct),
        svc_share_pct: svcPct,
        status,
        currency: cell(r, layout, 'currency') || 'ZAR',
        period_start: periodStart,
        period_end: dueDate || periodStart,
      });
    }

    if (dryRun) {
      return res.json({
        ok: true, dry_run: true, matched_columns: Object.keys(layout),
        parsed_count: parsed.length, skipped, preview: parsed.slice(0, 20),
        would_total: F.round2(parsed.reduce((s, p) => s + p.gross_amount, 0)),
      });
    }

    let inserted = 0, updated = 0;
    for (const p of parsed) {
      /* Keyed on the Xero invoice number for this company. A second upload of
         the same export refreshes the rows rather than doubling the revenue. */
      const existing = await pool.query(
        `SELECT id FROM pe_fees WHERE company_id = $1 AND xero_invoice_id = $2 LIMIT 1`,
        [companyId, p.invoice_number]
      );
      if (existing.rows[0]) {
        await pool.query(
          `UPDATE pe_fees SET amount=$2, gross_amount=$3, svc_share_pct=$4, svc_share_amount=$5,
                  status=$6, invoice_date=$7, due_date=$8, paid_date=$9, invoice_number=$10,
                  currency=$11, source='xero', updated_at=NOW()
            WHERE id=$1`,
          [existing.rows[0].id, p.gross_amount, p.gross_amount, p.svc_share_pct, p.svc_share_amount,
           p.status, p.invoice_date, p.due_date, p.paid_date, p.invoice_number, p.currency]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO pe_fees (id, company_id, period_start, period_end, fee_type, amount,
                                gross_amount, svc_share_pct, svc_share_amount, status,
                                invoice_date, due_date, paid_date, invoice_number,
                                currency, source, xero_invoice_id, notes)
           VALUES ($1,$2,$3,$4,'management',$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,'xero',$12,$14)`,
          ['pefee-' + uuidv4(), companyId, p.period_start, p.period_end, p.gross_amount,
           p.svc_share_pct, p.svc_share_amount, p.status, p.invoice_date, p.due_date,
           p.paid_date, p.invoice_number, p.currency,
           p.contact ? `Imported from Xero — ${p.contact}` : 'Imported from Xero']
        );
        inserted++;
      }
    }

    const after = await pool.query('SELECT * FROM pe_fees WHERE company_id = $1', [companyId]);
    res.json({
      ok: true, inserted, updated, skipped,
      matched_columns: Object.keys(layout),
      lifetime_revenue: F.lifetimeRevenue(after.rows, company),
    });
  } catch (err) {
    console.error('[pe-insights xero-invoices]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._internals = { parseCsv, mapHeaders, parseXeroDate, parseAmount, xeroStatus };
