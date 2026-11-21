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
 *   …--update-floor     record what each check asserted, as the new floor
 *   …--allow-skips      let a check skip part of itself (lowers the guarantee)
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
const RAISE   = has('--update-floor');
const SKIPS_OK = has('--allow-skips');
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

/* A run tag no other runner can pick.
 *
 * The template and every per-check database were named from process.pid alone.
 * check-run-checks spawns this runner up to five times in one suite, each a
 * fresh short-lived process, and a container recycles pids — so two runners
 * could name the same template. buildTemplate() opens with
 * DROP DATABASE ... WITH (FORCE), which terminates whatever is connected to
 * that name, and the other runner's checks die with
 * FATAL 57P01 "terminating connection due to administrator command" — an error
 * that names neither the database nor the process that dropped it.
 *
 * The suffix costs nothing and makes the collision impossible rather than
 * unlikely. */
const RUN_TAG  = process.pid + '_' + Math.random().toString(36).slice(2, 8);
const TEMPLATE = 'svc_chk_tpl_' + RUN_TAG;

/* ─── The floor ──────────────────────────────────────────────────────
   An exit code of 0 says a check did not throw. It does not say the check
   LOOKED at anything, and 62 of them are written to carry on when something
   they need is absent: 32 drop their whole browser half with
   "SKIP no headless Chromium" and 30 drop theirs when a table is missing.
   All of those exit 0, and the runner used to print a tick for each.

   So a green suite could mean two thousand assertions or four hundred, with
   nothing in the output to tell the difference — and the gap would widen
   silently for as long as nobody noticed. Every claim this suite makes,
   including every mutation test run against it, rests on knowing it is
   still looking.

   Each check already ends by printing its own tally. The runner now reads
   it, refuses a check that printed none or asserted nothing, refuses one
   that said SKIP, and holds every check to the number of assertions it
   managed last time this file was written. Raising the floor is deliberate:
     node server/scripts/run-checks.cjs --update-floor
   which prints what moved. --allow-skips is for a machine that genuinely
   cannot run a browser; it lowers the guarantee and says so. */
const FLOOR_PATH = path.join(__dirname, 'assertion-floor.json');
const FLOOR = (() => {
  try { return JSON.parse(fs.readFileSync(FLOOR_PATH, 'utf8')).checks || {}; }
  catch (_) { return {}; }
})();

/* The last line of the form "N passed, M failed" a check printed. Last,
   not first: a check that reports a section and then a total should be
   held to the total. */
const TALLY = /^\s*(\d+) passed, (\d+) failed/;
function tallyOf(output) {
  let found = null;
  for (const line of String(output).split('\n')) {
    const m = line.match(TALLY);
    if (m) found = { passed: Number(m[1]), failed: Number(m[2]) };
  }
  return found;
}

/* The convention across the suite is two spaces then SKIP then two more. */
function skipsIn(output) {
  return String(output).split('\n')
    .filter(l => /(^|\s)SKIP\s\s/.test(l))
    .map(l => l.trim().slice(0, 160));
}

/* Where a failed check's full output goes, so a rare failure can be read
   rather than guessed at. */
const FAIL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-checks-'));
const admin = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

/* DROPPING IT AND SWALLOWING THE FAILURE IS NOT DROPPING IT.
 *
 * This swallowed every error, so a drop that did not go left a database
 * behind and said nothing. FOURTEEN template databases had accumulated on
 * the scratch server before a shuffled run happened to measure the delta
 * and report one — each a full copy of the schema, each invisible.
 *
 * WITH (FORCE) terminates the connections it can see when it runs, so a
 * connection that opens between that and the drop defeats it: the clone a
 * check is still finishing, or pg's own pool reconnecting. So the backends
 * are terminated first, the drop is retried, and a drop that still will not
 * go is REPORTED — with the name, which is the one thing needed to clear it
 * by hand. */
async function dropDb(name) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]).catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      return true;
    } catch (err) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name}`); return true; }
      catch (_) {
        if (attempt === 3) {
          console.error(`\n[runner] could not drop ${name}: ${err.message}`);
          console.error('[runner] it is still on the server. Drop it by hand.');
          return false;
        }
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
  }
  return false;
}

/* AND A RUN THAT IS KILLED STILL HAS TO CLEAN UP.
 *
 * The template was dropped on the line after the loop, so every path that
 * did not reach it — Ctrl-C, a harness timeout, SIGTERM from a parent that
 * gave up — left the copy behind. Those are not rare: this runner is
 * spawned by check-run-checks, and a long suite gets interrupted.
 *
 * `process.on('exit')` cannot help: the drop is asynchronous and the loop
 * is already closed by then. So the signals are caught, the template is
 * dropped, and the signal's own exit code is honoured. */
let OWN_TEMPLATE_DROPPED = false;
/* Set the moment a signal lands. execFileSync blocks the event loop, so a
   handler only runs BETWEEN checks — and it then has awaits of its own, in
   which the loop resumes and asks an ended pool for another database. That
   printed "Cannot use a pool after calling end on the pool" once per
   remaining check, which is a hundred lines of noise over the one line that
   says what happened. The loop reads this and stops. */
let ABORTED = false;
async function dropOwnTemplate() {
  if (OWN_TEMPLATE_DROPPED) return;
  OWN_TEMPLATE_DROPPED = true;
  await dropDb(TEMPLATE);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    ABORTED = true;
    console.error(`\n[runner] ${sig} — dropping ${TEMPLATE} before leaving.`);
    await dropOwnTemplate();
    await admin.end().catch(() => {});
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

/* AND WHATEVER AN EARLIER RUN LEFT BEHIND IS SWEPT ON THE WAY IN.
 *
 * Every database this runner makes is named with the pid that made it, so a
 * name whose pid is no longer running belongs to nobody — nothing is going
 * to come back for it. A pid that IS running might be a concurrent runner
 * (check-run-checks spawns several), and those are left strictly alone: the
 * cost of dropping one is another runner's checks dying with
 * "terminating connection due to administrator command".
 *
 * A pid is recycled eventually, so a live pid can be the wrong process.
 * That only ever means a stale database is kept, which is the safe way to
 * be wrong. */
/* EVERY SHAPE THIS SUITE CREATES, not only the two the runner makes
   itself. The first version of this matched svc_chk_tpl_<pid>_<rand> and
   chk_<nnn>_<pid>_<rand> — and chk_feepool_28331_62sskx was sitting on the
   scratch server while the sweep walked past it, because
   check-fee-pool-attribution builds a database of its own and names it in
   its own way. A sweep that knows only the names one file writes is a
   sweep that stops working the next time somebody needs a database.

   So: anything beginning chk_ or svc_chk_ and ending in _<pid>_<suffix>.
   The pid is still what decides — a live one is left strictly alone — and
   no other software on this server names a database chk_anything. */
const OWN_PID_RE = /^(?:svc_)?chk_[a-z0-9_]+_(\d+)_[a-z0-9]+$/;
async function sweepAbandoned() {
  let rows;
  try {
    ({ rows } = await admin.query(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'svc\\_chk\\_tpl\\_%' OR datname LIKE 'chk\\_%'`));
  } catch (_) { return []; }

  const swept = [];
  for (const { datname } of rows) {
    const m = datname.match(OWN_PID_RE);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    try { process.kill(pid, 0); continue; }   // alive — somebody else's run
    catch (err) { if (err.code === 'EPERM') continue; }
    if (await dropDb(datname)) swept.push(datname);
  }
  return swept;
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

  const swept = await sweepAbandoned();
  if (swept.length) {
    console.log(`swept ${swept.length} database(s) left by a run that was killed: `
                + swept.join(', '));
  }

  try {
    process.stdout.write('building template schema… ');
    await buildTemplate();
    console.log('done\n');
  } catch (err) {
    console.error('could not build the template:', err.message);
    await dropOwnTemplate(); await admin.end().catch(() => {});
    process.exit(2);
  }

  let pass = 0, fail = 0, raised = 0;
  const failures = [];
  const asserted = {};

  /* The loop is wrapped rather than indented, so that a throw inside it
     cannot carry the template out of the run with it. */
  try {

  for (let i = 0; i < checks.length; i++) {
    if (ABORTED) break;
    const rel = checks[i];
    const name = path.basename(rel);
    const wantsDb = needsDatabase(rel);
    const dbName = `chk_${String(i).padStart(3, '0')}_${RUN_TAG}`;
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

    /* What the check itself says it did, which is the thing the exit code
       does not tell us. */
    const tally = tallyOf(output);
    asserted[name] = tally ? tally.passed : 0;
    if (ok) {
      const skips = SKIPS_OK ? [] : skipsIn(output);
      const floor = FLOOR[name];
      let degraded = null;
      if (!tally) {
        degraded = 'printed no "N passed, M failed" line, so the runner cannot '
                 + 'tell what it looked at';
      } else if (tally.passed === 0) {
        degraded = 'exited 0 having asserted nothing';
      } else if (skips.length) {
        degraded = `did not run part of itself — ${skips.join(' | ')}`;
      } else if (floor != null && tally.passed < floor) {
        degraded = `asserted ${tally.passed}, floor is ${floor} — `
                 + `${floor - tally.passed} assertion(s) stopped running`;
      }
      if (degraded) { ok = false; output += `\n[runner] ${degraded}\n`; }
    }

    if (ok) {
      pass++;
      if (FLOOR[name] != null && tally.passed > FLOOR[name]) raised++;
      console.log(`  ✓ ${name.padEnd(42)} ${secs}s${wantsDb ? '' : '  (no db)'}`);
    }
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

  } finally {
    if (!KEEP) await dropOwnTemplate();
  }
  await admin.end().catch(() => {});

  const total = Object.values(asserted).reduce((n, v) => n + v, 0);
  console.log(`\n${pass} passed, ${fail} failed`
    + `  ·  ${total.toLocaleString('en')} assertions`
    + `${SKIPS_OK ? '  (skips allowed — the floor is not being held)' : ''}`
    + `${SHUFFLE ? `  (seed ${SEED})` : ''}`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  ${f.name}\n     ${f.why}${f.logPath ? `\n     full output: ${f.logPath}` : ''}`);
    if (SHUFFLE) console.log(`\nreproduce this order with:  --shuffle --seed ${SEED}`);
  }

  /* Raising the floor is a deliberate act with a readable diff, the way
     asset-stamps --update is: a floor nobody reads before accepting is a
     floor that gets lowered by accident. */
  if (RAISE) {
    if (FILTER) {
      console.log('\n--update-floor needs the whole suite; --filter would write a partial floor.');
      process.exit(2);
    }
    if (fail) {
      console.log('\nnot writing the floor: the suite is not green, so these numbers are not what the suite does.');
      process.exit(1);
    }
    const moved = [];
    for (const [name, n] of Object.entries(asserted)) {
      const was = FLOOR[name];
      if (was == null) moved.push(`  + ${name.padEnd(42)} ${n}`);
      else if (was !== n) moved.push(`  ${n > was ? '↑' : '↓'} ${name.padEnd(42)} ${was} → ${n}`);
    }
    for (const name of Object.keys(FLOOR)) {
      if (asserted[name] == null) moved.push(`  - ${name.padEnd(42)} gone (was ${FLOOR[name]})`);
    }
    fs.writeFileSync(FLOOR_PATH, JSON.stringify({
      note: 'What each check asserted when this was last written. run-checks '
          + 'refuses a check that asserts fewer. Raise it with '
          + 'node server/scripts/run-checks.cjs --update-floor',
      total,
      checks: asserted,
    }, null, 2) + '\n');
    console.log(`\nfloor written: ${Object.keys(asserted).length} checks, ${total.toLocaleString('en')} assertions`);
    if (moved.length) console.log(moved.join('\n'));
    else console.log('  nothing moved');
    process.exit(0);
  }

  if (raised) {
    console.log(`\n${raised} check(s) now assert more than the floor. `
      + 'Raise it with --update-floor so the new ones are held too.');
  }
  process.exit(fail ? 1 : 0);
})();
