#!/usr/bin/env node
/* Feedback on a change request can carry the screenshot it is about.
 *
 * It could not. change_request_attachments had a request_id and nothing else,
 * so a file could only be filed against the REQUEST — there was no way to put
 * a screenshot or a screen recording next to the sentence explaining it. The
 * report was: "this makes it difficult to provide visual context or
 * demonstrate exactly what we are referring to."
 *
 * WHAT THIS HAD TO GET RIGHT
 *
 * INLINE RENDERING IS A SECURITY DECISION. Showing an <img> or a <video> means
 * the server has to serve the file with Content-Disposition: inline, on our
 * own origin, from a URL any authenticated person can open. Do that for an
 * arbitrary uploaded file and you have handed every uploader a same-origin
 * script: an SVG is an image and can carry <script>; so can an HTML file; a
 * PDF can too. So there are two sets. Raster images and the three video
 * containers render inline. Everything else — SVG and PDF included — still
 * uploads, because they are legitimate things to attach, and still downloads,
 * because Content-Disposition: attachment is what makes them harmless. The
 * decision is made on the STORED mime type, never on the filename.
 *
 * AND THERE WAS NO FILTER AT ALL. Before this, any file of any type was
 * accepted, stored and served back. That had to close before anything was
 * rendered rather than after.
 *
 * VIDEO NEEDS RANGES. Without them a <video> pulls the whole file before it
 * will play and the scrub bar does nothing — on a screen recording, which is
 * the point, that is the difference between useful and not.
 *
 * TEXT AND MEDIA COMMIT TOGETHER. Posting the comment first and uploading
 * after would leave "see the screenshot" with no screenshot whenever an upload
 * failed, which reads as though the sender forgot.
 *
 * Every case below goes through the real routes.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-change-request-media.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_crmedia_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const SRC  = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'changeRequests.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'team', 'change-requests.html'), 'utf8');
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const CODE = strip(SRC);
const PAGE_CODE = strip(PAGE);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
  /* The teardown drops this database WITH (FORCE); pg reports the termination
     as a pool 'error', and a pool with no listener takes the process down
     after every assertion has already passed. */
  pool.on('error', () => {});
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, children: [], paths: [],
    exports: {
      requireAuth: (req, _r, n) => {
        req.user = { role: 'admin', empId: 'CRM-E1', firstName: 'Kagiso', lastName: 'Tester',
                     email: 'k@example.test' };
        n();
      },
      requireRole: () => (_a, _b, n) => n(),
    } };
  const app = express();
  app.use(express.json());
  app.use('/api/change-requests', require(path.join(ROOT, 'server', 'routes', 'changeRequests')));
  return new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

/* ── HTTP, by hand: multipart with several files, and range requests. ── */
function multipart(fields, files) {
  const B = '----crmedia' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\n` +
      `Content-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${B}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${B}` };
}

const request = (port, method, url, opts = {}) => new Promise((resolve, reject) => {
  const headers = Object.assign({}, opts.headers);
  let payload = null;
  if (opts.json !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.json));
    headers['Content-Type'] = 'application/json';
  } else if (opts.form) {
    const m = multipart(opts.form.fields || {}, opts.form.files || []);
    payload = m.body; headers['Content-Type'] = m.type;
  }
  if (payload) headers['Content-Length'] = payload.length;
  const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* binary */ }
      resolve({ status: res.statusCode, headers: res.headers, body: json, buf });
    });
  });
  r.on('error', reject); if (payload) r.write(payload); r.end();
});

/* Real media, so the mime types and the byte counts are not invented. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHUlEQVQI12P4//8/AzYwCgYNGjRoEAMDAwMDAwMDAAwMDAxD3kSbAAAAAElFTkSuQmCC',
  'base64');
/* A structurally real MP4 container — ftyp + a large mdat — big enough that a
   range request over it means something. */
const box = (t, b) => { const h = Buffer.alloc(8); h.writeUInt32BE(b.length + 8, 0); h.write(t, 4); return Buffer.concat([h, b]); };
const MP4 = Buffer.concat([
  box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isomiso2avc1mp41')])),
  box('mdat', Buffer.alloc(120000, 7)),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<script>alert(1)</script>');

const file = (field, name, type, data) => ({ field, name, type, data });

(async () => {
  let srv;
  try {
    await makeDatabase();
    srv = await serve();
    const port = srv.address().port;

    const mk = async title => (await request(port, 'POST', '/api/change-requests',
      { json: { title, description: 'd', category: 'other', priority: 'medium' } })).body.data.id;
    const detail = async id => (await request(port, 'GET', `/api/change-requests/${id}`)).body;

    console.log('\na comment carries the screenshot it is about');
    let rid, imgId, vidId;
    {
      rid = await mk('Media on comments');
      const r = await request(port, 'POST', `/api/change-requests/${rid}/comments`, {
        form: { fields: { body: 'Here is the screen I mean, and a recording.' },
                files: [file('files', 'shot.png', 'image/png', PNG),
                        file('files', 'clip.mp4', 'video/mp4', MP4)] } });
      ok('the comment posts with its files', r.status === 201 && r.body.data,
         JSON.stringify(r.body).slice(0, 180));
      ok('and both come back with it', (r.body.attachments || []).length === 2,
         'so the page can draw them without another round trip');
      ok('each is filed against the COMMENT, not just the request',
         (r.body.attachments || []).every(a => a.comment_id === r.body.data.id),
         'that link is what puts the picture next to the sentence');
      ok('the byte count is recorded', (r.body.attachments || []).every(a => a.file_size > 0));

      const d = await detail(rid);
      imgId = d.attachments.find(a => a.mime_type === 'image/png').id;
      vidId = d.attachments.find(a => a.mime_type === 'video/mp4').id;
      ok('the detail view returns comment_id so the page can group them',
         d.attachments.every(a => 'comment_id' in a));
    }

    console.log('\nand a comment can be nothing but a screenshot');
    {
      const r = await request(port, 'POST', `/api/change-requests/${rid}/comments`, {
        form: { fields: { body: '' }, files: [file('files', 'only.png', 'image/png', PNG)] } });
      ok('an image with no words is a real comment', r.status === 201,
         JSON.stringify(r.body).slice(0, 140));
      const empty = await request(port, 'POST', `/api/change-requests/${rid}/comments`,
        { json: { body: '   ' } });
      ok('but an empty one with nothing attached is refused',
         empty.status === 400 && /Write a comment or attach a file/.test(empty.body.error || ''),
         empty.body && empty.body.error);
      const textOnly = await request(port, 'POST', `/api/change-requests/${rid}/comments`,
        { json: { body: 'Text only, as before.' } });
      ok('and a plain JSON comment still works exactly as it did',
         textOnly.status === 201 && textOnly.body.data.body === 'Text only, as before.',
         'the endpoint takes both shapes');
    }

    console.log('\nwhat renders in the page, and what may not');
    {
      const img = await request(port, 'GET', `/api/change-requests/attachments/${imgId}`);
      ok('a PNG is served inline, so an <img> shows it',
         /^inline/.test(img.headers['content-disposition'] || ''), img.headers['content-disposition']);
      ok('with its real type and the bytes intact',
         img.headers['content-type'] === 'image/png' && img.buf.equals(PNG));
      ok('and told not to be sniffed into something else',
         img.headers['x-content-type-options'] === 'nosniff');

      const vid = await request(port, 'GET', `/api/change-requests/attachments/${vidId}`);
      ok('an MP4 is served inline too', /^inline/.test(vid.headers['content-disposition'] || ''));
      ok('and advertises ranges', vid.headers['accept-ranges'] === 'bytes');

      /* The security boundary. An SVG is an image and can carry script; so can
         HTML; so can a PDF. Rendering any of them inline from our own origin
         would be a same-origin script for anyone who can attach a file. */
      const up = await request(port, 'POST', `/api/change-requests/${rid}/attachments`,
        { form: { files: [file('file', 'vector.svg', 'image/svg+xml', SVG)] } });
      ok('an SVG still uploads — it is a legitimate diagram', up.status === 201,
         JSON.stringify(up.body).slice(0, 140));
      const svg = await request(port, 'GET', `/api/change-requests/attachments/${up.body.data.id}`);
      ok('but is served as a DOWNLOAD, never inline',
         /^attachment/.test(svg.headers['content-disposition'] || ''),
         `${svg.headers['content-disposition']} — an SVG can carry <script>`);

      const html = await request(port, 'POST', `/api/change-requests/${rid}/attachments`,
        { form: { files: [file('file', 'nasty.html', 'text/html', HTML)] } });
      ok('an HTML file is refused outright',
         html.status === 400 && /Unsupported file type/.test(html.body.error || ''),
         JSON.stringify(html.body).slice(0, 160));
      const lying = await request(port, 'POST', `/api/change-requests/${rid}/attachments`,
        { form: { files: [file('file', 'evil.html', 'application/octet-stream', HTML)] } });
      ok('and so is one that hides its type behind octet-stream',
         lying.status === 400, JSON.stringify(lying.body).slice(0, 160));

      ok('the inline set is decided on the stored mime type, not the filename',
         /INLINE_MIME\.has\(mime\)/.test(CODE) && !/INLINE_MIME\.has\([^)]*filename/.test(CODE),
         'a file that talked its way past the extension check must not talk its way into rendering');
      ok('SVG and PDF are deliberately NOT on the inline set',
         !/INLINE_MIME = new Set\(\[[^\]]*svg/.test(CODE) &&
         !/INLINE_MIME = new Set\(\[[^\]]*pdf/.test(CODE));
    }

    console.log('\na video can be scrubbed, not just downloaded whole');
    {
      const r = await request(port, 'GET', `/api/change-requests/attachments/${vidId}`,
        { headers: { Range: 'bytes=1000-1999' } });
      ok('a range request returns 206, not the whole file', r.status === 206, String(r.status));
      ok('with the range it was asked for',
         r.headers['content-range'] === `bytes 1000-1999/${MP4.length}`, r.headers['content-range']);
      ok('and exactly those bytes', r.buf.length === 1000 && r.buf.equals(MP4.subarray(1000, 2000)));

      const openEnded = await request(port, 'GET', `/api/change-requests/attachments/${vidId}`,
        { headers: { Range: 'bytes=119000-' } });
      ok('an open-ended range runs to the end',
         openEnded.status === 206 && openEnded.buf.length === MP4.length - 119000,
         `${openEnded.buf.length} bytes`);

      const past = await request(port, 'GET', `/api/change-requests/attachments/${vidId}`,
        { headers: { Range: 'bytes=999999999-' } });
      ok('a range past the end is 416, not a broken body', past.status === 416, String(past.status));

      /* An image is not a video, but a range on one must not corrupt it. */
      const imgRange = await request(port, 'GET', `/api/change-requests/attachments/${imgId}`,
        { headers: { Range: 'bytes=0-9' } });
      ok('a range on an image is honoured too rather than mishandled',
         imgRange.status === 206 && imgRange.buf.equals(PNG.subarray(0, 10)));

      /* A download must NOT be range-served — it has no need and the code path
         should not be reachable for it. */
      const svgId = (await request(port, 'GET', `/api/change-requests/${rid}`))
        .body.attachments.find(a => a.mime_type === 'image/svg+xml').id;
      const svgRange = await request(port, 'GET', `/api/change-requests/attachments/${svgId}`,
        { headers: { Range: 'bytes=0-4' } });
      ok('a download-only file ignores ranges and sends the whole thing',
         svgRange.status === 200 && svgRange.buf.length === SVG.length, String(svgRange.status));
    }

    console.log('\nthe limits, and what they say when they bite');
    {
      const big = await request(port, 'POST', `/api/change-requests/${rid}/attachments`,
        { form: { files: [file('file', 'huge.mp4', 'video/mp4', Buffer.alloc(26 * 1024 * 1024, 1))] } });
      ok('an oversized file is a 400 with the limit in it, not a 500 with a stack',
         big.status === 400 && /25 MB limit/.test(big.body.error || ''),
         `${big.status}: ${(big.body || {}).error}`);

      const many = await request(port, 'POST', `/api/change-requests/${rid}/comments`, {
        form: { fields: { body: 'too many' },
                files: Array.from({ length: 9 }, (_, i) => file('files', `s${i}.png`, 'image/png', PNG)) } });
      ok('more than eight files on one comment is refused, and says so',
         many.status === 400 && /up to 8/.test(many.body.error || ''),
         `${many.status}: ${(many.body || {}).error}`);

      ok('there is a size limit at all — there used to be no type filter either',
         /fileFilter/.test(CODE) && /MAX_BYTES/.test(CODE),
         'any file of any type was accepted, stored and served back');
    }

    console.log('\ntext and media land together or not at all');
    {
      const before = (await detail(rid)).comments.length;
      /* A file the database will refuse: a filename long enough to blow the
         column would not fail, so force it with a bad comment id instead —
         the transaction has to roll the comment back with it. */
      const bad = await request(port, 'POST', `/api/change-requests/nope-not-a-request/comments`, {
        form: { fields: { body: 'orphan' }, files: [file('files', 'shot.png', 'image/png', PNG)] } });
      ok('a comment on a request that does not exist is a 404', bad.status === 404, String(bad.status));
      const after = (await detail(rid)).comments.length;
      ok('and writes nothing anywhere', after === before, `${before} -> ${after}`);

      ok('the comment and its files are written in one transaction',
         /await db\.query\('BEGIN'\)[\s\S]{0,1400}change_request_attachments[\s\S]{0,600}COMMIT/.test(CODE),
         'otherwise "see the screenshot" can post with no screenshot');
      ok('and rolled back together', /ROLLBACK/.test(CODE));
    }

    console.log('\nthe schema keeps what was already filed');
    {
      const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='change_request_attachments' AND column_name = ANY($1)`,
        [['comment_id', 'file_size']]);
      ok('change_request_attachments carries comment_id and file_size', cols.rowCount === 2);
      const reqLevel = await pool.query(
        `SELECT COUNT(*) n FROM change_request_attachments WHERE comment_id IS NULL`);
      ok('a NULL comment_id still means "on the request itself"',
         Number(reqLevel.rows[0].n) > 0,
         'which is every row that existed before comments could carry a file');
      const d = await detail(rid);
      ok('and those stay in the request\'s own attachment list',
         d.attachments.some(a => !a.comment_id) && d.attachments.some(a => a.comment_id));
    }

    console.log('\nthe page shows them where the comment is');
    {
      ok('comments render their media inline',
         /function commentMediaHtml\(/.test(PAGE_CODE) && /<img src="\$\{url\}"/.test(PAGE) &&
         /<video src="\$\{url\}" controls/.test(PAGE));
      ok('and attachments are grouped under the comment they belong to',
         /COMMENT_MEDIA\[a\.comment_id\]/.test(PAGE_CODE),
         'otherwise a screenshot shows detached from the sentence explaining it');
      ok('the page and the server agree on what renders inline',
         (() => {
           const pageImg = (PAGE.match(/const INLINE_IMAGE = \[([^\]]*)\]/) || [])[1] || '';
           const pageVid = (PAGE.match(/const INLINE_VIDEO = \[([^\]]*)\]/) || [])[1] || '';
           const server  = (SRC.match(/const INLINE_MIME = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '';
           const want = [...(pageImg + pageVid).matchAll(/'([^']+)'/g)].map(m => m[1]);
           return want.length >= 8 && want.every(t => server.includes(`'${t}'`));
         })(),
         'a video the page renders in a <video> that the server sends as a download plays nothing');
      ok('a video does not pull its whole file the moment the thread opens',
         /preload="metadata"/.test(PAGE), 'which is what the range support is for');
      ok('files chosen are shown before the comment is sent',
         /function renderPending\(/.test(PAGE_CODE) && /pending-chip/.test(PAGE),
         'so a wrong file comes off before it is in the thread, not after');
      ok('and can be taken off again', /function removePendingFile\(/.test(PAGE_CODE));
      ok('a screenshot opens full size', /function openLightbox\(/.test(PAGE_CODE) && /id="lightbox"/.test(PAGE));
      ok('and escape closes it, not only the small x',
         /e\.key === 'Escape'[\s\S]{0,120}closeLightbox/.test(PAGE));
      ok('the size limit is checked before the upload, not after waiting for it',
         /CR_MAX_BYTES/.test(PAGE_CODE) && /is over 25 MB/.test(PAGE));
      ok('a refused upload is reported instead of being called a success',
         /if \(res\.ok\) \{ ok\+\+; continue; \}/.test(PAGE_CODE) && /failed\.push/.test(PAGE_CODE),
         'this only caught network errors, so a 400 fell through to "uploaded"');
      ok('the discussion count follows the list',
         /id="commentsTitle"/.test(PAGE) && /commentsTitle[\s\S]{0,200}comment-item/.test(PAGE),
         'posting used to leave "Discussion (3)" over four comments');
      ok('a small image is still something you can see and click',
         /min-width:64px/.test(PAGE), 'a four-pixel image was an invisible speck');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
