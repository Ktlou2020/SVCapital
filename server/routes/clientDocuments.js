'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Everything a client has uploaded — /api/client-documents/*

   The files were always there; finding them was the problem. FICA documents
   sit in kyc_documents and are reachable from the FICA queue; a deposit slip
   or a bank letter attached to a support ticket sits on the ticket and is
   reachable only by remembering which ticket it was. Somebody asking "did
   this client ever send us their proof of address" had two screens to search
   and no way to be sure they had searched both.

   One list, per client, newest first.

   The list deliberately does NOT carry the files. kyc_documents.file_data is
   a base64 data URI — a photographed ID is comfortably two megabytes — and a
   client with six of them would make opening their record a twelve-megabyte
   download before a single row appeared. The list carries what is needed to
   decide which document you want; the file is fetched when you ask for it.
   ═══════════════════════════════════════════════════════════════════ */

const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

/* The same roles that can already read kyc_documents through the table API.
   A narrower list here would be a second opinion about who may see a client's
   ID, and two opinions is how one of them goes stale. */
const requireStaff = [requireAuth, requireRole('admin', 'director', 'fund_manager')];

const LABELS = {
  id: 'ID Document', id_document: 'ID Document', passport: 'Passport',
  proof_of_address: 'Proof of Address', address: 'Proof of Address',
  proof_of_bank: 'Proof of Bank Account', bank_statement: 'Bank Statement',
  selfie: 'Selfie / Live Photo', tax: 'Tax Certificate (SARS)',
  payslip: 'Payslip', other: 'Other Document',
};
const labelFor = t => LABELS[t] || String(t || 'Document').replace(/_/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());

/* A data URI's media type, or the extension, or nothing. Used only to choose
   an icon and decide whether it can be shown inline. */
function kindOf(src, name) {
  const s = String(src || '');
  const m = s.match(/^data:([^;,]+)/);
  if (m) return m[1];
  const ext = String(name || s).split('?')[0].split('.').pop().toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
            webp: 'image/webp', pdf: 'application/pdf' })[ext] || '';
}

/* Base64 inflates by 4/3, so this is the stored size rather than the file's —
   near enough to tell a scan from a screenshot, and it costs nothing. */
const sizeOf = src => {
  const s = String(src || '');
  const b64 = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : '';
  return b64 ? Math.round(b64.length * 0.75) : null;
};

/* ─── GET /:investorId ────────────────────────────────────────────── */
router.get('/:investorId', requireStaff, async (req, res) => {
  const investorId = req.params.investorId;
  try {
    const [kyc, tickets] = await Promise.all([
      pool.query(
        `SELECT id, doc_type, doc_subtype, file_name, status, notes,
                submitted_at, created_at, reviewed_at, reviewed_by, expiry_date,
                (file_data IS NOT NULL AND file_data <> '') AS has_data,
                LEFT(COALESCE(file_data, ''), 64) AS head,
                LENGTH(COALESCE(file_data, ''))   AS data_len,
                file_url
           FROM kyc_documents WHERE investor_id = $1`, [investorId]),
      pool.query(
        `SELECT id, subject, file_url, proof_filename, created_at
           FROM support_tickets
          WHERE investor_id = $1
            AND (COALESCE(file_url, '') <> '' OR COALESCE(proof_filename, '') <> '')`,
        [investorId]),
    ]);

    const docs = [];

    for (const d of kyc.rows) {
      const src = d.has_data ? d.head : (d.file_url || '');
      docs.push({
        source: 'kyc', id: d.id,
        label: labelFor(d.doc_subtype || d.doc_type),
        doc_type: d.doc_type,
        file_name: d.file_name || null,
        status: d.status || null,
        notes: d.notes || null,
        at: d.submitted_at || d.created_at,
        reviewed_at: d.reviewed_at || null, reviewed_by: d.reviewed_by || null,
        expiry_date: d.expiry_date || null,
        has_file: !!(d.has_data || d.file_url),
        content_type: kindOf(src, d.file_name),
        /* From the stored length, not the truncated head. */
        bytes: d.has_data ? Math.round(Number(d.data_len) * 0.75) : null,
      });
    }

    for (const t of tickets.rows) {
      docs.push({
        source: 'ticket', id: t.id,
        label: t.proof_filename || 'Ticket attachment',
        doc_type: 'ticket_attachment',
        file_name: t.proof_filename || null,
        status: null, notes: t.subject || null,
        at: t.created_at,
        reviewed_at: null, reviewed_by: null, expiry_date: null,
        has_file: !!t.file_url,
        content_type: kindOf(t.file_url, t.proof_filename),
        bytes: sizeOf(t.file_url),
        ticket_subject: t.subject || null,
      });
    }

    /* Newest first: somebody opening a client record is almost always looking
       for the thing that arrived most recently. */
    docs.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    res.json({ data: docs, count: docs.length });
  } catch (err) {
    console.error('[client-documents] list error:', err.message);
    res.status(500).json({ error: 'Could not load the documents.' });
  }
});

/* ─── GET /:investorId/:source/:id/file ───────────────────────────────
   Scoped to the investor in the path as well as the document id: without it
   a staff member could read any document by id alone, and the id is in the
   list of every client they are allowed to see. */
router.get('/:investorId/:source/:id/file', requireStaff, async (req, res) => {
  const { investorId, source, id } = req.params;
  try {
    let src = null, name = null;
    if (source === 'kyc') {
      const { rows } = await pool.query(
        `SELECT COALESCE(NULLIF(file_data, ''), file_url) AS src, file_name
           FROM kyc_documents WHERE id = $1 AND investor_id = $2`, [id, investorId]);
      if (rows[0]) { src = rows[0].src; name = rows[0].file_name; }
    } else if (source === 'ticket') {
      const { rows } = await pool.query(
        `SELECT file_url AS src, proof_filename AS file_name
           FROM support_tickets WHERE id = $1 AND investor_id = $2`, [id, investorId]);
      if (rows[0]) { src = rows[0].src; name = rows[0].file_name; }
    } else {
      return res.status(400).json({ error: 'Unknown document source.' });
    }

    if (!src) return res.status(404).json({ error: 'No file on that document.' });

    const m = String(src).match(/^data:([^;,]+);base64,(.*)$/s);
    if (!m) {
      /* Stored as a link rather than a file. Handed back as a link, not
         fetched and proxied: the server would become a way to make it issue
         requests to arbitrary hosts. */
      return res.json({ url: src, file_name: name || null });
    }
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    /* The class is ["\r\n] and not ["\\r\\n]: the second is a backslash, an r
       and an n, which strips every letter r and n out of the filename —
       anele-id.png came back as aele-id.pg. */
    const safe = String(name || 'document').replace(/["\r\n]/g, '').trim() || 'document';
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (err) {
    console.error('[client-documents] file error:', err.message);
    res.status(500).json({ error: 'Could not load the document.' });
  }
});

module.exports = router;
