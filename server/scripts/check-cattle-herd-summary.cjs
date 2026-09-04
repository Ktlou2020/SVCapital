#!/usr/bin/env node
/* The cattle console must not download the herd to value it.
 *
 * It used to. _loadHerd walked cattle_animals through the generic table API a
 * hundred rows at a time, sequentially, then reduced twenty thousand rows in
 * the browser to about fifty numbers. Measured against a 20 000-head herd on
 * localhost, with no network latency at all:
 *
 *     210 requests · 8.7 MB · 4 598 ms      of which 4 424 ms was the animals
 *
 * On a real connection the two hundred sequential round trips cost more than
 * the transfer does, and none of it was necessary: cycleNAV reduces a cycle's
 * animals to four numbers — the entry and exit masses on file, as sums and
 * counts — and the dashboard wants a breed histogram and three totals. All of
 * it is GROUP BY. After:
 *
 *      11 requests · 0.29 MB ·   199 ms
 *
 * The same valuation, to the cent: 45 cycles and 17 portfolio fields compared
 * both ways over the same data, zero differences, R485 757 189.62 either way.
 *
 * Two things have to hold for that to stay true, and both are easy to undo by
 * accident:
 *
 *   1. Nothing in the console fetches cattle_animals in bulk again. It is one
 *      line to add back — `fetchAll('cattle_animals')` reads perfectly
 *      reasonably — and nothing would fail, it would just be slow again, and
 *      slow in a way that grows with every animal ever imported.
 *
 *   2. The arithmetic stays in one place. cycleNAV takes either a summary or
 *      an array; if the array branch ever computes something the summary
 *      branch does not, two callers get two valuations for one cycle.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-herd-summary.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC  = read('fund/js/cattle.js');
const ROUTE = read('server/routes/cattle.js');
/* Comments blanked, newlines kept, so a negative match cannot find the
   explanation of the fix and report the defect as still present. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
                .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

console.log('\nthe console does not walk the herd');
{
  ok('nothing bulk-fetches cattle_animals',
     !/fetchAll\(\s*['"]cattle_animals['"]/.test(CODE),
     'this is the line that cost 4.4 seconds and 200 requests');

  /* The Animals view is the one screen that genuinely needs rows, and it
     pages. Losing that would be the opposite mistake. */
  ok('the animals view still pages the table',
     /tables\/cattle_animals\?/.test(CODE) && /limit=\$\{|limit=/.test(CODE),
     'the one screen that lists individual animals must still be able to');

  ok('and it still asks the server for its filter-bar stats',
     /cattle\/animals\/stats/.test(CODE));

  ok('the three start-up reads run together',
     /await Promise\.all\(\[\s*\n?\s*fetchAll\('cattle_cycles'\),\s*\n?\s*fetchAll\('cattle_costs'\),\s*\n?\s*safeGet\('cattle\/herd-summary'\)/.test(CODE),
     'sequentially they were the console\'s whole start-up cost');
}

console.log('\nthe summary comes from the database');
{
  ok('there is a herd-summary route',
     /router\.get\('\/herd-summary', requireFund/.test(ROUTE),
     'requireFund, not requireAuth — herd valuation is fund-desk data');

  const handler = (ROUTE.match(/router\.get\('\/herd-summary'[\s\S]*?\n\}\);/) || [''])[0];
  ok('it groups per cycle rather than returning rows',
     /GROUP BY cycle_id/.test(handler) && !/SELECT \*/.test(handler));
  ok('it returns the four figures cycleNAV needs',
     ['entry_sum', 'entry_count', 'exit_sum', 'exit_count'].every(f => handler.includes(f)));
  ok('and the totals and breeds the dashboard draws',
     /AS total/.test(handler) && /AS sold/.test(handler) &&
     /AS mortalities/.test(handler) && /GROUP BY 1/.test(handler));
  ok('the breed histogram is ordered, so the top six really are the top six',
     /ORDER BY count DESC/.test(handler),
     'the chart takes six — unordered, they were whichever six sorted first');
  ok('the three queries run together',
     /await Promise\.all\(\[/.test(handler));

  /* GROUP BY cycle_id over the whole table is the one query that has to scale. */
  ok('cattle_animals is indexed on cycle_id',
     /CREATE INDEX IF NOT EXISTS cattle_animals_cycle_idx ON cattle_animals\(cycle_id\)/
       .test(read('server/db/setup.js')));
}

/* ── The arithmetic is the same either way ────────────────────────────────
   Not asserted by reading: the shipped engine is run, twice, over the same
   herd — once as rows and once as the summary the route would return. */
console.log('\nand a summary values a cycle exactly as its animals do');
{
  function sliceObject(name) {
    const at = SRC.indexOf(`const ${name} = {`);
    if (at < 0) throw new Error(`${name} not found`);
    let i = SRC.indexOf('{', at), depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    return SRC.slice(at, i + 1) + ';';
  }
  const ctx = {
    S: { navSettings: { live_cattle_price_per_kg: 42.5, avg_daily_weight_gain_kg: 1.2, default_entry_mass_kg: 220 } },
    console,
  };
  vm.createContext(ctx);
  let NAV = null;
  try { vm.runInContext(sliceObject('NAV') + '\nthis.NAV = NAV;', ctx); NAV = ctx.NAV; }
  catch (err) { ok('the NAV engine could be extracted and run', false, err.message); }
  ok('the NAV engine is runnable', !!NAV && typeof NAV.cycleNAV === 'function',
     'without this every comparison below is skipped rather than failed');

  if (NAV) {
    ok('it exposes the summary the route mirrors',
       typeof NAV.massSummary === 'function' && typeof NAV.byCycle === 'function');

    /* A herd with three shapes in it: weighed out, entry-only, and one with
       no mass recorded at all — which is the case that falls back to the
       settings default, and the one a naive summary gets wrong. */
    const HERD = [
      { cycle_id: 'C1', entry_mass: 210, exit_mass: 470 },
      { cycle_id: 'C1', entry_mass: 230, exit_mass: 490 },
      { cycle_id: 'C1', entry_mass: 220, exit_mass: null },
      { cycle_id: 'C1', entry_mass: null, exit_mass: null },
      { cycle_id: 'C2', entry_mass: 205, exit_mass: null },
    ];
    const CYCLES = [
      { id: 'C1', status: 'active', no_live: 400, no_purchased: 410, mortalities: 10,
        purchase_value: 1700000, cycle_start_date: '2026-01-05' },
      { id: 'C2', status: 'active', no_live: 300, no_purchased: 305, mortalities: 5,
        purchase_value: 1200000, cycle_start_date: '2026-03-01' },
      /* No animals on file at all — the settings-default path. */
      { id: 'C3', status: 'active', no_live: 100, no_purchased: 100, mortalities: 0,
        purchase_value: 400000, cycle_start_date: '2026-05-01' },
    ];
    const COSTS = [{ cycle_id: 'C1', amount: 90000, category: 'feed' }];

    const summaries = NAV.byCycle(HERD);
    let worst = 0, worstField = '';
    for (const cy of CYCLES) {
      const fromRows = NAV.cycleNAV(cy, HERD.filter(a => a.cycle_id === cy.id), COSTS);
      const fromAgg  = NAV.cycleNAV(cy, summaries[cy.id], COSTS);
      for (const f of Object.keys(fromRows)) {
        if (typeof fromRows[f] !== 'number') continue;
        const d = Math.abs(fromRows[f] - fromAgg[f]);
        if (d > worst) { worst = d; worstField = `${cy.id}.${f} ${fromRows[f]} vs ${fromAgg[f]}`; }
      }
    }
    ok('every cycle values identically from rows and from its summary',
       worst < 1e-9, worstField);

    /* Including the cycle with no animals at all, which must reach the
       settings default rather than divide by zero. */
    const empty = NAV.cycleNAV(CYCLES[2], summaries['C3'], COSTS);
    ok('a cycle with no animals on file falls back to the settings default',
       empty.massKnown === 0 && empty.avgEntryMass === 220 && isFinite(empty.herdValue),
       JSON.stringify({ massKnown: empty.massKnown, avgEntryMass: empty.avgEntryMass, herdValue: empty.herdValue }));

    const port1 = NAV.portfolioNAV(CYCLES, HERD, COSTS);
    const port2 = NAV.portfolioNAV(CYCLES, summaries, COSTS);
    const fields = Object.keys(port1).filter(f => typeof port1[f] === 'number');
    const bad = fields.filter(f => Math.abs(port1[f] - port2[f]) > 1e-9);
    ok('and the portfolio total agrees across every field',
       bad.length === 0, bad.map(f => `${f}: ${port1[f]} vs ${port2[f]}`).join(', '));

    /* massKnown is what tells the dashboard a valuation rests on weigh-in
       slips rather than on a default. Summarising must not lose it. */
    ok('the count a valuation rests on survives summarising',
       NAV.cycleNAV(CYCLES[0], summaries['C1'], COSTS).massKnown === 3,
       'three of C1\'s four animals have an entry mass on file');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
