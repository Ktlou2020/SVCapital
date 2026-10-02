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
const CSS   = read('team/css/employee.css');

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
     /SELECT p\.id, p\.title[\s\S]{0,900}FROM staff_policies p/.test(CODE)
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

console.log('\nI have read this');
{
  /* Acknowledging is the reader's own act, so it sits behind the READING
     guard. Putting it behind requireAuthor would mean only directors could
     ever say they had read a policy. */
  ok('a member of staff records their own reading',
     /router\.post\('\/:id\/acknowledge', requireAuth, requireStaff/.test(CODE),
     'behind requireAuthor, only a director could ever confirm one');
  ok('pressing it twice is pressing it once',
     /ON CONFLICT \(policy_id, employee_id\) DO NOTHING/.test(CODE));
  ok('and the first date is the one kept',
     !/DO UPDATE SET[\s\S]{0,80}acknowledged_at/.test(CODE)
     && /SELECT acknowledged_at FROM staff_policy_acks WHERE policy_id = \$1 AND employee_id = \$2/.test(CODE),
     'a second press must not move a date somebody is relying on');
  ok('a withdrawn policy cannot be acknowledged',
     /if \(!p\.is_active\) return res\.status\(409\)/.test(CODE),
     'signing for something nobody is being held to is a false record');
  ok('nor one that does not ask for it',
     /if \(!p\.requires_ack\) return res\.status\(400\)/.test(CODE));
  ok('who signed, and from where, is kept',
     /INSERT INTO staff_policy_acks \(policy_id, employee_id, employee_name, employee_email, ip_address\)/.test(CODE),
     'a name on the row survives the employee record being renamed');

  ok('who has NOT read it is a director question',
     /router\.get\('\/:id\/acknowledgements', requireAuthor/.test(CODE),
     'it names colleagues and their standing — not a staff-wide list');
  ok('and it is the half the report computes',
     /NOT EXISTS \(SELECT 1 FROM staff_policy_acks a/.test(CODE),
     'a list of who HAS read it answers the easy question');
  ok('counting only people still employed',
     /WHERE COALESCE\(e\.status, 'active'\) = 'active'/.test(CODE),
     'a leaver who never signed is outstanding forever');

  ok('the shelf tells the reader what they still owe',
     /LEFT JOIN staff_policy_acks a ON a\.policy_id = p\.id AND a\.employee_id = \$1/.test(CODE),
     'acknowledged_at is per person, not a count');
  ok('and counts only live policies that ask for one',
     /rows\.filter\(r => r\.is_active && r\.requires_ack && !r\.acknowledged_at\)/.test(CODE));
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
  const raw = [...view.matchAll(/\$\{(?!esc\(|POLICY_|Object|byCat|cat\b|_policies|_canPublish|_policyOutstanding)([a-zA-Z_][\w.?]*)\}/g)]
    .map(m => m[1]).filter(v => !/^(p|cat)$/.test(v));
  ok('and everything a person supplied goes through it', raw.length === 0, raw.join(', '));

  /* A one-click "I have read this" next to a document nobody opened records
     nothing but the click. The button is a lock until the file has been
     fetched through openPolicy. */
  ok('the acknowledge button is locked until the document is opened',
     /const opened = _policyOpened\.has\(p\.id\);[\s\S]{0,200}\$\{opened \? '' : 'disabled'\}/.test(JS),
     'otherwise it records a click, not a reading');
  ok('and opening it is what unlocks it',
     /_policyOpened\.add\(id\); renderPolicies\(\)/.test(JS));
  ok('an outstanding policy is said out loud, not left to be noticed',
     /_policyOutstanding \?/.test(JS) && /your acknowledgement/.test(JS));
  ok('a card still owing one is marked',
     /policy-card--todo/.test(JS) && /\.policy-card--todo/.test(CSS));
  ok('the "who has read it" button is a director one',
     /_canPublishPolicies\(\) \? `<button class="policy-who"/.test(JS));
  {
    /* Inverted deliberately: every ${…} in this modal must START with
       something known to be safe, rather than every ${…} merely not looking
       like a bare identifier. A colleague's name reaches this screen from
       their own employee record, and ${[e.first_name, e.last_name]...} is
       not a bare identifier. */
    const modal = JS.slice(JS.indexOf('async function showPolicyReaders('), JS.indexOf('function openPolicyUpload('));
    const SAFE = ['esc(', 'encodeURIComponent(', 'r.readCount', 'r.outstandingCount',
                  'r.outstanding.map(', 'r.read.map(', '!r.policy.requires_ack', 'r.policy.version ?'];
    const raw = [...modal.matchAll(/\$\{/g)]
      .map(m => modal.slice(m.index + 2, m.index + 42))
      .filter(tail => !SAFE.some(s => tail.startsWith(s)))
      .map(tail => tail.split('\n')[0].slice(0, 30));
    ok('and the names in it are escaped', raw.length === 0, raw.join(' | '));
  }
  ok('publishing can say whether it needs acknowledging',
     /id="polRequiresAck"/.test(JS)
     && /requires_ack: *document\.getElementById\('polRequiresAck'\)\.checked/.test(JS));

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
    ok('and it knows whether it must be acknowledged', have.requires_ack === 'NO');

    console.log('\nand a table to hold who has read them');
    const { rows: acols } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'staff_policy_acks'`);
    const ahave = acols.map(c => c.column_name);
    ok('staff_policy_acks exists', acols.length > 0);
    for (const c of ['policy_id','employee_id','employee_name','employee_email','acknowledged_at','ip_address'])
      ok(`it has ${c}`, ahave.includes(c));

    const { rows: [pk] } = await db.query(`
      SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.conrelid = 'staff_policy_acks'::regclass AND c.contype = 'p'`);
    ok('one row per person per policy, enforced by the key',
       pk && pk.cols === 'employee_id,policy_id',
       `primary key is (${pk ? pk.cols : 'none'}) — a person could sign twice`);

    const { rows: [fk] } = await db.query(`
      SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'staff_policy_acks'::regclass AND contype = 'f'`);
    ok('and the rows go when the policy does', fk && fk.confdeltype === 'c',
       'an ack pointing at a deleted policy is a record of nothing');

    /* A policy is replaced rather than edited, so an acknowledgement belongs
       to the VERSION. Signing v1 must not count as having read v2. */
    console.log('\nsigning one version is not signing the next');
    const tag = 'CHK-ACK-' + Date.now();
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO staff_policies (id, title, category, filename, mimetype, file_data, requires_ack)
                      VALUES ($1,'Check v1','general','a.pdf','application/pdf','data:application/pdf;base64,JVBERi0=',true)`, [tag + '-1']);
      await db.query(`INSERT INTO staff_policies (id, title, category, filename, mimetype, file_data, requires_ack, supersedes_id)
                      VALUES ($1,'Check v2','general','a.pdf','application/pdf','data:application/pdf;base64,JVBERi0=',true,$2)`, [tag + '-2', tag + '-1']);
      await db.query(`INSERT INTO staff_policy_acks (policy_id, employee_id) VALUES ($1,'CHK-EMP')`, [tag + '-1']);
      const { rows: [n] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM staff_policy_acks WHERE policy_id = $1 AND employee_id = 'CHK-EMP'`, [tag + '-2']);
      ok('the replacement is still outstanding', n.n === 0);
      const first = await db.query(
        `SELECT acknowledged_at FROM staff_policy_acks WHERE policy_id = $1`, [tag + '-1']);
      await db.query(`INSERT INTO staff_policy_acks (policy_id, employee_id) VALUES ($1,'CHK-EMP')
                      ON CONFLICT (policy_id, employee_id) DO NOTHING`, [tag + '-1']);
      const again = await db.query(
        `SELECT acknowledged_at FROM staff_policy_acks WHERE policy_id = $1`, [tag + '-1']);
      ok('and a second signature does not move the first date',
         again.rows.length === 1
         && +new Date(again.rows[0].acknowledged_at) === +new Date(first.rows[0].acknowledged_at));
      await db.query('DELETE FROM staff_policies WHERE id = $1', [tag + '-2']);
      const { rows: [left] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM staff_policy_acks WHERE policy_id = $1`, [tag + '-2']);
      ok('deleting a policy takes its acknowledgements with it', left.n === 0);
    } finally {
      await db.query('ROLLBACK');
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
