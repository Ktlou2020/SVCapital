#!/usr/bin/env node
/* The cattle NAV must be one number, computed one way.
 *
 * It was two. The Fund Ops dashboard showed a headline "Unrealised Gain" of
 * herdValue − purchaseValue, and directly beneath it a table of active cycles
 * whose gain column was herdValue − purchaseValue − feed − standing fees. The
 * difference is the entire carry cost of the herd: on a hundred head over four
 * months at the console's own R28/day assumption, R336 000 of disagreement
 * between two figures on one screen, either of which a director might quote.
 *
 * Three more, in the same engine:
 *
 *   THE COST LEDGER WAS IGNORED. Carry came from a per-day assumption, always,
 *   so a cycle could hold a season of real feed invoices and the valuation
 *   would not move by a rand. (It could hold none, in fact — every cost entry
 *   failed to save. That is fixed separately; this is the half that would still
 *   have ignored them.)
 *
 *   THE REALISED RETURN WAS AN UNWEIGHTED MEAN of the per-cycle percentages.
 *   R10 000 at 20% and R500 000 at 2% averaged to 11% — a return no rand in
 *   the fund earned.
 *
 *   EVERY ANIMAL WAS VALUED AT 30 DAYS, hardcoded, whatever its cycle.
 *
 * The engine is lifted out of the shipped file and run, rather than read: the
 * defect here was never in one line, it was in two correct-looking lines
 * disagreeing, and only arithmetic shows that.
 *
 * Run: node scripts/check-cattle-nav.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'fund', 'js', 'cattle.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'fund', 'cattle.html'), 'utf8');

/* Source with the comments blanked out, for the scans that assert something is
   ABSENT. Those comments explain the defects by quoting the code that caused
   them — `loadCattleView()`, `id="cf_status"` — so a raw scan finds the fix's
   own description and reports the bug as still present. Newlines are kept so
   any line number in a failure still points at the right place. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b, tol = 0.5) => Math.abs(a - b) < tol;

/* Pull `const NAV = { … };` out of the shipped file, brace-matched. */
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

const ctx = { S: { navSettings: {}, cycles: [], allAnimals: [], costs: [] }, console };
vm.createContext(ctx);
/* `const NAV = …` inside a vm script is a LEXICAL binding, not a property of
   the context's global — reading ctx.NAV afterwards gives undefined, and the
   whole arithmetic section below is skipped in silence. The count at the
   bottom is what caught it, so the count is asserted too. */
try { vm.runInContext(sliceObject('NAV') + '\nthis.NAV = NAV;', ctx); }
catch (err) { ok('the NAV engine could be extracted and run', false, err.message); }
const NAV = ctx.NAV;
ok('the NAV engine was extracted and is runnable', !!NAV && typeof NAV.cycleNAV === 'function',
   'without this every arithmetic assertion below is skipped rather than failed');

const SETTINGS = {
  live_cattle_price_per_kg: 40,
  avg_daily_weight_gain_kg: 1,
  feedlot_cost_per_day_per_head: 28,
  svc_standing_fee_per_day_per_head: 3.5,
};

/* A cycle 100 days old: 100 head bought for R1 000 000, all still alive,
   entering at 200kg. */
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const CYCLE = {
  id: 'C1', status: 'active', cycle_start_date: daysAgo(100),
  no_purchased: 100, no_live: 100, no_sold: 0, mortalities: 0,
  purchase_value: 1000000, net_return_pct: 0,
};
const HERD = Array.from({ length: 100 }, (_, i) => ({ id: `A${i}`, cycle_id: 'C1', entry_mass: 200 }));

if (NAV) {
  ctx.S.navSettings = { ...SETTINGS };

  console.log('\nthe headline and the rows describe one book');
  {
    const cycle = NAV.cycleNAV(CYCLE, HERD, []);
    const port  = NAV.portfolioNAV([CYCLE], HERD, []);

    /* 100 head × (200 + 1×100)kg × R40 = R1 200 000 */
    ok('the herd value is the live count at its estimated mass',
       near(cycle.herdValue, 1200000), String(cycle.herdValue));

    /* 100 head × 100 days × (28 + 3.50) = R315 000 */
    ok('carry is charged for every head, every day', near(cycle.carryCosts, 315000),
       String(cycle.carryCosts));

    ok('the cycle NAV is the herd less purchase AND carry',
       near(cycle.nav, 1200000 - 1000000 - 315000), String(cycle.nav));

    ok('THE PORTFOLIO NAV IS THE SUM OF THE CYCLE NAVs',
       near(port.portNAV, cycle.nav),
       `portfolio ${port.portNAV} vs cycle ${cycle.nav} — a gap here is the carry cost ` +
       'the headline drops and the rows beneath it deduct');

    ok('so the headline gain and the row gain agree',
       near(port.portNAV, cycle.nav) && port.portNAV < 0,
       'this cycle is under water once the feed bill is counted, and both must say so');

    ok('and the carry it dropped is reported in its own right',
       near(port.totalCarryCosts, 315000), String(port.totalCarryCosts));
  }

  console.log('\nrecorded invoices beat the assumption');
  {
    const costs = [
      { cycle_id: 'C1', category: 'feed',      amount: 240000 },
      { cycle_id: 'C1', category: 'vet',       amount: 15000  },
      { cycle_id: 'C1', category: 'transport', amount: 9000   },
      { cycle_id: 'C2', category: 'feed',      amount: 999999 },  // another cycle's
    ];
    const withCosts = NAV.cycleNAV(CYCLE, HERD, costs);
    ok('a cycle with invoices is valued against them, not the model',
       near(withCosts.carryCosts, 264000) && withCosts.costSource === 'actual',
       `${withCosts.carryCosts} / ${withCosts.costSource}`);
    ok("and not against another cycle's invoices", near(withCosts.carryCosts, 264000));

    /* Purchase cost booked to the ledger as well must not be counted twice —
       it is already in purchase_value. */
    const dbl = NAV.cycleNAV(CYCLE, HERD,
      costs.concat([{ cycle_id: 'C1', category: 'purchase', amount: 1000000 }]));
    ok('a purchase booked to the ledger is not charged twice',
       near(dbl.totalCosts, withCosts.totalCosts),
       `${dbl.totalCosts} vs ${withCosts.totalCosts} — purchase_value already carries it`);

    const none = NAV.cycleNAV(CYCLE, HERD, []);
    ok('a cycle with no invoices falls back to the model, and says so',
       none.costSource === 'modelled', none.costSource);
  }

  console.log('\nthe realised return is what the capital earned');
  {
    const sold = [
      { id: 'S1', status: 'sold', purchase_value: 10000,  total_selling_price: 12000,  net_return_pct: 20, no_sold: 5 },
      { id: 'S2', status: 'sold', purchase_value: 500000, total_selling_price: 510000, net_return_pct: 2,  no_sold: 100 },
    ];
    const p = NAV.portfolioNAV(sold, [], []);
    /* (10 000×20 + 500 000×2) / 510 000 = 2.35% */
    ok('two cycles of very different size are weighted by their capital',
       near(p.totalReturnPct, 2.3529, 0.01),
       `${p.totalReturnPct} — the mean of the percentages is 11%, which no rand earned`);
    ok('and the rand return is the sale less the cost',
       near(p.totalReturn, 12000), String(p.totalReturn));

    /* A cycle with no cost basis is not a nil return. */
    const partial = NAV.portfolioNAV(
      sold.concat([{ id: 'S3', status: 'sold', purchase_value: 0, net_return_pct: 0, total_selling_price: 0 }]), [], []);
    ok('a sold cycle with no purchase value recorded is excluded, not counted as zero',
       near(partial.totalReturnPct, 2.3529, 0.01) && partial.returnBasis === 'partial',
       `${partial.totalReturnPct} / ${partial.returnBasis}`);
  }

  console.log('\nan animal is valued at its own age, and at its own weight');
  {
    const young = NAV.animalNAV({ entry_mass: 200 }, 10);
    const old   = NAV.animalNAV({ entry_mass: 200 }, 200);
    ok('an animal on day 200 is worth more than one on day 10',
       old.estMass > young.estMass,
       `${young.estMass} vs ${old.estMass} — both were 30 days old to this function`);
    ok('and the difference is the modelled daily gain',
       near(old.estMass - young.estMass, 190), String(old.estMass - young.estMass));

    const weighed = NAV.animalNAV({ entry_mass: 200, exit_mass: 305 }, 200);
    ok('an animal that has been weighed out uses the scale, not the model',
       near(weighed.estMass, 305) && weighed.estimated === false,
       `${weighed.estMass} / estimated=${weighed.estimated}`);
    ok('and one that has not is flagged as an estimate',
       old.estimated === true);

    ok('daysIn on a cycle with no start date is zero, not NaN',
       NAV.daysIn({}) === 0 && NAV.daysIn(null) === 0 && NAV.daysIn({ cycle_start_date: 'banana' }) === 0);
  }

  console.log('\nthe herd NAV rests on animals, not on a default');
  {
    const measured = NAV.cycleNAV(CYCLE, HERD, []);
    const none     = NAV.cycleNAV(CYCLE, [], []);
    ok('a cycle with animals on file reports how many masses it averaged',
       measured.massKnown === 100, String(measured.massKnown));
    ok('and one with none reports zero rather than looking identical',
       none.massKnown === 0, String(none.massKnown));

    const weighedHerd = HERD.map((a, i) => i < 50 ? { ...a, exit_mass: 320 } : a);
    const w = NAV.cycleNAV(CYCLE, weighedHerd, []);
    ok('where animals have been weighed out, that is the herd average',
       near(w.estAvgMass, 320), String(w.estAvgMass));
  }
}

/* The page-versus-herd split that caused the same cycle to value three
   different ways depending on which tab had been visited first. */
console.log('\nNAV never reads the animals table\'s current page');
{
  ok('the state carries a full herd separate from the table page',
     /allAnimals:\s*\[\]/.test(SRC) && /animals:\s*\[\]/.test(SRC));
  ok('the animals table page is written to S.animals',
     /S\.animals\s*=\s*res\.data/.test(SRC));
  ok('and every cycleNAV call reads the full herd',
     !/cycleNAV\([^)]*S\.animals\b/.test(CODE),
     'a NAV computed over 75 filtered rows is not a NAV');
  ok('the dashboard aggregates over the full herd too',
     /portfolioNAV\(S\.cycles,\s*S\.allAnimals/.test(SRC));
  ok('the cycles tab loads the herd before valuing it',
     /async function loadCycles[\s\S]{0,400}_loadHerd\(/.test(SRC),
     'it used to load cycles only, and fall back to a hardcoded 220kg average');
  ok('no hardcoded 30-day valuation survives',
     !/animalNAV\(a,\s*30\)/.test(CODE));
}

console.log('\nthe cost ledger writes the columns the table actually has');
{
  ok('costs are saved as category, not cost_type',
     /category:\s*getV\('co_category'\)/.test(SRC));
  ok('as date, not cost_date', /date:\s*getV\('co_date'\)/.test(SRC));
  ok('as vendor, not supplier', /vendor:\s*getV\('co_vendor'\)/.test(SRC));
  ok('and cycle_name is not written at all',
     !/cycle_name:/.test(CODE),
     'the cycle owns its name; a copy on every cost row goes stale on rename');
  ok('the cost modal no longer shares an id with the cycle form',
     !/id="cf_status"/.test(CODE),
     'both forms had cf_status, so every cost was saved with the cycle form\'s status');
  ok('and cattle.html still has the cycle form\'s cf_status to collide with',
     /id="cf_status"/.test(HTML),
     'if this ever goes, the check above stops proving anything');
}

console.log('\nthe destructive paths');
{
  ok('the purge asks for a typed phrase',
     /prompt\(/.test(SRC) && /DELETE ALL CATTLE DATA/.test(SRC),
     'it was a confirm() reading "Type OK to confirm", with nothing to type into');
  ok('and sends it, so the server can refuse without it',
     /JSON\.stringify\(\{ confirm: PURGE_PHRASE \}\)/.test(SRC));
  ok('it no longer calls a function that does not exist',
     !/loadCattleView\(/.test(CODE),
     'the purge succeeded and then threw a ReferenceError instead of refreshing');
  ok('deleting a cycle handles the linked-animals refusal',
     /r\.status === 409/.test(SRC) && /orphan=1/.test(SRC));
}

console.log('\nthe reconciliation is reachable');
{
  ok('the sidebar offers it', /data-view="reconcile"/.test(HTML));
  ok('the page has somewhere to render it', /id="view-reconcile"/.test(HTML));
  ok('and a loader is wired to that view', /reconcile:\s*loadReconciliation/.test(SRC));
  ok('the cattle assets are cache-busted so the fix reaches the browser',
     /cattle\.js\?v=\d+/.test(HTML));
}

/* A silently skipped section reports "all passed". Pinning the total means a
   block that stops running is a failure rather than a shorter green list. */
const EXPECTED = 41;
ok(`all ${EXPECTED} assertions ran`, pass + fail === EXPECTED + 1,
   `${pass + fail - 1} ran — a section was skipped, or one was added without updating EXPECTED`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
