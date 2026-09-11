#!/usr/bin/env node
/* The change-request console sends a credential the server reads.
 *
 * It sent the staff token as X-Staff-Token. requireAuth reads
 * `Authorization: Bearer` or the svc_token COOKIE, and has never looked at
 * that header — so every call from the page worked only while the cookie was
 * valid, and a staff cookie lasts eight hours. Once it lapsed the page still
 * looked signed in, because the session lives in localStorage, and every
 * write came back 401. Attaching a screenshot to a comment is what people
 * noticed, because it is what they were doing.
 *
 * The request-level upload was worse: it sent no credential at all, not even
 * the header nobody read.
 *
 * Run: node server/scripts/check-change-request-auth.cjs
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

const PAGE  = read('team/change-requests.html');
const AUTH  = read('server/middleware/auth.js');
const ROUTE = read('server/routes/changeRequests.js');

console.log('\nthe page sends what the server reads');
{
  /* Stated as the relationship, not as a string: the point is that the two
     agree, and asserting the header name alone would pass if requireAuth
     changed underneath it. */
  const serverReads = (AUTH.match(/req\.headers\['([a-z-]+)'\]/g) || []).join(' ');
  ok('requireAuth reads the authorization header',
     /authorization/.test(serverReads), serverReads);
  ok('and the page sends it',
     /h\['Authorization'\] = 'Bearer ' \+ token;/.test(PAGE),
     'the page sends a header the server ignores, leaving it on the cookie alone');
  ok('the cookie is a fallback, not the only credential',
     /req\.cookies && req\.cookies\['svc_token'\]/.test(AUTH) &&
     /h\['Authorization'\]/.test(PAGE));
}

console.log('\nboth upload paths carry it');
{
  ok('the comment upload goes through apiFetch, which adds the header',
     /apiFetch\(\s*`\/api\/change-requests\/\$\{CURRENT_REQUEST_ID\}\/comments`/.test(PAGE),
     'a bare fetch here would rely on the cookie');
  ok('and the request-level upload sends the header explicitly',
     /\/attachments`,\s*\{ method:'POST', body:fd, credentials:'include', headers: apiHeaders\(false\) \}/.test(PAGE),
     'this one sent no credential at all');
  ok('without forcing a JSON content type on the multipart body',
     /apiHeaders\(false\)/.test(PAGE) &&
     /function apiHeaders\(isJson = true\) \{[\s\S]{0,200}if \(isJson\) h\['Content-Type'\]/.test(PAGE),
     'setting Content-Type on FormData strips the multipart boundary');
  ok('apiFetch already skips it for FormData',
     /const isJson = !\(opts\.body instanceof FormData\);/.test(PAGE));
}

console.log('\nan expired session says so');
{
  ok('a 401 on upload is reported as an expired session',
     /res\.status === 401\s*\?\s*'your session has expired/.test(PAGE),
     '"HTTP 401" tells somebody nothing they can act on');
}

console.log('\nthe upload errors say which problem it is');
{
  /* multer raises LIMIT_UNEXPECTED_FILE both for too many files and for a
     field name the route does not expect. Reporting both as "too many files
     on one comment" sent somebody hunting for a ninth file on a route that
     takes one. */
  /* The variable existing is not the point — it has to CHOOSE the message.
     An earlier version of this assertion also accepted the mere presence of
     `onComments`, and passed with the ternary neutered. */
  ok('the path chooses which message is sent',
     /unexpected \? \(onComments/.test(ROUTE),
     'one message covered two different faults');
  ok('the comment route still says the eight-file limit',
     /Too many files on one comment — attach up to 8\./.test(ROUTE));
  ok('and the single-file route says something a person can act on',
     /not in the form this page sends/.test(ROUTE));
  ok('the error handler can see the path it is answering for',
     /router\.use\(\(err, req, res, next\)/.test(ROUTE),
     'it took _req and could not tell the routes apart');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
