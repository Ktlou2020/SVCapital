'use strict';

const router  = require('express').Router();
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

/* ── What may be uploaded ─────────────────────────────────────────────────
   There was no filter at all: any file of any type up to 10 MB was accepted,
   stored, and served back. That is worth closing on its own, and it has to be
   closed before anything gets rendered INLINE — see the download route.

   Split into two sets because they are treated differently on the way out.
   INLINE_MIME is what a browser will be asked to render in the page, so it is
   deliberately narrow: raster images and the two video containers, and
   nothing that can carry script. SVG is an image and is NOT on it — an SVG is
   a document that can run JavaScript, and rendering one inline from our own
   origin would hand any uploader a same-origin script. PDFs are off it for
   the same reason. Both still upload; they just download rather than
   render. */
const INLINE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);
const OTHER_MIME = new Set([
  'image/svg+xml', 'application/pdf', 'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const ALLOWED_EXT = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|pdf|txt|csv|docx?|xlsx?)$/i;

/* Video is the reason the limit moved. A 10 MB cap made a screen recording of
   the thing being reported the one attachment you could not send, which is
   the whole point of the request. Base64 in a TEXT column inflates by about a
   third, so this is not a number to be generous with. */
const MAX_BYTES = 25 * 1024 * 1024;

function fileAllowed(file) {
  if (INLINE_MIME.has(file.mimetype) || OTHER_MIME.has(file.mimetype)) return true;
  /* Browsers are unreliable about mimetypes on some containers — a .mov often
     arrives as application/octet-stream — so a known extension is accepted as
     corroboration. It does not widen what gets rendered inline: that decision
     is made on the stored mime type alone. */
  return ALLOWED_EXT.test(file.originalname || '');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = fileAllowed(file);
    cb(ok ? null : new Error(`Unsupported file type: ${file.originalname || file.mimetype}`), ok);
  },
});

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
      pool.query(`SELECT id,request_id,comment_id,employee_id,author_name,filename,mime_type,file_size,created_at
                    FROM change_request_attachments WHERE request_id=$1 ORDER BY created_at ASC`, [req.params.id]),
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

/* ── POST /api/change-requests/:id/comments ──
   Takes JSON as it always did, and multipart when the comment carries files.
   multer's array middleware passes a non-multipart request straight through,
   so both shapes go down the same path.

   The comment and its files are written in ONE transaction. Posting the text
   first and uploading afterwards would leave "see the screenshot" sitting
   there with no screenshot whenever an upload failed — which is worse than
   the comment not posting at all, because it reads as though the sender
   forgot. */
router.post('/:id/comments', upload.array('files', 8), async (req, res) => {
  const files = req.files || [];
  try {
    const body = (req.body.body || '').trim();
    /* A comment that is nothing but a screenshot is a real comment. Only an
       empty one with no files is refused. */
    if (!body && !files.length) {
      return res.status(400).json({ error: 'Write a comment or attach a file.' });
    }

    const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email;
    const id = uuidv4();

    const { rows: cr } = await pool.query('SELECT title FROM change_requests WHERE id=$1', [req.params.id]);
    if (!cr[0]) return res.status(404).json({ error: 'Request not found' });

    const db = await pool.connect();
    let comment, attachments = [];
    try {
      await db.query('BEGIN');
      ({ rows: [comment] } = await db.query(
        `INSERT INTO change_request_comments (id, request_id, employee_id, author_name, body)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, req.params.id, req.user.empId, actorName, body]
      ));

      for (const f of files) {
        const { rows: [a] } = await db.query(
          `INSERT INTO change_request_attachments
             (id, request_id, comment_id, employee_id, author_name, filename, mime_type, file_size, file_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, request_id, comment_id, employee_id, author_name, filename, mime_type, file_size, created_at`,
          [uuidv4(), req.params.id, id, req.user.empId, actorName,
           f.originalname, f.mimetype, f.size, f.buffer.toString('base64')]
        );
        attachments.push(a);
      }
      await db.query('COMMIT');
    } catch (dbErr) {
      await db.query('ROLLBACK').catch(() => {});
      throw dbErr;
    } finally {
      db.release();
    }

    await fireEvent(req.params.id, 'new_comment', actorName,
      `${actorName} commented on "${cr[0].title}"` +
      (attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : ''));

    res.status(201).json({ data: comment, attachments });
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
      `INSERT INTO change_request_attachments
         (id, request_id, comment_id, employee_id, author_name, filename, mime_type, file_size, file_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, request_id, comment_id, employee_id, author_name, filename, mime_type, file_size, created_at`,
      [id, req.params.id, req.body.comment_id || null, req.user.empId, actorName,
       req.file.originalname, req.file.mimetype, req.file.size, b64]
    );

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    console.error('[change-requests POST /:id/attachments]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/change-requests/attachments/:id ──
   Downloads, and — for the narrow set of types a browser can render without
   being handed a script — serves inline so an <img> or a <video> in a comment
   just works. Everything else keeps Content-Disposition: attachment, which is
   what makes an uploaded SVG or PDF harmless: the browser saves it instead of
   executing it on our origin.

   The decision is made on the STORED mime type, never on the filename, so a
   file that talked its way past the extension check on upload still cannot
   talk its way into being rendered.

   requireAuth is on the whole router and accepts the svc_token cookie as well
   as a Bearer header, which is what lets a plain <img src> authenticate. */
router.get('/attachments/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT filename, mime_type, file_data FROM change_request_attachments WHERE id=$1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    const mime = rows[0].mime_type || 'application/octet-stream';
    const buf  = Buffer.from(rows[0].file_data, 'base64');
    const inline = INLINE_MIME.has(mime);
    /* Quotes and newlines out of the filename — a header cannot carry them,
       and a filename is whatever the uploader's machine called the file. */
    const safeName = String(rows[0].filename || 'file').replace(/["\r\n]/g, '');

    res.set('Content-Type', mime);
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    /* Belt and braces: even on the inline set, tell the browser not to
       second-guess the type it has been given. */
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=3600');

    /* Video needs ranges. Without them a <video> has to pull the whole file
       before it will play and the scrub bar does nothing — on a screen
       recording, which is the point of this, that is the difference between
       useful and not. */
    const range = req.headers.range;
    if (inline && range && /^bytes=/.test(range)) {
      const [startRaw, endRaw] = range.replace(/^bytes=/, '').split('-');
      let start = parseInt(startRaw, 10);
      let end   = endRaw ? parseInt(endRaw, 10) : buf.length - 1;
      if (Number.isNaN(start)) { start = buf.length - end; end = buf.length - 1; }
      if (Number.isNaN(end) || end >= buf.length) end = buf.length - 1;
      if (start > end || start < 0) {
        res.set('Content-Range', `bytes */${buf.length}`);
        return res.status(416).end();
      }
      res.status(206);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Range', `bytes ${start}-${end}/${buf.length}`);
      res.set('Content-Length', String(end - start + 1));
      return res.end(buf.subarray(start, end + 1));
    }

    if (inline) res.set('Accept-Ranges', 'bytes');
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* multer rejects a file by THROWING from fileFilter, and rejects an oversized
   one with a code. Either way that lands on the app's last error handler as a
   500 with a stack, and the person attaching a screen recording is told
   nothing. A refused upload is an ordinary outcome with an ordinary answer. */
router.use((err, _req, res, next) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  const tooMany = err.code === 'LIMIT_UNEXPECTED_FILE';
  if (!tooBig && !tooMany && !/Unsupported file type/.test(err.message || '')) return next(err);
  res.status(400).json({
    error: tooBig  ? `That file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit.`
         : tooMany ? 'Too many files on one comment — attach up to 8.'
         : `${err.message}. Accepted: PNG, JPEG, GIF, WEBP, AVIF, MP4, WEBM, MOV, PDF, Word, Excel, CSV or text.`,
  });
});

module.exports = router;
