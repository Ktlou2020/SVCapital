#!/usr/bin/env node
/* Point a pool's rollovers at a product that actually has an open pool.
 *
 * The maturity engine matches on product_type and NOTHING else. reinvestAmount
 * is handed inv.product_type and its target query's only predicate is
 * `product_type = $1`. Pool names play no part — "Cattle Investment - August
 * 2025" does not roll into "Cattle Investment - August 2026" unless their
 * product_type values match. The migrated pools carry 'other' on every
 * investment, so their rollovers find nothing and become wallet payouts.
 *
 * Correcting the POOL alone reroutes nothing: the engine reads the column on
 * the INVESTMENT. Both are written together here, in one transaction.
 *
 * ── Three modes, and only one of them writes ──────────────────────────
 *
 *   (no arguments)      Survey. Names every pool whose rollovers currently
 *                       find no open pool, with the amount at stake and a
 *                       SUGGESTED target. Changes nothing.
 *
 *   --map ID=type,...   Dry run of exactly those remaps. Changes nothing.
 *
 *   --map ... --apply   Executes them. One transaction per pool, with an
 *                       audit row per pool.
 *
 * The suggestion is derived from the pool's NAME, which is precisely what the
 * engine cannot see — so it is never applied on its own. It has to be repeated
 * back through --map, by a person who agrees with it.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/remap-pool-product-type.cjs
 *   DATABASE_URL=… node server/scripts/remap-pool-product-type.cjs --map POOL-A=cattle
 *   DATABASE_URL=… node server/scripts/remap-pool-product-type.cjs --map POOL-A=cattle --apply
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const path = require('path');
const { Pool } = require('pg');
const { resolveRolloverTarget } = require(path.join(__dirname, '..', 'services', 'maturityPreflight'));

const ARGV   = process.argv.slice(2);
const APPLY  = ARGV.includes('--apply');
const mapArg = (() => {
  const i = ARGV.indexOf('--map');
  return i > -1 ? (ARGV[i + 1] || '') : '';
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const rand = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');

/* Parse --map. A malformed entry stops everything rather than being skipped:
   silently ignoring one pair in a list of five is how the wrong subset gets
   applied while the operator believes all of it did. */
function parseMap(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const at = pair.lastIndexOf('=');
    if (at < 1) throw new Error(`--map entry "${pair}" is not of the form POOL_ID=product_type`);
    const poolId = pair.slice(0, at).trim();
    const type   = pair.slice(at + 1).trim();
    if (!poolId || !type) throw new Error(`--map entry "${pair}" is missing a side`);
    if (!/^[a-z0-9_]+$/.test(type)) {
      throw new Error(`product_type "${type}" must be lower-case letters, digits and underscores`);
    }
    return { poolId, type };
  });
}

async function knownTypes(excludePoolId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT product_type FROM investment_pools
      WHERE product_type IS NOT NULL AND product_type <> '' AND id <> $1`,
    [excludePoolId || '']);
  return new Set(rows.map(r => r.product_type));
}

/* What the endpoint reports, from the same queries, so the CLI and the admin
   console cannot describe the same remap differently. */
async function plan(client, poolId, target) {
  const { rows: [p] } = await client.query(
    'SELECT id, name, product_type, status FROM investment_pools WHERE id = $1', [poolId]);
  if (!p) return { error: `Pool ${poolId} not found.` };

  const allowed = await knownTypes(poolId);
  if (!allowed.has(target)) {
    return { error: `No other pool uses product_type "${target}". Existing types: ` +
                    `${[...allowed].sort().join(', ') || '(none)'}.` };
  }

  const { rows: breakdown } = await client.query(
    `SELECT COALESCE(NULLIF(product_type, ''), '(empty)') AS current_type,
            COALESCE(status, '(no status)')               AS status,
            COUNT(*)::int                                  AS n,
            COALESCE(SUM(amount), 0)                       AS capital
       FROM investments WHERE pool_id = $1
      GROUP BY 1, 2 ORDER BY 1, 2`, [poolId]);

  const { rows: [{ n: changing }] } = await client.query(
    `SELECT COUNT(*)::int n FROM investments
      WHERE pool_id = $1 AND COALESCE(product_type, '') <> $2`, [poolId, target]);

  const before = await resolveRolloverTarget(client, p.product_type || '');
  const after  = await resolveRolloverTarget(client, target);

  return { pool: p, breakdown, changing, before, after,
           poolChanges: (p.product_type || '') !== target,
           total: breakdown.reduce((s, b) => s + b.n, 0),
           capital: breakdown.reduce((s, b) => s + Number(b.capital || 0), 0) };
}

function printPlan(pl, target) {
  const p = pl.pool;
  console.log(`\n  ${p.id}  "${p.name}"  [${p.status || 'no status'}]`);
  console.log(`     product_type  ${p.product_type || '(empty)'}  →  ${target}` +
              `${pl.poolChanges ? '' : '   (pool already correct)'}`);
  console.log(`     investments   ${pl.changing} of ${pl.total} would change · ${rand(pl.capital)} total capital`);
  for (const b of pl.breakdown) {
    console.log(`        ${String(b.current_type).padEnd(14)} ${String(b.status).padEnd(12)} ` +
                `${String(b.n).padStart(4)}  ${rand(b.capital)}`);
  }
  console.log(`     rollovers now   ${pl.before ? `→ ${pl.before.name}` : '→ NO OPEN POOL — wallet payouts'}`);
  console.log(`     rollovers after ${pl.after ? `→ ${pl.after.name} (closes ${day(pl.after.end_date)})`
                                               : '→ STILL no open pool — wallet payouts'}`);
  if (!pl.after) {
    console.log(`     ⚠  "${target}" has no open pool either. This remap would not fix the routing.`);
  }
}

/* ── Survey: whose rollovers currently go nowhere ──────────────────── */
async function survey() {
  const { rows } = await pool.query(`
    SELECT i.pool_id, p.name AS pool_name, p.status AS pool_status, p.end_date,
           COALESCE(NULLIF(i.product_type, ''), '(empty)') AS product_type,
           COUNT(*)::int AS n, COALESCE(SUM(i.amount), 0) AS capital
      FROM investments i
      JOIN investment_pools p ON p.id = i.pool_id
     WHERE i.status = 'active'
       AND i.maturity_processed_at IS NULL
     GROUP BY 1,2,3,4,5
     ORDER BY SUM(i.amount) DESC`);

  const types = new Map();
  for (const r of rows) {
    if (!types.has(r.product_type)) {
      types.set(r.product_type, await resolveRolloverTarget(pool, r.product_type === '(empty)' ? '' : r.product_type));
    }
  }

  const stranded = rows.filter(r => !types.get(r.product_type));
  const allowed  = [...await knownTypes(null)].sort();

  H('Pools whose rollovers currently find no open pool');
  if (!stranded.length) {
    console.log('\n  None. Every active investment\'s product_type resolves to an open pool.');
    console.log('  Nothing to remap.\n');
    return;
  }

  const total = stranded.reduce((s, r) => s + Number(r.capital || 0), 0);
  console.log(`\n  ${stranded.length} pool/type group(s) · ${rand(total)} of capital would become wallet payouts.\n`);

  for (const r of stranded) {
    /* Suggested from the NAME — which is exactly what the engine cannot see.
       Offered so the mapping does not have to be assembled by hand, never
       acted on without being typed back through --map. */
    const guess = allowed.find(t => {
      const words = t.split('_').filter(w => w.length > 2);
      return words.length && words.every(w => String(r.pool_name || '').toLowerCase().includes(w));
    });
    console.log(`  ${r.pool_id}  "${r.pool_name}"`);
    console.log(`     ${r.n} active investment(s) · ${rand(r.capital)} · product_type "${r.product_type}"`);
    console.log(`     suggested: ${guess ? `--map ${r.pool_id}=${guess}` : '(no product name matches — decide manually)'}`);
  }

  console.log(`\n  Product types with an open pool: ${allowed.filter(t => types.get(t) !== null).join(', ') || '(none resolved here)'}`);
  console.log('  All known product types: ' + (allowed.join(', ') || '(none)'));
  console.log('\n  The suggestion comes from the pool NAME. The engine matches on product_type');
  console.log('  only and cannot see names — that mismatch is the whole bug — so nothing is');
  console.log('  applied from it. Re-state what you agree with via --map, then --apply.\n');
}

(async () => {
  try {
    const mappings = parseMap(mapArg);

    if (!mappings.length) {
      if (APPLY) {
        console.error('--apply needs --map. Run with no arguments first to see what is stranded.');
        process.exitCode = 2;
        return;
      }
      await survey();
      return;
    }

    H(APPLY ? 'Applying remaps' : 'Dry run — nothing will be written');

    const client = await pool.connect();
    let failed = 0, applied = 0;
    try {
      for (const { poolId, type } of mappings) {
        const pl = await plan(client, poolId, type);
        if (pl.error) { console.log(`\n  ✗ ${poolId}: ${pl.error}`); failed++; continue; }

        printPlan(pl, type);

        if (!pl.poolChanges && pl.changing === 0) {
          console.log('     nothing to change — already set');
          continue;
        }
        if (!APPLY) continue;

        await client.query('BEGIN');
        try {
          const poolRes = await client.query(
            `UPDATE investment_pools SET product_type = $2, updated_at = NOW() WHERE id = $1`,
            [poolId, type]);
          const invRes = await client.query(
            `UPDATE investments SET product_type = $2, updated_at = NOW()
              WHERE pool_id = $1 AND COALESCE(product_type, '') <> $2`,
            [poolId, type]);
          await client.query('COMMIT');
          applied++;
          console.log(`     ✓ applied — ${poolRes.rowCount} pool, ${invRes.rowCount} investment(s)`);

          /* Same audit record the admin endpoint writes, so a remap run from a
             console is not invisible next to one run from the browser. */
          const audit = require(path.join(__dirname, '..', 'services', 'audit'));
          await audit.log({
            actorId: null,
            actorEmail: process.env.REMAP_ACTOR || 'cli',
            actorRole: 'admin',
            action: 'pool_product_type_remapped',
            entityType: 'investment_pool',
            entityId: poolId,
            description: `Product type of "${pl.pool.name}" changed from ` +
              `"${pl.pool.product_type || '(empty)'}" to "${type}"; ` +
              `${invRes.rowCount} investment(s) updated to match. Run from remap-pool-product-type.cjs.`,
            before: { product_type: pl.pool.product_type || '', rollover_target: pl.before ? pl.before.id : null },
            after:  { product_type: type, investments_updated: invRes.rowCount,
                      rollover_target: pl.after ? pl.after.id : null },
            platform: 'cli',
          }).catch(e => console.log(`     ⚠  applied, but the audit row failed: ${e.message}`));
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          failed++;
          console.log(`     ✗ failed — nothing changed for this pool: ${err.message}`);
        }
      }
    } finally {
      client.release();
    }

    H('Summary');
    if (APPLY) {
      console.log(`  ${applied} pool(s) remapped, ${failed} failed.`);
      console.log('  Re-run the maturity pre-flight and confirm each block now names a successor pool.');
    } else {
      console.log(`  Dry run over ${mappings.length} pool(s), ${failed} could not be planned.`);
      console.log('  Nothing was written. Add --apply to execute exactly this.');
    }
    console.log('');
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error('\nremap failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
