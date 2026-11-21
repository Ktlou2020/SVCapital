#!/usr/bin/env node
/* The runner must isolate, refuse production, and clean up after itself.
 *
 * Every other check's result now depends on this one. Before it existed the
 * suite was a shell loop over one shared scratch database, and eighteen
 * database-backed checks contended over it: eleven DROP the schema and rebuild
 * it, six create their own tables in it, one assumes whatever is there. So a
 * check inherited whatever its predecessor left behind.
 *
 * That cost real time. Alphabetical order passed and reverse order passed,
 * both by luck; three random orders gave 48/50, 49/50 and 50/50, failing a
 * different check each time. Two of those failures were diagnosed as code
 * problems in files nobody had touched before the real cause turned up.
 *
 * This runs the runner. Not a transcription of its rules — the thing itself,
 * against a real Postgres, including the case it must refuse.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-run-checks.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { Pool } = require('pg');

const ROOT   = path.join(__dirname, '..', '..');
const RUNNER = path.join(__dirname, 'run-checks.cjs');
const SSL    = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const admin  = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* A key set to null is REMOVED from the child's environment rather than
   passed as the string "null". The scratch-database guard is the reason: it
   reads CHECK_ALLOW_RESET, and whoever runs this suite may well have that
   set in their own shell — inheriting it silently disarmed the guard the
   check exists to test, and the check then reported the runner as broken
   when the only broken thing was the environment it inherited. */
function run(args, env) {
  const childEnv = { ...process.env, ...(env || {}) };
  for (const [k, v] of Object.entries(env || {})) if (v === null) delete childEnv[k];
  try {
    return { code: 0, out: execFileSync('node', [RUNNER, ...args],
      { env: childEnv, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }) };
  } catch (err) {
    return { code: err.status == null ? -1 : err.status,
             out: (err.stdout || '') + (err.stderr || '') };
  }
}

const scratchDbs = async () => (await admin.query(
  `SELECT datname FROM pg_database WHERE datname LIKE 'chk\\_%' OR datname LIKE 'svc\\_chk\\_%'`
)).rows.map(r => r.datname);

(async () => {
  try {
    console.log('\nit gives each check its own database');
    {
      const src = fs.readFileSync(RUNNER, 'utf8');
      ok('a template is built once and cloned per check',
         /CREATE DATABASE \$\{dbName\} TEMPLATE \$\{TEMPLATE\}/.test(src),
         'replaying the full schema build per check would be far slower');
      ok('and each check is handed its own DATABASE_URL',
         /env\.DATABASE_URL = withDatabase\(process\.env\.DATABASE_URL, dbName\)/.test(src));
      ok('the database name is swapped structurally, not by regex',
         /const u = new URL\(url\);\s*\n\s*u\.pathname = '\/' \+ name;/.test(src),
         'the regex form elsewhere in this repo silently does nothing without a query string');
      ok('a check that opens no database is given none',
         /\(no db\)/.test(src) && /function needsDatabase/.test(src));
    }

    console.log('\nit actually isolates — the same checks, two different orders');
    {
      const a = run(['--filter', 'maturity']);
      const b = run(['--filter', 'maturity', '--shuffle', '--seed', '7']);
      ok('in order, everything passes', /(\d+) passed, 0 failed/.test(a.out), a.out.slice(-300));
      ok('shuffled, everything passes too', /(\d+) passed, 0 failed/.test(b.out), b.out.slice(-300));
      const na = (a.out.match(/(\d+) passed/) || [])[1];
      const nb = (b.out.match(/(\d+) passed/) || [])[1];
      ok('and the same number of checks ran either way', na === nb, `${na} vs ${nb}`);
      ok('the seed is reported so a failing order can be reproduced',
         /seed 7/.test(b.out), b.out.slice(-200));
    }

    console.log('\nit leaves nothing behind');
    {
      /* Measured as a delta, not as an absolute.

         This check is itself usually run BY the runner, which legitimately
         holds its own template database open the whole time. Asserting that no
         svc_chk_tpl exists anywhere passed standalone and failed under the
         runner — the check was making a claim about shared state it does not
         own. The question that is actually meaningful is whether the inner run
         added anything that outlived it. */
      const before = new Set(await scratchDbs());
      run(['--filter', 'maturity']);
      const after = await scratchDbs();
      const added = after.filter(d => !before.has(d));

      ok('no scratch database survives the run it belongs to',
         added.length === 0,
         `left behind: ${JSON.stringify(added)}`);
      ok('including its template',
         !added.some(d => /^svc_chk_tpl/.test(d)), JSON.stringify(added));
    }

    /* A RUN THAT IS KILLED. The template was dropped on the line after the
       loop, so every path that did not reach that line kept it: Ctrl-C, a
       harness timeout, a parent that gave up. Fourteen of them had piled up
       on the scratch server, each a full copy of the schema, before a
       shuffled run measured the delta and reported one. */
    console.log('\neven when the run is killed');
    {
      const before = new Set(await scratchDbs());
      const child = spawn('node', [RUNNER, '--filter', 'maturity'],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

      /* Killed once the template EXISTS and checks are running — before it
         exists there is nothing to leak, and that is not the case that
         went wrong. */
      const exited = new Promise(res => child.on('exit', (c, sig) => res({ c, sig })));
      /* STDERR TOO. The line that says what it is doing about the signal is
         written there, and capturing only stdout asserted its absence. */
      let out = '';
      const running = new Promise(res => {
        child.stdout.on('data', d => { out += d; if (/✓|✗/.test(out)) res(true); });
        child.stderr.on('data', d => { out += d; });
        child.on('exit', () => res(false));
      });
      const reached = await Promise.race([
        running, new Promise(res => setTimeout(() => res(false), 120000))]);
      if (reached) child.kill('SIGTERM');
      await exited;

      /* The signal handler drops it; give the server a moment to finish. */
      await new Promise(r => setTimeout(r, 500));
      const left = (await scratchDbs()).filter(d => !before.has(d));
      ok('A KILLED RUN TAKES ITS DATABASES WITH IT', reached && left.length === 0,
         reached ? `left behind: ${JSON.stringify(left)}` : 'the run never got as far as a check');
      ok('and it says so rather than going quietly',
         /dropping svc_chk_tpl/.test(out), out.slice(-300));
      ok('AND IT STOPS, rather than asking a closed pool for more databases',
         !/Cannot use a pool after calling end/.test(out),
         'that printed once per remaining check \u2014 a hundred lines of noise '
         + 'over the one line that says what happened');

      /* Give the exit a moment, then read the extra wait above. */

      for (const d of left) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
    }

    /* AND WHAT AN EARLIER KILLED RUN LEFT. The sweep is what clears the
       ones already there, and the ones a kill -9 will always leave. */
    console.log('\nand it sweeps what an earlier run abandoned');
    {
      /* Pid 2 is the kernel's — not a node runner, and `process.kill(pid, 0)`
         from inside a container reports it as not ours to signal. A pid that
         cannot possibly be a live runner of this script is what is wanted,
         so the highest pid the kernel will allocate, plus one. */
      const deadPid = Number(
        (fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8') || '4194304').trim()) + 1;
      const abandoned = `svc_chk_tpl_${deadPid}_sweepme`;
      const mine      = `svc_chk_tpl_${process.pid}_keepme`;
      for (const d of [abandoned, mine]) {
        await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
        await admin.query(`CREATE DATABASE ${d}`);
      }

      const r = run(['--filter', 'check-tax-year-options']);
      const after = new Set(await scratchDbs());

      ok('A DATABASE WHOSE RUN IS GONE IS DROPPED', !after.has(abandoned),
         `${abandoned} is still there — nothing is ever coming back for it`);
      ok('and the run says which ones it swept',
         new RegExp(abandoned).test(r.out), r.out.slice(0, 600));
      ok('BUT A LIVE RUN\u2019S DATABASES ARE LEFT ALONE', after.has(mine),
         'check-run-checks spawns several runners at once, and dropping a '
         + 'live one\u2019s template kills its checks with "terminating connection '
         + 'due to administrator command" \u2014 an error that names neither the '
         + 'database nor who dropped it');

      for (const d of [abandoned, mine])
        await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
    }

    /* AND A DROP THAT DOES NOT GO IS REPORTED. This is how fourteen of them
       went unnoticed: every error was swallowed. */
    console.log('\nand a drop that will not go is not passed off as done');
    {
      const src = fs.readFileSync(RUNNER, 'utf8');
      const drop = src.slice(src.indexOf('async function dropDb'),
                             src.indexOf('let OWN_TEMPLATE_DROPPED'));
      ok('the failure is printed, with the name',
         /console\.error\([^)]*could not drop \$\{name\}/.test(drop), drop.slice(-400));
      ok('and the connections are terminated before the drop, not only by FORCE',
         drop.indexOf('pg_terminate_backend') < drop.indexOf('DROP DATABASE'),
         'WITH (FORCE) terminates what it can see when it runs, so a connection '
         + 'opened a moment later defeats it');
      ok('and it is retried rather than given up on first refusal',
         /attempt <= 3/.test(drop), drop.slice(0, 300));
    }

    console.log('\nit refuses a database that does not look like scratch');
    {
      /* The runner's whole job is creating and dropping databases. Pointed at
         the wrong host that is not a failing test, it is an incident. */
      const baseline = new Set(await scratchDbs());
      const r = run(['--filter', 'maturity'],
        { DATABASE_URL: 'postgres://u:p@db.production.example.com:5432/svcapital',
          CHECK_ALLOW_RESET: null });
      ok('it exits rather than proceeding', r.code === 2, `exit ${r.code}`);
      ok('and says why', /does not look like a scratch database/.test(r.out), r.out.slice(0, 300));
      ok('naming the override rather than leaving it undiscoverable',
         /CHECK_ALLOW_RESET=1/.test(r.out));
      ok('and created nothing on the way out',
         (await scratchDbs()).filter(d => !baseline.has(d)).length === 0,
         'a refusal must happen before any database is made');
    }

    console.log('\na failing check is reported, not swallowed');
    {
      /* A runner that reports 50/50 whatever happens is worse than no runner.
         A deliberately failing check proves the exit code and the summary. */
      const tmpDir = path.join(ROOT, 'scripts');
      const tmp = path.join(tmpDir, 'check-zz-runner-selftest.cjs');
      fs.writeFileSync(tmp, "'use strict';\nconsole.log('  \\u2717 deliberately failing');\nprocess.exit(1);\n");
      try {
        const r = run(['--filter', 'zz-runner-selftest']);
        ok('the run exits non-zero', r.code === 1, `exit ${r.code}`);
        ok('the summary counts it as failed', /0 passed, 1 failed/.test(r.out), r.out.slice(-300));
        ok('and the failure is named', /check-zz-runner-selftest/.test(r.out), r.out.slice(-300));
      } finally {
        fs.unlinkSync(tmp);
      }
    }

    console.log('\nthe suite has a documented way to run it');
    {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      ok('npm run check exists', pkg.scripts && /run-checks\.cjs/.test(pkg.scripts.check || ''),
         JSON.stringify(pkg.scripts && pkg.scripts.check));
      ok('and a shuffled variant, so order-dependence stays visible',
         /--shuffle/.test((pkg.scripts && pkg.scripts['check:shuffle']) || ''));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await admin.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
