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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg', 'image/png', 'image/webp',
    ].includes(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

/* POST /upload */
router.post('/upload', requireAuth, upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { company_id, deal_id, doc_type = 'AFS', label } = req.body;
  if (!company_id && !deal_id) return res.status(400).json({ error: 'company_id or deal_id required' });

  const id = 'pedoc-' + uuidv4();
  const b64 = req.file.buffer.toString('base64');
  try {
    await pool.query(
      `INSERT INTO pe_documents (id, company_id, deal_id, doc_type, label, filename, mimetype, file_size, file_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, company_id || null, deal_id || null, doc_type,
       label || req.file.originalname, req.file.originalname,
       req.file.mimetype, req.file.size, b64]
    );
    res.json({ ok: true, id, filename: req.file.originalname, label: label || req.file.originalname, doc_type });
  } catch (err) {
    console.error('[pe-documents upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /list?company_id=X or ?deal_id=X */
router.get('/list', requireAuth, async (req, res) => {
  const { company_id, deal_id } = req.query;
  if (!company_id && !deal_id) return res.status(400).json({ error: 'company_id or deal_id required' });

  const conditions = [];
  const params = [];
  if (company_id) { conditions.push(`company_id = $${params.length + 1}`); params.push(company_id); }
  if (deal_id)    { conditions.push(`deal_id    = $${params.length + 1}`); params.push(deal_id); }

  try {
    const { rows } = await pool.query(
      `SELECT id, company_id, deal_id, doc_type, label, filename, mimetype, file_size, uploaded_at
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

module.exports = router;
