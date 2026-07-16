'use strict';
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

/* GET /api/factsheets?pool_id=X — list factsheets (current first, then history) */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { pool_id } = req.query;
    const q = pool_id
      ? `SELECT * FROM product_factsheets WHERE pool_id=$1 ORDER BY is_current DESC, created_at DESC`
      : `SELECT * FROM product_factsheets ORDER BY pool_id, is_current DESC, created_at DESC`;
    const { rows } = await pool.query(q, pool_id ? [pool_id] : []);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* POST /api/factsheets/upload — upload/link a new factsheet for a product */
router.post('/upload', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { pool_id, pool_name, file_name, file_url, file_size, mime_type, version } = req.body;
    if (!pool_id || !file_name || !file_url) {
      return res.status(400).json({ error: 'pool_id, file_name and file_url are required' });
    }
    if (!req.body.file_name || !/^[\w\-. ]{1,200}\.(pdf|PDF)$/.test(req.body.file_name)) {
      return res.status(400).json({ error: 'Invalid file name. Must be a PDF filename.' });
    }
    const id = `FS-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    // Mark all previous factsheets for this pool as not current
    await pool.query(`UPDATE product_factsheets SET is_current=false WHERE pool_id=$1`, [pool_id]);
    const { rows } = await pool.query(
      `INSERT INTO product_factsheets
         (id,pool_id,pool_name,file_name,file_url,file_size,mime_type,version,uploaded_by,is_current,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW()) RETURNING *`,
      [id, pool_id, pool_name || null, file_name, file_url,
       file_size || null, mime_type || 'application/pdf', version || null, req.user?.email || null]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* DELETE /api/factsheets/:id */
router.delete('/:id', requireAuth, requireRole('admin', 'director'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM product_factsheets WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const deleted = rows[0];
    if (deleted.is_current) {
      await pool.query(
        `UPDATE product_factsheets SET is_current=true
         WHERE id=(SELECT id FROM product_factsheets WHERE pool_id=$1 ORDER BY created_at DESC LIMIT 1)`,
        [deleted.pool_id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
