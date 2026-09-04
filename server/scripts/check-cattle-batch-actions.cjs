#!/usr/bin/env node
/* Bulk batch actions, and per-animal sale capture.
 *
 * THE ONE THAT COSTS MONEY. A sold cycle reports total_selling_price as its
 * realised value and (sale − purchase) ÷ purchase as its realised return. Mark
 * a batch sold with no figure and it books its entire purchase value as a
 * realised loss — and this is a BULK action over a list where every batch is
 * ticked by one click on a select-all. On the book that prompted this work,
 * 138 cycles carrying R110m, defaulting that field would have put a
 * nine-figure hole in the fund's reported return, produced by two clicks and
 * no typing. So the route refuses the action without a value per cycle, and
 * refuses it BEFORE the transaction opens, so a missing figure changes nothing.
 *
 * DISCONTINUED takes no value, by design: it is for batches that will never be
 * closed out properly — the stale imports sitting past a thousand days, still
 * accruing 1.2kg a day of modelled weight gain against animals nobody is
 * feeding. It freezes the cycle where it stands and leaves the book entirely:
 * counted in neither the active herd nor realised returns. Booking those as
 * sold-at-zero would be a fabricated loss; leaving them active is the runaway
 * valuation this exists to stop.
 *
 * REOPEN has one sharp edge. Discontinuing flags a batch's live animals sold;
 * reopening must release exactly those and no others. The animals it flagged
 * carry sale_batch 'DISC-<cycle id>', and without matching on that tag a
 * reopen would resurrect animals that were genuinely sold — by an import, or
 * by a real sale recorded one animal at a time.
 *
 * PER ANIMAL, the three fields that say what happened to a beast — status,
 * sold, mortality — are separate columns that have disagreed. Every write sets
 * all three together. A sale value belongs to a sold animal, so marking one
 * deceased clears it: money it did not fetch would otherwise be summed into
 * the batch's sale total.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-batch-actions.cjs
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

console.log('\nthe console can select batches, and selecting does not fight itself');
{
  ok('cards carry a checkbox and the list carries a bar',
     /class="cycle-pick"/.test(CODE) && /id="cycleBulkBar"/.test(CODE));

  /* The first version re-rendered the whole list on every tick. That detached
     every other checkbox mid-click, so the second box a user ticked did
     nothing and the count stuck at one — the feature, broken by a re-render
     nobody needed. Found by driving the page, not by reading it. */
  ok('ticking one box does not rebuild the list',
     /function toggleCycleSelected[\s\S]{0,500}_refreshCycleBulkBar\(\)/.test(CODE) &&
     !/function toggleCycleSelected\([^)]*\)\s*\{[^}]*renderCyclesView\(\)/.test(CODE),
     'rebuilding the list detaches the other checkboxes and multi-select stops working');

  ok('the bar and the card list agree on what is shown',
     /function _filteredCycles\(\)/.test(CODE) &&
     (CODE.match(/_filteredCycles\(\)/g) || []).length >= 3,
     'two copies of the filter would let the bar count one set and the list draw another');

  ok('an action only ever covers batches on screen',
     /_filteredCycles\(\)\.filter\(c => S\.cycleSel\.has\(c\.id\)/.test(CODE),
     'a selection made before a filter still exists — acting on the hidden ' +
     'part of it from a button labelled with a visible number is acting on ' +
     'batches the user is not looking at');
}

console.log('\na batch cannot be marked sold at nothing');
{
  ok('the dialog asks for a value per batch',
     /class="bulk-sold-row"/.test(CODE) && /Sale value/.test(CODE));
  /* The phrase is split by a ternary — `batch${n === 1 ? ' needs' : 'es need'}
     a sale value` — so asserting the sentence as one string finds nothing and
     fails against code that is correct. Match the half that is literal. */
  ok('and will not submit with one missing',
     /if \(missing\.length\)[\s\S]{0,300}return;/.test(CODE) &&
     /a sale value/i.test(CODE));
  ok('the return that will be written is shown as it is typed',
     /function _bulkSoldPreview/.test(CODE) && /\(sale - purchase\) \/ purchase/.test(CODE),
     'the number that goes into the book should not be a surprise');
  /* Scoped to this handler. The first BEGIN in the file belongs to bulkInsert,
     thousands of lines earlier, so comparing against it compared the guard
     with an unrelated transaction and failed on correct code. */
  const bulkHandler = (ROUTE.match(/router\.post\('\/cycles\/bulk-status'[\s\S]*?\n\}\);/) || [''])[0];
  ok('the route refuses it too, before the transaction opens',
     bulkHandler.length > 500 &&
     /error: 'sale_value_required'/.test(bulkHandler) &&
     bulkHandler.indexOf("sale_value_required") < bulkHandler.indexOf("await client.query('BEGIN')"),
     'client-side validation is a convenience; this is the guard');
}

console.log('\ndiscontinued is frozen, and out of the book');
{
  ok('it takes no sale value',
     /function bulkDiscontinueCycles[\s\S]{0,900}_bulkStatus\('discontinued'/.test(CODE) &&
     !/function bulkDiscontinueCycles[\s\S]{0,900}total_selling_price/.test(CODE));

  ok('the route leaves the cycle\'s own figures alone',
     /SET status = 'discontinued', updated_at = NOW\(\)/.test(ROUTE),
     'freezing means the numbers stay where they are; only the status moves');

  ok('portfolioNAV counts it in neither bucket',
     /const activeCycles = cycles\.filter\(c => c\.status === 'active'\)/.test(CODE) &&
     /const soldCycles   = cycles\.filter\(c => c\.status === 'sold'\)/.test(CODE) &&
     !/status !== 'sold'\s*\)\s*;?\s*\n\s*const soldCycles/.test(CODE),
     'widening active to "not sold" would put a batch nobody is feeding back ' +
     'into the herd value, still accruing 1.2kg a day');

  ok('the card stops showing a live valuation and a running day count',
     /const frozen = cycle\.status === 'discontinued'/.test(CODE) &&
     /frozen \? 'Frozen'/.test(CODE) &&
     /frozen \? ` &nbsp;·&nbsp; <strong>Frozen/.test(CODE),
     'a frozen batch showing "1 355 days in cycle" is the bug this status fixes');

  ok('and it is visible as its own thing, not just absent from two tiles',
     /Discontinued<\/div>/.test(CODE) && /value="discontinued"/.test(CODE),
     'without a tile and a filter it vanishes from Active and Sold while ' +
     'Total Cycles stays put, and the three stop adding up');
}

console.log('\nreopening releases only what discontinuing flagged');
{
  ok('discontinue tags the animals it flags',
     /sale_batch = \$2[\s\S]{0,200}`DISC-\$\{id\}`/.test(ROUTE) ||
     /\[id, `DISC-\$\{id\}`\]/.test(ROUTE));
  ok('and reopen matches on that tag',
     /AND sale_batch = \$2`, \[id, `DISC-\$\{id\}`\]/.test(ROUTE),
     'without the tag, reopening resurrects every sold animal in the batch');
  ok('discontinue never re-flags an animal already sold',
     /COALESCE\(sold, false\) = false/.test(ROUTE),
     'it would take over the sale_batch of a real sale, and a later reopen ' +
     'would then undo it');
}

console.log('\nper animal: the three fields that say what happened move together');
{
  ok('sold sets all three',
     /sets\.push\(`status = 'sold'`, `sold = true`, `mortality = false`/.test(ROUTE));
  ok('deceased sets all three',
     /sets\.push\(`status = 'mortality'`, `sold = false`, `mortality = true`\)/.test(ROUTE));
  ok('and a deceased animal keeps no sale value',
     /`status = 'mortality'`[\s\S]{0,300}`sale_value = NULL`/.test(ROUTE),
     'money it did not fetch would be summed into the batch total');
  ok('the parameters are built with the fragments, not counted by hand',
     /const P = v => \{ params\.push\(v\); return `\$\$\{params\.length\}`; \}/.test(ROUTE),
     'the first version counted $-placeholders by hand and lost step the ' +
     'moment exit_mass was optional — which writes a date into a numeric column');
  ok('the cycle\'s counts are recomputed from its animals',
     /SET no_live     = s\.live/.test(ROUTE) && /mortalities = s\.dead/.test(ROUTE));
  ok('but never for a closed batch',
     /AND c\.status NOT IN \('sold','discontinued'\)/.test(ROUTE),
     'a sold or frozen cycle is a closed record and must not start moving ' +
     'because one animal was corrected');
}

console.log('\nthe batch detail values the batch it is showing');
{
  /* The modal read S.animals — the animals TABLE's current page, 75 rows of
     whatever filter was last applied — so it valued a batch off animals
     belonging to other batches, or off none, in which case the average entry
     mass fell back to the settings default. The card and the modal showed
     R776 356 and R829 056 for the same 24-head batch. */
  ok('the detail modal no longer reads the animals table page',
     !/S\.animals\.filter\(a => a\.cycle_id/.test(CODE),
     'that is the table\'s current page, not this batch');
  ok('it values from the herd summary, like the card does',
     /const nav = NAV\.cycleNAV\(cycle, S\.herd\.cycles\[id\], S\.costs\)/.test(CODE));
  ok('and it lists the batch\'s own animals, fetched for it',
     /cattle\/cycles\/\$\{encodeURIComponent\(cycleId\)\}\/animals/.test(CODE) &&
     /router\.get\('\/cycles\/:id\/animals', requireFund/.test(ROUTE));
  ok('paged, because a batch can hold hundreds',
     /limit=200&offset=/.test(CODE) && /LIMIT \$2 OFFSET \$3/.test(ROUTE));
  ok('a row is patched in place rather than the page refetched',
     /st\.rows\[i\] = \{ \.\.\.st\.rows\[i\], \.\.\.r\.animal \}/.test(CODE),
     'losing your position after every animal is what makes a list like this ' +
     'unusable');
}

console.log('\nthe sale value has somewhere to live, and rolls up');
{
  ok('animals carry a sale value',
     /ALTER TABLE cattle_animals ADD COLUMN sale_value NUMERIC\(18,2\)/.test(read('server/db/setup.js')) &&
     /sale_value NUMERIC\(18,2\)/.test(read('server/db/setup.js')));
  ok('and the herd summary totals it per batch',
     /COALESCE\(SUM\(sale_value\), 0\)::float8\s+AS sale_sum/.test(ROUTE));
  ok('so the bulk dialog can offer it rather than ask for it blind',
     /sale_sum/.test(CODE) && /from animals sold/.test(CODE),
     'and it names the source on the row, so the operator knows whether they ' +
     'are confirming a fact or an estimate');
}

/* ── Against the real routes ──────────────────────────────────────────────
   The assertions above read source. These run the shipped handlers over real
   rows, because "the guard is written" and "the guard fires" are different
   claims — and this is the one where the difference is nine figures. */
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

  const req = (port, method, url, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      res => { let b = ''; res.on('data', d => (b += d));
        res.on('end', () => { let j; try { j = JSON.parse(b); } catch (_) { j = { _raw: b.slice(0, 200) }; }
          resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });

  try {
    const express  = require(path.join(ROOT, 'server', 'node_modules', 'express'));
    const authPath = require.resolve(path.join(ROOT, 'server', 'middleware', 'auth'));
    require.cache[authPath] = {
      id: authPath, filename: authPath, loaded: true, children: [], paths: [],
      exports: {
        requireAuth: (rq, _rs, next) => { rq.user = { id: 'CB-ADM', role: 'director' }; next(); },
        requireRole: () => (_rq, _rs, next) => next(),
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/cattle', require(path.join(ROOT, 'server', 'routes', 'cattle')));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;

    /* Two batches: one with animals, one with a sale already recorded. */
    await pool.query(`DELETE FROM cattle_animals WHERE cycle_id LIKE 'CB-%'`);
    await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CB-%'`);
    await pool.query(`
      INSERT INTO cattle_cycles (id, batch_name, status, no_purchased, no_live, mortalities, purchase_value, cycle_start_date)
      VALUES ('CB-1','Bulk One','active', 4, 4, 0, 100000, NOW() - INTERVAL '400 days'),
             ('CB-2','Bulk Two','active', 2, 2, 0,  50000, NOW() - INTERVAL '400 days')`);
    await pool.query(`
      INSERT INTO cattle_animals (id, cycle_id, tag_number, entry_mass, status, sold, mortality, sale_batch)
      VALUES ('CB-A1','CB-1','T1',200,'active',false,false,NULL),
             ('CB-A2','CB-1','T2',210,'active',false,false,NULL),
             ('CB-A3','CB-1','T3',220,'sold',  true, false,'REAL-SALE'),
             ('CB-A4','CB-1','T4',230,'active',false,false,NULL),
             ('CB-B1','CB-2','T5',205,'active',false,false,NULL),
             ('CB-B2','CB-2','T6',215,'active',false,false,NULL)`);

    console.log('\nand the guards actually fire');

    const noValue = await req(port, 'POST', '/api/cattle/cycles/bulk-status',
      { action: 'sold', cycles: [{ id: 'CB-1' }, { id: 'CB-2' }] });
    ok('marking sold with no value is refused',
       noValue.status === 400 && noValue.body.error === 'sale_value_required',
       JSON.stringify(noValue.body).slice(0, 160));
    const untouched = await pool.query(`SELECT status FROM cattle_cycles WHERE id IN ('CB-1','CB-2')`);
    ok('and nothing was changed by the attempt',
       untouched.rows.every(r => r.status === 'active'));

    const disc = await req(port, 'POST', '/api/cattle/cycles/bulk-status',
      { action: 'discontinued', cycles: [{ id: 'CB-1' }] });
    ok('discontinuing needs no value', disc.status === 200 && disc.body.cyclesChanged === 1,
       JSON.stringify(disc.body).slice(0, 160));
    const after = await pool.query(`SELECT status, no_live, no_purchased FROM cattle_cycles WHERE id = 'CB-1'`);
    ok('the cycle is frozen with its numbers intact',
       after.rows[0].status === 'discontinued' && after.rows[0].no_live === 4 && after.rows[0].no_purchased === 4,
       JSON.stringify(after.rows[0]));
    const flagged = await pool.query(
      `SELECT id, sale_batch FROM cattle_animals WHERE cycle_id = 'CB-1' ORDER BY id`);
    ok('its live animals are flagged, tagged to this discontinue',
       flagged.rows.filter(r => r.sale_batch === 'DISC-CB-1').length === 3);
    ok('and the one already sold keeps its own tag',
       flagged.rows.find(r => r.id === 'CB-A3').sale_batch === 'REAL-SALE',
       'taking it over would let a later reopen undo a real sale');

    const re = await req(port, 'POST', '/api/cattle/cycles/bulk-status',
      { action: 'reopen', cycles: [{ id: 'CB-1' }] });
    ok('reopening releases exactly the three it flagged',
       re.status === 200 && re.body.animalsChanged === 3, JSON.stringify(re.body).slice(0, 160));
    const stillSold = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cattle_animals WHERE cycle_id = 'CB-1' AND sold = true`);
    ok('and the genuinely-sold animal is still sold', stillSold.rows[0].n === 1);

    const sold = await req(port, 'POST', '/api/cattle/cycles/bulk-status',
      { action: 'sold', cycles: [{ id: 'CB-2', total_selling_price: 65000 }] });
    ok('marking sold with a value works', sold.status === 200 && sold.body.cyclesChanged === 1);
    const s2 = await pool.query(
      `SELECT status, total_selling_price, net_return_pct, no_live, no_sold FROM cattle_cycles WHERE id = 'CB-2'`);
    ok('and records the sale and the return it implies',
       s2.rows[0].status === 'sold' &&
       Number(s2.rows[0].total_selling_price) === 65000 &&
       Math.abs(Number(s2.rows[0].net_return_pct) - 30) < 0.001 &&
       s2.rows[0].no_live === 0,
       JSON.stringify(s2.rows[0]));

    /* Per animal. */
    const a1 = await req(port, 'PATCH', '/api/cattle/animals/CB-A1',
      { status: 'sold', sale_value: 9900, exit_mass: 470 });
    ok('an animal can be sold with a value and a weigh-out',
       a1.status === 200 && Number(a1.body.animal.sale_value) === 9900 &&
       Number(a1.body.animal.exit_mass) === 470, JSON.stringify(a1.body).slice(0, 200));

    const a2 = await req(port, 'PATCH', '/api/cattle/animals/CB-A1', { status: 'mortality' });
    ok('marking it deceased clears the sale value',
       a2.status === 200 && a2.body.animal.sale_value === null &&
       a2.body.animal.sold === false && a2.body.animal.mortality === true &&
       a2.body.animal.status === 'mortality', JSON.stringify(a2.body.animal));

    const a3 = await req(port, 'PATCH', '/api/cattle/animals/CB-A1', { status: 'active' });
    ok('and it can be set back to live',
       a3.status === 200 && a3.body.animal.status === 'active' &&
       a3.body.animal.sold === false && a3.body.animal.mortality === false);

    const bad = await req(port, 'PATCH', '/api/cattle/animals/CB-A1', { status: 'gone' });
    ok('an unknown status is refused', bad.status === 400);

    /* CB-2 is sold — a closed record. */
    const closed = await req(port, 'PATCH', '/api/cattle/animals/CB-B1', { status: 'mortality' });
    const cb2 = await pool.query(`SELECT no_live, mortalities FROM cattle_cycles WHERE id = 'CB-2'`);
    ok('correcting an animal does not move a closed batch\'s figures',
       closed.status === 200 && cb2.rows[0].no_live === 0 && cb2.rows[0].mortalities === 0,
       JSON.stringify(cb2.rows[0]));

    const summary = await req(port, 'GET', '/api/cattle/herd-summary');
    ok('the herd summary carries the per-batch sale total',
       summary.status === 200 && summary.body.cycles['CB-1'] &&
       'sale_sum' in summary.body.cycles['CB-1']);

    await pool.query(`DELETE FROM cattle_animals WHERE cycle_id LIKE 'CB-%'`);
    await pool.query(`DELETE FROM cattle_cycles  WHERE id LIKE 'CB-%'`);
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
