#!/usr/bin/env node
/* Published performance must mean what it says.
 *
 * investment_pools.actual_rate is the return achieved FOR THAT POOL'S PERIOD,
 * for every product — the rule the maturity engine already pays by
 * (postedReturnFor multiplies amount × actual_rate, with no proration).
 * products.js still held the older reading: short_term was the one product
 * treated as period-based, everything else as per annum.
 *
 * Two public figures came out of that, both on the marketing site and the
 * portal:
 *
 *   total_paid_back   invested × (1 + actual × term/12). For a 12-month cattle
 *                     pool term/12 is 1, so cattle matched and the error stayed
 *                     invisible. For solar_7yr it is SEVEN. On R100,000 at a
 *                     98% period return the site published R786,000 paid back
 *                     against a true R198,000.
 *
 *   avg_actual_rate   the period figure, shown under a label reading "p.a.".
 *                     The same solar pool published 98% p.a. where the
 *                     annualised figure is 14.00%.
 *
 * These are disclosure figures for a regulated FSP, so the arithmetic is
 * exercised against a real request to the real router rather than asserted
 * from the source.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-track-record-rates.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const near = (a, b, tol = 0.0001) => Math.abs(Number(a) - Number(b)) <= tol;

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investment_pools', 'investments', 'products']]);
  if (rows[0].ready) return true;
  if (!isScratchDatabase(process.env.DATABASE_URL) && process.env.CHECK_ALLOW_RESET !== '1') {
    console.log('  SKIP  incomplete schema and this is not a scratch database.');
    return false;
  }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const q = console.log; console.log = () => {};
  try { await require(path.join(ROOT, 'server', 'db', 'setup.js'))(); } finally { console.log = q; }
  return true;
}

const wipe = async () => {
  await pool.query(`DELETE FROM investments      WHERE pool_id LIKE 'TRK-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'TRK-%'`);
};

/* Three matured pools, each posting a return for its own period:
     cattle      12 months  — where period and annual coincide, so the old code
                              agreed and the defect stayed hidden
     solar_7yr   84 months  — where they diverge sevenfold
     short_term   5 months  — the one product the old code got right      */
async function seed() {
  await wipe();
  await pool.query(`
    INSERT INTO investment_pools (id, name, product_type, status, end_date, annual_rate, actual_rate, term_months, raised_amount)
    VALUES ('TRK-CAT','Cattle Investment - August 2025','cattle','matured',    CURRENT_DATE-10, 0.16, 0.1223, 12, 100000),
           ('TRK-SOL','Solar 7yr - 2019',               'solar_7yr','matured', CURRENT_DATE-20, 0.14, 0.98,   84, 100000),
           ('TRK-ST', 'Short Term - March 2026',        'short_term','matured',CURRENT_DATE-5,  0.05, 0.0213,  5, 100000)`);
}

/* The real router, over a real socket. */
function serve() {
  const express = require(path.join(ROOT, 'server', 'node_modules', 'express'));
  const app = express();
  app.use('/api/products', require(path.join(ROOT, 'server', 'routes', 'products.js')));
  return new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const get = (port, url) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: url }, res => {
    let b = ''; res.on('data', d => (b += d));
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error(b.slice(0, 200))); } });
  }).on('error', reject);
});

(async () => {
  let srv;
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    await seed();
    srv = await serve();
    const port = srv.address().port;

    const { status, body } = await get(port, '/api/products/track-record');
    ok('the endpoint answers', status === 200, `status ${status}`);
    const d = body.data || {};

    console.log('\npaid back is what the engine actually paid');
    {
      /* postedReturnFor pays amount × actual_rate with no proration, so this
         is not a matter of convention — a different figure here is simply not
         reporting what left the platform. */
      ok('cattle: R100,000 at a 12.23% period return',
         d.cattle && d.cattle.total_paid_back === 112230, JSON.stringify(d.cattle?.total_paid_back));
      ok('solar 7yr: R100,000 at a 98% period return is R198,000',
         d.solar_7yr && d.solar_7yr.total_paid_back === 198000,
         `got ${d.solar_7yr?.total_paid_back} — the old expression gave 786000, a 7× proration`);
      ok('short term: R100,000 at 2.13%',
         d.short_term && d.short_term.total_paid_back === 102130, JSON.stringify(d.short_term?.total_paid_back));
      ok('no product is prorated by its term any more',
         d.solar_7yr?.total_paid_back !== 786000);
    }

    console.log('\nthe rate is annualised for every product, not one of them');
    {
      ok('cattle over 12 months is unchanged by annualising',
         near(d.cattle?.avg_actual_rate, 0.1223), String(d.cattle?.avg_actual_rate));
      ok('solar 7yr annualises 98% over 84 months to 14%',
         near(d.solar_7yr?.avg_actual_rate, 0.14), String(d.solar_7yr?.avg_actual_rate));
      ok('and that lands exactly on the pool\'s own benchmark',
         near(d.solar_7yr?.avg_benchmark_rate, 0.14) && near(d.solar_7yr?.avg_actual_rate, 0.14),
         'a pool that achieves its benchmark should annualise back to it — corroboration that ' +
         'the column really does hold a period return');
      ok('short term still annualises as it always did',
         near(d.short_term?.avg_actual_rate, 0.0213 * 12 / 5), String(d.short_term?.avg_actual_rate));
    }

    console.log('\nthe figure as posted is carried, not discarded');
    {
      const sol = d.solar_7yr?.pools?.[0];
      ok('each pool reports its period rate', sol && near(sol.period_rate, 0.98), JSON.stringify(sol));
      ok('and its term, so the annualisation can be checked',
         sol && sol.term_months === 84, JSON.stringify(sol?.term_months));
      ok('alongside the annualised figure', sol && near(sol.actual_rate, 0.14));
    }

    console.log('\nthe response says what its numbers mean');
    {
      ok('the basis is declared, not left to each caller',
         body.rate_basis === 'annualised_simple', JSON.stringify(body.rate_basis));
      ok('and the note explains both figures',
         /period/.test(body.note || '') && /annualised/.test(body.note || ''), body.note);
    }

    console.log('\nthe products list exposes both bases too');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'products.js'), 'utf8');
      ok('as posted, per period', /AS avg_period_rate/.test(src));
      ok('and annualised for the p.a. label the clients use',
         /ip\.actual_rate \* 12\.0 \/ ip\.term_months/.test(src));
      ok('a pool with no term is left alone rather than divided by zero',
         /COALESCE\(ip\.term_months, 0\) > 0/.test(src));
    }

    console.log('\nthe one-product special case is gone');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'products.js'), 'utf8');
      ok('short_term is no longer singled out in the arithmetic',
         !/const isShortTerm = t === 'short_term'/.test(src),
         'treating one product as period-based and the rest as p.a. is the reading being retired');
      ok('and nothing multiplies a return by term / 12',
         !/actual \* \(term \/ 12\)/.test(src));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    if (srv) srv.close();
    await wipe().catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
