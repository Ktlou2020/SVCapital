#!/usr/bin/env node
/* A signed agreement has to be retrievable by both sides.
 *
 * The signing flow stored the document and hashed it, and then neither party
 * could reach it: no screen listed one, for the client or for the console.
 * A contract nobody can produce afterwards is not much of a contract.
 *
 * The access rules matter as much as the screens. The read check used to be
 * "is this person not an investor?", which let any authenticated non-investor
 * account fetch any signed contract by id.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-agreement-access.cjs
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
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-agreement-access-secret';
const jwt    = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const router = require(path.join(ROOT, 'server', 'routes', 'agreements.js'));
const AG     = require(path.join(ROOT, 'server', 'services', 'agreements.js'));

const tokenFor = u => jwt.sign(u, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
function call(method, url, body, user) {
  return new Promise(resolve => {
    const req = {
      method, url, originalUrl: url, baseUrl: '', body: body || {},
      query: Object.fromEntries(new URLSearchParams((url.split('?')[1] || ''))),
      headers: { 'user-agent': 'check-agreement-access', authorization: 'Bearer ' + tokenFor(user) },
      cookies: {}, ip: '198.51.100.9',
      get(h) { return this.headers[String(h).toLowerCase()]; },
    };
    let code = 200;
    const res = {
      statusCode: 200,
      status(c) { code = c; this.statusCode = c; return this; },
      set() { return this; },
      json(p) { resolve({ status: code, body: p }); return this; },
      send(p) { resolve({ status: code, body: p }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { error: 'no route' } }));
  });
}

const OWNER   = { role: 'investor', investorId: 'INV-ACC-1' };
const OTHER   = { role: 'investor', investorId: 'INV-ACC-2' };
const ADMIN   = { role: 'admin' };
const OUTSIDE = { role: 'ifa' };          // authenticated, not staff, not the owner

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    /* A signed agreement to reach for. Written directly: this check is about
       who may read one, not about how it comes to exist. */
    const id = 'AGR-access-1';
    await db.query(`DELETE FROM investment_agreements WHERE id = $1`, [id]);
    const html = '<!doctype html><html><body>Agreement body</body></html>';
    await db.query(
      `INSERT INTO investment_agreements
         (id, agreement_no, investor_id, pool_id, product_type, amount_cents,
          pool_amount_cents, fee_cents, template_key, template_version, status,
          document_html, document_sha256, signed_at)
       VALUES ($1,'AGR-ACC-0001','INV-ACC-1','POOL-ACC','standard',
               101000,100000,1000,'standard','v1','signed',$2,$3,NOW())`,
      [id, html, AG.sha256(html)]
    );

    console.log('\nthe client can reach their own');
    {
      const list = await call('GET', '/', null, OWNER);
      ok('their listing includes it', list.status === 200 &&
         (list.body.agreements || []).some(a => a.id === id),
         JSON.stringify(list.body).slice(0, 200));
      const one = (list.body.agreements || []).find(a => a.id === id) || {};
      ok('with the figures the table shows',
         Number(one.pool_amount_cents) === 100000 && Number(one.fee_cents) === 1000 &&
         Number(one.amount_cents) === 101000,
         JSON.stringify(one));
      const doc = await call('GET', `/${id}/document`, null, OWNER);
      ok('and the document opens', doc.status === 200 && String(doc.body).includes('Agreement body'));
      ok('served as the stored bytes, not a rebuild',
         String(doc.body) === html, 'the copy differs from what was signed');
    }

    console.log('\nanother client cannot');
    {
      const list = await call('GET', '/', null, OTHER);
      ok('it is not in their listing',
         !((list.body.agreements || []).some(a => a.id === id)),
         JSON.stringify(list.body).slice(0, 200));
      const doc = await call('GET', `/${id}/document`, null, OTHER);
      ok('and the document is not found rather than refused',
         doc.status === 404, `${doc.status} ${JSON.stringify(doc.body)}`);
      const meta = await call('GET', `/${id}`, null, OTHER);
      ok('nor is its metadata', meta.status === 404, String(meta.status));
    }

    console.log('\nthe console can, under the client’s profile');
    {
      const list = await call('GET', `/?investor_id=INV-ACC-1`, null, ADMIN);
      ok('staff can list a named client’s agreements',
         list.status === 200 && (list.body.agreements || []).some(a => a.id === id),
         JSON.stringify(list.body).slice(0, 200));
      const doc = await call('GET', `/${id}/document`, null, ADMIN);
      ok('and open the document', doc.status === 200 && String(doc.body).includes('Agreement body'));
      const none = await call('GET', '/', null, ADMIN);
      ok('but must say whose', none.status === 403, `${none.status} ${JSON.stringify(none.body)}`);
    }

    console.log('\nand nobody else can, whatever they are logged in as');
    {
      /* The rule was "not an investor", so any authenticated non-investor
         account could fetch any contract by id. */
      const doc = await call('GET', `/${id}/document`, null, OUTSIDE);
      ok('a non-staff, non-owner account is refused', doc.status === 404,
         `${doc.status} — an authenticated ${OUTSIDE.role} read a client’s contract`);
      const list = await call('GET', `/?investor_id=INV-ACC-1`, null, OUTSIDE);
      ok('and cannot list somebody else’s', list.status === 403 ||
         !((list.body.agreements || []).length), JSON.stringify(list.body).slice(0, 200));
      ok('the role list is explicit in the source',
         /const STAFF_ROLES = \['admin', 'director', 'fund_manager'\]/.test(read('server/routes/agreements.js')));
    }

    console.log('\nboth screens exist');
    {
      for (const p of ['portal/index.html', 'mobile/src/index.html']) {
        ok(`${p} has a signed-agreements card`, /docAgreementsBody/.test(read(p)),
           'the client has nowhere to find what they signed');
      }
      const core = strip(read('js/portal-core.js'));
      ok('the documents view renders it',
         /_renderAgreementsTable\(\)/.test(core) && /function _renderAgreementsTable/.test(core));
      /* The BODY of loadDocuments, not a window around it: the function's own
         definition further down contains the same text, so a regex spanning
         from "function loadDocuments" matched even after the call was
         deleted. */
      const body = (core.match(/function loadDocuments\(\)\s*\{([\s\S]*?)\n\}/) || ['', ''])[1];
      ok('and loadDocuments calls it',
         /_renderAgreementsTable\(\)/.test(body),
         `the card would sit on "Loading..." for ever — body: ${body.trim().slice(0, 160)}`);

      const admin = strip(read('admin/js/admin.js'));
      ok('the console has an Agreements tab on the investor profile',
         /invTab-agreements/.test(admin) && /invPanel-agreements/.test(admin));
      ok('and it loads them for that investor',
         /_loadInvestorAgreements\('\$\{inv\.id\}'\)/.test(admin) &&
         /async function _loadInvestorAgreements/.test(admin));
      ok('the console shows the checksum, so a copy can be verified',
         /document_sha256/.test(admin));
      ok('both sides open the stored document over the API',
         /agreements\/\$\{encodeURIComponent\(id\)\}\/document/.test(core) &&
         /agreements\/\$\{encodeURIComponent\(id\)\}\/document/.test(admin),
         'a document rebuilt in the browser is not the one that was signed');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
