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

/* THIS BATCH USED TO BE EVERY DEPOSITOR, and these fixtures were deposits.
   The automated route now starts at an INVESTMENT of R2 000 — a deposit is
   not a purchase, and the check is paid provider calls per client — so the
   fixtures are investments, and two new cases carry the rule:
   somebody who only deposited, and somebody who invested R500.

   Nine investors, one situation each. Only two may be picked up.

   FS-OK     invested R2 000, never checked     → first-investment batch
   FS-OLD    checked 2 years ago                → annual batch
   FS-SUSP   invested, never checked, SUSPENDED
   FS-DONE   invested, checked yesterday
   FS-NOINV  never invested
   FS-PEND   investment CANCELLED               — a placement that did not
                                                  stand is not a placement
   FS-DEP    deposited R50 000, never invested  — money in a wallet is not a
                                                  purchase
   FS-SMALL  invested R500                      — under the threshold, so
                                                  documents and a person
   FS-SCREEN approved, never screened           → sanctions backfill */
async function seed() {
  const inv = (id, status, lastCheck) => pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, kyc_status,
        id_number, date_of_birth, nationality, last_auto_fica_check)
    VALUES ($1,'Test',$1,$1 || '@example.test',$2,'pending',
            '9001015800085','1990-01-01','South African',$3)`,
    [id, status, lastCheck]);

  await inv('FS-OK',     'active', null);
  await inv('FS-OLD',    'active', new Date(Date.now() - 400 * 864e5));
  await inv('FS-SUSP',   'suspended', null);
  await inv('FS-DONE',   'active', new Date(Date.now() - 864e5));
  await inv('FS-NOINV',  'active', null);
  await inv('FS-PEND',   'active', null);
  await inv('FS-DEP',    'active', null);
  await inv('FS-SMALL',  'active', null);

  /* Approved and never screened — the backfill's population. Stamped as
     screened-never by leaving last_sanctions_check NULL, which is what
     every client on the platform carries until the screen runs. */
  await pool.query(`UPDATE investors SET kyc_status = 'approved' WHERE id = 'FS-DONE'`);
  await inv('FS-SCREEN', 'active', new Date(Date.now() - 60 * 864e5));
  await pool.query(`UPDATE investors SET kyc_status = 'approved' WHERE id = 'FS-SCREEN'`);
  /* Everybody else is kyc_status 'pending', so nobody but FS-DONE and
     FS-SCREEN can reach the screen-only scope. FS-DONE is approved AND
     checked yesterday AND unscreened, which makes it the case that tells
     the two windows apart: its full check is inside the window, so the
     screen is what it is due. */

  const place = (id, who, amount, status) => pool.query(`
    INSERT INTO investments (id, investor_id, amount, status, start_date)
    VALUES ($1,$2,$3,$4, NOW() - INTERVAL '10 days')`,
    [id, who, amount, status]);

  await place('FS-V-OK',    'FS-OK',    2000, 'active');
  await place('FS-V-OLD',   'FS-OLD',   5000, 'active');
  await place('FS-V-SUSP',  'FS-SUSP',  5000, 'active');
  await place('FS-V-DONE',  'FS-DONE',  5000, 'active');
  await place('FS-V-PEND',  'FS-PEND',  5000, 'cancelled');
  await place('FS-V-SMALL', 'FS-SMALL',  500, 'active');

  /* A deposit and nothing placed. */
  await pool.query(`
    INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date)
    VALUES ('FS-T-DEP','FS-DEP','deposit', 50000,'completed','FS-T-DEP','Deposit', NOW() - INTERVAL '10 days')`);
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

    /* THE OLD FORM OF THIS ASSERTION WAS
         /0 annual re-checks/.test(queued) === false || /1 first-deposit/…
       which is true the moment the ANNUAL batch queues anybody, whatever
       the investment batch did. It passed through a change that emptied
       the batch it is about. The count is read directly now. */
    ok('it queues the investor who invested R2 000 and was never checked',
       /1 first-investment checks/.test(queued),
       `${queued} — this is the batch that is empty every night in production`);
    ok('and a check was actually recorded against them',
       (await checksFor('FS-OK')).some(r => r.trigger === 'first_investment'),
       JSON.stringify(await checksFor('FS-OK')));
    ok('it queues the investor whose check is over a year old',
       (await checksFor('FS-OLD')).some(r => r.trigger === 'annual_recheck'),
       JSON.stringify(await checksFor('FS-OLD')));

    console.log('\nand leaves alone the people it is not for');
    ok('a suspended investor is skipped', (await checksFor('FS-SUSP')).length === 0);
    ok('an investor checked yesterday is skipped', (await checksFor('FS-DONE')).length === 0);
    ok('an investor who never invested is skipped', (await checksFor('FS-NOINV')).length === 0);
    ok('a CANCELLED investment is not a placement', (await checksFor('FS-PEND')).length === 0,
       'a placement that did not stand does not start the FICA clock');

    /* ── THE RULE ITSELF ── */
    ok('A DEPOSIT WITH NOTHING PLACED IS NOT CHECKED',
       (await checksFor('FS-DEP')).length === 0,
       'R50 000 sitting in a wallet is not a purchase, and this batch used '
       + 'to be every depositor: ' + JSON.stringify(await checksFor('FS-DEP')));
    ok('AND NEITHER IS AN INVESTMENT UNDER R2 000',
       (await checksFor('FS-SMALL')).length === 0,
       'R500 goes to documents and a person — this is the whole rule: '
       + JSON.stringify(await checksFor('FS-SMALL')));

    console.log('\nand screens the approved client who was never screened');
    ok('THE BACKFILL QUEUES THEM',
       /1 sanctions backfills/.test(queued) || /2 sanctions backfills/.test(queued),
       queued);
    /* AND RECORDS NOTHING FOR THEM, because there is no screening provider
       in this environment — which is the state production is in right now.
       A screen-only run with nothing to screen with would otherwise write a
       row whose every step says 'skipped', and that row says the client was
       screened. They were not. So the honest outcome is no row, no stamp,
       and an incident naming what cannot happen until a provider is
       configured — asserted below. */
    ok('and records nothing, because there is no screening provider here',
       (await checksFor('FS-SCREEN')).length === 0,
       'a row of skips says this client was screened, and they were not: '
       + JSON.stringify(await checksFor('FS-SCREEN')));

    console.log('\nand says what it did');
    ok('the completion line counts every batch',
       /annual:1 firstInvestment:1/.test(done) && /sanctionsBackfill:[1-9]/.test(done),
       done);

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
         (await checksFor('FS-OK')).some(r => r.trigger === 'first_investment'),
         `${again.trim()} — an error means we never checked them, so stamping ` +
         'them as checked hides them for a year behind a verification that ' +
         'never happened');
      ok('and the stamp that hides them was never written',
         (await pool.query(
           `SELECT last_auto_fica_check FROM investors WHERE id = 'FS-OK'`)
         ).rows[0].last_auto_fica_check === null,
         'the column the first-investment batch tests must stay NULL until ' +
         'somebody has actually been checked');

      /* Nobody being verified is not a log line. */
      const { rows: inc } = await pool.query(
        `SELECT severity, message FROM platform_incidents WHERE source = 'fica'`);
      /* SEARCHED, NOT INDEXED. There is a second critical incident now —
         an approved client who cannot be screened because no screening
         provider is configured — and it is raised first, so inc[0] is no
         longer the one this asserts about. An assertion that reads index
         zero is an assertion about the order things happened to run in. */
      ok('and the silence is raised as an incident',
         inc.length >= 1 && inc.every(i => i.severity === 'critical'),
         JSON.stringify(inc));
      ok('naming what cannot happen until it is fixed',
         inc.some(i => /No investor can be verified/.test(i.message || '')),
         JSON.stringify(inc.map(i => i.message)));
      ok('AND THE UNSCREENED APPROVED CLIENT IS NAMED TOO',
         inc.some(i => /cannot be screened/.test(i.message || '')),
         'a client left approved and unscreened because a provider is '
         + 'missing is not a thing to leave in a log: '
         + JSON.stringify(inc.map(i => i.message)));
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
      /* An INVESTMENT over the threshold, not a deposit: the batch that
         picks this client up is the first-investment one now. R1 000 in a
         wallet would leave them unqueued and this whole section asserting
         nothing. */
      await pool.query(`
        INSERT INTO investments (id, investor_id, amount, status, start_date)
        VALUES ('FS-V-PASS','FS-PASS', 2500,'active', NOW())`);

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
