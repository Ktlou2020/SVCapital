#!/usr/bin/env node
/* A FICA consent that says what it covers, and a record of which wording.
 *
 * The box used to say "I consent to FICA / FAIS identity verification as
 * required by the Financial Intelligence Centre Act". One clause, naming one
 * check. What the platform runs is four — identity and photo, bank account,
 * address, and sanctions / crime / PEP screening — and three of them were
 * never put to the person agreeing. Consent to identity verification is not
 * consent to be screened against a sanctions list.
 *
 * Three things had to be true for the fix to be worth anything, and each is
 * a way it could have been done and still been useless:
 *
 *  · THE WORDING NAMES THE CHECKS. Named in one place, server side, and
 *    asserted verbatim against both signup pages — the public one and the
 *    mobile app's own copy, which is a separate file and was carrying its
 *    own copy of the sentence.
 *  · THE VERSION MOVED. accepted_client_documents stamps a version on every
 *    acceptance and every FICA consent ever taken was stamped '1.0'. Widen
 *    the wording while the version stands still and the row for somebody
 *    who agreed to identity verification alone becomes indistinguishable
 *    from the row for somebody who agreed to be screened. The register then
 *    reads as though everyone consented to everything, which is a lie
 *    nobody wrote and nobody could spot.
 *  · THE SERVER ACTUALLY REQUIRES IT. It did not. ficaConsent defaulted to
 *    TRUE in the handler, so a request that never mentioned consent got a
 *    consent row written for it. The browser has always required the tick;
 *    the server was assuming the answer. That is the assertion in this file
 *    most worth keeping.
 *
 * The database half drives the real endpoint, because the first two can be
 * read off the source and the third cannot: what matters is what the server
 * does with a request, not what the handler appears to say.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-fica-consent.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CONSENT = require(path.join(ROOT, 'server', 'services', 'ficaConsent.js'));
const AUTH    = read('server/routes/auth.js');
const PAGES   = { 'signup.html': read('signup.html'),
                  'mobile/src/signup.html': read('mobile/src/signup.html') };

console.log('\nwhat the client is told they are agreeing to');
{
  ok('the four checks are named in one place',
     Array.isArray(CONSENT.SCOPES) && CONSENT.SCOPES.length === 4,
     JSON.stringify(CONSENT.SCOPES));
  for (const want of ['identity and photo', 'bank account', 'address',
                      'sanctions', 'politically exposed']) {
    ok(`and that place covers "${want}"`,
       CONSENT.SCOPES.some(sc => sc.toLowerCase().includes(want)),
       CONSENT.SCOPES.join(' | '));
  }

  for (const [name, html] of Object.entries(PAGES)) {
    const flat = html.replace(/\s+/g, ' ');
    const missing = CONSENT.SCOPES.filter(sc => !flat.includes(sc));
    ok(`${name} names every one of them, word for word`,
       missing.length === 0, missing.join(' | '));
  }
}

console.log('\nand it is a tick, not an assumption');
{
  for (const [name, html] of Object.entries(PAGES)) {
    const box = (html.match(/<input[^>]*id="ficaConsentCheck"[^>]*>/) || [''])[0];
    ok(`${name} has the box`, !!box);
    ok(`${name} leaves it unticked`, !/\bchecked\b/.test(box), box,
       'a pre-ticked box is not consent, it is a default somebody did not notice');
    ok(`${name} will not go on without it`,
       /if \(!fica\)\s*return showError/.test(html));
  }
}

console.log('\nthe wording exists once per page, not twice');
{
  /* It used to exist twice in each file: in the markup, and again as a
     string literal in the citizenship toggle that restored it. An edit to
     the markup that missed the literal would have put the old, narrower
     sentence back the moment somebody switched citizenship — silently, and
     on the sentence a compliance record points at. */
  for (const [name, html] of Object.entries(PAGES)) {
    const sentences = (html.match(/I confirm that I am a South African citizen/g) || []).length;
    ok(`${name} carries the sentence once`, sentences === 1, `found ${sentences}`);
    ok(`${name} restores it from what it loaded with`,
       /_FICA_CONSENT_DEFAULT/.test(html),
       'the restore has to point at the markup, not at a second copy of it');
  }
}

console.log('\nwhich wording they ticked is recorded');
{
  ok('the version is not the one the old wording used',
     CONSENT.VERSION !== '1.0', CONSENT.VERSION,
     'a widened consent filed under the old version cannot be told apart from the narrow one');
  ok('the acceptance is stamped with it rather than a literal',
     /fica_consent',\s*flag: ficaConsent,\s*version: FICA_CONSENT\.VERSION/.test(AUTH),
     'a hardcoded version in the INSERT is how the stamp stops following the wording');
  ok('and each acceptance carries its own version',
     /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)/.test(AUTH)
     && !/VALUES \(\$1, \$2, '1\.0'/.test(AUTH),
     'one version for the lot means the FICA consent moves only when everything moves');
}

console.log('\nand the server requires it, rather than assuming it');
{
  ok('consent is not defaulted to true in the handler',
     !/ficaConsent = true/.test(AUTH),
     'the default wrote a consent record for every caller that did not mention one');
  ok('a registration without it is refused',
     /if \(!ficaConsent\)[\s\S]{0,160}status\(400\)/.test(AUTH));
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ── Driven for real ────────────────────────────────────────────── */
const http = require('http');
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  let srv;
  try {
    const { rows } = await db.query(
      `SELECT to_regclass('public.accepted_client_documents') IS NOT NULL AS ready`);
    if (!rows[0].ready) {
      console.log('\n  SKIP  no accepted_client_documents table in this database');
      return;
    }

    process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only-secret';
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require(path.join(ROOT, 'server', 'routes', 'auth.js')));
    srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });

    const post = body => new Promise(res => {
      const p = Buffer.from(JSON.stringify(body));
      const q = http.request({ port: srv.address().port, path: '/api/auth/register',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': p.length } },
        x => { let s = ''; x.on('data', c => s += c);
               x.on('end', () => res({ status: x.statusCode, body: JSON.parse(s || '{}') })); });
      q.end(p);
    });

    const base = n => ({
      email: `fica-check-${n}-${Date.now()}@example.test`,
      password: 'Abcdefgh12', firstName: 'Fica', lastName: 'Check',
      termsAccepted: true, popiaAccepted: true,
    });
    const consents = email => db.query(
      `SELECT d.document_type, d.document_version
         FROM accepted_client_documents d
         JOIN investors i ON i.id = d.investor_id
         JOIN users u ON u.investor_id = i.id
        WHERE lower(u.email) = lower($1)`, [email]);

    console.log('\na registration that consents');
    const good = base('yes'); good.ficaConsent = true;
    const r1 = await post(good);
    ok('is accepted', r1.status === 200 || r1.status === 201,
       `${r1.status} ${JSON.stringify(r1.body).slice(0, 160)}`);
    const rowsGood = (await consents(good.email)).rows;
    const fica = rowsGood.find(r => r.document_type === 'fica_consent');
    ok('and its FICA consent is on the record', !!fica,
       JSON.stringify(rowsGood));
    ok(`stamped ${CONSENT.VERSION}, the wording they were shown`,
       fica && fica.document_version === CONSENT.VERSION,
       fica && fica.document_version);
    ok('while the unchanged documents stay on 1.0',
       rowsGood.filter(r => r.document_type !== 'fica_consent')
               .every(r => r.document_version === '1.0'),
       JSON.stringify(rowsGood));

    console.log('\na registration that declines');
    const no = base('no'); no.ficaConsent = false;
    const r2 = await post(no);
    ok('is refused', r2.status === 400, `${r2.status} ${JSON.stringify(r2.body)}`);
    ok('and says why', /FICA consent is required/i.test(r2.body.error || ''), r2.body.error);
    ok('and no account was created', (await consents(no.email)).rows.length === 0);

    console.log('\na registration that simply does not mention consent');
    /* The defect this check exists for. ficaConsent defaulted to true, so a
       request with no consent in it got a consent row written against the
       client's name. */
    const silent = base('silent');
    const r3 = await post(silent);
    ok('is refused too', r3.status === 400, `${r3.status} ${JSON.stringify(r3.body)}`);
    ok('and leaves no consent on the record', (await consents(silent.email)).rows.length === 0,
       'a missing answer was being recorded as yes');

    await db.query(`DELETE FROM users WHERE email LIKE 'fica-check-%@example.test'`);

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
