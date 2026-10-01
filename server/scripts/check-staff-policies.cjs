#!/usr/bin/env node
/* Company policies: written by the directors, read by everyone on staff.
 *
 * Two guards, deliberately different, and the difference is the point:
 *
 *   READING  anyone with a STAFF identity. Not a role list — a role list has
 *            to name every role a new hire might carry, and silently excludes
 *            whoever was forgotten. req.user.empId is what separates staff
 *            from an investor, and an investor must never see these at all.
 *
 *   WRITING  admin or director, the pairing every other authoring surface on
 *            this platform uses.
 *
 * The file is validated from its BYTES. A policy is something people open, so
 * a stored text/html claiming to be a PDF would run as the platform with the
 * reader's session — the same hole the factsheet routes had.
 *
 * And it is served as real bytes from its own endpoint, never as a data: URL
 * in the listing: Chrome has refused to navigate to one since 2017 and the
 * CSP refuses to frame one, which is what made factsheets open blank. Keeping
 * file_data out of the list is also what stops a shelf of policies being
 * megabytes per row.
 *
 * Needs a database:
 *   DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-staff-policies.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..', '..');
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTE = read('server/routes/staffPolicies.js');
const CODE  = strip(ROUTE);
const HTML  = read('team/employee.html');
const JS    = read('team/js/employee.js');
const INDEX = read('server/index.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nwho may read, and who may write');
{
  ok('it is mounted', /app\.use\('\/api\/staff-policies'/.test(strip(INDEX)));
  ok('reading needs a staff identity, not a role',
     /function requireStaff\([\s\S]{0,200}req\.user\.empId/.test(CODE),
     'a role list excludes whichever role nobody remembered to add');
  ok('and an investor, who has no empId, is refused',
     /if \(!req\.user \|\| !req\.user\.empId\)[\s\S]{0,120}403/.test(CODE));
  ok('the list is behind it', /router\.get\('\/', requireAuth, requireStaff/.test(CODE));
  ok('and so is the file itself',
     /router\.get\('\/:id\/file', requireAuth, requireStaff/.test(CODE),
     'the document is the thing worth protecting, not the list of titles');
  ok('writing is admin or director',
     /const requireAuthor = \[requireAuth, requireRole\('admin', 'director'\)\]/.test(CODE));
  for (const verb of ['post', 'patch', 'delete']) {
    ok(`${verb} uses it`, new RegExp(`router\\.${verb}\\('[^']*', requireAuthor`).test(CODE));
  }
}

console.log('\nwhat may be uploaded');
{
  ok('the type is taken from the bytes',
     /validateStoredFile\(file_data, \{ allow: ALLOWED/.test(CODE),
     'trusting a declared mime is how an HTML file becomes a factsheet');
  ok('only documents and pictures of documents',
     /const ALLOWED = \['application\/pdf', 'image\/png', 'image\/jpeg', 'image\/webp'\]/.test(CODE));
  ok('nothing a browser executes', !/text\/html|image\/svg|application\/javascript/.test(CODE));
  ok('there is a size limit', /MAX_BYTES = \d+ \* 1024 \* 1024/.test(CODE));
  ok('and the category cannot be anything a caller invents',
     /CATEGORIES\.includes\(/.test(CODE));
}

console.log('\nhow it comes back out');
{
  ok('the listing carries no file bytes',
     /SELECT p\.id, p\.title[\s\S]{0,400}FROM staff_policies p/.test(CODE)
     && !/SELECT[^;]*p\.file_data[\s\S]{0,200}FROM staff_policies p\b/.test(CODE),
     'megabytes a row, and every policy at once');
  ok('the file is served as real bytes',
     /res\.setHeader\('Content-Type'/.test(CODE) && /res\.send\(parsed\.bytes\)/.test(CODE),
     'a data: URL will not open and cannot be framed');
  ok('inline, so a PDF opens rather than downloads',
     /Content-Disposition[\s\S]{0,40}inline/.test(CODE));
  ok('and the filename is sanitised into the header',
     /replace\(\/\[\^\\w\.\\- \]\/g, '_'\)/.test(CODE));
}

console.log('\na policy is replaced, never edited');
{
  ok('a replacement retires the old one in the same transaction',
     /BEGIN[\s\S]{0,900}supersedes_id[\s\S]{0,400}is_active = false[\s\S]{0,200}COMMIT/.test(CODE),
     'two steps leave both live for as long as the second is forgotten');
  ok('withdrawing does not delete',
     /router\.delete\([\s\S]{0,300}UPDATE staff_policies SET is_active = false/.test(CODE),
     '"what did it say in March" cannot be answered by a deleted row');
  ok('and the file is never patched',
     !/router\.patch\([\s\S]{0,1200}file_data/.test(CODE),
     'the bytes behind an id must stay the bytes somebody read under that id');
  ok('every publish, change and withdrawal is audited',
     (CODE.match(/await audit\.log\(/g) || []).length >= 3);
}

console.log('\nthe screen');
{
  ok('Policies is in the staff sidebar', /data-view="policies"/.test(HTML));
  ok('and has a view to render into', /id="view-policies"/.test(HTML));
  ok('navigate knows how to render it', /policies: *renderPolicies/.test(JS));
  ok('the publish button is shown only to a director or admin',
     /_canPublishPolicies\(\) \? `<div class="view-header-actions">/.test(JS));
  ok('and the server does not rely on that',
     /requireAuthor/.test(CODE),
     'hiding a button is not a permission');

  /* This file had no escaper at all before policies were added to it. */
  ok('there is an HTML escaper in this file now', /const esc = v => String\(v == null/.test(JS));
  const view = JS.slice(JS.indexOf('async function renderPolicies()'), JS.indexOf('async function openPolicy('));
  const raw = [...view.matchAll(/\$\{(?!esc\(|POLICY_|Object|byCat|cat\b|_policies|_canPublish)([a-zA-Z_][\w.?]*)\}/g)]
    .map(m => m[1]).filter(v => !/^(p|cat)$/.test(v));
  ok('and everything a person supplied goes through it', raw.length === 0, raw.join(', '));

  /* requireAuth prefers the Authorization header over the cookie, and this
     portal signs in with a cookie — so "Bearer null" would 401 every open. */
  ok('the file fetch only sends a token when there is one',
     /headers: token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}/.test(JS),
     'requireAuth prefers the header, so Bearer null beats the cookie and 401s');
}

/* ── Against a database ────────────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the database half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
    console.log('\nthe table is there to hold them');
    const { rows: cols } = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'staff_policies'`);
    const have = Object.fromEntries(cols.map(c => [c.column_name, c.is_nullable]));
    ok('staff_policies exists', cols.length > 0);
    for (const c of ['id','title','category','filename','mimetype','file_data','is_active','supersedes_id'])
      ok(`it has ${c}`, c in have);
    ok('and the file cannot be null', have.file_data === 'NO');
    ok('nor the title', have.title === 'NO');
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
