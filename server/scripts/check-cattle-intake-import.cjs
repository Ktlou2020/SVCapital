#!/usr/bin/env node
/* The animal intake import: two CSV layouts, and the batch they land in.
 *
 * THE TRAP. Two exports reach this importer and both carry a column called
 * `Date`. In the legacy export it is the MORTALITY date; in the 2026 intake it
 * is the date the cattle arrived. The old code wrote `Date` straight to
 * mortality_date on every row, unconditionally — so importing an intake file
 * through it stamps a mortality date on every live animal in the file. On the
 * one that prompted this work that is 129 head, all alive, all carrying a date
 * saying otherwise, in a table the herd reconciliation reads.
 *
 * So a layout is identified before a column is read, and mortality_date is
 * written only when the animal is actually dead.
 *
 * THE ALLOCATION. The importer used to attach animals to a cycle by matching
 * the batch NAME in the file against a cycle's name, exactly. When that missed
 * — a different spelling, a batch number where a name was expected — the
 * animals landed with cycle_id NULL: present in the herd, attached to nothing,
 * and contributing to no valuation. Herd Reconciliation exists to clean that
 * up after the fact. The console now asks which batch, defaults to the match
 * if there is one, and sends the id.
 *
 * THE COUNTS. A cycle's header carries no_purchased / no_live / mortalities.
 * Importing animals into it used to leave those alone, which is why batches on
 * this book read "0 purchased" beside hundreds of animals and were valued at
 * nothing. They are recomputed from the animals — but no_purchased is only
 * ever raised, because it is the fund's own figure off the invoice and an
 * import carrying part of a batch must not shrink it.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-intake-import.cjs
 */
'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC  = read('fund/js/cattle.js');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const ROUTE = read('server/routes/cattle.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The shipped mapping functions, run rather than read. */
const vm = require('vm');
function lift(names) {
  const ctx = { console, S: { cycles: [] } };
  vm.createContext(ctx);
  let src = '';
  for (const n of names) {
    /* A plain substring, not a regex. Escaping a literal '(' through a JS
       string into a RegExp needs exactly one level of backslash and I got it
       wrong twice; the catch below then blamed the shipped code for a fault
       that was in this file. There is nothing here a regex was doing for us. */
    let at = SRC.indexOf('function ' + n + '(');
    const isFn = at >= 0;
    if (at < 0) at = SRC.indexOf('const ' + n + ' = ');
    if (at < 0) throw new Error(n + ' not found');
    /* Function declarations in this file end on a line that is exactly "}";
       the const objects end on "};". */
    const marker = isFn ? '\n}\n' : '\n};\n';
    const end = SRC.indexOf(marker, at);
    if (end < 0) throw new Error(n + ' has no end marker');
    src += SRC.slice(at, end + marker.length) + '\n';
  }
  vm.runInContext(src + '\nthis._lifted = { ' + names.join(', ') + ' };', ctx);
  return ctx._lifted;
}

console.log('\nthe layout is identified before a column is read');
let L = null;
/* ANIMAL_CSV_FIELDS first — _csvField reads it, and lifting the function
   without its table gives a ReferenceError at the first call rather than at
   load, which reads like the shipped code is broken. */
try { L = lift(['ANIMAL_CSV_FIELDS', '_animalCsvLayout', '_csvField', '_animalStatusFromRow']); }
catch (e) { ok('the mapping functions could be lifted and run', false, e.message); }
ok('the mapping functions are runnable', !!L && typeof L._animalCsvLayout === 'function');

if (L) {
  const INTAKE_HEADERS = ['Date','Event','Batch no','Owner','Main tag ID','Breed','Gender','Qty Female','Qty Male','Qty Total','Mass'];
  const LEGACY_HEADERS = ['Batch No','Main tag number','Entry Mass','Gender','Breed','Name','Mortality','Date','Mortality Report','Sold','Sale Batch','Sale date','Notes'];

  ok('the 2026 intake export is recognised',
     L._animalCsvLayout(INTAKE_HEADERS) === 'intake2026');
  ok('the legacy export is recognised',
     L._animalCsvLayout(LEGACY_HEADERS) === 'legacy');
  ok('and an unknown set is refused rather than guessed at',
     L._animalCsvLayout(['Foo', 'Bar']) === null,
     'guessing puts a mass in a tag column');
  ok('extra columns do not stop a file being recognised',
     L._animalCsvLayout([...INTAKE_HEADERS, 'Something New']) === 'intake2026',
     'identified by the columns unique to each, not by counting them');

  /* One real row from the file this was built for. */
  const INTAKE_ROW = {
    'Date': '2026-09-01', 'Event': 'New Intake', 'Batch no': '55396 - BEEFCOR',
    'Owner': 'SVC FARMING', 'Main tag ID': '26-09-36-205757', 'Breed': 'Brahman',
    'Gender': 'Male', 'Qty Female': '0', 'Qty Male': '1', 'Qty Total': '1', 'Mass': '270.4',
  };
  ok('the tag comes from Main tag ID',
     L._csvField(INTAKE_ROW, 'intake2026', 'tag') === '26-09-36-205757');
  ok('the entry mass comes from Mass',
     L._csvField(INTAKE_ROW, 'intake2026', 'mass') === '270.4');
  ok('and the batch number from Batch no',
     L._csvField(INTAKE_ROW, 'intake2026', 'batchNo') === '55396 - BEEFCOR');

  /* THE TRAP, stated as an assertion: the intake layout must have no path
     from `Date` to a mortality date. */
  ok('an intake file offers no mortality date at all',
     L._csvField(INTAKE_ROW, 'intake2026', 'mortDate') === '',
     'Date here is the arrival date; writing it as a mortality date marks ' +
     'every living animal in the file as dead');
  ok('and every row of an intake file is a live animal',
     L._animalStatusFromRow(INTAKE_ROW, 'intake2026') === 'active');

  const LEGACY_DEAD = { 'Main tag number': 'T1', 'Entry Mass': '200', 'Mortality': 'yes', 'Date': '2025-01-05' };
  const LEGACY_LIVE = { 'Main tag number': 'T2', 'Entry Mass': '200', 'Mortality': '',    'Date': '2025-01-05' };
  ok('the legacy layout still reads a mortality',
     L._animalStatusFromRow(LEGACY_DEAD, 'legacy') === 'mortality' &&
     L._csvField(LEGACY_DEAD, 'legacy', 'mortDate') === '2025-01-05');
  ok('and a live legacy row is live',
     L._animalStatusFromRow(LEGACY_LIVE, 'legacy') === 'active');
}

console.log('\nthe date is only written when the animal is dead');
{
  ok('mortality_date is conditional on the status',
     /mortality_date:\s*isMortality \? cleanDate\(_csvField\(r, layout, 'mortDate'\)\) : null/.test(CODE),
     'unconditional, it dated 129 living animals as dead');
  ok('and so is the sale date',
     /sale_date:\s*isSold \? cleanDate\(r\['Sale date'\]\) : null/.test(CODE));
}

console.log('\nthe operator chooses the batch');
{
  ok('the preview carries a cycle picker',
     /id="animalCycleSelect"/.test(CODE) && /Allocate these/.test(CODE));
  ok('it is defaulted from the file, not decided by it',
     /const guess = S\.cycles\.find/.test(CODE) && /Change it if that is wrong/.test(CODE));
  ok('leaving it unallocated is an explicit option',
     /Leave unallocated/.test(CODE),
     'and the note says Herd Reconciliation is where they get linked later');
  ok('the chosen id is sent with every record',
     /const cycleId = sel \? sel\.value \|\| null : null/.test(CODE) &&
     /cycle_id:\s*cycleId/.test(CODE));
  ok('and the animal takes the chosen batch\'s name',
     /batch_name:\s*\(cycle && cycle\.batch_name\) \|\| _csvField/.test(CODE),
     'rather than the raw text out of the file');
  ok('the server prefers an explicit id over matching on a name',
     /const cycleId   = r\.cycle_id \|\| \(batchName \? cycleByName\[batchName\.toLowerCase\(\)\] : null\) \|\| null/.test(ROUTE),
     'the name match is the fallback that left imports attached to nothing');
  ok('the file is read before the picker is drawn, so the list is current',
     /if \(!S\.cycles\.length\) \{ try \{ S\.cycles = await fetchAll\('cattle_cycles'\)/.test(CODE));
}

console.log('\nthe batch is searchable, not a list of 138 to scroll');
{
  ok('the picker is a search over the cycles',
     /id="animalCycleSearch"/.test(CODE) && /function _filterCyclePicker/.test(CODE) &&
     !/<select id="animalCycleSelect">/.test(CODE),
     "a native select's type-ahead matches from the first character, and every " +
     'batch here is called "Batch <number> - <company>"');

  ok('it searches the invoice number and the company, not just the name',
     /\[c\.batch_name, c\.inv_no, c\.company, c\.cycle_no, c\.id\]/.test(CODE),
     'the file names its batch "55396 - BEEFCOR" and 55396 is the INVOICE ' +
     'number on the cycle, not part of its name');

  ok('an exact hit ranks above a partial one',
     /if \(inv === term \|\| name === term\) return 0;/.test(CODE));

  ok('the chosen batch is still carried by an id the import reads',
     /<input type="hidden" id="animalCycleSelect"/.test(CODE) &&
     /function _pickCycle/.test(CODE) &&
     /const cycleId = sel \? sel\.value \|\| null : null/.test(CODE),
     'the import already read #animalCycleSelect — the picker had to keep that ' +
     'contract, not change it');

  ok('and it says what it is allocating to after a pick',
     /Allocating to <strong>/.test(CODE));

  ok('a long list is capped with a note rather than rendered whole',
     /hits\.slice\(0, 40\)/.test(CODE) && /narrow the search/.test(CODE));
  ok('and a search that matches nothing says so',
     /No batch matches/.test(CODE));
}

console.log('\nand the herd is asked about these tags before anything is written');
{
  ok('there is a read-only check',
     /router\.post\('\/animals\/check-tags', requireFund/.test(ROUTE) &&
     !/INSERT|UPDATE|DELETE/.test((ROUTE.match(/router\.post\('\/animals\/check-tags'[\s\S]*?\n\}\);/) || [''])[0]));

  ok('it runs from the preview, before the import',
     /_checkTagsAndRender\(tags\.filter\(Boolean\)\)/.test(CODE));

  ok('it separates the three kinds',
     /exact\.push\(hit\)/.test(ROUTE) && /near\.push\(/.test(ROUTE) &&
     /const withinFile = /.test(ROUTE));

  /* The distinction is only real because the import's dedup is an exact
     string match. If that ever became case-insensitive, `near` would stop
     being the dangerous one and this panel would be saying something false. */
  ok('the import\'s own dedup really is exact',
     /const existingSet = new Set\(existingTags\.map\(r => String\(r\.tag_number\)\)\)/.test(ROUTE) &&
     /!existingSet\.has\(String\(r\.tag_number\)\)/.test(ROUTE),
     'which is why a tag differing only by case or spacing is NOT skipped, and ' +
     'why the panel frames that kind as the severe one');

  ok('the panel says which batch already holds them',
     /import-dupes__batch/.test(CODE) && /byBatch/.test(CODE),
     'twelve tags in the batch being imported means the file was sent twice; ' +
     'twelve in a different batch means an animal is recorded in two places');

  ok('the headline counts distinct tags, not the sum of the lists',
     /const flagged = new Set\(\[/.test(CODE),
     'a tag can be both already on file and repeated within the file — adding ' +
     'the counts reported "131 of 129", which is arithmetically impossible');

  ok('a failed check does not read as a clean bill of health',
     /Could not check these tags against the herd/.test(CODE),
     'silence after a failure is indistinguishable from silence after a pass');

  ok('and a clean file says so explicitly',
     /All \$\{d\.checked\.toLocaleString\(\)\} tags are new/.test(CODE));
}

console.log('\nwhat the file does not say is said out loud');
{
  ok('rows with no tag are counted as skipped up front',
     /no tag number and will be skipped/.test(CODE));
  ok('duplicate tags within the file are named',
     /duplicate tag number/.test(CODE));
  ok('an unexpected Event is surfaced rather than assumed',
     /Events other than "New Intake"/.test(CODE),
     'the layout has no column that would carry a sale or a death');
  ok('and a quantity above one is flagged',
     /quantity above 1/.test(CODE),
     'one row is one animal — several head behind a single tag cannot be split');
}

/* ── Against the real route ─────────────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\n  (skipping the route half — DATABASE_URL not set)');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  const { Pool } = require('pg');
  const SSL = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL, max: 2 });
  pool.on('error', () => {});
  let server = null;

  const post = (port, url, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: url, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      res => { let b = ''; res.on('data', d => (b += d));
        res.on('end', () => { let j; try { j = JSON.parse(b); } catch (_) { j = { _raw: b.slice(0, 200) }; }
          resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); r.write(data); r.end();
  });

  try {
    const express  = require(path.join(ROOT, 'server', 'node_modules', 'express'));
    const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
    require.cache[authPath] = {
      id: authPath, filename: authPath, loaded: true, children: [], paths: [],
      exports: {
        requireAuth: (rq, _rs, next) => { rq.user = { id: 'CI-ADM', role: 'director' }; next(); },
        requireRole: () => (_rq, _rs, next) => next(),
      },
    };
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/cattle', require(path.join(ROOT, 'server', 'routes', 'cattle')));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;

    console.log('\nand the import lands where it was told to');
    await pool.query(`DELETE FROM cattle_animals WHERE tag_number LIKE 'CI-TAG-%'`);
    await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CI-CYC%'`);
    await pool.query(`
      INSERT INTO cattle_cycles (id, batch_name, status, no_purchased, no_live, purchase_value)
      VALUES ('CI-CYC1','Intake Target','active', 0, 0, 500000),
             ('CI-CYC2','Other Batch',  'active', 0, 0, 100000),
             ('CI-CYC3','Closed Batch', 'sold',   9, 0, 100000)`);

    const recs = n => Array.from({ length: n }, (_, i) => ({
      tag_number: `CI-TAG-${i}`, batch_no: '55396 - BEEFCOR', batch_name: 'Intake Target',
      cycle_id: 'CI-CYC1', entry_mass: 200 + i, exit_mass: null,
      gender: i % 2 ? 'Female' : 'Male', breed: 'Brahman',
      mortality: false, mortality_date: null, sold: false, sale_date: null, notes: '',
    }));

    const r1 = await post(port, '/api/cattle/import/animals', { records: recs(5) });
    ok('the animals import', r1.status === 200 && r1.body.inserted === 5, JSON.stringify(r1.body));

    const onBatch = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cattle_animals WHERE cycle_id = 'CI-CYC1'`);
    ok('all of them on the chosen batch', onBatch.rows[0].n === 5);

    const dated = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cattle_animals WHERE tag_number LIKE 'CI-TAG-%' AND mortality_date IS NOT NULL`);
    ok('and not one of them dated as dead', dated.rows[0].n === 0);

    const c1 = await pool.query(`SELECT no_purchased, no_live, mortalities FROM cattle_cycles WHERE id = 'CI-CYC1'`);
    ok('the batch header now says what it holds',
       c1.rows[0].no_purchased === 5 && c1.rows[0].no_live === 5,
       JSON.stringify(c1.rows[0]) + ' — a batch reading "0 purchased" beside its animals is valued at nothing');

    /* A second, partial import must not shrink the invoice figure. */
    await pool.query(`UPDATE cattle_cycles SET no_purchased = 120 WHERE id = 'CI-CYC1'`);
    await post(port, '/api/cattle/import/animals', {
      records: [{ tag_number: 'CI-TAG-99', batch_name: 'Intake Target', cycle_id: 'CI-CYC1',
                  entry_mass: 210, gender: 'Male', breed: 'Nguni', mortality: false, sold: false }] });
    const c2 = await pool.query(`SELECT no_purchased, no_live FROM cattle_cycles WHERE id = 'CI-CYC1'`);
    ok('a later partial import never shrinks no_purchased',
       c2.rows[0].no_purchased === 120 && c2.rows[0].no_live === 6,
       JSON.stringify(c2.rows[0]) + ' — that figure comes off the invoice, not off the file');

    /* A closed batch is a closed record. */
    await post(port, '/api/cattle/import/animals', {
      records: [{ tag_number: 'CI-TAG-CLOSED', batch_name: 'Closed Batch', cycle_id: 'CI-CYC3',
                  entry_mass: 200, gender: 'Male', breed: 'Nguni', mortality: false, sold: false }] });
    const c3 = await pool.query(`SELECT no_purchased, no_live FROM cattle_cycles WHERE id = 'CI-CYC3'`);
    ok('importing into a sold batch leaves its figures alone',
       c3.rows[0].no_purchased === 9 && c3.rows[0].no_live === 0,
       JSON.stringify(c3.rows[0]));

    /* The explicit id beats the name. */
    await post(port, '/api/cattle/import/animals', {
      records: [{ tag_number: 'CI-TAG-XREF', batch_name: 'Other Batch', cycle_id: 'CI-CYC1',
                  entry_mass: 200, gender: 'Male', breed: 'Nguni', mortality: false, sold: false }] });
    const xref = await pool.query(`SELECT cycle_id FROM cattle_animals WHERE tag_number = 'CI-TAG-XREF'`);
    ok('an explicit cycle_id wins over the batch name in the file',
       xref.rows[0].cycle_id === 'CI-CYC1',
       'the name match is the fallback, not the rule');

    /* ── The three kinds of tag collision, over real rows ─────────────── */
    console.log('\nand the check tells them apart');
    await pool.query(`DELETE FROM cattle_animals WHERE tag_number LIKE 'CT-%'`);
    await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CT-CYC%'`);
    await pool.query(`
      INSERT INTO cattle_cycles (id, batch_name, status, no_purchased, no_live, purchase_value)
      VALUES ('CT-CYC1','Home Batch','active', 0, 0, 1),
             ('CT-CYC2','Somewhere Else','active', 0, 0, 1)`);
    await pool.query(`
      INSERT INTO cattle_animals (id, cycle_id, tag_number, status, sold, mortality)
      VALUES ('CT-A1','CT-CYC1','CT-SAME','active',false,false),
             ('CT-A2','CT-CYC2','CT-ELSEWHERE','active',false,false),
             ('CT-A3','CT-CYC1','ct-case ','active',false,false)`);

    const chk = await post(port, '/api/cattle/animals/check-tags', {
      tags: ['CT-SAME', 'CT-ELSEWHERE', 'CT-CASE', 'CT-BRAND-NEW', 'CT-TWICE', 'CT-TWICE'],
    });
    ok('the check answers', chk.status === 200, JSON.stringify(chk.body).slice(0, 160));
    const b = chk.body || {};
    const exactTags = (b.exact || []).map(h => h.tag_number).sort();
    ok('a tag already on file comes back exact',
       exactTags.join(',') === 'CT-ELSEWHERE,CT-SAME', exactTags.join(','));
    ok('and it names the batch that holds it',
       (b.exact || []).find(h => h.tag_number === 'CT-ELSEWHERE')?.batch_name === 'Somewhere Else',
       'an animal recorded in a different batch is counted twice by the herd valuation');

    /* The one the import will NOT skip: 'ct-case ' on file, 'CT-CASE' in the
       file. Different strings, same animal. */
    ok('a tag differing only by case and spacing comes back as near, not exact',
       (b.near || []).length === 1 &&
       b.near[0].tag_number === 'ct-case ' && b.near[0].in_file_as === 'CT-CASE',
       JSON.stringify(b.near));
    ok('and it is NOT in the exact list, because the import will not skip it',
       !exactTags.includes('CT-CASE'));

    ok('a tag repeated inside the file is reported on its own',
       (b.withinFile || []).length === 1 &&
       b.withinFile[0].tag_number === 'CT-TWICE' && b.withinFile[0].count === 2,
       JSON.stringify(b.withinFile));
    ok('a genuinely new tag is in none of the three',
       !exactTags.includes('CT-BRAND-NEW') &&
       !(b.near || []).some(h => h.in_file_as === 'CT-BRAND-NEW') &&
       !(b.withinFile || []).some(t => t.tag_number === 'CT-BRAND-NEW'));

    /* And the claim the panel makes about `near` is true of the importer. */
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM cattle_animals WHERE cycle_id = 'CT-CYC1'`);
    await post(port, '/api/cattle/import/animals', {
      records: [{ tag_number: 'CT-CASE', batch_name: 'Home Batch', cycle_id: 'CT-CYC1',
                  entry_mass: 200, gender: 'Male', breed: 'Nguni', mortality: false, sold: false }] });
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM cattle_animals WHERE cycle_id = 'CT-CYC1'`);
    ok('the import really does let a near-miss through as a second record',
       after.rows[0].n === before.rows[0].n + 1,
       'if this ever stops being true the panel is telling the operator ' +
       'something false, and the severe framing has to go');

    const empty = await post(port, '/api/cattle/animals/check-tags', { tags: [] });
    ok('an empty request is answered rather than refused',
       empty.status === 200 && empty.body.checked === 0);

    await pool.query(`DELETE FROM cattle_animals WHERE tag_number LIKE 'CT-%' OR tag_number LIKE 'ct-%'`);
    await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CT-CYC%'`);

    await pool.query(`DELETE FROM cattle_animals WHERE tag_number LIKE 'CI-TAG-%'`);
    await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CI-CYC%'`);
  } catch (err) {
    fail++;
    console.log(`  ✗ threw: ${err.message}\n      ${String(err.stack || '').split('\n')[1] || ''}`);
  } finally {
    if (server) server.close();
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
