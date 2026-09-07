'use strict';
/* ═══════════════════════════════════════════════════════
   PE Documents — file attachments for companies & deals
   POST   /api/pe/documents/upload
   GET    /api/pe/documents/list?company_id=&deal_id=
   GET    /api/pe/documents/:id/download
   DELETE /api/pe/documents/:id
   ═══════════════════════════════════════════════════════ */

const router = require('express').Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

/* ─── Auto-create table ─── */
pool.query(`
  CREATE TABLE IF NOT EXISTS pe_documents (
    id          TEXT PRIMARY KEY,
    company_id  TEXT,
    deal_id     TEXT,
    doc_type    TEXT NOT NULL DEFAULT 'AFS',
    label       TEXT,
    filename    TEXT NOT NULL,
    mimetype    TEXT NOT NULL,
    file_size   INTEGER,
    file_data   TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('[pe_documents] table init error:', err.message));

/* Spreadsheets are now first-class here: the Xero invoice export and the
   monthly working spreadsheet are both .xlsx or .csv, and neither could be
   uploaded before — the picker accepted them and the server rejected them
   after the upload had already run.

   Extension is checked as well as mimetype because browsers are unreliable on
   Office formats: .xlsx arrives as application/octet-stream from some
   file pickers and as application/zip from others, and a .csv exported from
   Excel often arrives as application/vnd.ms-excel. Rejecting on mimetype
   alone turned "we sent you the spreadsheet" into "the system says the file
   is the wrong type". */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv', 'application/csv', 'text/plain',
  'image/jpeg', 'image/png', 'image/webp',
]);
const ALLOWED_EXT = /\.(pdf|doc|docx|xls|xlsx|xlsm|xltx|ods|csv|txt|jpe?g|png|webp)$/i;

function fileIsAllowed(file) {
  if (ALLOWED_MIME.has(file.mimetype)) return true;
  /* An unrecognised mimetype is accepted only when the extension is one we
     take — an octet-stream with no telling extension is still refused. */
  return ALLOWED_EXT.test(file.originalname || '');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = fileIsAllowed(file);
    cb(ok ? null : new Error(`Unsupported file type: ${file.originalname || file.mimetype}`), ok);
  },
});

/* POST /upload */
router.post('/upload', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { company_id, deal_id, update_id, bee_id, doc_type = 'AFS', label, financial_year } = req.body;
  /* An attachment on an update or a BEE year still belongs to a company, and
     the company id is what every listing filters on — so one of the four has
     to be present, not just the original two. */
  if (!company_id && !deal_id && !update_id && !bee_id) {
    return res.status(400).json({ error: 'company_id, deal_id, update_id or bee_id required' });
  }

  const id = 'pedoc-' + uuidv4();
  const b64 = req.file.buffer.toString('base64');
  const fy = /^\d{4}$/.test(String(financial_year || '')) ? parseInt(financial_year, 10) : null;
  try {
    await pool.query(
      `INSERT INTO pe_documents (id, company_id, deal_id, update_id, bee_id, financial_year,
                                 doc_type, label, filename, mimetype, file_size, file_data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, company_id || null, deal_id || null, update_id || null, bee_id || null, fy, doc_type,
       label || req.file.originalname, req.file.originalname,
       req.file.mimetype, req.file.size, b64,
       (req.user && (req.user.email || req.user.id)) || null]
    );
    res.json({
      ok: true, id, filename: req.file.originalname,
      label: label || req.file.originalname, doc_type,
      update_id: update_id || null, bee_id: bee_id || null, financial_year: fy,
    });
  } catch (err) {
    console.error('[pe-documents upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /list?company_id=X or ?deal_id=X */
router.get('/list', requireAuth, async (req, res) => {
  const { company_id, deal_id, update_id, bee_id } = req.query;
  if (!company_id && !deal_id && !update_id && !bee_id) {
    return res.status(400).json({ error: 'company_id, deal_id, update_id or bee_id required' });
  }

  const conditions = [];
  const params = [];
  if (company_id) { conditions.push(`company_id = $${params.length + 1}`); params.push(company_id); }
  if (deal_id)    { conditions.push(`deal_id    = $${params.length + 1}`); params.push(deal_id); }
  if (update_id)  { conditions.push(`update_id  = $${params.length + 1}`); params.push(update_id); }
  if (bee_id)     { conditions.push(`bee_id     = $${params.length + 1}`); params.push(bee_id); }

  try {
    const { rows } = await pool.query(
      `SELECT id, company_id, deal_id, update_id, bee_id, financial_year,
              doc_type, label, filename, mimetype, file_size, uploaded_at, uploaded_by
       FROM pe_documents WHERE ${conditions.join(' OR ')} ORDER BY uploaded_at DESC`,
      params
    );
    res.json({ ok: true, docs: rows });
  } catch (err) {
    console.error('[pe-documents list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /:id/download */
router.get('/:id/download', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT filename, mimetype, file_data FROM pe_documents WHERE id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const doc = rows[0];
    const buf = Buffer.from(doc.file_data, 'base64');
    res.set('Content-Type', doc.mimetype);
    res.set('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
    res.set('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    console.error('[pe-documents download]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE /:id */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM pe_documents WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[pe-documents delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* multer rejects a file by THROWING from fileFilter, and that error surfaces
   as whatever the app's last error handler makes of it — a 500 with a stack in
   the log, and a message the operator never sees. A rejected upload is a
   normal outcome with a normal answer: say which file and what is accepted. */
router.use((err, _req, res, next) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  if (!tooBig && !/Unsupported file type/.test(err.message || '')) return next(err);
  res.status(400).json({
    error: tooBig
      ? 'That file is larger than the 20 MB limit.'
      : `${err.message}. Accepted: PDF, Word, Excel or CSV, and JPEG, PNG or WEBP images.`,
  });
});

module.exports = router;
