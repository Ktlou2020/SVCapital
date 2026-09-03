#!/usr/bin/env node
/* The stored-markup audit, run from the admin console.
 *
 * One implementation behind two front ends — the endpoint and the CLI — for
 * the same reason as the maturity pre-flight: two copies of a security check
 * drift, and then they disagree about whether anything is wrong.
 *
 * The property worth guarding hardest is the panel's own output. Every finding
 * it renders IS the suspect text. A panel that reported unescaped markup by
 * writing it into the page would be the vulnerability it exists to find, and
 * it would fire in an admin session that can move money.
 *
 * Exercised against the real router over a real socket, on seeded rows.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-markup-audit-endpoint.cjs
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

/* Its own database, created and dropped here.

   The suite shares one scratch database and several checks replace its schema
   with a minimal one to suit themselves. A check that rebuilds the full schema
   mid-run breaks whatever follows — this one did exactly that on its first
   outing, taking the two maturity checks down with it, which is the same trap
   check-investor-text-writes hit an hour earlier.

   Skipping instead would be worse: the check that runs immediately before this
   one leaves a minimal schema, so a "skip if incomplete" guard would skip
   every single time and quietly test nothing. Isolation is the only answer
   that both works and stays honest. */
const SSL = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
/* A name no other process can pick.
 *
 * A check failed intermittently with FATAL 57P01, "terminating connection due
 * to administrator command" — which in this suite only comes from
 * DROP DATABASE ... WITH (FORCE), confirmed by the forced checkpoint the
 * server logs immediately after it. Something dropped a database out from
 * under a running check.
 *
 * process.pid alone is not unique enough to rule that out: one suite run
 * spawns two hundred short-lived processes and a container recycles pids, so
 * two checks can pick the same database name minutes apart. The random suffix
 * costs nothing and removes the only way two processes can name the same
 * database. */
const DB_NAME = 'chk_markup_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

/* Swapped structurally rather than by regex. An earlier helper elsewhere in
   this repo rewrote the database name with a pattern that only matched when
   the URL carried a query string, so it silently pointed at the ORIGINAL
   database and reported failures that had nothing to do with the code. */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
}

const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });
let pool;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);

  /* setup.js reads DATABASE_URL through db/pool.js at require time, so the
     variable is pointed at the new database before it is loaded. */
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  process.env.DATABASE_URL = original;

  pool = new Pool({ connectionString: url, ssl: SSL });

  /* The teardown drops this database WITH (FORCE), which terminates whatever

     is still connected to it. pg reports that as an 'error' event on the pool,

     and a pool with no listener for one takes the process down — so a check

     that passed every assertion exits non-zero, at random, with a stack that

     names pg and not the drop. The termination is expected. The crash is not. */

  pool.on('error', () => {});
  return true;
}

const wipe = () => pool.query(`DELETE FROM investors WHERE id LIKE 'MKA-%'`);

const PAYLOAD = '<img src=x onerror=alert(1)>';

async function seed() {
  await wipe();
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, address)
    VALUES ('MKA-EXEC',  $1,        'Attacker','exec@example.test', 'active','fine'),
           ('MKA-QUOTE', 'Seán',    'O''Brien','quote@example.test','active','fine'),
           ('MKA-CLEAN', 'Thandi',  'Mokoena', 'clean@example.test','active','12 Main Rd')`,
    [PAYLOAD]);
}

function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const app = express();
  /* The real router, but with its auth guard replaced — this check is about
     the audit's behaviour, not about re-testing requireRole. That the route
     IS guarded is asserted separately, from the source. */
  const router = express.Router();
  const { runStoredMarkupAudit } = require(path.join(ROOT, 'server', 'services', 'storedMarkupAudit'));
  router.get('/stored-markup-audit', async (req, res) => {
    try { res.json(await runStoredMarkupAudit(pool, { limit: req.query.limit })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.use('/api/admin', router);
  return new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
}
const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error(b.slice(0, 200))); } });
  }).on('error', reject);
});

(async () => {
  let srv;
  try {
    await makeDatabase();
    await seed();
    srv = await serve();
    const port = srv.address().port;

    const { status, body } = await get(port, '/api/admin/stored-markup-audit');
    ok('the endpoint answers', status === 200, `status ${status}`);

    console.log('\nit finds what is there, at the right severity');
    {
      const ex = body.executable.filter(x => x.rowId === 'MKA-EXEC');
      ok('the payload is found', ex.length === 1, JSON.stringify(body.executable.map(x => x.rowId)));
      ok('and reported as executable, not merely breaking',
         ex[0] && /onerror/.test(ex[0].value), JSON.stringify(ex[0]));
      ok('naming the table and column so it can be found',
         ex[0] && ex[0].table === 'investors' && ex[0].column === 'first_name', JSON.stringify(ex[0]));

      const br = body.breaking.filter(x => x.rowId === 'MKA-QUOTE');
      ok('an apostrophe is reported as breaking, not executable',
         br.length === 1 && !body.executable.some(x => x.rowId === 'MKA-QUOTE'),
         JSON.stringify({ breaking: br.length, executable: body.executable.map(x => x.rowId) }));
      ok('a clean row is not reported at all',
         !body.executable.concat(body.breaking).some(x => x.rowId === 'MKA-CLEAN'));
      ok('a row appears once, at its worst severity',
         !body.breaking.some(x => x.rowId === 'MKA-EXEC'),
         'the breaking query excludes the executable predicate');
      ok('the verdict reflects the worst finding',
         body.verdict === 'executable-found', body.verdict);
    }

    console.log('\nstructural quotes are not reported as findings');
    {
      /* investors.notes holds a JSON array, so every populated row contains
         double quotes. On the first production run those were most of the
         findings and buried the three that were real. */
      await pool.query(`INSERT INTO investors (id, first_name, last_name, email, status, notes)
        VALUES ('MKA-JSON','Thandi','Mokoena','json@example.test','active',
                '[{"note":"Wallet topped up","admin_email":"Odireleng Ramela"}]'),
               ('MKA-JSX','Thandi','Mokoena','jsx@example.test','active',
                '[{"note":"<script>alert(1)</script>"}]')`);
      const r = await get(port, '/api/admin/stored-markup-audit');

      ok('an ordinary JSON note is not reported',
         !r.body.breaking.some(x => x.rowId === 'MKA-JSON') &&
         !r.body.executable.some(x => x.rowId === 'MKA-JSON'),
         JSON.stringify(r.body.breaking.filter(x => x.column === 'notes')));
      ok('but markup inside a note still is',
         r.body.executable.some(x => x.rowId === 'MKA-JSX' && x.column === 'notes'),
         'skipping the quote check must not stop the audit looking for tags');
      ok('and the response names where quotes ARE checked',
         Array.isArray(r.body.quotesCheckedIn) &&
         r.body.quotesCheckedIn.includes('investors.first_name') &&
         !r.body.quotesCheckedIn.includes('investors.notes'),
         JSON.stringify(r.body.quotesCheckedIn));
      await pool.query(`DELETE FROM investors WHERE id IN ('MKA-JSON','MKA-JSX')`);
    }

    console.log('\na quote only counts where it reaches an attribute');
    {
      /* Two production runs got this wrong in different ways: the first
         reported every JSON note, the second every support ticket, because
         English prose is full of apostrophes. Both buried the findings that
         were about a real person's name. */
      await pool.query(`INSERT INTO investors (id, first_name, last_name, email, status, suburb)
        VALUES ('MKA-SUB','Thandi','Mokoena','sub@example.test','active','Allen''s Nek')`);
      await pool.query(`INSERT INTO support_tickets (id, investor_id, subject, message, status)
        VALUES ('MKA-TKT','MKA-SUB','Bank','Please verify in the investor''s profile.','open'),
               ('MKA-TKX','MKA-SUB','Bad','<img src=x onerror=1>','open')`);
      const r = await get(port, '/api/admin/stored-markup-audit');

      ok('an apostrophe in prose is not reported',
         !r.body.breaking.some(x => x.rowId === 'MKA-TKT'),
         JSON.stringify(r.body.breaking.map(x => `${x.column}:${x.rowId}`)));
      ok('nor one in a field rendered as text, like suburb',
         !r.body.breaking.some(x => x.column === 'suburb'),
         JSON.stringify(r.body.breaking.map(x => x.column)));
      ok('but markup in that same prose column still is',
         r.body.executable.some(x => x.rowId === 'MKA-TKX'),
         'narrowing the quote check must not narrow the markup check');
      await pool.query(`DELETE FROM support_tickets WHERE id IN ('MKA-TKT','MKA-TKX')`);
      await pool.query(`DELETE FROM investors WHERE id = 'MKA-SUB'`);
    }

    console.log('\nit says what it looked at');
    {
      ok('the scanned columns are listed', Array.isArray(body.scanned) && body.scanned.length > 0,
         JSON.stringify(body.scanned?.slice(0, 4)));
      ok('a column that does not exist is skipped, not silently dropped',
         Array.isArray(body.skipped),
         'an audit that quietly scans less than it claims is worse than one that scans nothing');
      ok('and it is timestamped', !!body.generatedAt);
    }

    console.log('\nclean data produces a clean verdict');
    {
      await pool.query(`DELETE FROM investors WHERE id IN ('MKA-EXEC','MKA-QUOTE')`);
      const r2 = await get(port, '/api/admin/stored-markup-audit');
      ok('nothing is reported', r2.body.totals.executable === 0, JSON.stringify(r2.body.totals));
      ok('and the verdict says so', r2.body.verdict === 'clean' || r2.body.verdict === 'attribute-breaking-only',
         r2.body.verdict);
    }

    console.log('\none implementation, two front ends');
    {
      const svc   = fs.readFileSync(path.join(ROOT, 'server', 'services', 'storedMarkupAudit.js'), 'utf8');
      const cli   = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'audit-stored-markup.cjs'), 'utf8');
      const route = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'manualCredit.js'), 'utf8');

      ok('the CLI renders the shared service rather than its own queries',
         /require\(path\.join\(__dirname, '\.\.', 'services', 'storedMarkupAudit'\)\)/.test(cli) &&
         !/EXECUTABLE = /.test(cli),
         'it carried a second copy of the predicates before this');
      ok('and so does the endpoint',
         /require\('\.\.\/services\/storedMarkupAudit'\)/.test(route));
      ok('the service writes nothing',
         !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b\s/.test(
           svc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')));
      ok('the route is admin-gated',
         /router\.use\(requireAuth, requireRole\('admin', 'director'\)\)/.test(route),
         'the findings quote stored text back verbatim');
      ok('the per-column cap is bounded',
         /Math\.min\(1000, Math\.max\(1, parseInt\(limit, 10\) \|\| 200\)\)/.test(svc));
    }

    console.log('\nthe panel does not render the markup it is reporting');
    {
      const adm = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
      const at  = adm.indexOf('async function runStoredMarkupAudit(btn)');
      ok('the handler exists', at > -1);
      const fn = adm.slice(at, adm.indexOf('\n}\n', at));

      /* The finding IS the payload. If any of these reached innerHTML raw, the
         panel would execute the thing it is warning about. */
      for (const field of ['x.value', 'x.table', 'x.column', 'x.rowId']) {
        ok(`${field} is escaped`, new RegExp(`_esc\\(${field.replace('.', '\\.')}\\)`).test(fn), fn.slice(0, 400));
      }
      ok('no finding field is interpolated raw',
         !/\$\{x\.(value|table|column|rowId)\}/.test(fn), fn.slice(0, 600));
      ok('the failure message is escaped too',
         /_esc\(e\.message/.test(fn),
         'a server error can carry text that came from the database');
      ok('and the panel has somewhere to render',
         /id="markupAuditResult"/.test(fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8')));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    if (pool) await pool.end().catch(() => {});
    /* Dropped, not left behind — one scratch database per run would accumulate. */
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
