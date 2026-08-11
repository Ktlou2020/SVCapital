'use strict';

const router  = require('express').Router();
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

/* helper — fire a notification event */
async function fireEvent(requestId, eventType, actorName, message) {
  await pool.query(
    `INSERT INTO cr_events (id, request_id, event_type, actor_name, message)
     VALUES ($1,$2,$3,$4,$5)`,
    [uuidv4(), requestId, eventType, actorName, message]
  );
}

/* ── GET /api/change-requests  — all requests with counts ── */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cr.*,
        (SELECT COUNT(*) FROM change_request_comments   c WHERE c.request_id = cr.id)::int AS comment_count,
        (SELECT COUNT(*) FROM change_request_attachments a WHERE a.request_id = cr.id)::int AS attachment_count
      FROM change_requests cr
      ORDER BY cr.created_at DESC
    `);
    res.json({ data: rows });
  } catch (err) {
    console.error('[change-requests GET /]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/change-requests  — create new request ── */
router.post('/', async (req, res) => {
  try {
    const { category, priority, title, description, expected_impact } = req.body;
    if (!title || !description) return res.status(400).json({ error: 'title and description are required' });

    const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    const id = uuidv4();

    const { rows } = await pool.query(
      `INSERT INTO change_requests (id, employee_id, submitted_by, category, priority, title, description, expected_impact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, req.user.empId, actorName, category || 'other', priority || 'medium', title, description, expected_impact || null]
    );

    await fireEvent(id, 'new_request', actorName,
      `${actorName} submitted a new ${priority || 'medium'}-priority request: "${title}"`);

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[change-requests POST /]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/change-requests/notifications ── */
router.get('/notifications', async (req, res) => {
  try {
    const empId = req.user.empId;
    const { rows } = await pool.query(`
      SELECT e.*, cr.title AS request_title
      FROM cr_events e
      JOIN change_requests cr ON cr.id = e.request_id
      WHERE e.created_at > COALESCE(
        (SELECT cleared_at FROM cr_notification_clears WHERE employee_id = $1),
        '1970-01-01'::timestamptz
      )
      ORDER BY e.created_at DESC
      LIMIT 50
    `, [empId]);
    res.json({ data: rows });
  } catch (err) {
    console.error('[change-requests GET /notifications]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/change-requests/notifications/count ── */
router.get('/notifications/count', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS count FROM cr_events
      WHERE created_at > COALESCE(
        (SELECT cleared_at FROM cr_notification_clears WHERE employee_id = $1),
        '1970-01-01'::timestamptz
      )
    `, [req.user.empId]);
    res.json({ count: rows[0].count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/change-requests/notifications/clear ── */
router.post('/notifications/clear', async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO cr_notification_clears (employee_id, cleared_at)
      VALUES ($1, NOW())
      ON CONFLICT (employee_id) DO UPDATE SET cleared_at = NOW()
    `, [req.user.empId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/change-requests/:id  — full detail ── */
router.get('/:id', async (req, res) => {
  try {
    const { rows: cr } = await pool.query('SELECT * FROM change_requests WHERE id=$1', [req.params.id]);
    if (!cr[0]) return res.status(404).json({ error: 'Not found' });

    const [{ rows: comments }, { rows: attachments }] = await Promise.all([
      pool.query('SELECT * FROM change_request_comments   WHERE request_id=$1 ORDER BY created_at ASC', [req.params.id]),
      pool.query('SELECT id,request_id,employee_id,author_name,filename,mime_type,created_at FROM change_request_attachments WHERE request_id=$1 ORDER BY created_at ASC', [req.params.id]),
    ]);

    res.json({ data: cr[0], comments, attachments });
  } catch (err) {
    console.error('[change-requests GET /:id]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /api/change-requests/:id  — update status / admin notes ── */
router.patch('/:id', async (req, res) => {
  try {
    const { status, admin_notes } = req.body;
    const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;

    const { rows } = await pool.query(
      `UPDATE change_requests
       SET status      = COALESCE($2, status),
           admin_notes = COALESCE($3, admin_notes),
           reviewed_by = $4,
           reviewed_at = NOW(),
           updated_at  = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, status || null, admin_notes !== undefined ? admin_notes : null, actorName]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    if (status) {
      await fireEvent(req.params.id, 'status_change', actorName,
        `${actorName} changed the status to "${status}" on "${rows[0].title}"`);
    }

    res.json({ data: rows[0] });
  } catch (err) {
    console.error('[change-requests PATCH /:id]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/change-requests/:id/comments ── */
router.post('/:id/comments', async (req, res) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Comment body is required' });

    const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    const id = uuidv4();

    const { rows: cr } = await pool.query('SELECT title FROM change_requests WHERE id=$1', [req.params.id]);
    if (!cr[0]) return res.status(404).json({ error: 'Request not found' });

    const { rows } = await pool.query(
      `INSERT INTO change_request_comments (id, request_id, employee_id, author_name, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, req.params.id, req.user.empId, actorName, body.trim()]
    );

    await fireEvent(req.params.id, 'new_comment', actorName,
      `${actorName} commented on "${cr[0].title}"`);

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[change-requests POST /:id/comments]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/change-requests/:id/attachments ── */
router.post('/:id/attachments', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    const b64 = req.file.buffer.toString('base64');
    const id  = uuidv4();

    const { rows } = await pool.query(
      `INSERT INTO change_request_attachments (id, request_id, employee_id, author_name, filename, mime_type, file_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, request_id, employee_id, author_name, filename, mime_type, created_at`,
      [id, req.params.id, req.user.empId, actorName, req.file.originalname, req.file.mimetype, b64]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[change-requests POST /:id/attachments]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/change-requests/attachments/:id  — download a file ── */
router.get('/attachments/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT filename, mime_type, file_data FROM change_request_attachments WHERE id=$1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const buf = Buffer.from(rows[0].file_data, 'base64');
    res.set('Content-Type', rows[0].mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${rows[0].filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
