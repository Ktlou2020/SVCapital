#!/usr/bin/env node
/* Retiring the SMME product type.
 *
 * 'smme' became 'short_term' long ago, but product_type is a bare string in
 * nine places with no foreign key holding them together, and the migration
 * only ever touched two of them. The rest kept a value that names a product
 * that no longer exists.
 *
 * The products row is the sharp edge. product_type is UNIQUE, so once a
 * short_term row existed the rename could not happen: it raised a duplicate
 * key on every boot into a .catch() that reported zero rows migrated, and the
 * dead row stayed listed in the marketplace.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-smme-retirement.cjs
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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const runSetup = async () => {
  const realLog = console.log, realWarn = console.warn;
  let out = '';
  console.log = (...a) => { out += a.join(' ') + '\n'; };
  console.warn = (...a) => { out += a.join(' ') + '\n'; };
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); }
  finally { console.log = realLog; console.warn = realWarn; }
  return out;
};

const count = async (table, col, val) => (await pool.query(
  `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`, [val]
)).rows[0].n;

const hasColumn = async (table, col) => (await pool.query(
  `SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, col]
)).rows.length > 0;

(async () => {
  try {
    await runSetup();   // schema first; the fixtures below need the tables

    console.log('\nit moves every column that carries the dead value');
    {
      /* Two tables were migrated and seven were not. Each one here is a place
         a live record could still name a product that does not exist. */
      const COLS = [
        ['investment_pools',     'product_type'],
        ['investments',          'product_type'],
        ['investments',          'switch_product_type'],
        ['investors',            'recurring_product_type'],
        ['investor_allocations', 'product_type'],
        ['gifts',                'product_type'],
        ['fund_runs',            'product_type'],
        ['product_faqs',         'product_type'],
        ['invest_funnel_events', 'product_type'],
      ];

      const present = [];
      for (const [t, c] of COLS) if (await hasColumn(t, c)) present.push([t, c]);
      ok('the columns it claims to cover exist in the schema',
         present.length === COLS.length,
         `missing: ${JSON.stringify(COLS.filter(x => !present.some(p => p[0] === x[0] && p[1] === x[1])))}`);

      /* Written directly rather than through the app: the point is that the
         value is reachable in each column, however it got there. */
      for (const [t, c] of present) {
        await pool.query(`UPDATE ${t} SET ${c} = 'smme'`).catch(() => {});
      }
      const seeded = [];
      for (const [t, c] of present) if (await count(t, c, 'smme') > 0) seeded.push(`${t}.${c}`);

      await runSetup();

      for (const [t, c] of present) {
        const left = await count(t, c, 'smme');
        const wasSeeded = seeded.includes(`${t}.${c}`);
        ok(`${t}.${c} is migrated`, left === 0,
           wasSeeded ? `${left} row(s) still say smme` : '(no rows to migrate — vacuously true)');
      }
      ok('and at least one column actually held a row to move',
         seeded.length > 0,
         'every table was empty, so the assertions above proved nothing');
    }

    console.log('\nit retires the leftover product row rather than failing forever');
    {
      await pool.query(`DELETE FROM products WHERE product_type IN ('smme','short_term')`);
      await pool.query(`
        INSERT INTO products (id, product_type, label, is_active)
        VALUES ('prod-short', 'short_term', 'Short Term Investment', true),
               ('prod-smme',  'smme',       'SMME Investment',       true)
      `);
      const out = await runSetup();

      ok('the duplicate SMME product is gone',
         (await count('products', 'product_type', 'smme')) === 0,
         'it stays listed in the marketplace as a second tile');
      ok('the Short Term product it duplicated is untouched',
         (await count('products', 'product_type', 'short_term')) === 1);
      ok('and the removal is reported, naming what went',
         /Removed the leftover SMME product \("SMME Investment"\)/.test(out),
         out.split('\n').filter(l => /smme|SMME/i.test(l)).join(' | '));
      ok('no duplicate-key error is raised any more',
         !/duplicate key|products_product_type_key/i.test(out),
         out.split('\n').filter(l => /duplicate/i.test(l)).join(' | '));
    }

    console.log('\nwith no Short Term product it renames instead of deleting');
    {
      /* The original behaviour, and still the right one when the name is
         free — deleting there would lose the product entirely. */
      await pool.query(`DELETE FROM products WHERE product_type IN ('smme','short_term')`);
      await pool.query(`
        INSERT INTO products (id, product_type, label, is_active)
        VALUES ('prod-smme', 'smme', 'SMME Investment', true)
      `);
      await runSetup();
      ok('the row survives under the new name',
         (await count('products', 'product_type', 'short_term')) === 1,
         'the only SMME product was deleted rather than renamed');
      ok('and nothing is left under the old one',
         (await count('products', 'product_type', 'smme')) === 0);
    }

    console.log('\nit will not delete a product something still points at');
    {
      /* If a table above failed to migrate, its rows still name 'smme' and the
         product row they describe has to outlive the failure. */
      await pool.query(`DELETE FROM products WHERE product_type IN ('smme','short_term')`);
      await pool.query(`
        INSERT INTO products (id, product_type, label, is_active)
        VALUES ('prod-short', 'short_term', 'Short Term Investment', true),
               ('prod-smme',  'smme',       'SMME Investment',       true)
      `);
      /* The real failure mode is an UPDATE that runs and does not take, so
         that is what this reproduces: a trigger holds the value at 'smme'
         however the migration rewrites it. The step's own re-count is then the
         only thing standing between a live record and a deleted product. */
      await pool.query(`
        CREATE OR REPLACE FUNCTION smme_fixture_hold() RETURNS trigger AS $$
        BEGIN NEW.product_type := 'smme'; RETURN NEW; END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER smme_fixture_hold_trg BEFORE UPDATE ON invest_funnel_events
          FOR EACH ROW EXECUTE FUNCTION smme_fixture_hold();
      `);
      try {
        await pool.query(
          `INSERT INTO invest_funnel_events (event_type, product_type)
           VALUES ('smme-straggler-fixture', 'smme')`
        );
        ok('the fixture leaves a record the migration cannot move',
           (await count('invest_funnel_events', 'product_type', 'smme')) > 0);

        const out = await runSetup();
        ok('the record is still there after the migration ran',
           (await count('invest_funnel_events', 'product_type', 'smme')) > 0,
           'the trigger did not hold, so the guard was never put under load');
        ok('the product row is kept while a record still names it',
           (await count('products', 'product_type', 'smme')) === 1,
           'deleted a product that live records still refer to');
        ok('and it says how many are holding it back',
           /still reference 'smme'/.test(out),
           out.split('\n').filter(l => /smme/i.test(l)).join(' | '));
      } finally {
        await pool.query(`
          DROP TRIGGER IF EXISTS smme_fixture_hold_trg ON invest_funnel_events;
          DROP FUNCTION IF EXISTS smme_fixture_hold();
        `).catch(() => {});
      }
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
