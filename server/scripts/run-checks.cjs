#!/usr/bin/env node
/* Run the check suite, each check in its own database.
 *
 * Until now there was no runner: the suite was a shell loop over
 * `find . -name 'check-*.cjs'`, and every database-backed check shared one
 * scratch database. Eighteen of them contend over it — eleven DROP the schema
 * and rebuild it, six create their own tables in it, one simply assumes
 * whatever is there. A check therefore inherited whatever its predecessor
 * happened to leave behind.
 *
 * That is not theoretical. Alphabetical order passes and reverse order passes,
 * both by luck; three random orders gave 48/50, 49/50 and 50/50, failing a
 * different check each time. Two checks broke this way during one afternoon's
 * work, and each cost more to diagnose than it did to fix — the first
 * presented as a code failure in a file nobody had touched.
 *
 * So: one database per check, cloned from a template. autoSetup runs once into
 * the template and each check gets a CREATE DATABASE … TEMPLATE copy, which
 * Postgres does by copying files rather than replaying DDL — otherwise this
 * would mean running the full schema build eighteen times.
 *
 * Checks that never open a database are given none, and run as they always
 * have.
 *
 *   DATABASE_URL=… node server/scripts/run-checks.cjs
 *   …--shuffle          run in a random order — isolation should make this boring
 *   …--seed N           a specific shuffle, to reproduce one
 *   …--filter maturity  only checks whose path contains this
 *   …--keep             leave the scratch databases behind for inspection
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const ARGV = process.argv.slice(2);
const arg  = name => { const i = ARGV.indexOf(name); return i > -1 ? ARGV[i + 1] : null; };
const has  = name => ARGV.includes(name);

const SHUFFLE = has('--shuffle');
const KEEP    = has('--keep');
const FILTER  = arg('--filter');
const SEED    = arg('--seed') ? parseInt(arg('--seed'), 10) : Math.floor(Math.random() * 1e9);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at a scratch Postgres — this creates and');
  console.error('drops databases, so it must not be production.');
  process.exit(2);
}

const SSL = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };

/* Refuse to run against anything that looks like production. The runner's whole
   job is creating and dropping databases; pointed at the wrong host that is
   not a test failure, it is an incident. */
function looksLikeScratch(url) {
  const u = new URL(url);
  const db = (u.pathname || '').replace(/^\//, '').toLowerCase();
  const host = (u.hostname || '').toLowerCase();
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(host);
  const scratchName = /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(db) || /^svctest/.test(db);
  return localHost || scratchName;
}
if (!looksLikeScratch(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
  console.error('DATABASE_URL does not look like a scratch database, and this runner creates');
  console.error('and drops databases. Set CHECK_ALLOW_RESET=1 if you are certain.');
  process.exit(2);
}

/* Structural, not a regex. The regex form of this exists elsewhere in the repo
   and silently does nothing when the URL carries no query string, which sent a
   check at the wrong database and reported failures that had nothing to do
   with the code under test. */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
}

function discover() {
  const dirs = ['scripts', 'server/scripts', 'mobile/scripts'];
  const out = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/^check-.*\.cjs$/.test(f)) out.push(path.join(d, f));
    }
  }
  return out.sort();
}

/* Whether a check opens a database at all. Read from the file rather than
   guessed: giving a database to a check that does not want one is harmless but
   slow, and withholding one from a check that does is a false failure. */
function needsDatabase(rel) {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return /process\.env\.DATABASE_URL/.test(s);
}

/* Deterministic shuffle so a failing order can be reproduced from its seed. */
function shuffled(list, seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TEMPLATE = 'svc_chk_tpl_' + process.pid;

/* Where a failed check's full output goes, so a rare failure can be read
   rather than guessed at. */
const FAIL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-checks-'));
const admin = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

async function dropDb(name) {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
  });
}

async function buildTemplate() {
  await dropDb(TEMPLATE);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);

  const url = withDatabase(process.env.DATABASE_URL, TEMPLATE);
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];

  /* console.error too, not just log — autoSetup reports the expected COO
     failure through error, and letting it print here makes a clean template
     build look like something went wrong. The failures are read from the
     returned result below, which is the reliable source. */
  const qLog = console.log, qErr = console.error, qWarn = console.warn;
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  let result;
  try { result = await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally {
    console.log = qLog; console.error = qErr; console.warn = qWarn;
    process.env.DATABASE_URL = original;
  }

  /* autoSetup reports rather than throws, and the COO step fails without
     COO_PASSWORD — expected here and irrelevant to schema shape. Anything else
     failing means the template is incomplete, and every check cloned from it
     would fail for a reason that has nothing to do with the check. */
  const failures = (result && result.failures) || [];
  const unexpected = failures.filter(f => !/COO account/i.test(f.name || ''));
  if (unexpected.length) {
    console.error('\nThe template schema did not build cleanly:');
    for (const f of unexpected) console.error(`   · ${f.name} — ${f.message}`);
    throw new Error('template build failed');
  }

  /* Postgres refuses to clone a template that has open connections. */
  const p = require(path.join(ROOT, 'server', 'db', 'pool.js'));
  await p.end().catch(() => {});
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [TEMPLATE]).catch(() => {});
}

(async () => {
  let checks = discover();
  if (FILTER) checks = checks.filter(c => c.includes(FILTER));
  if (SHUFFLE) checks = shuffled(checks, SEED);

  console.log(`\n${checks.length} check(s)${SHUFFLE ? `, shuffled with seed ${SEED}` : ', in order'}`);

  try {
    process.stdout.write('building template schema… ');
    await buildTemplate();
    console.log('done\n');
  } catch (err) {
    console.error('could not build the template:', err.message);
    await dropDb(TEMPLATE); await admin.end().catch(() => {});
    process.exit(2);
  }

  let pass = 0, fail = 0;
  const failures = [];

  for (let i = 0; i < checks.length; i++) {
    const rel = checks[i];
    const name = path.basename(rel);
    const wantsDb = needsDatabase(rel);
    const dbName = `chk_${String(i).padStart(3, '0')}_${process.pid}`;
    const env = { ...process.env };

    if (wantsDb) {
      try {
        await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE}`);
        env.DATABASE_URL = withDatabase(process.env.DATABASE_URL, dbName);
      } catch (err) {
        fail++; failures.push({ name, why: 'could not provision a database: ' + err.message });
        console.log(`  ✗ ${name}  (no database: ${err.message})`);
        continue;
      }
    }

    const started = Date.now();
    let ok = true, output = '';
    try {
      output = execFileSync('node', [path.join(ROOT, rel)],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    } catch (err) {
      ok = false;
      output = (err.stdout || '') + (err.stderr || '');
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    if (ok) { pass++; console.log(`  ✓ ${name.padEnd(42)} ${secs}s${wantsDb ? '' : '  (no db)'}`); }
    else {
      fail++;
      /* Keep the whole output. Summarising it to three matching lines is how
         an intermittent failure got diagnosed twice from its stack frames
         alone: /Error/ matches "_handleErrorEvent", so pg's stack crowded out
         the one line that says what the server actually refused. A rare
         failure you cannot read is a failure you will guess at. */
      const logPath = path.join(FAIL_LOG_DIR, `${name}.log`);
      try { fs.writeFileSync(logPath, output); } catch (_) { /* diagnosis only */ }

      const lines = output.trim().split('\n');
      const stackish = l => /^\s*at\s/.test(l);
      const why = lines.filter(l => /✗|threw|Error/.test(l) && !stackish(l)).slice(0, 3).join(' | ')
               || lines.filter(l => !stackish(l)).slice(-2).join(' | ')
               || lines.slice(-2).join(' | ');
      failures.push({ name, why: why.slice(0, 300), logPath });
      console.log(`  ✗ ${name.padEnd(42)} ${secs}s`);
    }

    if (wantsDb && !KEEP) await dropDb(dbName);
  }

  if (!KEEP) await dropDb(TEMPLATE);
  await admin.end().catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed${SHUFFLE ? `  (seed ${SEED})` : ''}`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  ${f.name}\n     ${f.why}${f.logPath ? `\n     full output: ${f.logPath}` : ''}`);
    if (SHUFFLE) console.log(`\nreproduce this order with:  --shuffle --seed ${SEED}`);
  }
  process.exit(fail ? 1 : 0);
})();
