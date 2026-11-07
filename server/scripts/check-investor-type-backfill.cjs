#!/usr/bin/env node
/* Filling in investor_type from the export, without trusting it blindly.
 *
 * The Firebase export carries investorType and the migration never read it,
 * so every imported client reads "Not set". backfill-investor-types.cjs reads
 * the same users.json and writes that one column — rather than re-running the
 * whole migration, which would also rewrite names, addresses, KYC statuses
 * and everything else staff have corrected since, on every client, to fill in
 * one field.
 *
 * What this holds:
 *
 *   previews      nothing is written without --apply
 *   never guesses a value the mapper does not recognise is reported and
 *                 SKIPPED, because calling an unknown "individual" turns an
 *                 imported trust into a natural person and the next FICA run
 *                 verifies it against Home Affairs rather than its deed
 *   defers        a type already set in the console is left alone unless
 *                 --overwrite says otherwise; the console is the more recent
 *                 authority
 *   all or none   one transaction, so the book is never half-classified
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-investor-type-backfill.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_itbf_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const SCRIPT  = path.join(ROOT, 'server', 'scripts', 'backfill-investor-types.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool, dbUrl, exportFile;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  dbUrl = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = dbUrl;
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'pool.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: dbUrl, ssl: SSL, max: 2 });
  pool.on('error', () => {});
}

/* An export shaped like the real one, with one record of every kind the
   script has to tell apart. */
function writeExport() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itbf-'));
  exportFile = path.join(dir, 'users.json');
  fs.writeFileSync(exportFile, JSON.stringify([
    { userAccountNumber: 'BF-IND',    investorType: 'INDIVIDUAL' },
    { userAccountNumber: 'BF-BIZ',    investorType: 'PTY_LTD' },
    { userAccountNumber: 'BF-TRUST',  investorType: 'inter vivos trust' },
    { userAccountNumber: 'BF-GROUP',  investorType: 'STOKVEL' },
    { userAccountNumber: 'BF-WEIRD',  investorType: 'NPO_SECTION_21' },
    { userAccountNumber: 'BF-SET',    investorType: 'TRUST' },
    { userAccountNumber: 'BF-AGREES', investorType: 'BUSINESS' },
    { userAccountNumber: 'BF-NONE' },
    { userAccountNumber: 'BF-GHOST',  investorType: 'BUSINESS' },
  ], null, 2));
}

async function seed() {
  const inv = (id, type) => pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, investor_type)
    VALUES ($1,'Test',$1,$1 || '@example.test','active',$2)`, [id, type]);
  await inv('BF-IND', null);
  await inv('BF-BIZ', null);
  await inv('BF-TRUST', null);
  await inv('BF-GROUP', null);
  await inv('BF-WEIRD', null);
  await inv('BF-NONE', null);
  /* Already classified in the console, and the export disagrees. */
  await inv('BF-SET', 'individual');
  /* Already classified, and the export agrees. */
  await inv('BF-AGREES', 'business');
  /* BF-GHOST is in the export and NOT in this database. */
}

const run = (...args) => execFileSync(process.execPath, [SCRIPT, `--file=${exportFile}`, ...args], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { DATABASE_URL: dbUrl, DATABASE_SSL: 'false' }),
});
const typeOf = async id => (await pool.query(
  `SELECT investor_type FROM investors WHERE id = $1`, [id])).rows[0].investor_type;

(async () => {
  try {
    await makeDatabase();
    writeExport();
    await seed();

    console.log('\nit previews, and writes nothing');
    {
      const out = run();
      ok('it says so', /nothing will be written/i.test(out), out.slice(0, 300));
      ok('and lists what it would set', /TO SET \(4\)/.test(out), out.slice(0, 900));
      ok('the database is untouched', (await typeOf('BF-IND')) === null);
    }

    console.log('\nand it maps the spellings the export actually uses');
    {
      const out = run('--apply');
      ok('four clients are classified', /4 client\(s\) classified/.test(out), out.slice(-400));
      ok('INDIVIDUAL → individual', (await typeOf('BF-IND')) === 'individual');
      ok('PTY_LTD → business', (await typeOf('BF-BIZ')) === 'business');
      ok('inter vivos trust → trust', (await typeOf('BF-TRUST')) === 'trust');
      ok('STOKVEL → group', (await typeOf('BF-GROUP')) === 'group');
    }

    console.log('\nand it refuses to guess at one it does not know');
    {
      ok('the unrecognised client is left unset', (await typeOf('BF-WEIRD')) === null,
         'guessing turns an imported entity into a natural person and FICA then ' +
         'verifies it against Home Affairs rather than its registration');
      const out = run();
      ok('and the value is named so it can be added',
         /NOT RECOGNISED/.test(out) && /NPO_SECTION_21/.test(out), out.slice(0, 1400));
      ok('with where to add it', /ALIASES in server\/services\/investorType\.js/.test(out));
    }

    console.log('\nand it defers to a type somebody set in the console');
    {
      ok('the conflicting one is untouched', (await typeOf('BF-SET')) === 'individual',
         'the export says trust; the console said individual more recently');
      const out = run();
      ok('the disagreement is reported, not silently resolved',
         /ALREADY SET, AND THE EXPORT DISAGREES \(1\)/.test(out), out.slice(0, 1600));
      ok('naming both answers',
         /console says Individual, export says Trust/.test(out), out.slice(0, 1600));

      run('--apply', '--overwrite');
      ok('and --overwrite does take the export', (await typeOf('BF-SET')) === 'trust');
    }

    console.log('\nand it leaves alone what it has no business touching');
    {
      ok('a client with no investorType in the export stays unset',
         (await typeOf('BF-NONE')) === null);
      ok('one that already agreed is unchanged', (await typeOf('BF-AGREES')) === 'business');
      const out = run();
      ok('a client in the export but not in this database is reported, not an error',
         /NOT IN THIS DATABASE \(1\)/.test(out), out.slice(0, 1800));
    }

    console.log('\nand a second run finds nothing left to do');
    {
      const out = run('--apply');
      ok('nothing further is written', /Nothing to write/.test(out), out.slice(-300));
      ok('and the classifications hold', (await typeOf('BF-BIZ')) === 'business');
    }

    console.log('\nand it refuses an export it cannot read rather than writing half of one');
    {
      const bad = path.join(path.dirname(exportFile), 'broken.json');
      fs.writeFileSync(bad, '{ not json');
      let threw = false;
      try {
        execFileSync(process.execPath, [SCRIPT, `--file=${bad}`, '--apply'],
          { encoding: 'utf8', env: Object.assign({}, process.env,
            { DATABASE_URL: dbUrl, DATABASE_SSL: 'false' }), stdio: 'pipe' });
      } catch (_) { threw = true; }
      ok('a malformed export is refused', threw);
      ok('and nothing was changed by it', (await typeOf('BF-BIZ')) === 'business');
    }
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    if (pool) await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
    await adminPool.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
