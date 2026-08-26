#!/usr/bin/env node
/* Auto-setup must run every step, report what failed, and not abandon the rest.
 *
 * It was one long try/catch. Two things followed from that:
 *
 *   1. The first statement to throw skipped every step after it, and the catch
 *      logged one line and resolved as though nothing had happened. A container
 *      could boot for months with half its schema missing.
 *
 *   2. Two `return`s in the COO step exited autoSetup outright. On any database
 *      where the COO account already exists — every production boot — steps 4
 *      through 10 never ran. Those are migrations, not seeds: the end_date
 *      backfill, the smme → short_term rename, the cattle_cycles backfill.
 *
 * Needs a database. It creates and drops its own, so it will not touch
 * anything the other checks are using:
 *   DATABASE_URL=postgres://… DATABASE_SSL=false node server/scripts/check-setup-steps.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-setup-steps.cjs header');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const ROOT = path.join(__dirname, '..', '..');

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  try {
    /* ── Structure ──────────────────────────────────────────────────── */
    console.log('\nevery step is isolated');
    const src = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');

    const steps = (src.match(/await step\(/g) || []).length;
    ok(`all ${steps} steps go through the runner`, steps >= 17, `found ${steps}`);

    ok('a failing step is recorded rather than thrown away',
       /failures\.push\(\{ name, message: err\.message \}\)/.test(src));
    ok('and the run reports what did not apply',
       /step\$\{failures\.length === 1 \? '' : 's'\} did not apply/.test(src));
    ok('the result is returned, not just logged',
       /return _lastResult;/.test(src));
    ok('and exposed for the readiness endpoint',
       /autoSetup\.lastResult = \(\) =>/.test(src));

    const indexSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    ok('/api/health/ready surfaces an incomplete setup',
       /setup: 'incomplete'/.test(indexSrc),
       'a boot-log line scrolls away; a health check does not');

    /* ── Behaviour, against a real database ─────────────────────────── */
    const dbName = 'chk_setup_' + Math.abs(process.pid);
    await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await pool.query(`CREATE DATABASE ${dbName}`);
    const url = process.env.DATABASE_URL.replace(/\/[^/?]+\?/, `/${dbName}?`);

    try {
      // Fresh boot: the COO step fails without COO_PASSWORD. Everything after
      // it must still run — that is the whole point.
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
      process.env.DATABASE_URL = url;
      const autoSetup = require(path.join(ROOT, 'server', 'db', 'setup.js'));

      const log = [];
      const origLog = console.log, origErr = console.error, origWarn = console.warn;
      console.log = (...a) => log.push(a.join(' '));
      console.error = (...a) => log.push(a.join(' '));
      console.warn = (...a) => log.push(a.join(' '));
      let res1;
      try { res1 = await autoSetup(); } finally {
        console.log = origLog; console.error = origErr; console.warn = origWarn;
      }

      console.log('\na failing step does not abandon the ones after it');
      ok('the run reports failure rather than silent success',
         res1 && res1.ok === false, JSON.stringify(res1 && res1.failures));
      ok('and names the step that failed',
         res1.failures.some(f => /COO account/.test(f.name)), JSON.stringify(res1.failures));

      const db = new Pool({ connectionString: url, ssl: false });

      // Step 8 runs after the COO step. Under the old code it never ran.
      ok('a later step still applied despite the earlier failure',
         log.some(l => /smme/.test(l)),
         'nothing after the failing step ran');

      /* ── The production case: the COO already exists ──────────────── */
      await db.query(`INSERT INTO users (email, password_hash, role, first_name, last_name)
                      VALUES ('coo@svcapital.co.za','x','director','COO','SV')
                      ON CONFLICT (email) DO NOTHING`);
      await db.query(`UPDATE investment_pools SET product_type = 'smme' WHERE product_type = 'short_term'`);
      const before = (await db.query(`SELECT count(*)::int n FROM investment_pools WHERE product_type='smme'`)).rows[0].n;

      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      const autoSetup2 = require(path.join(ROOT, 'server', 'db', 'setup.js'));
      const log2 = [];
      const l2 = console.log, e2 = console.error, w2 = console.warn;
      console.log = (...a) => log2.push(a.join(' '));
      console.error = (...a) => log2.push(a.join(' '));
      console.warn = (...a) => log2.push(a.join(' '));
      let res2;
      try { res2 = await autoSetup2(); } finally { console.log = l2; console.error = e2; console.warn = w2; }

      const after = (await db.query(`SELECT count(*)::int n FROM investment_pools WHERE product_type='smme'`)).rows[0].n;

      console.log('\nwith the COO present — every production boot');
      ok('the seed step still skips, as intended',
         log2.some(l => /already provisioned/.test(l)), 'the seed should not re-run');
      ok('but the migrations after it now run',
         before > 0 && after === 0,
         `smme pools before ${before}, after ${after} — the two returns in the COO step used to exit autoSetup here`);
      ok('and the run reports success', res2 && res2.ok === true, JSON.stringify(res2));

      await db.end();
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await pool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
