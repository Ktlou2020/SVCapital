#!/usr/bin/env node
/* Refer a Friend, switched on.
 *
 * The screen, the route and the XP award all existed; the entry points were
 * hidden behind display:none and a commented-out line. Unhiding them is the
 * easy half. The half that decides whether it works is the code itself:
 *
 *   · Only signup ever issued one, so every investor added from the console
 *     or imported reached the screen to find a dash where their code goes.
 *   · There was no unique index, and the generator was five random characters
 *     with no retry. The lookup that credits a referrer is
 *     `WHERE referral_code = $1 LIMIT 1`, so two investors sharing a code
 *     means one of them silently loses every referral they make.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-referral-programme.cjs
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
const read  = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const RC = require(path.join(ROOT, 'server', 'services', 'referralCode.js'));

const setup = () => require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

(async () => {
  try {
    await setup();

    console.log('\nthe way in is open, on both shells');
    {
      for (const p of ['portal/index.html', 'mobile/src/index.html']) {
        const html = read(p);
        const nav = (html.match(/<button class="nav-item" data-view="referral"[^>]*>/) || [''])[0];
        ok(`${p} shows the nav item`, nav && !/display:\s*none/.test(nav),
           nav || 'no referral nav item at all');
      }
      for (const p of ['portal/js/portal.js', 'mobile/src/js/portal.js']) {
        const js = read(p);
        ok(`${p} offers it in the command palette`,
           /label: 'Refer a Friend'[\s\S]{0,200}navigate\('referral'/.test(js),
           'the palette entry is still commented out');
        ok(`${p} no longer says the feature is unreleased`,
           !/referral programme not yet live/.test(js));
      }
      ok('the view itself is still there to navigate to',
         /id="view-referral"/.test(read('portal/index.html')));
    }

    console.log('\nevery investor has a code, so nobody meets a dash');
    {
      await db.query(`DELETE FROM investors WHERE id LIKE 'INV-REF-%'`);
      /* Dropped FIRST. The index cannot coexist with the duplicates, and this
         is the state a real database is in before the repair runs — seeding
         them with the index in place just fails the fixture. */
      await db.query('DROP INDEX IF EXISTS investors_referral_code_uniq');
      await db.query(`
        INSERT INTO investors (id, first_name, last_name, email, referral_code, created_at)
        VALUES ('INV-REF-1','No','Code','ref1@example.com',NULL,      NOW() - INTERVAL '3 days'),
               ('INV-REF-2','Empty','Code','ref2@example.com','',     NOW() - INTERVAL '2 days'),
               ('INV-REF-3','Older','Dup','ref3@example.com','SVCDUP',NOW() - INTERVAL '5 days'),
               ('INV-REF-4','Newer','Dup','ref4@example.com','SVCDUP',NOW() - INTERVAL '1 days')`);

      await setup();

      const { rows } = await db.query(
        `SELECT id, referral_code FROM investors WHERE id LIKE 'INV-REF-%' ORDER BY id`);
      const byId = Object.fromEntries(rows.map(r => [r.id, r.referral_code]));
      ok('an investor with no code is given one', !!byId['INV-REF-1'], JSON.stringify(byId));
      ok('and one with an empty code too', !!byId['INV-REF-2'], JSON.stringify(byId));
      ok('the older of two sharing a code keeps it', byId['INV-REF-3'] === 'SVCDUP',
         `kept ${byId['INV-REF-3']} — the older row is the one more likely already shared`);
      ok('and the newer is reissued a different one',
         byId['INV-REF-4'] && byId['INV-REF-4'] !== 'SVCDUP', byId['INV-REF-4']);

      const { rows: dupes } = await db.query(`
        SELECT referral_code, COUNT(*)::int n FROM investors
         WHERE referral_code IS NOT NULL AND referral_code <> ''
         GROUP BY referral_code HAVING COUNT(*) > 1`);
      ok('no two investors share a code afterwards', dupes.length === 0, JSON.stringify(dupes));

      const { rows: missing } = await db.query(
        `SELECT COUNT(*)::int n FROM investors WHERE referral_code IS NULL OR referral_code = ''`);
      ok('and none is left without one', missing[0].n === 0, `${missing[0].n} still have none`);
    }

    console.log('\nand the database will not let that happen again');
    {
      const { rows: idx } = await db.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'investors_referral_code_uniq'`);
      ok('a unique index stands behind the code', idx.length === 1, 'nothing enforces uniqueness');
      ok('and it ignores rows that have none',
         idx.length === 1 && /WHERE/.test(idx[0].indexdef), idx[0] && idx[0].indexdef);

      let clashed = false;
      try {
        await db.query(
          `UPDATE investors SET referral_code = (SELECT referral_code FROM investors WHERE id='INV-REF-3')
            WHERE id = 'INV-REF-4'`);
      } catch (e) { clashed = e.code === '23505'; }
      ok('a duplicate is refused by the database, not by hope', clashed,
         'two investors can still share a code');
    }

    console.log('\nthe code is fit to be read off a screen and typed into another');
    {
      const codes = new Set();
      for (let i = 0; i < 5000; i++) codes.add(RC.newCode());
      ok('5 000 codes collide none of the time', codes.size === 5000,
         `${5000 - codes.size} collisions in 5 000`);
      ok('every code is prefixed so it is recognisable',
         [...codes].every(c => /^SVC[A-Z2-9]{6}$/.test(c)), [...codes][0]);
      ok('and leaves out the characters people mistype',
         !/[ILO01]/.test(RC.ALPHABET), RC.ALPHABET);
    }

    console.log('\nnew investors get one however they are created');
    {
      ok('signup asks the service for it',
         /require\('\.\.\/services\/referralCode'\)\.newCode\(\)/.test(read('server/routes/auth.js')));
      ok('and retries rather than failing the signup on a clash',
         /investors_referral_code_uniq[\s\S]{0,220}newCode\(\)/.test(read('server/routes/auth.js')),
         'a collision would 500 the one request least able to afford it');
      ok('an investor added from the console gets one too',
         /table === 'investors' && !body\.referral_code[\s\S]{0,120}newCode\(\)/.test(read('server/routes/tables.js')),
         'staff-created clients would reach the screen and find a dash');
    }

    console.log('\nthe rewards panel tells the truth about what is paid');
    {
      const core = strip(read('js/portal-core.js'));
      ok('referral history shows when there is some',
         /refSection\.style\.display = refTxns\.length \? '' : 'none'/.test(core),
         'it was pinned shut regardless of what the account held');
      ok('and the rows are actually rendered',
         /refList && refTxns\.length/.test(core),
         'the list was computed and thrown away');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
