#!/usr/bin/env node
/* The nightly FICA sweep has to actually queue somebody.
 *
 * In production it reports the same line every night:
 *
 *     [FICA Cron] Queued: 0 annual re-checks, 0 first-deposit checks.
 *
 * No automated check has ever succeeded there — the Smile Identity keys the
 * ID step needs are not set on the service — so investors.last_auto_fica_check
 * is NULL for everybody, and every investor who has ever deposited should be
 * in the first-deposit batch. Deposits plainly exist. So either the queries
 * are wrong, or production's data does not look the way the queries expect,
 * and those two want telling apart before a line of provider code is written:
 * a new verification provider behind a trigger that never fires changes
 * nothing at all.
 *
 * This runs the REAL runFicaSweep against a seeded database and asserts who
 * it picks up and who it leaves alone. It is the control: if this passes, the
 * queries are sound and the production zero is a fact about the data.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-fica-sweep-queues.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const SSL  = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
const DB_NAME = 'chk_ficasweep_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

function withDatabase(url, name) { const u = new URL(url); u.pathname = '/' + name; return u.toString(); }
const adminPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
let pool;

async function makeDatabase() {
  await adminPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await adminPool.query(`CREATE DATABASE ${DB_NAME}`);
  const url = withDatabase(process.env.DATABASE_URL, DB_NAME);
  process.env.DATABASE_URL = url;
  for (const m of ['db/pool.js', 'db/setup.js', 'jobs/ficaCron.js', 'services/ficaService.js']) {
    const p = require.resolve(path.join(ROOT, 'server', m));
    delete require.cache[p];
  }
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  pool = new Pool({ connectionString: url, ssl: SSL, max: 2 });
  pool.on('error', () => {});
}

/* Six investors, one situation each. Only two of them may be picked up.

   FS-OK    deposited, never checked          → first-deposit batch
   FS-OLD   checked 2 years ago               → annual batch
   FS-SUSP  deposited, never checked, SUSPENDED
   FS-DONE  deposited, checked yesterday
   FS-NODEP never deposited
   FS-PEND  deposit still PENDING             — money that has not arrived is
                                                not a first deposit */
async function seed() {
  const inv = (id, status, lastCheck) => pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, kyc_status,
        id_number, date_of_birth, nationality, last_auto_fica_check)
    VALUES ($1,'Test',$1,$1 || '@example.test',$2,'pending',
            '9001015800085','1990-01-01','South African',$3)`,
    [id, status, lastCheck]);

  await inv('FS-OK',    'active', null);
  await inv('FS-OLD',   'active', new Date(Date.now() - 400 * 864e5));
  await inv('FS-SUSP',  'suspended', null);
  await inv('FS-DONE',  'active', new Date(Date.now() - 864e5));
  await inv('FS-NODEP', 'active', null);
  await inv('FS-PEND',  'active', null);

  const dep = (id, who, status) => pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date)
    VALUES ($1,$2,'deposit', 1000, $3, $1, 'Deposit', NOW() - INTERVAL '10 days')`,
    [id, who, status]);

  await dep('FS-T-OK',   'FS-OK',   'completed');
  await dep('FS-T-OLD',  'FS-OLD',  'completed');
  await dep('FS-T-SUSP', 'FS-SUSP', 'completed');
  await dep('FS-T-DONE', 'FS-DONE', 'completed');
  await dep('FS-T-PEND', 'FS-PEND', 'pending');
}

const checksFor = async id => (await pool.query(
  `SELECT trigger, overall_status FROM fica_checks WHERE investor_id = $1`, [id])).rows;

(async () => {
  try {
    await makeDatabase();
    await seed();

    /* The real job. The ID step has no provider keys here, exactly as in
       production, so each check it runs records an error — which is the
       point: what is being asserted is WHO it picked up, not whether the
       verification succeeded. */
    const { runFicaSweep } = require(path.join(ROOT, 'server', 'jobs', 'ficaCron.js'));
    const quiet = console.log; const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try { await runFicaSweep(); } finally { console.log = quiet; }

    const queued = lines.find(l => /Queued:/.test(l)) || '';
    const done   = lines.find(l => /Sweep complete/.test(l)) || '';
    console.log('\nthe sweep picks up the people it is for');
    console.log(`  (${queued.trim()})`);

    ok('it queues the investor who deposited and was never checked',
       /0 annual re-checks/.test(queued) === false || /1 first-deposit/.test(queued),
       `${queued} — this is the batch that is empty every night in production`);
    ok('and a check was actually recorded against them',
       (await checksFor('FS-OK')).some(r => r.trigger === 'first_deposit'),
       JSON.stringify(await checksFor('FS-OK')));
    ok('it queues the investor whose check is over a year old',
       (await checksFor('FS-OLD')).some(r => r.trigger === 'annual_recheck'),
       JSON.stringify(await checksFor('FS-OLD')));

    console.log('\nand leaves alone the people it is not for');
    ok('a suspended investor is skipped', (await checksFor('FS-SUSP')).length === 0);
    ok('an investor checked yesterday is skipped', (await checksFor('FS-DONE')).length === 0);
    ok('an investor who never deposited is skipped', (await checksFor('FS-NODEP')).length === 0);
    ok('a PENDING deposit is not a first deposit', (await checksFor('FS-PEND')).length === 0,
       'money that has not arrived does not start the FICA clock');

    console.log('\nand says what it did');
    ok('the completion line counts both batches',
       /annual:1 firstDeposit:1/.test(done), done);

    /* The ID step cannot succeed without provider keys. Worth asserting,
       because it is the state production is in RIGHT NOW: were the trigger
       ever to fire there, every investor it touched would be recorded as an
       error and left pending — which is the honest outcome, but it is not
       verification, and nobody should read those rows as checks that ran. */
    console.log('\nand with no provider configured it records an error, not a pass');
    const r = (await checksFor('FS-OK'))[0];
    ok('the check is not recorded as a pass', r && r.overall_status !== 'pass',
       JSON.stringify(r));
    ok('it is recorded as an error', r && r.overall_status === 'error',
       `got ${r && r.overall_status} — an unconfigured provider must never read as verified`);
    const { rows: [k] } = await pool.query(
      `SELECT kyc_status, fica_auto_status FROM investors WHERE id = 'FS-OK'`);
    ok('and the investor is left pending rather than rejected',
       k && k.kyc_status === 'pending',
       `${JSON.stringify(k)} — our own missing credentials must not reject a client`);
    /* ── The trap ────────────────────────────────────────────────────
       ficaService stamps last_auto_fica_check on EVERY outcome, errors
       included. So one sweep with no provider credentials marks every
       depositor as checked and drops them out of the first-deposit batch
       — for a YEAR, until the annual window reopens. That is the shape of
       production's nightly "0 and 0": not nobody to check, but everybody
       already stamped by a sweep that verified nothing.

       It matters now rather than later: plug a new provider in and the
       first-deposit batch is STILL empty, because the stamp is already
       there. */
    console.log('\nand an errored check does not count as having checked them');
    {
      await pool.query(`DELETE FROM fica_checks WHERE investor_id = 'FS-OK'`);
      const quiet2 = console.log; const lines2 = [];
      console.log = (...a) => lines2.push(a.join(' '));
      try { await runFicaSweep(); } finally { console.log = quiet2; }
      const again = lines2.find(l => /Queued:/.test(l)) || '';

      ok('the investor whose check errored is picked up again',
         (await checksFor('FS-OK')).some(r => r.trigger === 'first_deposit'),
         `${again.trim()} — an error means we never checked them, so stamping ` +
         'them as checked hides them for a year behind a verification that ' +
         'never happened');
      ok('and the stamp that hides them was never written',
         (await pool.query(
           `SELECT last_auto_fica_check FROM investors WHERE id = 'FS-OK'`)
         ).rows[0].last_auto_fica_check === null,
         'the column the first-deposit batch tests must stay NULL until ' +
         'somebody has actually been checked');

      /* Nobody being verified is not a log line. */
      const { rows: inc } = await pool.query(
        `SELECT severity, message FROM platform_incidents WHERE source = 'fica'`);
      ok('and the silence is raised as an incident',
         inc.length === 1 && inc[0].severity === 'critical',
         JSON.stringify(inc));
      ok('naming what cannot happen until it is fixed',
         inc[0] && /No investor can be verified/.test(inc[0].message),
         JSON.stringify(inc[0] && inc[0].message));
    }

    /* ── And the other half: a check that RESOLVES must stamp ────────
       Exempting the error case is only right if the success case still
       writes the stamp — otherwise everyone is re-checked every night for
       ever, which on a prepaid account is somebody's money.

       The provider is stubbed to answer here. Nothing else in this file
       can reach the success path, because the real client throws without
       credentials — which is also why the happy path had no coverage at
       all before this. */
    console.log('\nand a check that resolves DOES stamp them as checked');
    {
      await pool.query(`
        INSERT INTO investors (id, first_name, last_name, email, status, kyc_status,
            id_number, date_of_birth, nationality, last_auto_fica_check)
        VALUES ('FS-PASS','Pass','Case','pass@example.test','active','pending',
                '9001015800085','1990-01-01','South African', NULL)`);
      await pool.query(`
        INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date)
        VALUES ('FS-T-PASS','FS-PASS','deposit', 1000,'completed','FS-T-PASS','Deposit', NOW())`);

      /* Stand a passing provider in front of the real one, then reload the
         service so it picks the stub up. */
      const smilePath = require.resolve(path.join(ROOT, 'server', 'services', 'smileIdentity.js'));
      require.cache[smilePath] = {
        id: smilePath, filename: smilePath, loaded: true, children: [], paths: [],
        exports: {
          verifyID:       async () => ({ ResultCode: '0810', ResultText: 'Verified' }),
          verifyPassport: async () => ({ ResultCode: '0810', ResultText: 'Verified' }),
          mapResult:      () => 'pass',
          verifyWebhook:  () => true,
        },
      };
      for (const m of ['services/ficaService.js', 'jobs/ficaCron.js']) {
        delete require.cache[require.resolve(path.join(ROOT, 'server', m))];
      }
      const { runFicaSweep: sweep2 } = require(path.join(ROOT, 'server', 'jobs', 'ficaCron.js'));
      const q3 = console.log; console.log = () => {};
      try { await sweep2(); } finally { console.log = q3; }

      const rows = await checksFor('FS-PASS');
      ok('the verification is recorded as a pass', rows.some(r => r.overall_status === 'pass'),
         JSON.stringify(rows));
      const { rows: [p] } = await pool.query(
        `SELECT last_auto_fica_check, kyc_status FROM investors WHERE id = 'FS-PASS'`);
      ok('and THIS time the stamp is written',
         p && p.last_auto_fica_check !== null,
         'without it a verified investor is re-checked every night, and on a ' +
         'prepaid account every check costs money');
      ok('and the investor is marked verified', p && p.kyc_status === 'verified',
         JSON.stringify(p));
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
