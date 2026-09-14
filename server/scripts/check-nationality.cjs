#!/usr/bin/env node
/* Every investor has a nationality, and the nightly FICA sweep can read it.
 *
 * server/jobs/ficaCron.js names investors.nationality in both of its queries.
 * The column had never been created. So both statements threw on their first
 * execution, every night, and neither the annual re-check batch nor the
 * first-deposit batch had ever verified a single investor:
 *
 *     [FICA Cron] Fatal sweep error: column "nationality" does not exist
 *
 * It announced that as a success. The catch logs the error and then execution
 * falls through to a summary line that sits OUTSIDE the try, so every run ended
 * "Sweep complete — annual:0 firstDeposit:0 errors:0" with counters that had
 * never been incremented. Anything watching that line saw a clean sweep.
 *
 * The default is South African, because the signup form only asks for a
 * nationality on the international path — a 13-digit SA ID number answers the
 * question for everyone else. That makes the default right for the SA path and
 * WRONG for the international one, where the answer the client actually gave
 * was written into the notes string instead of a column. Writing South African
 * over a Zimbabwean passport holder's FICA record would be a worse bug than the
 * crash it replaces, so step 16 takes their answer back out of notes.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-nationality.cjs
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

const CRON   = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'ficaCron.js'), 'utf8');
const AUTH   = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'auth.js'), 'utf8');
const decomment = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const seed = async (id, notes, nationality) => {
  await db.query(`DELETE FROM investors WHERE id = $1`, [id]);
  await db.query(
    `INSERT INTO investors (id, first_name, last_name, email, notes${nationality !== undefined ? ', nationality' : ''})
     VALUES ($1, 'Nat', 'Check', $2, $3${nationality !== undefined ? ', $4' : ''})`,
    nationality !== undefined
      ? [id, `${id.toLowerCase()}@example.com`, notes, nationality]
      : [id, `${id.toLowerCase()}@example.com`, notes]);
};
const natOf = async id =>
  (await db.query(`SELECT nationality FROM investors WHERE id = $1`, [id])).rows[0]?.nationality;

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nthe column the cron reads exists');
    {
      const { rows } = await db.query(
        `SELECT data_type, column_default FROM information_schema.columns
          WHERE table_name = 'investors' AND column_name = 'nationality'`);
      ok('investors.nationality is there', rows.length === 1, 'the FICA sweep selects it by name');
      ok('and defaults to South African',
         /South African/.test(rows[0]?.column_default || ''),
         String(rows[0]?.column_default));
    }

    console.log('\nand the query that used to throw now runs');
    {
      /* The shipped statement, lifted rather than retyped — a hand-copied SELECT
         would keep passing here after someone added another column to the real
         one and broke the sweep again. */
      const m = CRON.match(/const \{ rows: annualDue \} = await pool\.query\(`([\s\S]*?)`, \[BATCH_LIMIT\]\)/);
      ok('the annual batch statement is still findable', !!m,
         'if this fails the check can no longer prove anything about the real query');
      const m2 = CRON.match(/const \{ rows \} = await pool\.query\(`([\s\S]*?)`, \[remainingSlots\]\)/);
      ok('so is the first-deposit statement', !!m2);

      /* Each statement is RUN, and the columns it actually came back with are
         what gets asserted. Reading the SELECT text instead was not enough:
         with notes deleted from the annual query, a regex over the file still
         matched the i.notes in the first-deposit one and the check passed
         while the annual batch had lost the field it needs. Two statements
         mean two answers, so ask each of them separately. */
      const fieldsOf = async (sql) => {
        try { return (await db.query(sql, [5])).fields.map(f => f.name); }
        catch (e) { return { error: e.message }; }
      };
      const batches = [['annual re-check', m && m[1]], ['first-deposit', m2 && m2[1]]];

      for (const [label, sql] of batches) {
        if (!sql) continue;
        const cols = await fieldsOf(sql);
        ok(`the ${label} batch executes against the real schema`,
           Array.isArray(cols), cols && cols.error);
        if (!Array.isArray(cols)) continue;

        /* runFicaCheck destructures each of these off the row it is handed.
           Without notes it cannot tell a passport from an SA ID, and would
           submit a passport number as a national ID — a wrong answer rather
           than an error, which is the kind this job is least able to notice. */
        for (const col of ['id', 'first_name', 'last_name', 'id_number', 'notes', 'date_of_birth', 'nationality']) {
          ok(`  and returns ${col}`, cols.includes(col),
             `got: ${cols.join(', ')}`);
        }
      }

      /* Adding nationality was not enough on its own, and finding that out
         after a deploy would have cost another night of no FICA checks.
         fica_last_checked_at does not exist either and never has — the column
         everything else uses is last_auto_fica_check. */
      ok('the column that never existed is gone from the job',
         !/fica_last_checked_at/.test(decomment(CRON)),
         'a second missing column throws exactly like the first did');
    }

    console.log('\nan SA investor gets the default');
    {
      const SA = 'INV-NAT-SA';
      await seed(SA, 'DocType: SA ID. Experience: some.');
      ok('South African, without being asked', (await natOf(SA)) === 'South African',
         String(await natOf(SA)));
    }

    console.log('\nan international investor keeps the answer they gave');
    {
      const ZW = 'INV-NAT-ZW', GB = 'INV-NAT-GB';
      await seed(ZW, 'DocType: Passport. Nationality: Zimbabwean. Country: Zimbabwe. Expiry: 2030-01-01.', null);
      await seed(GB, 'DocType: Passport. Nationality: British. Country: United Kingdom. Expiry: 2029-06-30.', 'South African');

      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

      ok('a null is filled from their passport details', (await natOf(ZW)) === 'Zimbabwean',
         String(await natOf(ZW)));
      ok('and so is a row the column default already wrote over',
         (await natOf(GB)) === 'British',
         String(await natOf(GB)) + ' — ADD COLUMN … DEFAULT backfills every existing row, so the real answer has to win afterwards');
      ok('the trailing full stop is not part of the nationality',
         !/\.$/.test(String(await natOf(ZW))), String(await natOf(ZW)));
    }

    console.log('\nnothing that is not a passport record is touched');
    {
      const SAM = 'INV-NAT-MENTION';
      /* A notes field that mentions a nationality without being a passport
         record. The pattern is anchored to DocType: Passport for this reason. */
      await seed(SAM, 'DocType: SA ID. Client asked about Nationality: Nigerian tax treatment.', null);
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'db', 'setup.js'))];
      await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});
      ok('an SA record that merely mentions one stays South African',
         (await natOf(SAM)) === 'South African', String(await natOf(SAM)));
    }

    console.log('\nthe default is a value the code can actually map');
    {
      const { nationalityToCode } = require(path.join(ROOT, 'server', 'services', 'ficaService.js'));
      let code = null, threw = null;
      try { code = nationalityToCode('South African'); } catch (e) { threw = e.message; }
      ok('nationalityToCode answers for it', code === 'ZA', threw || String(code));
      ok('case does not matter', nationalityToCode('south african') === 'ZA');
      /* The rest of the map must still be there — an over-eager edit that
         replaced it with the default alone would pass the two above. */
      ok('and the foreign nationalities still map', nationalityToCode('Zimbabwean') === 'ZW');
    }

    console.log('\nregistration stores what the form collected');
    {
      const src = decomment(AUTH);
      ok('nationality is read off the request body', /idNumber, province, occupation, role = 'investor', nationality,/.test(src));
      ok('and named in the insert', /postal_code, nationality,/.test(src));
      ok('a missing one falls back to the default explicitly',
         /stripHtml\(nationality\) \|\| 'South African'/.test(src),
         "an INSERT that names a column and passes NULL stores NULL — the column DEFAULT does not fire");
      ok('and it is stripped like every other free-text field',
         /stripHtml\(nationality\)/.test(src));

      for (const f of ['signup.html', path.join('mobile', 'src', 'signup.html'), path.join('mobile', 'www', 'signup.html')]) {
        const form = fs.readFileSync(path.join(ROOT, f), 'utf8');
        ok(`${f} sends it`,
           /nationality:\s+isSA \? undefined : \(v\('nationality'\) \|\| undefined\)/.test(form),
           'the form has always required it of international clients and then dropped it into notes');
      }
    }

    for (const id of ['INV-NAT-SA', 'INV-NAT-ZW', 'INV-NAT-GB', 'INV-NAT-MENTION'])
      await db.query(`DELETE FROM investors WHERE id = $1`, [id]).catch(() => {});

  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
