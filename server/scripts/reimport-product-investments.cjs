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
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const ARGV = process.argv.slice(2);
const flag = n => ARGV.includes(n);
const val  = n => { const i = ARGV.indexOf(n); return i > -1 ? (ARGV[i + 1] || '') : ''; };

const FILE        = val('--file');
const PRODUCT     = val('--product');
const APPLY       = flag('--apply');
const FIX_LABEL   = flag('--fix-product-type');
const ACTOR       = process.env.IMPORT_ACTOR || 'cli';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}
if (!FILE || !PRODUCT) {
  console.error('Both --file <export.json> and --product <product_type> are required.');
  console.error('See the header of this file.');
  process.exit(2);
}

/* The same table both importers use, kept here rather than imported: a script
   that reads a historical export must keep reading it the way it was written,
   even if the live map is edited later. */
const PRODUCT_ID_MAP = {
  '0J1g67Ln99nMOct6vnqS': 'delivery_bikes',
  '8r3TlnGkizidu1JCgbDp': 'smme',
  'BjrELvLGvQzTSDt9ztGK': 'solar',
  'Q3R5RN21GWJ4lGCtI72R': 'cattle_12j',
  'SfpCxgJjP6i5GUz1JWYp': 'solar',
  'gSjiuqRg3E8IEO2hwfmu': 'cattle',
  'lwKM2GFyCXNd88l1nCAK': 'ilobola',
  'xKQkwQMa0Hnj0dAmGsWH': 'solar',
};
const STATUS_MAP = {
  MATURED: 'matured', ACTIVE: 'active', PAID_OUT: 'matured',
  COMPLETE: 'matured', CANCELLED: 'cancelled',
};

const lastSeg = v => {
  if (!v) return null;
  const s = (typeof v === 'object') ? (v.path || v.id || '') : String(v);
  const parts = s.split('/');
  return parts[parts.length - 1] || null;
};
const money = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

let auditUsed = false;

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 120000,
});

function normaliseInstruction(mi) {
  if (!mi || !mi.instruction) return null;
  return String(mi.instruction).toLowerCase().replace(/\s+/g, '_')
    .replace('payout_returns', 'payout_return')
    .replace('payout_all_funds', 'payout_all');
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const all = Array.isArray(raw) ? raw : (raw.investments || raw.data || []);
  if (!all.length) { console.error(`${FILE} holds no investment records.`); process.exit(2); }

  /* What the file actually contains, by product. A --product the file has
     nothing for is a typo, and is worth saying so rather than reporting
     "0 to import" as though the work were done. */
  const byProduct = {};
  for (const r of all) {
    const t = PRODUCT_ID_MAP[lastSeg(r.product)] || `other (${lastSeg(r.product) || 'no product'})`;
    byProduct[t] = (byProduct[t] || 0) + 1;
  }
  H(`${path.basename(FILE)} — ${all.length} investment record(s)`);
  Object.entries(byProduct).sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(6)}  ${t}`));

  const mine = all.filter(r => PRODUCT_ID_MAP[lastSeg(r.product)] === PRODUCT
                            && r._id && r.userAccountNumber);
  const dropped = all.filter(r => PRODUCT_ID_MAP[lastSeg(r.product)] === PRODUCT
                               && (!r._id || !r.userAccountNumber));
  if (!mine.length) {
    console.log(`\nNothing in this file maps to product_type "${PRODUCT}". Nothing to do.`);
    return;
  }
  console.log(`\n${mine.length} record(s) map to "${PRODUCT}"` +
    (dropped.length ? ` · ${dropped.length} unusable (no _id or no account number)` : ''));

  /* ── What the database already holds ─────────────────────────────── */
  const invIds   = mine.map(r => `INV-MIGR-${r._id}`);
  const poolIds  = [...new Set(mine.map(r => `POOL-MIGR-${lastSeg(r.pool)}`))];
  const investorIds = [...new Set(mine.map(r => r.userAccountNumber))];

  const { rows: existingById } = await db.query(
    `SELECT id, investor_id, pool_id, amount, product_type, status, start_date
       FROM investments WHERE id = ANY($1::text[])`, [invIds]);
  const byId = new Map(existingById.map(r => [r.id, r]));

  /* Every investment sitting in those pools, whatever its id — so a row that
     was entered by hand, or imported under a different id, is recognised as
     the same investment instead of being inserted a second time. */
  const { rows: inPools } = await db.query(
    `SELECT id, investor_id, pool_id, amount, product_type, start_date
       FROM investments WHERE pool_id = ANY($1::text[])`, [poolIds]);
  const fingerprint = r => [r.investor_id, r.pool_id, round2(r.amount),
    r.start_date ? new Date(r.start_date).toISOString().slice(0, 10) : ''].join('|');
  const byFingerprint = new Map();
  for (const r of inPools) {
    if (!byFingerprint.has(fingerprint(r))) byFingerprint.set(fingerprint(r), r);
  }

  const { rows: pools } = await db.query(
    `SELECT id, name, product_type, status, term_months,
            COALESCE(actual_rate, annual_rate, 0) AS rate,
            COALESCE(maturity_date::date, end_date) AS maturity
       FROM investment_pools WHERE id = ANY($1::text[])`, [poolIds]);
  const poolById = new Map(pools.map(p => [p.id, p]));

  const { rows: investors } = await db.query(
    `SELECT id, first_name, last_name, COALESCE(total_invested, 0) AS total_invested
       FROM investors WHERE id = ANY($1::text[])`, [investorIds]);
  const investorById = new Map(investors.map(i => [i.id, i]));

  /* ── Classify ────────────────────────────────────────────────────── */
  const plan = mine.map(r => {
    const id       = `INV-MIGR-${r._id}`;
    const poolId   = `POOL-MIGR-${lastSeg(r.pool)}`;
    const investor = r.userAccountNumber;
    const amount   = round2(r.investedAmount);
    const start    = r.dateInvested ? new Date(r.dateInvested) : null;
    const p        = poolById.get(poolId);
    const row      = byId.get(id);
    const twin     = row ? null : byFingerprint.get([investor, poolId, amount,
      start ? start.toISOString().slice(0, 10) : ''].join('|'));

    let verdict;
    if (row && row.product_type === PRODUCT)      verdict = 'present';
    else if (row)                                 verdict = 'mislabelled';
    else if (twin && twin.product_type === PRODUCT) verdict = 'present-other-id';
    else if (twin)                                verdict = 'mislabelled-other-id';
    else if (!investorById.has(investor))         verdict = 'no-investor';
    else if (!p)                                  verdict = 'no-pool';
    else if (!start)                              verdict = 'no-date';
    else                                          verdict = 'missing';

    return { src: r, id, poolId, investor, amount, start, pool: p, row, twin, verdict,
             status: STATUS_MAP[r.status] || 'active',
             instruction: normaliseInstruction(r.maturityInstruction) };
  });

  const of = v => plan.filter(x => x.verdict === v);
  const sum = xs => xs.reduce((a, x) => a + x.amount, 0);

  H('Where each record stands');
  const LABELS = {
    'missing':              'absent from the database — to be inserted',
    'mislabelled':          `in the database as another product — to be relabelled "${PRODUCT}"`,
    'mislabelled-other-id': 'the same investment under a different id, and another product',
    'present':              `already there as "${PRODUCT}" — skipped`,
    'present-other-id':     `already there under a different id as "${PRODUCT}" — skipped`,
    'no-pool':              'blocked: its pool is not in the database',
    'no-investor':          'blocked: its investor is not in the database',
    'no-date':              'blocked: no investment date in the export',
  };
  for (const [v, label] of Object.entries(LABELS)) {
    const xs = of(v);
    if (xs.length) console.log(`  ${String(xs.length).padStart(4)}  ${money(sum(xs)).padStart(16)}  ${label}`);
  }

  for (const v of ['missing', 'mislabelled', 'mislabelled-other-id', 'no-pool', 'no-investor', 'no-date']) {
    const xs = of(v);
    if (!xs.length) continue;
    H(LABELS[v]);
    for (const x of xs) {
      const who = investorById.get(x.investor);
      const name = who ? `${who.first_name || ''} ${who.last_name || ''}`.trim() : '(not in the database)';
      console.log(`  ${x.investor.padEnd(16)} ${money(x.amount).padStart(14)}  ` +
        `${x.start ? x.start.toISOString().slice(0, 10) : '(no date)'}  ` +
        `${x.src.txRef || '-'}  ${name}`);
      if (v === 'missing') {
        console.log(`      → ${x.id}  pool ${x.poolId} "${x.pool.name}" ` +
          `· rate ${Number(x.pool.rate)} · matures ${x.pool.maturity ? new Date(x.pool.maturity).toISOString().slice(0, 10) : 'unknown'}` +
          (x.pool.product_type !== PRODUCT ? `  ⚠ the pool itself is "${x.pool.product_type || '(empty)'}"` : ''));
      }
      if (v === 'mislabelled' || v === 'mislabelled-other-id') {
        const row = x.row || x.twin;
        console.log(`      → ${row.id} currently "${row.product_type || '(empty)'}"`);
      }
    }
  }

  /* A pool carrying the wrong product_type is a separate fault with its own
     consequence — the maturity engine matches rollovers on product_type and
     nothing else — and its own script. Named, not fixed here. */
  const wrongPools = pools.filter(p => p.product_type !== PRODUCT);
  if (wrongPools.length) {
    H('Pools holding these investments that are not labelled ' + PRODUCT);
    wrongPools.forEach(p => console.log(`  ${p.id}  "${p.name}"  currently "${p.product_type || '(empty)'}"`));
    console.log('\n  Rollovers match on product_type alone, so these pools will not roll into');
    console.log('  an open ' + PRODUCT + ' pool. Fix with remap-pool-product-type.cjs, not here.');
  }

  /* ── total_invested, so nobody has to guess whether to adjust it ── */
  const touched = [...new Set([...of('missing'), ...of('mislabelled'), ...of('mislabelled-other-id')]
    .map(x => x.investor))];
  if (touched.length) {
    const { rows: sums } = await db.query(
      `SELECT investor_id, COALESCE(SUM(amount), 0) AS live
         FROM investments
        WHERE investor_id = ANY($1::text[])
          AND COALESCE(status, '') IN ('active', 'matured', 'paid_out')
        GROUP BY investor_id`, [touched]);
    const liveBy = new Map(sums.map(r => [r.investor_id, Number(r.live)]));
    H('investors.total_invested, against the investment rows');
    console.log('  account           stored    rows now   rows after   difference');
    for (const acc of touched.sort()) {
      const stored = Number(investorById.get(acc)?.total_invested || 0);
      const live   = liveBy.get(acc) || 0;
      const after  = live + sum(of('missing').filter(x => x.investor === acc));
      console.log(`  ${acc.padEnd(14)} ${money(stored).padStart(14)} ${money(live).padStart(12)} ` +
        `${money(after).padStart(12)} ${money(stored - after).padStart(13)}`);
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

  /* ── Write ───────────────────────────────────────────────────────── */
  const audit  = require(path.join(__dirname, '..', 'services', 'audit'));
  auditUsed = true;
  const client = await db.connect();
  let inserted = 0, relabelled = 0;
  const done = [];
  try {
    await client.query('BEGIN');

    if (APPLY) {
      for (const x of of('missing')) {
        const rate = Number(x.pool.rate) || 0;
        const notes = `Re-imported from ${path.basename(FILE)} on ${new Date().toISOString().slice(0, 10)}. ` +
          `Legacy id ${x.src._id}; txRef ${x.src.txRef || '-'}. ` +
          (x.src.fees ? `Client paid ${money(x.src.fees.submitedAmount || x.amount)}, ` +
            `fees ${money(x.src.fees.financialServicesFee || 0)} + ${money(x.src.fees.managementFee || 0)}, ` +
            `${money(x.amount)} into the pool.` : '');
        const { rowCount } = await client.query(`
          INSERT INTO investments
            (id, investor_id, pool_id, pool_name, product_type, amount, status,
             start_date, end_date, term_months, annual_rate, expected_return,
             maturity_instruction, is_reinvestment, notes, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
          ON CONFLICT (id) DO NOTHING`,
          [x.id, x.investor, x.poolId, x.pool.name, PRODUCT, x.amount, x.status,
           x.start, x.pool.maturity || null, x.pool.term_months || null, rate,
           round2(x.amount * rate), x.instruction, !!x.src.reinvestment, notes, x.start]);
        if (rowCount) { inserted++; done.push({ kind: 'inserted', x }); }
      }
    }

    if (FIX_LABEL) {
      for (const x of [...of('mislabelled'), ...of('mislabelled-other-id')]) {
        const row = x.row || x.twin;
        const { rowCount } = await client.query(
          `UPDATE investments SET product_type = $2, updated_at = NOW()
            WHERE id = $1 AND COALESCE(product_type, '') <> $2`, [row.id, PRODUCT]);
        if (rowCount) { relabelled++; done.push({ kind: 'relabelled', x, from: row.product_type }); }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n✗ nothing was written — ${err.message}`);
    process.exitCode = 1;
    client.release();
    return;
  }
  client.release();

  /* Audited after the commit: a failed audit row must not undo an import that
     succeeded, and an audit row for an import that rolled back would be a lie. */
  for (const d of done) {
    await audit.log({
      actorId: null, actorEmail: ACTOR, actorRole: 'admin',
      action: d.kind === 'inserted' ? 'investment_reimported' : 'investment_product_type_corrected',
      entityType: 'investment', entityId: d.x.row ? d.x.row.id : (d.x.twin ? d.x.twin.id : d.x.id),
      description: d.kind === 'inserted'
        ? `Re-imported ${PRODUCT} investment of ${money(d.x.amount)} for ${d.x.investor} ` +
          `into ${d.x.poolId} from ${path.basename(FILE)} (legacy id ${d.x.src._id}).`
        : `Product type corrected from "${d.from || '(empty)'}" to "${PRODUCT}" ` +
          `on a ${money(d.x.amount)} investment for ${d.x.investor}.`,
      before: d.kind === 'inserted' ? null : { product_type: d.from || '' },
      after:  d.kind === 'inserted'
        ? { amount: d.x.amount, pool_id: d.x.poolId, status: d.x.status, source: path.basename(FILE) }
        : { product_type: PRODUCT },
    }).catch(e => console.log(`  ⚠  written, but the audit row failed: ${e.message}`));
  }
  await audit.log({
    actorId: null, actorEmail: ACTOR, actorRole: 'admin',
    action: 'product_investments_reimported',
    entityType: 'product', entityId: PRODUCT,
    description: `${inserted} ${PRODUCT} investment(s) inserted and ${relabelled} relabelled ` +
      `from ${path.basename(FILE)}; ${of('present').length + of('present-other-id').length} already present were skipped.`,
    after: { inserted, relabelled, file: path.basename(FILE),
             blocked: of('no-pool').length + of('no-investor').length + of('no-date').length },
  }).catch(() => {});

  H('Written');
  console.log(`  ${inserted} inserted · ${relabelled} relabelled · ` +
    `${of('present').length + of('present-other-id').length} already there · ` +
    `${of('no-pool').length + of('no-investor').length + of('no-date').length} blocked`);
  if (inserted) console.log(`  ${money(sum(of('missing')))} of ${PRODUCT} principal added.`);
  console.log('\n  investors.total_invested was not touched — see the table above.');
  console.log('  No transaction rows were written; this export holds investments only.');
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}`); process.exitCode = 1; })
  .finally(async () => {
    await db.end().catch(() => {});
    /* services/audit writes through the shared pool, whose idle connections
       hold the event loop open for another 30 seconds after the last row — so
       the script sits there looking hung long after it has finished. Closed
       only if it was used, since asking for it creates it. */
    if (auditUsed) await require(path.join(__dirname, '..', 'db', 'pool')).end().catch(() => {});
  });
