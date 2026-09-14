#!/usr/bin/env node
/* Admin notes about an investor go into investor_notes, and nowhere else.
 *
 * investor_notes has existed in the schema since it was written. It was never
 * added to ALLOWED_TABLES in server/routes/tables.js, so validateTable 404'd
 * every request the admin console made against it — roughly 170 a week in
 * production, not one of which ever succeeded. Nobody noticed, because the
 * console caught the failure and wrote the note into investors.notes instead,
 * as a JSON array, then reported "Note saved".
 *
 * investors.notes also carries banking JSON. The two formats shared one column
 * and the read path told them apart with raw.startsWith('{'), so an investor
 * whose banking details had been captured showed no notes at all from then on
 * — the ones already written were still in the column, just unreachable.
 *
 * Three things have to hold now, and each has a way of quietly coming undone:
 *
 *   1. The table is reachable — and admin-only. There is no INVESTOR_COLS
 *      entry for investor_notes, so the generic list route applies no row
 *      filter to it. Adding it to ALLOWED_TABLES without the admin gate would
 *      have let any investor read every note staff have written about every
 *      client. That is the expensive half of this fix.
 *   2. A note actually inserts. The primary key is a uuid with a database
 *      default, and the POST handler's id generator produces 'REC-<ts>' — so
 *      the route would have failed on the column type even once it was
 *      whitelisted. The console's own 'NOTE-<ts>' likewise.
 *   3. The stranded notes come back, and nothing else in that column is
 *      touched.
 *
 * The route is exercised over HTTP against a real database with the shipped
 * router, not read for the shape of its source. Only the token check is
 * stubbed — what is under test is which role may reach which table, not how a
 * JWT is parsed.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investor-notes.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const http = require('http');
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

const TABLES_SRC = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
const ADMIN_SRC  = fs.readFileSync(path.join(ROOT, 'admin', 'js', 'admin.js'), 'utf8');
const SETUP_SRC  = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');

/* Comments stripped before matching, so a paragraph describing the old
   behaviour cannot satisfy an assertion about the new one. */
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/* The real declarations, evaluated out of the shipped file. A retyped copy
   would go on passing for weeks after someone edited the original. */
function lift(name, opener) {
  const at = TABLES_SRC.indexOf(`const ${name} = ${opener}`);
  if (at < 0) throw new Error(`could not find ${name} in tables.js`);
  const from = TABLES_SRC.indexOf('=', at) + 1;
  const end  = TABLES_SRC.indexOf('\n};', from) >= 0 && opener === '{'
    ? TABLES_SRC.indexOf('\n};', from) + 2
    : TABLES_SRC.indexOf(']);', from) + 3;
  // eslint-disable-next-line no-eval
  return eval('(' + TABLES_SRC.slice(from, end).replace(/;\s*$/, '') + ')');
}

/* ── A server running the shipped router, with only the token check stubbed ── */
function startServer() {
  const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth.js'));
  const real     = require(authPath);
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, exports: {
      ...real,
      /* The role arrives in a header so one server can answer as either. Every
         other guard in tables.js — ADMIN_ONLY_TABLES, ADMIN_WRITE_TABLES,
         INVESTOR_COLS — is the shipped one. */
      requireAuth: (req, res, next) => {
        const role = req.headers['x-test-role'];
        if (!role) return res.status(401).json({ error: 'no role' });
        req.user = role === 'investor'
          ? { id: 'u-inv', role: 'investor', email: 'inv@example.com', investorId: req.headers['x-test-investor'] || null }
          : { id: 'u-adm', role, email: 'admin@example.com' };
        next();
      },
    },
  };

  delete require.cache[require.resolve(path.join(ROOT, 'server', 'routes', 'tables.js'))];
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/tables', require(path.join(ROOT, 'server', 'routes', 'tables.js')));
  return new Promise(resolve => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const call = (srv, method, url, role, body) => {
  const { port } = srv.address();
  return fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  let srv;
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nthe table is reachable at all');
    {
      const allowed = lift('ALLOWED_TABLES', '{');
      ok('investor_notes is in ALLOWED_TABLES',
         allowed.investor_notes === 'id',
         'validateTable 404s anything absent from this map — which is the whole bug');
    }

    console.log('\nand reaching it requires being staff');
    {
      const readOnly  = lift('ADMIN_ONLY_TABLES', 'new Set(');
      const writeOnly = lift('ADMIN_WRITE_TABLES', 'new Set(');
      const investorCols = lift('INVESTOR_COLS', '{');

      ok('reads are admin-only', readOnly.has('investor_notes'));
      ok('writes are admin-only', writeOnly.has('investor_notes'));
      /* Why the guard above is load-bearing rather than belt-and-braces: with
         no INVESTOR_COLS entry the list route adds no ownership condition, so
         an investor who got past the role check would read the whole table —
         every note about every client, not merely their own. */
      ok('there is no row filter to fall back on',
         !investorCols.investor_notes,
         'if this ever gains an entry, say so here — it changes what the admin gate is protecting against');
    }

    srv = await startServer();
    const INV = 'INV-NOTES-CHK';
    await db.query(`DELETE FROM investor_notes WHERE investor_id = $1`, [INV]);

    console.log('\na staff member can write a note and read it back');
    {
      const w = await call(srv, 'POST', '/api/tables/investor_notes', 'admin', {
        investor_id: INV, admin_email: 'kagiso@svcapital.co.za', note: 'Called the client, happy to proceed.',
      });
      ok('the write is accepted', w.status === 200 || w.status === 201, `${w.status} ${JSON.stringify(w.body)}`);
      ok('and the database generated the uuid key',
         UUID_RE.test(String(w.body?.data?.id || w.body?.id || '')),
         JSON.stringify(w.body));

      const r = await call(srv, 'GET', `/api/tables/investor_notes?investor_id=${INV}&limit=50`, 'admin');
      ok('it reads back against that investor', r.status === 200 && (r.body.data || []).length === 1,
         `${r.status} ${JSON.stringify(r.body)}`);
      ok('with the text intact',
         (r.body.data || [])[0]?.note === 'Called the client, happy to proceed.',
         JSON.stringify((r.body.data || [])[0]));
    }

    console.log("\nan id the console used to send does not break the insert");
    {
      /* The console sent id: `NOTE-${Date.now()}` for years. Against a uuid
         column that is invalid input, so whitelisting the table alone would
         have turned 404 into 500 and changed nothing for the operator. */
      const w = await call(srv, 'POST', '/api/tables/investor_notes', 'admin', {
        id: `NOTE-${Date.now()}`, investor_id: INV, admin_email: 'a@b.c', note: 'Second note.',
      });
      ok('a non-uuid id is dropped rather than passed through',
         (w.status === 200 || w.status === 201) && UUID_RE.test(String(w.body?.data?.id || w.body?.id || '')),
         `${w.status} ${JSON.stringify(w.body)}`);
      ok('and the auto-id generator does not claim it either',
         !/REC-\d/.test(JSON.stringify(w.body)),
         "'REC-<ts>' is what the prefix map produces for an unlisted table — also not a uuid");
    }

    console.log('\nan investor cannot read what staff wrote about them');
    {
      const r = await call(srv, 'GET', `/api/tables/investor_notes?investor_id=${INV}`, 'investor');
      ok('the list route refuses', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
      const w = await call(srv, 'POST', '/api/tables/investor_notes', 'investor',
                           { investor_id: INV, admin_email: 'x', note: 'mine now' });
      ok('and so does the write route', w.status === 403, `${w.status} ${JSON.stringify(w.body)}`);

      const { rows } = await db.query(`SELECT count(*)::int n FROM investor_notes WHERE investor_id = $1`, [INV]);
      ok('nothing of theirs reached the table', rows[0].n === 2, `${rows[0].n} rows`);
    }

    console.log('\nthe notes stranded in investors.notes come back');
    {
      const mk = async (id, notes) => {
        await db.query(`DELETE FROM investors WHERE id = $1`, [id]);
        await db.query(
          `INSERT INTO investors (id, first_name, last_name, email, notes)
           VALUES ($1, 'Note', 'Check', $2, $3)`,
          [id, `${id.toLowerCase()}@example.com`, notes]);
      };
      const ARR  = 'INV-CHK-ARRAY', BANK = 'INV-CHK-BANK', TEXT = 'INV-CHK-TEXT';
      const stranded = JSON.stringify([
        { note: 'Second contact',  admin_email: 'ops@svcapital.co.za', created_at: '2026-02-02T10:00:00Z' },
        { note: 'First contact',   admin_email: 'ops@svcapital.co.za', created_at: '2026-01-01T10:00:00Z' },
      ]);
      const bankJson = JSON.stringify({ bank: 'FNB', account: '62xxxxxxxx', branch: '250655' });

      for (const id of [ARR, BANK, TEXT]) await db.query(`DELETE FROM investor_notes WHERE investor_id = $1`, [id]);
      await mk(ARR, stranded);
      await mk(BANK, bankJson);
      await mk(TEXT, 'Prefers to be called after 17h00.');

      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

      const notesFor = async id => (await db.query(
        `SELECT note, admin_email, created_at FROM investor_notes
          WHERE investor_id = $1 ORDER BY created_at`, [id])).rows;
      const colFor = async id => (await db.query(`SELECT notes FROM investors WHERE id = $1`, [id])).rows[0]?.notes;

      const moved = await notesFor(ARR);
      ok('both notes are now rows', moved.length === 2, JSON.stringify(moved));
      ok('in the order they were written',
         moved[0]?.note === 'First contact' && moved[1]?.note === 'Second contact',
         JSON.stringify(moved.map(m => m.note)));
      ok('keeping who wrote them', moved.every(m => m.admin_email === 'ops@svcapital.co.za'));
      ok('and when',
         !!moved[0] && new Date(moved[0].created_at).toISOString().startsWith('2026-01-01'),
         String(moved[0]?.created_at) + ' — dropping the stored timestamp flattens every note to the deploy date');
      ok('the column is cleared once they are safely moved', (await colFor(ARR)) === null, String(await colFor(ARR)));

      ok('banking json is left exactly as it was', (await colFor(BANK)) === bankJson, String(await colFor(BANK)));
      ok('and produced no notes', (await notesFor(BANK)).length === 0);
      ok('plain text is left alone too',
         (await colFor(TEXT)) === 'Prefers to be called after 17h00.',
         'that shape is ambiguous — it may be a note, or it may be anything else somebody typed');
      ok('and produced no notes either', (await notesFor(TEXT)).length === 0);

      /* Boot happens more than once. */
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
      ok('a second boot does not duplicate them', (await notesFor(ARR)).length === 2,
         `${(await notesFor(ARR)).length} rows after running twice`);

      for (const id of [ARR, BANK, TEXT]) {
        await db.query(`DELETE FROM investor_notes WHERE investor_id = $1`, [id]);
        await db.query(`DELETE FROM investors WHERE id = $1`, [id]);
      }
    }

    console.log('\nthe migration cannot lose a note it fails to move');
    {
      const step = SETUP_SRC.slice(SETUP_SRC.indexOf('15. Move admin notes out of investors.notes'));
      const body = step.slice(0, step.indexOf('\n    });'));
      ok('each investor moves inside a transaction', /BEGIN/.test(body) && /COMMIT/.test(body));
      ok('and a failure rolls the whole row back', /ROLLBACK/.test(body),
         'clear-then-insert loses the only copy; insert-then-fail-to-clear duplicates on the next boot');
      ok('the column is only read for array-shaped values',
         /LIKE '\[%'/.test(body),
         'an object is banking json and plain text may be anything — neither is safe to move');
      ok('and a non-array is skipped rather than guessed at',
         /if \(!Array\.isArray\(parsed\)\) \{ skipped\+\+; continue; \}/.test(body));
    }

    console.log('\nthe console no longer writes notes into the wrong column');
    {
      const src = decomment(ADMIN_SRC);
      const fn  = src.slice(src.indexOf('async function addInvestorNote'));
      const addNote = fn.slice(0, fn.indexOf('\n}\n'));

      ok('it posts to the table', /tables\/investor_notes/.test(addNote));
      ok('without inventing an id', !/id:\s*`NOTE-/.test(addNote),
         'the column is a uuid with its own default');
      ok('and a failure is reported, not rerouted',
         !/tables\/investors\/\$\{investorId\}/.test(addNote) && /Toast\.error/.test(addNote),
         'the old fallback PATCHed investors.notes and then said "Note saved"');

      const load = src.slice(src.indexOf('async function loadInvestorNotes'));
      const loadNotes = load.slice(0, load.indexOf('\n}\n'));
      ok('the reader still shows whatever the migration left behind',
         /legacyNotes\(\)/.test(loadNotes),
         'plain text in investors.notes is deliberately not migrated — it has to stay visible');
      ok('but only when the table has nothing for that investor',
         /notes\.length \? notes : legacyNotes\(\)/.test(loadNotes),
         'otherwise a migrated note would be listed twice');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await db.query(`DELETE FROM investor_notes WHERE investor_id LIKE 'INV-%CHK%' OR investor_id LIKE 'INV-CHK%'`).catch(() => {});
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
