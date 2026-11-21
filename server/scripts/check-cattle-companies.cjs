#!/usr/bin/env node
/* Whose cattle are whose.
 *
 * A batch (cattle_cycles) carries ONE company. Some batches hold cattle
 * belonging to more than one, and there was nowhere to record it — the
 * header said one thing and the herd was two, so "how many head does this
 * company own" could not be answered from the platform at all.
 *
 * THE DEFINITION IS COALESCE(animal, batch). An animal belongs to its
 * batch's company unless it has been allocated away. That is what is
 * already true of every row in the table, which is why nothing needed
 * backfilling and why a single-owner batch keeps working untouched.
 *
 * ALLOCATION IS A TOTAL, NOT AN INCREMENT, and that is the assertion that
 * matters most here: "Company A owns 120 head of this batch" sent twice
 * leaves 120. An add-120 button pressed twice by somebody unsure whether
 * the first press landed is how a batch ends up owning more cattle than it
 * has.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-companies.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const SVC = require(path.join(ROOT, 'server', 'services', 'cattleCompanies.js'));

console.log('\nan animal belongs to its batch unless it has been allocated away');
{
  ok('a plain animal answers to its batch',
     SVC.ownerOf({ company: null }, { company: 'Beefcor' }) === 'Beefcor',
     'that is what is already true of every row, so nothing needed a backfill');
  ok('an allocated one answers to itself',
     SVC.ownerOf({ company: 'Grain Co' }, { company: 'Beefcor' }) === 'Grain Co');
  ok('and an empty string is not an allocation',
     SVC.ownerOf({ company: '   ' }, { company: 'Beefcor' }) === 'Beefcor',
     'a blank typed into a box must not quietly become a company');
  ok('THE SQL SAYS THE SAME THING',
     /COALESCE\(NULLIF\(a\.company, ''\), c\.company\)/.test(SVC.OWNER_SQL()),
     'the rollup, the split and the mixed list all read this — three '
     + 'answers to "whose animal is this" is how they disagree');
}

console.log('\nand a mixed batch is one whose animals disagree, not one whose header does');
{
  ok('one company is not mixed',
     !SVC.isMixed([{ company: 'Beefcor', head: 10 }]));
  ok('two are', SVC.isMixed([{ company: 'Beefcor', head: 10 }, { company: 'Grain Co', head: 5 }]));
  const SRC = strip(read('server/services/cattleCompanies.js'));
  ok('and the list of mixed batches comes from the animals',
     /HAVING COUNT\(DISTINCT \$\{OWNER_SQL\(\)\}\) > 1/.test(SRC)
     || /COUNT\(DISTINCT COALESCE/.test(SRC),
     'the header carries exactly one company by construction, so it is '
     + 'never the thing that is mixed');
}

console.log('\nand the console reads the split rather than the header');
{
  const UI = strip(read('fund/js/cattle.js'));
  ok('the batch detail asks for the split',
     /cattle\/cycles\/\$\{encodeURIComponent\(cycleId\)\}\/companies/.test(UI), 'fund/js/cattle.js');
  ok('and sets an allocation with PUT, not POST',
     /apiPut\(`cattle\/cycles/.test(UI),
     'POST reads as "add one more"; this sets a total');
  ok('the MIXED badge comes from the fetched list, not from the header',
     /S\.mixedCycles && S\.mixedCycles\.has\(cycle\.id\)/.test(UI), 'fund/js/cattle.js');
  ok('and it is fetched once for the whole list',
     /loadCompanyRollup/.test(UI) && !/cycles\.map[\s\S]{0,200}?companies`\)/.test(UI),
     'a card that asks per batch is a query per card');
  /* The redraw exists to put the badges on; fetching again from inside it
     is how that becomes a loop. */
  ok('and the redraw does not refetch',
     /if \(!isRedraw\) loadCompanyRollup\(\);/.test(UI), 'fund/js/cattle.js');
  ok('the panel explains that setting is a total',
     /TOTAL, not an addition/.test(read('fund/js/cattle.js')),
     'somebody who reads it as "add" will press it twice');
}

console.log('\nand the column exists for databases that predate it');
{
  const SETUP = read('server/db/setup.js');
  ok('company is on the animal', /ALTER TABLE cattle_animals ADD COLUMN IF NOT EXISTS company\s+TEXT/.test(SETUP),
     'server/db/setup.js');
  ok('with when it was set', /company_set_at TIMESTAMPTZ/.test(SETUP), 'server/db/setup.js');
  ok('and only the allocated ones are indexed',
     /cattle_animals_company_idx[\s\S]{0,120}WHERE company IS NOT NULL/.test(SETUP),
     'the rest answer through their batch and never need the lookup');
}

if (!process.env.DATABASE_URL) {
  console.log('\n  SKIP  the rest needs DATABASE_URL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    const { rows: [r] } = await db.query(
      `SELECT to_regclass('public.cattle_animals') IS NOT NULL AS ready`);
    if (!r.ready) { console.log('\n  SKIP  no cattle tables in this database'); return; }
    await db.query(`ALTER TABLE cattle_animals ADD COLUMN IF NOT EXISTS company TEXT`);
    await db.query(`ALTER TABLE cattle_animals ADD COLUMN IF NOT EXISTS company_set_at TIMESTAMPTZ`);

    const clean = async () => {
      await db.query(`DELETE FROM cattle_animals WHERE cycle_id LIKE 'CC-OWN-%'`);
      await db.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CC-OWN-%'`);
    };
    await clean();

    await db.query(
      `INSERT INTO cattle_cycles (id, batch_name, company, status, no_purchased, avg_cattle_cost)
       VALUES ('CC-OWN-1','Batch One','Beefcor','active',10,12000),
              ('CC-OWN-2','Batch Two','Grain Co','active',4,9000)`);
    /* Tags out of order on purpose: the picker is meant to work in tag
       order, not insertion order. */
    for (let i = 10; i >= 1; i--) {
      await db.query(
        `INSERT INTO cattle_animals (id, tag_number, cycle_id, status)
         VALUES ($1, $2, 'CC-OWN-1', 'active')`, [`CA-OWN-1-${i}`, String(1000 + i)]);
    }
    for (let i = 1; i <= 4; i++) {
      await db.query(
        `INSERT INTO cattle_animals (id, tag_number, cycle_id, status, sold, sale_value)
         VALUES ($1, $2, 'CC-OWN-2', 'sold', true, 15000)`, [`CA-OWN-2-${i}`, String(2000 + i)]);
    }

    console.log('\na batch with one owner needs no allocation at all');
    {
      const split = await SVC.splitFor(db, 'CC-OWN-1');
      ok('every animal already answers to the batch',
         split.length === 1 && split[0].company === 'Beefcor' && split[0].head === 10,
         JSON.stringify(split));
      ok('and none of them is stamped', split[0].allocated === 0, String(split[0].allocated));
      ok('so it is not mixed', !SVC.isMixed(split));
    }

    console.log('\nand allocating moves exactly as many head as asked for');
    {
      const out = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 3);
      ok('it reports what it did', out.moved === 3 && out.now === 3, JSON.stringify(out));
      const split = await SVC.splitFor(db, 'CC-OWN-1');
      const grain = split.find(s => s.company === 'Grain Co');
      const beef  = split.find(s => s.company === 'Beefcor');
      ok('THREE HEAD MOVED AND SEVEN STAYED',
         grain && grain.head === 3 && beef && beef.head === 7, JSON.stringify(split));
      ok('and the batch is now mixed', SVC.isMixed(split));
      ok('and the total is unchanged',
         split.reduce((n, s) => n + s.head, 0) === 10,
         'allocating must move cattle, never create them');

      const { rows } = await db.query(
        `SELECT tag_number FROM cattle_animals
          WHERE cycle_id = 'CC-OWN-1' AND company = 'Grain Co' ORDER BY tag_number`);
      ok('the animals are chosen in TAG order, not insertion order',
         rows.map(x => x.tag_number).join(',') === '1001,1002,1003',
         rows.map(x => x.tag_number).join(',')
         + ' — which tags is arbitrary, but it has to be repeatable and listable');
    }

    console.log('\nAND SETTING IT AGAIN DOES NOT ALLOCATE AGAIN');
    {
      const again = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 3);
      ok('nothing moves', again.moved === 0 && again.released === 0, JSON.stringify(again));
      const split = await SVC.splitFor(db, 'CC-OWN-1');
      ok('and it is still three',
         split.find(s => s.company === 'Grain Co').head === 3,
         JSON.stringify(split)
         + ' — an add-N button pressed twice is how a batch owns more cattle than it has');
    }

    console.log('\nand lowering it gives them back');
    {
      const down = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 1);
      ok('two are released', down.released === 2 && down.now === 1, JSON.stringify(down));
      const { rows } = await db.query(
        `SELECT tag_number FROM cattle_animals
          WHERE cycle_id = 'CC-OWN-1' AND company = 'Grain Co'`);
      ok('AND THE ONES RELEASED ARE THE ONES LAST GIVEN',
         rows.length === 1 && rows[0].tag_number === '1001',
         JSON.stringify(rows.map(x => x.tag_number))
         + ' — releasing should hand back what you just allocated, not a different set');
      const zero = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 0);
      ok('and zero releases the rest', zero.released === 1 && zero.now === 0, JSON.stringify(zero));
      const split = await SVC.splitFor(db, 'CC-OWN-1');
      ok('leaving the batch with one owner again',
         split.length === 1 && split[0].head === 10, JSON.stringify(split));
    }

    console.log('\nand it refuses what it cannot do');
    {
      const over = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 11);
      ok('MORE HEAD THAN THE BATCH HAS IS REFUSED', over.status === 409, JSON.stringify(over));
      ok('and the refusal counts them', /only 10 head/.test(over.error || ''), over.error);

      const own = await SVC.setAllocation(db, 'CC-OWN-1', 'Beefcor', 4);
      ok('allocating to the batch\'s own company is refused', own.status === 400, JSON.stringify(own));
      ok('and says why', /already counted against it/.test(own.error || ''), own.error);

      const nameless = await SVC.setAllocation(db, 'CC-OWN-1', '  ', 2);
      ok('a blank company is refused', nameless.status === 400, JSON.stringify(nameless));
      const fractional = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 2.5);
      ok('and half an animal is refused', fractional.status === 400, JSON.stringify(fractional));
      const negative = await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', -1);
      ok('and a negative count is refused', negative.status === 400, JSON.stringify(negative));
      const nobody = await SVC.setAllocation(db, 'CC-OWN-NONE', 'Grain Co', 1);
      ok('and a batch that does not exist is refused', nobody.status === 404, JSON.stringify(nobody));

      const split = await SVC.splitFor(db, 'CC-OWN-1');
      ok('AND NOT ONE OF THOSE MOVED AN ANIMAL',
         split.length === 1 && split[0].head === 10 && split[0].allocated === 0,
         JSON.stringify(split) + ' — every refusal happens before anything is written');
    }

    console.log('\nand a company\'s total is the sum of its animals, batch by batch');
    {
      await SVC.setAllocation(db, 'CC-OWN-1', 'Grain Co', 2);
      const all = await SVC.rollup(db);
      const grain = all.find(c => c.company === 'Grain Co');
      const beef  = all.find(c => c.company === 'Beefcor');

      ok('Grain Co holds its own batch and its share of the other',
         grain && grain.head === 6 && grain.batches === 2,
         JSON.stringify(grain) + ' — 4 of its own plus 2 allocated');
      ok('and Beefcor holds the rest of theirs',
         beef && beef.head === 8 && beef.batches === 1, JSON.stringify(beef));

      /* THE REASON THIS IS PER BATCH. Grain Co's two allocated head cost
         R12 000 each in Batch One; its own four cost R9 000. A blended
         average would price all six at one number and be wrong about both. */
      ok('PURCHASE VALUE IS SUMMED FROM EACH ANIMAL\'S OWN BATCH',
         grain && Math.abs(grain.purchaseValue - (2 * 12000 + 4 * 9000)) < 0.5,
         `${grain && grain.purchaseValue} — expected ${2 * 12000 + 4 * 9000}, not six head `
         + 'at a blended cost');
      ok('and realised value counts only what was sold',
         grain && Math.abs(grain.realisedValue - 4 * 15000) < 0.5,
         String(grain && grain.realisedValue));
      ok('while the batch that sold nothing has realised nothing',
         beef && beef.realisedValue === 0, String(beef && beef.realisedValue));

      const mixed = await SVC.mixedCycleIds(db);
      ok('and the mixed batch is named', mixed.includes('CC-OWN-1'), JSON.stringify(mixed));
      ok('while the single-owner one is not', !mixed.includes('CC-OWN-2'), JSON.stringify(mixed));

      const names = await SVC.known(db);
      ok('and both companies are offered to the console',
         names.includes('Beefcor') && names.includes('Grain Co'), JSON.stringify(names));
    }

    await clean();
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
