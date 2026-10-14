#!/usr/bin/env node
/* Re-import one product's investments from a Firestore audit export.
 *
 * The console's importer (POST /api/migrate/run) read an investment's product
 * from `inv.product?.name`. In every audit export `product` is a PATH STRING —
 * "investmentProducts/xKQkwQMa0Hnj0dAmGsWH" — with no `name` on it, so that
 * expression is undefined and every migrated investment was written as
 * product_type 'other'. Nothing was lost; it was filed under the wrong
 * product, which on any screen that asks for one product looks exactly like a
 * missing investment. Both importers now resolve the id out of the path; this
 * script is for the rows already in the database.
 *
 * It does two different jobs, and keeps them apart on purpose:
 *
 *   - an investment in the export that is NOT in the database is inserted
 *   - an investment that IS there under the wrong product_type is RELABELLED
 *
 * Re-importing the second kind would do nothing (the id already exists) while
 * reporting success, which is how you end up believing a product is fixed when
 * it is not. So the survey separates them and each has its own flag.
 *
 * ── Modes, and only two of them write ─────────────────────────────────
 *
 *   (no flags)            Survey. Classifies every record in the export for
 *                         that product, prices each class, reconciles each
 *                         investor's total_invested. Changes nothing.
 *
 *   --apply               Inserts the records that are genuinely absent.
 *
 *   --fix-product-type    Relabels rows that exist under another product_type.
 *
 * Both write flags can be given together. Everything is one transaction, with
 * an audit row per investment and one for the run.
 *
 * What it will NOT do:
 *
 *   - invent a pool. An investment whose POOL-MIGR-… row is absent is
 *     reported and skipped: the rate, the maturity date and the term would
 *     all be guesses, and they are what a client is shown.
 *   - invent an investor. Same reason, and the foreign key would refuse it.
 *   - touch investors.total_invested. The original migration set that from the
 *     whole export, whether or not each investment insert then succeeded, so
 *     these amounts are very likely already in it and adding them again would
 *     double-count. The survey prints the arithmetic instead.
 *   - write transactions. This export holds investments only; the client's
 *     transaction list is fed from transactions.json and is a separate import.
 *
 * Run:
 *   DATABASE_URL="<url>" node server/scripts/reimport-product-investments.cjs \
 *     --file ~/AuditExport-investments.json --product solar
 *   … same, plus --apply
 *   … same, plus --apply --fix-product-type
 *
 * --product is the name the EXPORT uses. Where this platform calls that
 * product something else, name the live one with --as:
 *
 *   --product smme --as short_term
 *
 * And where one export product is several products here — the legacy
 * catalogue had three solar products, five, six and seven years, which this
 * platform keeps apart — name the type per legacy product id:
 *
 *   --product solar --map xKQkwQMa0Hnj0dAmGsWH=solar_7yr,SfpCxgJjP6i5GUz1JWYp=solar_6yr
 *
 * The survey suggests that line from the POOL NAMES when the file holds more
 * than one product id, and never acts on it: a name is precisely what the
 * maturity engine cannot see, so the suggestion has to be repeated back by
 * somebody who agrees with it.
 *
 * The product written is checked against the types already in the database
 * and an unknown one is refused, the same way the remap panel refuses one:
 * a product_type nothing else uses is a rollover that silently becomes a
 * wallet payout, and a product page that stays empty. --force-new-type
 * overrides it, and should be a deliberate answer to that refusal.
 */
'use strict';

/* The classification, the insert and the audit rows live in
   server/services/productReimport.js, which the admin console's Data Fixes
   panel calls too. This file is the command line over it: arguments in,
   printing out, and nothing of its own to drift. */

const path = require('path');
const fs   = require('fs');

const ARGV = process.argv.slice(2);
const flag = n => ARGV.includes(n);
const val  = n => { const i = ARGV.indexOf(n); return i > -1 ? (ARGV[i + 1] || '') : ''; };

const FILE        = val('--file');
const EXPORT_KEY  = val('--product');
/* What the export calls the product and what this platform calls it are not
   always the same word — the export says smme where the database says
   short_term. The file is filtered by the first and the rows written with the
   second. --map names a type per legacy product id where one export product
   is several here. */
const AS          = val('--as');
const MAP_SPEC    = val('--map');
const FORCE_TYPE  = flag('--force-new-type');
const APPLY       = flag('--apply');
const FIX_LABEL   = flag('--fix-product-type');
const ACTOR       = process.env.IMPORT_ACTOR || 'cli';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}
if (!FILE || !EXPORT_KEY) {
  console.error('Both --file <export.json> and --product <product_type> are required.');
  console.error('See the header of this file.');
  process.exit(2);
}

const svc = require(path.join(__dirname, '..', 'services', 'productReimport'));
const { money } = svc;
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 120000,
});

const LABELS = {
  'missing':              'absent from the database — to be inserted',
  'mislabelled':          'in the database as another product — to be relabelled',
  'mislabelled-other-id': 'the same investment under a different id, and another product',
  'present':              'already there with the right product — skipped',
  'present-other-id':     'already there under a different id, with the right product — skipped',
  'no-pool':              'blocked: its pool is not in the database',
  'no-investor':          'blocked: its investor is not in the database',
  'no-date':              'blocked: no investment date in the export',
};

async function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const s = await svc.survey(db, {
    records: raw, exportKey: EXPORT_KEY, as: AS, map: MAP_SPEC,
  });

  H(`${path.basename(FILE)} — ${s.file.total} investment record(s)`);
  Object.entries(s.file.byProduct).sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(6)}  ${t}`));

  if (s.empty) {
    console.log(`\nNothing in this file maps to product_type "${EXPORT_KEY}". Nothing to do.`);
    return;
  }

  console.log(`\n${s.plan.length} record(s) map to "${EXPORT_KEY}"` +
    (s.wanted.join() !== EXPORT_KEY ? `, to be written as ${s.wanted.map(t => `"${t}"`).join(' / ')}` : '') +
    (s.dropped ? ` · ${s.dropped} unusable (no _id or no account number)` : ''));
  if (Object.keys(s.map).length) {
    for (const t of s.wanted) {
      const xs = s.plan.filter(x => x.type === t);
      console.log(`  ${String(xs.length).padStart(6)}  ${t}  ← ` +
        [...new Set(xs.map(x => x.legacyId))].join(', '));
    }
  }

  if (s.unknown.length) {
    H(`${s.unknown.map(t => `"${t}"`).join(', ')} ${s.unknown.length > 1 ? 'are' : 'is'} not a product type this database uses`);
    console.log(`  In use: ${s.known.join(', ') || '(none)'}`);
    console.log(`\n  The export calls it "${EXPORT_KEY}". If this platform calls it something`);
    console.log('  else, name the live one with --as, e.g. --product smme --as short_term.');
    if (!FORCE_TYPE) {
      console.log('\n  Nothing was read further and nothing was written.');
      console.log('  --force-new-type proceeds anyway, if the type really is new.');
      process.exitCode = 2;
      return;
    }
    console.log('\n  --force-new-type given — carrying on with a type nothing else uses.');
  }

  if (s.suggestion.length) {
    H(`"${EXPORT_KEY}" is ${s.suggestion.length} products in the export, not one`);
    const line = [];
    for (const g of s.suggestion) {
      console.log(`  ${g.legacyId}  ${String(g.records).padStart(3)} record(s)`);
      console.log(`      pools: ${g.poolNames.join(' · ') || '(none of its pools are in the database)'}`);
      if (g.guessKnown) { console.log(`      → looks like "${g.guess}"`); line.push(`${g.legacyId}=${g.guess}`); }
      else console.log(`      → nothing suggests itself${g.guess ? ` ("${g.guess}" is not a product type here)` : ''}`);
    }
    if (line.length) {
      console.log('\n  Read off the pool NAMES, which is what the engine cannot see. Nothing');
      console.log('  below is applied unless you repeat it back:');
      console.log(`\n    --map ${line.join(',')}\n`);
    }
    console.log(`  Without --map every one of them is written as "${s.product}".`);
  }

  const of  = v => s.plan.filter(x => x.verdict === v);
  const sum = xs => xs.reduce((a, x) => a + x.amount, 0);

  H('Where each record stands');
  for (const [v, label] of Object.entries(LABELS)) {
    const xs = of(v);
    if (xs.length) console.log(`  ${String(xs.length).padStart(4)}  ${money(sum(xs)).padStart(16)}  ${label}`);
  }

  for (const v of ['missing', 'mislabelled', 'mislabelled-other-id', 'no-pool', 'no-investor', 'no-date']) {
    const xs = of(v);
    if (!xs.length) continue;
    H(LABELS[v]);
    for (const x of xs) {
      console.log(`  ${x.investor.padEnd(16)} ${money(x.amount).padStart(14)}  ` +
        `${x.start ? new Date(x.start).toISOString().slice(0, 10) : '(no date)'}  ` +
        `${x.txRef || '-'}  ${x.investorName || '(not in the database)'}`);
      if (v === 'missing') {
        console.log(`      → ${x.id} as "${x.type}"  pool ${x.poolId} "${x.pool.name}" ` +
          `· rate ${x.pool.rate} · matures ${x.pool.maturity ? new Date(x.pool.maturity).toISOString().slice(0, 10) : 'unknown'}` +
          (x.pool.product_type !== x.type ? `  ⚠ the pool itself is "${x.pool.product_type || '(empty)'}"` : ''));
      }
      if (v === 'mislabelled' || v === 'mislabelled-other-id') {
        console.log(`      → ${x.existing.id} currently "${x.existing.product_type || '(empty)'}" → "${x.type}"`);
      }
    }
  }

  if (s.wrongPools.length) {
    H('Pools holding these investments that are not labelled as their investments will be');
    s.wrongPools.forEach(p => console.log(`  ${p.id}  "${p.name}"  currently "${p.product_type || '(empty)'}"` +
      `  → ${p.want.join(' / ')}`));
    console.log('\n  Rollovers match on product_type alone, so these pools will not roll into');
    console.log('  an open pool of that type. Fix with remap-pool-product-type.cjs, or the');
    console.log('  Remap Pool Product Type panel in the admin console — not here.');
  }

  if (s.totals.length) {
    H('investors.total_invested, against the investment rows');
    console.log('  account           stored    rows now   rows after   difference');
    for (const t of s.totals) {
      console.log(`  ${t.investor.padEnd(14)} ${money(t.stored).padStart(14)} ${money(t.live).padStart(12)} ` +
        `${money(t.after).padStart(12)} ${money(t.difference).padStart(13)}`);
    }
    console.log('\n  Nothing here is written. A difference of zero after the import means the');
    console.log('  original migration already counted these amounts, which is the usual case:');
    console.log('  it summed the whole export whether or not each insert then succeeded.');
  }

  if (!APPLY && !FIX_LABEL) {
    H('Nothing was changed');
    console.log(`  --apply              inserts the ${of('missing').length} absent record(s)`);
    console.log(`  --fix-product-type   relabels the ${of('mislabelled').length + of('mislabelled-other-id').length} row(s) already in the database`);
    return;
  }

  const res = await svc.execute(db, {
    survey: s, apply: APPLY, fixLabel: FIX_LABEL,
    source: path.basename(FILE), actor: { email: ACTOR, role: 'admin' },
  });
  res.warnings.forEach(w => console.log(`  ⚠  ${w}`));

  H('Written');
  console.log(`  ${res.inserted} inserted · ${res.relabelled} relabelled · ` +
    `${of('present').length + of('present-other-id').length} already there · ` +
    `${of('no-pool').length + of('no-investor').length + of('no-date').length} blocked`);
  for (const t of s.wanted) {
    const xs = of('missing').filter(x => x.type === t);
    if (res.inserted && xs.length) console.log(`  ${money(sum(xs))} of ${t} principal added (${xs.length}).`);
  }
  console.log('\n  investors.total_invested was not touched — see the table above.');
  console.log('  No transaction rows were written; this export holds investments only.');
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}`); process.exitCode = 1; })
  .finally(async () => {
    await db.end().catch(() => {});
    /* The audit service writes through the shared pool, whose idle connections
       hold the event loop open for another 30 seconds after the last row — so
       the script sits there looking hung long after it has finished. */
    await require(path.join(__dirname, '..', 'db', 'pool')).end().catch(() => {});
  });
