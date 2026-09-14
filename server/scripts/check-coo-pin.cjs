#!/usr/bin/env node
/* The COO's PIN is not published in this repository.
 *
 * Step 6 wrote id_number = '0000000009001' onto the coo@svcapital.co.za staff
 * row on every boot, on every environment including production.
 *
 * /staff-token's first-login branch validates a submitted PIN against the LAST
 * FOUR DIGITS of id_number when pin_set is false. That value therefore
 * published the PIN — 9001 — to anyone who could read this repository, for an
 * account seeded at level 'executive': empToJwtRole maps that to 'director'
 * and elevateRoleByApps grants all fourteen apps. Full admin console.
 *
 * Clearing id_number does not fix it, it locks the account. There is no admin
 * path to reset a staff PIN — ALWAYS_PROTECTED_COLS blocks pin_hash and
 * pin_set through the table API, and /set-pin only accepts the token
 * /staff-token issues after a successful first login. So the credential has to
 * be REPLACED, down the same temp-PIN path step 2f uses for the staging
 * director.
 *
 * Three rules this file exists to hold, in order of how much they matter:
 *   1. a chosen PIN is never touched;
 *   2. a real id_number is never overwritten — it is PII on a FICA column, and
 *      overwriting it is how the placeholder got onto a live row;
 *   3. only the exact published value is rotated, so this runs once.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-coo-pin.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
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

const PUBLISHED = '0000000009001';
const COO = 'coo@svcapital.co.za';
const SETUP = path.join(ROOT, 'server', 'db', 'setup.js');
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const runSetup = async () => {
  const said = [];
  const l = console.log, w = console.warn, e = console.error;
  console.log = (...a) => said.push(a.join(' '));
  console.warn = (...a) => said.push(a.join(' '));
  console.error = (...a) => said.push(a.join(' '));
  try {
    delete require.cache[require.resolve(SETUP)];
    await require(SETUP)().catch(() => {});
  } finally { console.log = l; console.warn = w; console.error = e; }
  return said;
};
const coo = async () => (await db.query(
  `SELECT id, id_number, pin_set, pin_hash, level, status FROM employees WHERE email = $1`, [COO])).rows[0];

(async () => {
  try {
    console.log('\nthe published value is never written');
    {
      const whole = decomment(fs.readFileSync(SETUP, 'utf8'));
      /* Scoped to step 6. Step 2f provisions the staging director down the same
         temp-PIN path and contains the same randomInt expression, so a check
         reading the whole file was satisfied by 2f's copy while step 6's had
         been replaced with a constant — which a mutation proved. */
      const step6 = whole.slice(whole.indexOf('6. Seed COO employee record for'),
                                whole.indexOf('7. Backfill investments end date to'));
      ok('step 6 is still findable', step6.length > 200, `${step6.length} chars`);
      const code = step6;
      const writes = code.match(/id_number\s*=\s*'0000000009001'/g) || [];
      ok('no statement assigns it', writes.length === 0, JSON.stringify(writes));
      const inserts = code.match(/'0000000009001'\s*,\s*'CO'/g) || [];
      ok('and no INSERT passes it positionally', inserts.length === 0, JSON.stringify(inserts));
      ok('it survives only as the value to detect',
         /PUBLISHED_PIN_ID = '0000000009001'/.test(code),
         'the rotation has to recognise the old credential to replace it');
      ok('the temp PIN is generated, not written down',
         /randomInt\(0, 10000\)/.test(code));
      ok('and can be supplied deliberately instead', /COO_TEMP_PIN/.test(code),
         'so a production boot need not print a credential to its log');
    }

    await runSetup();

    console.log('\na fresh database gets a random PIN, not the published one');
    {
      const c = await coo();
      ok('the COO record exists', !!c);
      ok('its id_number is not the published value', c && c.id_number !== PUBLISHED, String(c && c.id_number));
      ok('it is still id-number shaped', c && /^\d{13}$/.test(c.id_number || ''), String(c && c.id_number));
      ok('the derived PIN is not 9001', c && c.id_number.slice(-4) !== '9001', String(c && c.id_number));
      ok('and no PIN has been chosen yet', c && c.pin_set === false && c.pin_hash === null,
         'writing pin_hash directly makes pin_set true and strands the account — see step 2f');
    }

    console.log('\nthe published credential is rotated off a live row');
    {
      await db.query(`UPDATE employees SET id_number = $1, pin_set = false, pin_hash = NULL WHERE email = $2`,
                     [PUBLISHED, COO]);
      const said = await runSetup();
      const c = await coo();
      ok('the id_number is replaced', c.id_number !== PUBLISHED, String(c.id_number));
      ok('the new PIN is four digits', /^\d{13}$/.test(c.id_number) && /^\d{4}$/.test(c.id_number.slice(-4)));
      ok('and the boot log says it happened',
         said.some(x => /still on the PIN published in this repository/.test(x)),
         said.filter(x => /PIN/i.test(x)).join(' | ') || '(nothing said)');
      ok('and tells the reader to replace it',
         said.some(x => /set a PIN of your own/.test(x)));

      /* Once rotated the row no longer matches, so a second boot must leave it
         alone — otherwise the COO's PIN changes under them every deploy. */
      const before = c.id_number;
      await runSetup();
      ok('a second boot does not rotate again', (await coo()).id_number === before,
         'the PIN would change on every deploy and the log would fill with credentials');
    }

    console.log('\na chosen PIN is never touched');
    {
      await db.query(
        `UPDATE employees SET id_number = '9001010001088', pin_set = true, pin_hash = 'bcrypt-stub'
          WHERE email = $1`, [COO]);
      await runSetup();
      const c = await coo();
      ok('pin_set stays true', c.pin_set === true);
      ok('the PIN hash is untouched', c.pin_hash === 'bcrypt-stub');
      ok('and their real id_number is left alone', c.id_number === '9001010001088',
         'it is PII on a FICA column — overwriting it is how the placeholder got onto a live row');
    }

    console.log('\nnor is a real id_number on an account with no PIN yet');
    {
      await db.query(
        `UPDATE employees SET id_number = '8001015009087', pin_set = false, pin_hash = NULL
          WHERE email = $1`, [COO]);
      await runSetup();
      const c = await coo();
      ok('it is preserved', c.id_number === '8001015009087',
         'only the exact published value is rotated — anything else is somebody real');
    }

    console.log('\nthe role fields are still asserted on every boot');
    {
      await db.query(`UPDATE employees SET level = 'junior', status = 'inactive' WHERE email = $1`, [COO]);
      await runSetup();
      const c = await coo();
      ok('level is restored', c.level === 'executive');
      ok('status is restored', c.status === 'active');
    }

    console.log('\nCOO_TEMP_PIN is honoured when supplied');
    {
      process.env.COO_TEMP_PIN = '4731';
      await db.query(`UPDATE employees SET id_number = $1, pin_set = false WHERE email = $2`, [PUBLISHED, COO]);
      const said = await runSetup();
      const c = await coo();
      ok('the supplied PIN is used', c.id_number === '0000000004731', String(c.id_number));
      ok('and it is not printed', !said.some(x => /4731/.test(x)),
         'the point of supplying it is that the boot log does not carry a credential');
      delete process.env.COO_TEMP_PIN;
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
