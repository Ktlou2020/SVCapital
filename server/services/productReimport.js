'use strict';
/* Re-importing one product's investments from a Firestore audit export.
 *
 * The console importer read an investment's product from `inv.product?.name`,
 * which is undefined in every export because `product` is a path string, so
 * every migrated investment was written as product_type 'other'. Nothing was
 * lost; it was filed under no product, which on a screen that asks for one
 * product is indistinguishable from an investment that never arrived.
 *
 * That makes two faults, and the dangerous one is the second:
 *   1. the investment really is absent          → insert it
 *   2. the investment is there, labelled wrong  → an insert is a NO-OP
 * Treating (2) as (1) reports success and changes nothing. They are kept
 * apart here, and each is a separate decision for the caller.
 *
 * One place, two front doors: the CLI (server/scripts/reimport-product-
 * investments.cjs) and the admin console's Data Fixes panel both call this.
 * A second copy of the classification would drift from the one that writes.
 */

const audit = require('./audit');

/* The export's own catalogue, kept here rather than read from the live
   products table: a script that reads a historical export has to keep reading
   it the way it was written, whatever the live catalogue says today. */
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
const TERM_WORDS = { five: '5', six: '6', seven: '7', eight: '8', ten: '10', twelve: '12' };

const lastSeg = v => {
  if (!v) return null;
  const s = (typeof v === 'object') ? (v.path || v.id || '') : String(v);
  const parts = String(s).split('/');
  return parts[parts.length - 1] || null;
};
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* "id=type,id=type" — from --map on the CLI, or the same field in the panel. */
function parseMap(spec) {
  return Object.fromEntries(String(spec || '').split(',').filter(Boolean)
    .map(pair => { const [id, type] = pair.split('='); return [String(id || '').trim(), String(type || '').trim()]; })
    .filter(([id, type]) => id && type));
}

function normaliseInstruction(mi) {
  if (!mi || !mi.instruction) return null;
  return String(mi.instruction).toLowerCase().replace(/\s+/g, '_')
    .replace('payout_returns', 'payout_return')
    .replace('payout_all_funds', 'payout_all');
}

function recordsOf(raw) {
  const all = Array.isArray(raw) ? raw : (raw && (raw.investments || raw.data)) || [];
  return Array.isArray(all) ? all : [];
}

/* ── The survey. Reads; never writes. ───────────────────────────────── */
async function survey(db, { records, exportKey, as, map }) {
  const all = recordsOf(records);
  if (!all.length) { const e = new Error('The file holds no investment records.'); e.status = 400; throw e; }
  if (!exportKey)  { const e = new Error('A product is required.');                e.status = 400; throw e; }

  const MAP     = (map && typeof map === 'object') ? map : parseMap(map);
  const PRODUCT = as || exportKey;
  const typeOf  = r => MAP[lastSeg(r.product)] || PRODUCT;

  /* What the file actually holds, by product. A product the file has nothing
     for is a typo, worth saying rather than reporting "0 to import" as though
     the work were done. */
  const fileByProduct = {};
  for (const r of all) {
    const t = PRODUCT_ID_MAP[lastSeg(r.product)] || `other (${lastSeg(r.product) || 'no product'})`;
    fileByProduct[t] = (fileByProduct[t] || 0) + 1;
  }

  const usable  = r => r._id && r.userAccountNumber;
  const ofKey   = r => PRODUCT_ID_MAP[lastSeg(r.product)] === exportKey;
  const mine    = all.filter(r => ofKey(r) && usable(r));
  const dropped = all.filter(r => ofKey(r) && !usable(r)).length;
  const base = { file: { total: all.length, byProduct: fileByProduct }, exportKey, product: PRODUCT,
                 map: MAP, dropped, wanted: [], known: [], unknown: [], plan: [],
                 suggestion: [], wrongPools: [], totals: [] };
  if (!mine.length) return { ...base, empty: true };

  const wanted = [...new Set(mine.map(typeOf))].sort();

  /* A product_type nothing else uses is how a rollover silently becomes a
     wallet payout — the maturity engine matches on that column and nothing
     else — and how a product page stays empty after an import that reported
     success. Same refusal the remap panel gives, for the same reason. */
  const { rows: liveTypes } = await db.query(
    `SELECT DISTINCT product_type FROM investment_pools WHERE COALESCE(product_type,'') <> ''
      UNION SELECT DISTINCT product_type FROM investments WHERE COALESCE(product_type,'') <> ''
      UNION SELECT DISTINCT product_type FROM products WHERE COALESCE(product_type,'') <> ''`);
  const known   = liveTypes.map(r => r.product_type).sort();
  const unknown = wanted.filter(t => !known.includes(t));

  const invIds      = mine.map(r => `INV-MIGR-${r._id}`);
  const poolIds     = [...new Set(mine.map(r => `POOL-MIGR-${lastSeg(r.pool)}`))];
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
  for (const r of inPools) if (!byFingerprint.has(fingerprint(r))) byFingerprint.set(fingerprint(r), r);

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

  const plan = mine.map(r => {
    const id       = `INV-MIGR-${r._id}`;
    const legacyId = lastSeg(r.product);
    const poolId   = `POOL-MIGR-${lastSeg(r.pool)}`;
    const investor = r.userAccountNumber;
    const amount   = round2(r.investedAmount);
    const start    = r.dateInvested ? new Date(r.dateInvested) : null;
    const p        = poolById.get(poolId);
    const row      = byId.get(id);
    const twin     = row ? null : byFingerprint.get([investor, poolId, amount,
      start ? start.toISOString().slice(0, 10) : ''].join('|'));
    const type     = typeOf(r);
    const who      = investorById.get(investor);

    let verdict;
    if (row && row.product_type === type)        verdict = 'present';
    else if (row)                                verdict = 'mislabelled';
    else if (twin && twin.product_type === type) verdict = 'present-other-id';
    else if (twin)                               verdict = 'mislabelled-other-id';
    else if (!who)                               verdict = 'no-investor';
    else if (!p)                                 verdict = 'no-pool';
    else if (!start)                             verdict = 'no-date';
    else                                         verdict = 'missing';

    return {
      id, legacyId, poolId, investor, amount, start, type, verdict,
      investorName: who ? `${who.first_name || ''} ${who.last_name || ''}`.trim() : null,
      txRef: r.txRef || null,
      pool: p ? { id: p.id, name: p.name, product_type: p.product_type, rate: Number(p.rate),
                  term_months: p.term_months, maturity: p.maturity } : null,
      existing: row ? { id: row.id, product_type: row.product_type }
                    : (twin ? { id: twin.id, product_type: twin.product_type } : null),
      status: STATUS_MAP[r.status] || 'active',
      instruction: normaliseInstruction(r.maturityInstruction),
      isReinvestment: !!r.reinvestment,
      src: { _id: r._id, txRef: r.txRef || null, fees: r.fees || null },
    };
  });

  /* Which legacy id is which product is not in the export: the id is opaque
     and the records carry no term. The POOL NAMES say it — "Solar Investment
     - 7 Years - October 2025" — but a name is exactly what the maturity
     engine cannot see, and acting on one by itself is how a guess becomes a
     product label. So a suggestion is offered to be repeated back, and never
     applied on its own. */
  const suggestion = [];
  if (!Object.keys(MAP).length) {
    const byLegacy = new Map();
    for (const x of plan) {
      if (!byLegacy.has(x.legacyId)) byLegacy.set(x.legacyId, new Set());
      if (x.pool) byLegacy.get(x.legacyId).add(x.pool.name);
    }
    if (byLegacy.size > 1) {
      for (const [legacyId, names] of byLegacy) {
        const joined = [...names].join(' ');
        const term = (joined.match(/(\d+)\s*-?\s*(?:year|yr)/i) || [])[1]
                  || TERM_WORDS[(joined.toLowerCase().match(/\b(five|six|seven|eight|ten|twelve)\b/) || [])[1]];
        const guess = term ? `${exportKey}_${term}yr` : null;
        suggestion.push({
          legacyId, poolNames: [...names],
          records: plan.filter(x => x.legacyId === legacyId).length,
          guess, guessKnown: !!guess && known.includes(guess),
        });
      }
    }
  }

  /* The type a pool OUGHT to carry is the type its own investments are being
     written with — per record, once the map splits one export product into
     several. A pool holding records of two types is itself worth seeing. */
  const wantByPool = new Map();
  for (const x of plan) {
    if (!x.pool) continue;
    if (!wantByPool.has(x.poolId)) wantByPool.set(x.poolId, new Set());
    wantByPool.get(x.poolId).add(x.type);
  }
  const wrongPools = pools.filter(p => {
    const want = wantByPool.get(p.id);
    return want && !(want.size === 1 && want.has(p.product_type));
  }).map(p => ({ id: p.id, name: p.name, product_type: p.product_type,
                 want: [...wantByPool.get(p.id)].sort() }));

  /* investors.total_invested is never written here: the original migration
     summed the whole export whether or not each insert then succeeded, so
     these amounts are very likely already in it and adding them again would
     double-count. The arithmetic is reported so a person can judge. */
  const touched = [...new Set(plan
    .filter(x => ['missing', 'mislabelled', 'mislabelled-other-id'].includes(x.verdict))
    .map(x => x.investor))];
  let totals = [];
  if (touched.length) {
    const { rows: sums } = await db.query(
      `SELECT investor_id, COALESCE(SUM(amount), 0) AS live
         FROM investments
        WHERE investor_id = ANY($1::text[])
          AND COALESCE(status, '') IN ('active', 'matured', 'paid_out')
        GROUP BY investor_id`, [touched]);
    const liveBy = new Map(sums.map(r => [r.investor_id, Number(r.live)]));
    totals = touched.sort().map(acc => {
      const stored = Number(investorById.get(acc) ? investorById.get(acc).total_invested : 0);
      const live   = liveBy.get(acc) || 0;
      const after  = live + plan.filter(x => x.verdict === 'missing' && x.investor === acc)
                                .reduce((a, x) => a + x.amount, 0);
      return { investor: acc, stored, live, after, difference: round2(stored - after) };
    });
  }

  return { ...base, wanted, known, unknown, plan, suggestion, wrongPools, totals, empty: false };
}

/* ── The write. One transaction; audited after it commits. ──────────── */
async function execute(db, { survey: s, apply, fixLabel, source, actor }) {
  const of = v => s.plan.filter(x => x.verdict === v);
  const client = await db.connect();
  const done = [];
  let inserted = 0, relabelled = 0;
  try {
    await client.query('BEGIN');

    if (apply) {
      for (const x of of('missing')) {
        const rate  = x.pool ? Number(x.pool.rate) || 0 : 0;
        const notes = `Re-imported from ${source} on ${new Date().toISOString().slice(0, 10)}. ` +
          `Legacy id ${x.src._id}; txRef ${x.txRef || '-'}. ` +
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
          [x.id, x.investor, x.poolId, x.pool.name, x.type, x.amount, x.status,
           x.start, x.pool.maturity || null, x.pool.term_months || null, rate,
           round2(x.amount * rate), x.instruction, x.isReinvestment, notes, x.start]);
        if (rowCount) { inserted++; done.push({ kind: 'inserted', x }); }
      }
    }

    if (fixLabel) {
      for (const x of [...of('mislabelled'), ...of('mislabelled-other-id')]) {
        const { rowCount } = await client.query(
          `UPDATE investments SET product_type = $2, updated_at = NOW()
            WHERE id = $1 AND COALESCE(product_type, '') <> $2`, [x.existing.id, x.type]);
        if (rowCount) { relabelled++; done.push({ kind: 'relabelled', x, from: x.existing.product_type }); }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  /* Audited after the commit: a failed audit row must not undo an import that
     succeeded, and an audit row for an import that rolled back would be a lie. */
  const warnings = [];
  for (const d of done) {
    await audit.log({
      actorId: actor && actor.id ? actor.id : null,
      actorEmail: (actor && actor.email) || 'cli',
      actorRole: (actor && actor.role) || 'admin',
      action: d.kind === 'inserted' ? 'investment_reimported' : 'investment_product_type_corrected',
      entityType: 'investment', entityId: d.x.existing ? d.x.existing.id : d.x.id,
      description: d.kind === 'inserted'
        ? `Re-imported ${d.x.type} investment of ${money(d.x.amount)} for ${d.x.investor} ` +
          `into ${d.x.poolId} from ${source} (legacy id ${d.x.src._id}).`
        : `Product type corrected from "${d.from || '(empty)'}" to "${d.x.type}" ` +
          `on a ${money(d.x.amount)} investment for ${d.x.investor}.`,
      before: d.kind === 'inserted' ? null : { product_type: d.from || '' },
      after:  d.kind === 'inserted'
        ? { amount: d.x.amount, pool_id: d.x.poolId, status: d.x.status,
            product_type: d.x.type, source }
        : { product_type: d.x.type },
    }).catch(e => warnings.push(`written, but the audit row failed: ${e.message}`));
  }
  await audit.log({
    actorId: actor && actor.id ? actor.id : null,
    actorEmail: (actor && actor.email) || 'cli',
    actorRole: (actor && actor.role) || 'admin',
    action: 'product_investments_reimported',
    entityType: 'product', entityId: s.wanted.join(','),
    description: `${inserted} ${s.wanted.join('/')} investment(s) inserted and ${relabelled} relabelled ` +
      `from ${source}; ${of('present').length + of('present-other-id').length} already present were skipped.`,
    after: { inserted, relabelled, file: source, types: s.wanted,
             blocked: of('no-pool').length + of('no-investor').length + of('no-date').length },
  }).catch(() => {});

  return { inserted, relabelled, done, warnings };
}

module.exports = { survey, execute, parseMap, recordsOf, money, round2, lastSeg,
                   PRODUCT_ID_MAP, STATUS_MAP };
