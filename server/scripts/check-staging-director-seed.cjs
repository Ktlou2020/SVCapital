#!/usr/bin/env node
/* The staging director seed — it must let exactly one person in, on exactly
 * one environment.
 *
 * Staging has its own database, so nobody who administers production has a row
 * there and the login page answers "if an account exists" to everything. The
 * seed exists to break that deadlock. The whole risk of it is the other
 * direction: a step that mints a full-access director is a back door if it
 * ever fires on production, so the host guard is what this check spends most
 * of its assertions on.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-staging-director-seed.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const SEED_EMAIL = 'kagiso@svcapital.co.za';

/* setup.js is required once and re-invoked; the env is what changes between
   runs, exactly as it would between deployments of different services. */
const runSetup = async (env) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k];
    if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
};

const seedRow = async () => (await pool.query(
  `SELECT id, email, role, level, status, app_access, pin_hash, pin_set,
          login_attempts, login_locked_until
     FROM employees WHERE email = $1`, [SEED_EMAIL]
)).rows[0] || null;

const dropSeed = () => pool.query('DELETE FROM employees WHERE email = $1', [SEED_EMAIL]);

(async () => {
  try {
    /* Quiet the setup's own console — it is long, and this check reads the
       database rather than the log for everything except the PIN. */
    const realLog = console.log;
    let captured = '';
    const quiet = async (fn) => {
      console.log = (...a) => { captured += a.join(' ') + '\n'; };
      try { return await fn(); } finally { console.log = realLog; }
    };

    console.log('\nit refuses to run on production');
    {
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'platform.svcapital.co.za',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: null,
      }));
      ok('the production host creates no director', (await seedRow()) === null,
         'a seed that fires on production is a back door, not a convenience');

      /* The flag is the escape hatch for a staging service on an unrecognised
         hostname. It must not be a way to reach production. */
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'platform.svcapital.co.za',
        STAGING_SEED_DIRECTOR: '1', STAGING_DIRECTOR_PIN: null,
      }));
      ok('and the override does not unlock it there', (await seedRow()) === null,
         'STAGING_SEED_DIRECTOR=1 must lose to a production hostname');

      for (const h of ['svcapital.co.za', 'www.svcapital.co.za']) {
        await quiet(() => runSetup({
          RAILWAY_PUBLIC_DOMAIN: h, STAGING_SEED_DIRECTOR: '1', STAGING_DIRECTOR_PIN: null,
        }));
        ok(`nor on ${h}`, (await seedRow()) === null);
      }
    }

    console.log('\nit does nothing on a host it does not recognise');
    {
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'some-other-service.up.railway.app',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: null,
      }));
      ok('no director appears', (await seedRow()) === null);
      ok('and the log says which flag would enable it',
         /STAGING_SEED_DIRECTOR=1/.test(captured),
         'skipping in silence leaves nobody able to log in and no clue why');
    }

    console.log('\non staging it provisions an account that can actually log in');
    {
      captured = '';
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'svcapital-staging.up.railway.app',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: null,
      }));
      const row = await seedRow();
      ok('the account exists', !!row, 'nothing was created on the staging host');
      ok('and is active, which staff-lookup requires',
         row && row.status === 'active', row && row.status);
      ok('it is executive level, which is what grants the Director panel',
         row && row.level === 'executive', row && row.level);

      /* app_access is authoritative over the role fallback wherever it is set,
         so an incomplete list here is a locked door, not a smaller menu. */
      const apps = (row && row.app_access) || [];
      for (const a of ['employee', 'team', 'admin', 'director', 'staging', 'staging_admin']) {
        ok(`app_access carries ${a}`, apps.includes(a), JSON.stringify(apps));
      }

      /* The returning-user branch of /staff-token is bcrypt.compare against
         pin_hash, gated on pin_set. Both halves have to be right or the
         account exists and still cannot be used. */
      ok('a PIN is set, so login takes the PIN branch not the ID-number branch',
         row && row.pin_set === true, row && String(row.pin_set));
      const pin = (captured.match(/One-time PIN: (\d{4,6})/) || [])[1];
      ok('the one-time PIN is reported, since nothing else knows it', !!pin,
         captured.slice(-300));
      ok('and it is the PIN the account actually accepts',
         !!(pin && row && row.pin_hash && await bcrypt.compare(pin, row.pin_hash)),
         'the printed PIN and the stored hash disagree — the log would be a dead end');
      const wrong = String((Number(pin) + 1) % 1000000).padStart(String(pin).length, '0');
      ok('a different PIN is refused', !!row &&
         !(await bcrypt.compare(wrong, row.pin_hash)),
         'the hash accepts something other than the PIN that was issued');
    }

    console.log('\nit does not reset a PIN the person has already chosen');
    {
      /* Every deploy re-runs setup. Re-seeding here would log them out and
         print the new PIN to the build log. */
      const chosen = await bcrypt.hash('4821', 12);
      await pool.query(
        'UPDATE employees SET pin_hash = $1, pin_set = true WHERE email = $2',
        [chosen, SEED_EMAIL]
      );
      captured = '';
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'svcapital-staging.up.railway.app',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: null,
      }));
      const row = await seedRow();
      ok('the chosen PIN still works after a redeploy',
         !!(row && await bcrypt.compare('4821', row.pin_hash)),
         'setup overwrote a PIN its owner had set');
      ok('and no new PIN is printed', !/One-time PIN:/.test(captured),
         captured.slice(-200));
    }

    console.log('\na PIN supplied by the operator is used instead of a printed one');
    {
      await dropSeed();
      captured = '';
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'svcapital-staging.up.railway.app',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: '135791',
      }));
      const row = await seedRow();
      ok('the supplied PIN is what the account accepts',
         !!(row && await bcrypt.compare('135791', row.pin_hash)));
      ok('and it is never written to the log',
         !/135791/.test(captured), captured.slice(-200));
    }

    console.log('\nit clears a lockout earned before the account existed');
    {
      /* Failed attempts against an email with no row still record against it
         once the row appears; a 15-minute lock inherited at creation reads as
         the seed not having worked. */
      await pool.query(
        `UPDATE employees SET login_attempts = 5,
           login_locked_until = NOW() + INTERVAL '15 minutes' WHERE email = $1`,
        [SEED_EMAIL]
      );
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'svcapital-staging.up.railway.app',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: '135791',
      }));
      const row = await seedRow();
      ok('the lock is lifted', !!row && row.login_locked_until === null,
         row && String(row.login_locked_until));
      ok('and the attempt counter is back to zero', !!row && row.login_attempts === 0,
         row && String(row.login_attempts));
    }

    console.log('\nit will not seed an address PIN login cannot serve');
    {
      await dropSeed();
      await quiet(() => runSetup({
        RAILWAY_PUBLIC_DOMAIN: 'svcapital-staging.up.railway.app',
        STAGING_DIRECTOR_EMAIL: 'someone@gmail.com',
        STAGING_SEED_DIRECTOR: null, STAGING_DIRECTOR_PIN: null,
      }));
      const { rows } = await pool.query(
        'SELECT 1 FROM employees WHERE email = $1', ['someone@gmail.com']
      );
      ok('a non-svcapital address is refused, because /staff-token refuses it too',
         rows.length === 0,
         'seeding it creates an account that exists and can never authenticate');
    }

    console.log('\nthe guard is in the source, not only in behaviour');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      ok('production hosts are named explicitly',
         /PRODUCTION_HOSTS\s*=\s*\[[^\]]*platform\.svcapital\.co\.za/.test(src));
      ok('and checked before the override is consulted',
         src.indexOf('PRODUCTION_HOSTS.includes(host)') <
         src.indexOf("STAGING_SEED_DIRECTOR === '1'"),
         'an override read first would let the flag reach production');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
