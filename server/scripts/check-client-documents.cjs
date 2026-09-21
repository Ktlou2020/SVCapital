#!/usr/bin/env node
/* Everything a client uploaded, in one place.
 *
 * The files were never missing; finding them was. A FICA document is
 * reachable from the FICA queue and a deposit slip from whichever support
 * ticket it was attached to, so "did this client ever send their proof of
 * address" meant searching two screens and hoping.
 *
 * Two things this has to get right, and a third it must not get wrong.
 *
 *   It has to find BOTH sources. A panel that quietly shows only the FICA
 *   documents is worse than no panel: it answers the question confidently
 *   and wrongly.
 *
 *   The list must not carry the files. kyc_documents.file_data is a base64
 *   data URI, and a photographed ID is a couple of megabytes; six of them
 *   would make opening a client record a twelve-megabyte download.
 *
 *   And a document id must not be readable under another client's path. The
 *   ids are in the list of every client a staff member can open.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-client-documents.cjs
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-client-documents-secret';
const router = require(path.join(ROOT, 'server', 'routes', 'clientDocuments.js'));
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const tokenFor = u => jwt.sign(u, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

function call(url, user) {
  return new Promise(resolve => {
    const req = {
      method: 'GET', url, originalUrl: url, baseUrl: '', body: {}, params: {},
      headers: { authorization: 'Bearer ' + tokenFor(user) }, cookies: {},
      get(h) { return this.headers[String(h).toLowerCase()]; },
    };
    let code = 200; const headers = {};
    const res = {
      statusCode: 200,
      status(c) { code = c; this.statusCode = c; return this; },
      setHeader(k, v) { headers[k.toLowerCase()] = v; return this; },
      set(k, v) { return this.setHeader(k, v); },
      json(p) { resolve({ status: code, body: p, headers }); return this; },
      send(p) { resolve({ status: code, body: p, headers }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { error: 'no route' }, headers }));
  });
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ADMIN  = { id: 'u-a', email: 'a@svcapital.co.za', role: 'admin' };
const CLIENT = { id: 'u-c', investorId: 'CD-1', email: 'c@example.com', role: 'investor' };

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    for (const id of ['CD-1', 'CD-2']) {
      await db.query(
        `INSERT INTO investors (id, first_name, last_name, email, status)
         VALUES ($1, 'Doc', 'Check', $2, 'active') ON CONFLICT (id) DO NOTHING`,
        [id, `${id.toLowerCase()}@example.com`]);
    }
    await db.query(`DELETE FROM kyc_documents WHERE investor_id IN ('CD-1','CD-2')`);
    await db.query(`DELETE FROM support_tickets WHERE investor_id IN ('CD-1','CD-2')`);
    await db.query(
      `INSERT INTO kyc_documents (id, investor_id, doc_type, status, file_name, file_data, submitted_at)
       VALUES ('CD-K1','CD-1','id_document','approved','my-id.png',$1, NOW() - INTERVAL '5 days'),
              ('CD-K2','CD-1','proof_of_address','pending','bill.png',$1, NOW() - INTERVAL '2 days'),
              ('CD-K3','CD-1','selfie','approved','none.png',NULL, NOW() - INTERVAL '9 days'),
              ('CD-K9','CD-2','id_document','approved','other.png',$1, NOW())`, [PNG]);
    await db.query(
      `INSERT INTO support_tickets (id, investor_id, subject, file_url, proof_filename, created_at)
       VALUES ('CD-T1','CD-1','EFT deposit',$1,'slip.png', NOW())`, [PNG]);

    const list = await call('/CD-1', ADMIN);

    console.log('\nit finds every place a client can upload something');
    {
      const by = s => (list.body.data || []).filter(d => d.source === s);
      ok('FICA documents are listed', by('kyc').length === 3, JSON.stringify(list.body).slice(0, 200));
      /* The half that was easy to forget: a deposit slip on a ticket is a
         document the client uploaded, and it lives nowhere near the others. */
      ok('and so are files attached to support tickets', by('ticket').length === 1,
         'a panel that shows only FICA answers the question confidently and wrongly');
      ok('nothing belonging to another client leaks in',
         !(list.body.data || []).some(d => d.id === 'CD-K9'));
      ok('newest first', (list.body.data || [])[0].id === 'CD-T1',
         'somebody opening a record is looking for what arrived most recently');
      ok('a document with no file is still listed, marked as such',
         (list.body.data || []).some(d => d.id === 'CD-K3' && d.has_file === false),
         'a recorded-but-missing document is a fact worth seeing');
    }

    console.log('\nthe list carries no files');
    {
      const raw = JSON.stringify(list.body);
      ok('no base64 payload in the listing', !raw.includes('iVBORw0KGgo'),
         'six photographed IDs would be a twelve-megabyte download to open a record');
      ok('but enough to choose a document',
         (list.body.data || []).every(d => 'label' in d && 'content_type' in d && 'has_file' in d));
      ok('including how big it is',
         (list.body.data || []).find(d => d.id === 'CD-K1').bytes > 0,
         'so a scan can be told from a screenshot before downloading it');
      ok('and the listing stays small', raw.length < 4000, `${raw.length} bytes`);
      /* The response never carries the blob whatever the query does — the
         head is only read to pick an icon — so the assertion above passes
         even when the whole column is dragged out of the database and into
         memory to do it. The cost being avoided is the fetch, so the query is
         what has to be pinned. */
      ok('and the blob is never fetched in the first place',
         /LEFT\(COALESCE\(file_data, ''\), \d+\) AS head/
           .test(read('server/routes/clientDocuments.js')),
         'six photographed IDs would be pulled into memory to read twenty characters of each');
    }

    console.log('\nfetching one gives the file, correctly named');
    {
      const f = await call('/CD-1/kyc/CD-K1/file', ADMIN);
      ok('the bytes are the real file',
         Buffer.isBuffer(f.body) && f.body.slice(0, 4).toString('hex') === '89504e47',
         'PNG magic expected');
      ok('with its own content type', f.headers['content-type'] === 'image/png');
      /* ["\\r\\n] is a backslash, an r and an n — it strips every letter r and
         n out of the name, and anele-id.png came back as aele-id.pg. */
      ok('and its name intact',
         /filename="my-id\.png"/.test(f.headers['content-disposition'] || ''),
         f.headers['content-disposition']);
      const none = await call('/CD-1/kyc/CD-K3/file', ADMIN);
      ok('a document with no file is a 404, not an empty download', none.status === 404);
      const bogus = await call('/CD-1/nowhere/CD-K1/file', ADMIN);
      ok('an unknown source is refused', bogus.status === 400);
    }

    console.log('\nand a document cannot be read under the wrong client');
    {
      const cross = await call('/CD-1/kyc/CD-K9/file', ADMIN);
      ok('another client’s document id gets nothing here', cross.status === 404,
         'the ids are in the listing of every client a staff member can open');
      const own = await call('/CD-2/kyc/CD-K9/file', ADMIN);
      ok('but it is readable under its own', own.status === 200);
    }

    console.log('\nclients cannot read this at all');
    {
      ok('not the listing', (await call('/CD-1', CLIENT)).status === 403);
      ok('nor a file, even their own',
         (await call('/CD-1/kyc/CD-K1/file', CLIENT)).status === 403,
         'the portal has its own document surface; this one is the staff view');
    }

    console.log('\nthe console actually asks for it');
    {
      const admin = read('admin/js/admin.js');
      ok('the panel is on the client record', /id="invDocsBody"/.test(admin));
      ok('and it is filled when the record opens', /_loadClientDocuments\(inv\.id\)/.test(admin));
      ok('from the endpoint', /client-documents\/\$\{encodeURIComponent\(investorId\)\}/.test(admin));
      ok('files are linked, not embedded',
         /href="\$\{href\}" target="_blank"/.test(admin) && !/file_data/.test(
           (admin.match(/async function _loadClientDocuments[\s\S]*?\n\}/) || [''])[0]),
         'embedding them would put the megabytes back');
      ok('a failure says so and can be retried',
         /Could not load documents[\s\S]{0,200}_loadClientDocuments/.test(admin),
         'a silent failure is indistinguishable from a client who uploaded nothing');
    }

    await db.query(`DELETE FROM kyc_documents WHERE investor_id IN ('CD-1','CD-2')`);
    await db.query(`DELETE FROM support_tickets WHERE investor_id IN ('CD-1','CD-2')`);
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    await db.end().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
