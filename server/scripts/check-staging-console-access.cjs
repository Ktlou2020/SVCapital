#!/usr/bin/env node
/* Staging is reachable from the dashboard, by the people who should reach it.
 *
 * The hub has carried a "Staging Portal" tile for some time and NOBODY COULD
 * SEE IT. The key 'staging' was in the tile registry and in no access list at
 * all — not EXECUTIVE_APPS, not the role matrix, not any employee's app_access
 * — and the hub renders only the keys getAllowedApps returns. So the tile was
 * filtered out for every person on the platform, and testing staging meant
 * knowing the URL by heart. A tile nobody can see is indistinguishable from a
 * tile that was never added.
 *
 * And it opened the INVESTOR portal. Testing anything that is configured
 * rather than merely displayed — a product, a pool, a rate — needs the admin
 * console, which had no tile at all. So there are two now, side by side, and
 * both are granted.
 *
 * WHO GETS THEM. Whoever can already administer PRODUCTION. Staging is a copy
 * of the platform against a throwaway database, so it is strictly less
 * sensitive than the console those people already hold; anyone who should not
 * be on it should not have 'admin' either.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-staging-console-access.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_staging_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const HUB   = fs.readFileSync(path.join(ROOT, 'team', 'hub.html'), 'utf8');
const AUTH  = fs.readFileSync(path.join(ROOT, 'js', 'staff-auth.js'), 'utf8');
const RBAC  = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'settings.js'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'server', 'db', 'setup.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function runSetup() {
  for (const f of ['pool.js', 'setup.js']) {
    delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', f))];
  }
  const q = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = q; console.warn = w; }
  try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
}

/* getAllowedApps, lifted out of the shipped file and run — the hub renders
   exactly what it returns, so asserting on anything else is asserting on a
   paraphrase. */
function liftAllowedApps() {
  const at = AUTH.indexOf('function getAllowedApps(');
  if (at < 0) throw new Error('getAllowedApps not found');
  let i = AUTH.indexOf('{', AUTH.indexOf(')', at)), depth = 0;
  for (; i < AUTH.length; i++) {
    if (AUTH[i] === '{') depth++;
    else if (AUTH[i] === '}') { depth--; if (depth === 0) break; }
  }
  const exec = (AUTH.match(/const EXECUTIVE_APPS = \[[^\]]*\];/) || [])[0];
  if (!exec) throw new Error('EXECUTIVE_APPS not found');
  const ctx = vm.createContext({ console });
  vm.runInContext(`${exec}
    var _rbacCache = null;
    var ROLE_PERMISSIONS = {};
    ${AUTH.slice(at, i + 1)}
    this._f = getAllowedApps;`, ctx);
  return ctx._f;
}

(async () => {
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
    process.env.DATABASE_URL = withDatabase(process.env.DATABASE_URL, DB_NAME);
    await runSetup();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
    /* The teardown drops this database WITH (FORCE); pg reports the
       termination as a pool 'error', and a pool with no listener takes the
       process down after every assertion has already passed. */
    pool.on('error', () => {});

    console.log('\nthere are two staging tiles, and they open different things');
    {
      ok('the console tile exists', /staging_admin: \{/.test(HUB));
      ok('and points at the admin console on staging',
         /path:\s*'https:\/\/svcapital-staging\.up\.railway\.app\/admin\/'/.test(HUB));
      ok('the portal tile still points at the investor portal',
         /path:\s*'https:\/\/svcapital-staging\.up\.railway\.app\/'/.test(HUB));
      ok('both open in a new tab',
         (HUB.match(/svcapital-staging[\s\S]{0,300}?newTab:\s*true/g) || []).length >= 2,
         'staging and production are different origins with separate login ' +
         'cookies — navigating away would sign you out of the one you are in');
      ok('and both say which surface they are',
         /The ADMIN console on the staging environment/.test(HUB) &&
         /The INVESTOR portal on the staging environment/.test(HUB),
         'two identically-described staging tiles is worse than one');
      ok('they are badged as staging', (HUB.match(/badge:\s*'Staging'/g) || []).length === 2);
    }

    console.log('\nand the keys actually reach somebody');
    {
      const getAllowedApps = liftAllowedApps();

      /* The fallback path: a session with no per-person allocation. */
      const execApps = getAllowedApps({ level: 'executive', role: 'CEO' });
      ok('an executive with no explicit allocation gets both keys',
         execApps.includes('staging') && execApps.includes('staging_admin'),
         execApps.join(', '));

      /* The authoritative path: a per-person list. This is why the keys had to
         be written to app_access as well as added to EXECUTIVE_APPS — when a
         list is present it is used INSTEAD of the role fallback, so an
         executive who has ever been configured would still not have seen it. */
      const listed = getAllowedApps({ appAccess: ['employee', 'admin'] });
      ok('a per-person list is authoritative, so the fallback does not rescue it',
         !listed.includes('staging_admin'),
         'which is exactly why setup has to write the key onto the row');

      ok('EXECUTIVE_APPS carries both keys',
         /EXECUTIVE_APPS = \[[^\]]*'staging'[^\]]*'staging_admin'/.test(AUTH));
      ok('and every role that already holds admin has them in the matrix',
         (() => {
           const block = (RBAC.match(/const DEFAULT_RBAC = \{[\s\S]*?\n\};/) || [''])[0];
           const rows = [...block.matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)];
           const admins = rows.filter(r => /'admin'/.test(r[2]));
           return admins.length > 0 && admins.every(r => /'staging_admin'/.test(r[2]));
         })());
      ok('and no role that does not', (() => {
        const block = (RBAC.match(/const DEFAULT_RBAC = \{[\s\S]*?\n\};/) || [''])[0];
        const rows = [...block.matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)];
        return rows.filter(r => !/'admin'/.test(r[2])).every(r => !/'staging/.test(r[2]));
      })(), 'Marketing and the junior roles have no business on staging');
    }

    console.log('\nthe grant, run against real employees');
    {
      await pool.query(`
        INSERT INTO employees (id,first_name,last_name,email,role,level,app_access) VALUES
          ('ST-ADM','A','Admin','st-adm@example.test','Admin','staff',ARRAY['employee','admin','accounting']),
          ('ST-EXEC','B','Exec','st-exec@example.test','COO','executive',ARRAY['employee','team','admin']),
          ('ST-MKT','C','Mkt','st-mkt@example.test','Marketing','staff',ARRAY['employee']),
          ('ST-NULL','D','Null','st-null@example.test','CEO','executive',NULL)
        ON CONFLICT (id) DO NOTHING`);
      await runSetup();

      const has = async id => (await pool.query(
        `SELECT app_access @> ARRAY['staging','staging_admin']::TEXT[] AS y FROM employees WHERE id=$1`,
        [id])).rows[0].y;

      ok('someone who administers production gets them', await has('ST-ADM') === true);
      ok('so does an executive', await has('ST-EXEC') === true);
      ok('and someone who does not, does not', await has('ST-MKT') === false,
         'staging is less sensitive than production, not less sensitive than nothing');
      ok('an employee with no allocation is left alone',
         (await pool.query(`SELECT app_access FROM employees WHERE id='ST-NULL'`)).rows[0].app_access === null,
         'a NULL list means "fall back to the role", and writing one would silently pin them');

      const before = (await pool.query(
        `SELECT array_length(app_access,1) n FROM employees WHERE id='ST-ADM'`)).rows[0].n;
      await runSetup();
      const after = (await pool.query(
        `SELECT array_length(app_access,1) n FROM employees WHERE id='ST-ADM'`)).rows[0].n;
      ok('a second boot does not append them again', before === after,
         `${before} -> ${after} — array_append with no guard doubles the list on every restart`);
    }

    console.log('\nand the step is written to be seen');
    {
      ok('setup grants the keys on boot', /2e\. Grant the staging environment keys/.test(SETUP));
      ok('scoped to production administrators',
         /app_access @> ARRAY\['admin'\]::TEXT\[\] OR level = 'executive'/.test(SETUP));
      ok('and it says why the tile was invisible before',
         /NOBODY COULD SEE IT/.test(SETUP) || /in no access list/.test(SETUP),
         'so the next person does not add a tile and wonder where it went');
    }

  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    try { await require(path.join(ROOT, 'server', 'db', 'pool.js')).end(); } catch (_) {}
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
