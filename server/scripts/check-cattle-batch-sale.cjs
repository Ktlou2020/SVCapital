#!/usr/bin/env node
/* Selling a lot of cattle in one action.
 *
 * The operator's unit of work is the load that left the farm, not the beast.
 * Selling 113 animals one at a time is 113 dialogs and 113 writes, which is
 * what was reported.
 *
 * The money is entered once, as the total the lot fetched, and divided across
 * the animals. That division is where this can go quietly wrong: a cycle's
 * realised value is SUMMED back off these rows, so a split that rounds per
 * animal either invents money or loses it, and nothing on any screen says so.
 *
 *   R1 000 000 over 113 animals, rounded per head:
 *     113 x R8 849.56 = R1 000 000.28   28 cents invented
 *     113 x R8 849.55 =   R999 999.15   85 cents lost
 *
 * Split in cents with the remainder handed out one cent at a time, it comes
 * back to exactly R1 000 000.00. That is the property this file exists for,
 * and it is checked against a real database rather than asserted about code.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-cattle-batch-sale.cjs
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
const db   = new Pool({ connectionString: process.env.DATABASE_URL, ssl: SSL });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-cattle-batch-secret';
const router = require(path.join(ROOT, 'server', 'routes', 'cattle.js'));
const jwt    = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const FUND   = { id: 'u-cbs', email: 'cbs@svcapital.co.za', role: 'fund_manager', first_name: 'C' };

function call(method, url, body, user) {
  return new Promise(resolve => {
    const req = {
      method, url, originalUrl: url, baseUrl: '', body: body || {}, query: {}, params: {},
      headers: { 'user-agent': 'check',
                 authorization: 'Bearer ' + jwt.sign(user || FUND, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '10m' }) },
      cookies: {}, ip: '203.0.113.11',
      get(h) { return this.headers[String(h).toLowerCase()]; },
    };
    let code = 200;
    const res = {
      statusCode: 200,
      status(c) { code = c; this.statusCode = c; return this; },
      set() { return this; }, setHeader() { return this; },
      json(p) { resolve({ status: code, body: p }); return this; },
      send(p) { resolve({ status: code, body: p }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { error: 'no route' } }));
  });
}

const CYC = 'CYC-CBSCHK';
const ids = n => Array.from({ length: n }, (_, i) => `A-CBS-${i + 1}`);

async function seed(n) {
  await db.query(`DELETE FROM cattle_animals WHERE cycle_id = $1`, [CYC]);
  await db.query(`DELETE FROM cattle_cycles  WHERE id = $1`, [CYC]);
  await db.query(
    `INSERT INTO cattle_cycles (id, batch_name, cycle_no, status, no_live, no_purchased, purchase_value)
     VALUES ($1,'Batch sale check','CBS','active',$2,$2,900000)`, [CYC, n]);
  await db.query(
    `INSERT INTO cattle_animals (id, tag_number, batch_no, cycle_id, entry_mass, breed, status)
     SELECT 'A-CBS-'||g, 'CBS-'||g, 'CBS', $1, 200+g, 'Brahman', 'active'
       FROM generate_series(1,$2) g`, [CYC, n]);
}
const sumOf = async () =>
  Number((await db.query(`SELECT COALESCE(SUM(sale_value),0) s FROM cattle_animals WHERE cycle_id=$1`, [CYC])).rows[0].s);

(async () => {
  try {
    await require(path.join(ROOT, 'server', 'db', 'setup.js'))().catch(() => {});

    console.log('\nthe total is what the batch realises, to the cent');
    {
      /* Every one of these divides badly on purpose. */
      for (const [n, total] of [[113, 1000000], [3, 400000], [7, 1000], [113, 999999.99],
                                [2, 0.01], [11, 100], [113, 1234567.89]]) {
        await seed(n);
        const r = await call('POST', `/cycles/${CYC}/sell-animals`,
          { animal_ids: ids(n), total_value: total });
        const got = await sumOf();
        ok(`${String(n).padStart(3)} animals for ${total} sums back exactly`,
           r.status === 200 && Math.abs(got - total) < 1e-9,
           `status ${r.status}, sum ${got}`);
      }
    }

    console.log('\nand the split is the fairest one, not an arbitrary one');
    {
      await seed(113);
      await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ids(113), total_value: 1000000 });
      const { rows } = await db.query(
        `SELECT sale_value::text v, COUNT(*)::int n FROM cattle_animals
          WHERE cycle_id=$1 GROUP BY sale_value ORDER BY sale_value DESC`, [CYC]);
      ok('at most two distinct values', rows.length <= 2, JSON.stringify(rows));
      const cents = rows.map(r => Math.round(parseFloat(r.v) * 100));
      ok('and they differ by exactly one cent',
         rows.length === 1 || Math.abs(cents[0] - cents[1]) === 1, JSON.stringify(rows));
      ok('85 of them carry the extra cent',
         rows.length === 2 && rows[0].n === 85 && rows[1].n === 28, JSON.stringify(rows));
    }

    console.log('\nthe batch is recognisable, and the cycle keeps up');
    {
      await seed(10);
      const r = await call('POST', `/cycles/${CYC}/sell-animals`,
        { animal_ids: ids(10), total_value: 50000, sale_date: '2026-09-20' });
      ok('one shared sale_batch reference', !!r.body.sale_batch && /^SALE-\d{8}-/.test(r.body.sale_batch),
         String(r.body.sale_batch));
      const { rows: [g] } = await db.query(
        `SELECT COUNT(DISTINCT sale_batch)::int b, COUNT(*)::int n,
                COUNT(*) FILTER (WHERE sale_date = DATE '2026-09-20')::int dated
           FROM cattle_animals WHERE cycle_id=$1`, [CYC]);
      ok('every animal carries it', g.b === 1 && g.n === 10, JSON.stringify(g));
      ok('and the sale date given', g.dated === 10, JSON.stringify(g));
      ok('the cycle counts were recomputed',
         r.body.cycle && r.body.cycle.no_sold === 10 && r.body.cycle.no_live === 0,
         JSON.stringify(r.body.cycle));
    }

    console.log('\nwhat it refuses');
    {
      await seed(5);
      ok('an empty selection',
         (await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: [], total_value: 100 })).status === 400);
      ok('a sale with no value — which would book the purchase as a loss',
         (await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ids(2) })).status === 400);
      ok('a negative value',
         (await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ids(2), total_value: -1 })).status === 400);
      ok('a batch that does not exist',
         (await call('POST', `/cycles/CYC-NOPE/sell-animals`, { animal_ids: ids(1), total_value: 1 })).status === 404);

      /* Zero IS allowed — a lot genuinely can realise nothing — but only by
         typing it, which is the distinction the cycle-level route draws too. */
      const zero = await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ['A-CBS-1'], total_value: 0 });
      ok('but zero, typed deliberately, is allowed', zero.status === 200, JSON.stringify(zero.body).slice(0,90));

      const again = await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ['A-CBS-1'], total_value: 500 });
      ok('an animal already sold is not sold twice', again.status === 409, JSON.stringify(again.body));

      await db.query(`UPDATE cattle_cycles SET status='sold' WHERE id=$1`, [CYC]);
      const closed = await call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ['A-CBS-2'], total_value: 500 });
      ok('a closed batch', closed.status === 409, JSON.stringify(closed.body));
      await db.query(`UPDATE cattle_cycles SET status='active' WHERE id=$1`, [CYC]);
    }

    console.log('\nit sells only what belongs to the batch, and says how many');
    {
      await seed(4);
      await db.query(
        `INSERT INTO cattle_cycles (id, batch_name, status) VALUES ('CYC-CBSOTHER','Other','active')
         ON CONFLICT (id) DO NOTHING`);
      await db.query(
        `INSERT INTO cattle_animals (id, tag_number, cycle_id, status)
         VALUES ('A-CBS-OTHER','OTHER-1','CYC-CBSOTHER','active') ON CONFLICT (id) DO NOTHING`);

      const r = await call('POST', `/cycles/${CYC}/sell-animals`,
        { animal_ids: [...ids(4), 'A-CBS-OTHER'], total_value: 4000 });
      ok('an animal from another batch is left alone', r.status === 200 && r.body.sold === 4,
         `sold ${r.body && r.body.sold}`);
      ok('and the count reported is what moved, not what was asked',
         r.body.sold === 4 && r.body.requested === 5, JSON.stringify({ sold: r.body.sold, requested: r.body.requested }));
      const { rows: [o] } = await db.query(
        `SELECT COALESCE(sold,false) s FROM cattle_animals WHERE id='A-CBS-OTHER'`);
      ok('the other batch’s animal is untouched', o.s === false);
      ok('and the total still landed on the four', Math.abs(await sumOf() - 4000) < 1e-9);
    }

    console.log('\ntwo operators, one lot');
    {
      /* The rows are locked when they are read, not when they are written.
         Without that, two people selling the same load at the same time both
         read it live, both write, and the batch is booked twice at whichever
         price landed last — with no error anywhere to say so. */
      await seed(6);
      const [a, b] = await Promise.all([
        call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ids(6), total_value: 60000 }),
        call('POST', `/cycles/${CYC}/sell-animals`, { animal_ids: ids(6), total_value: 90000 }),
      ]);
      const codes = [a.status, b.status].sort();
      ok('one of the two sales wins and the other is refused',
         codes[0] === 200 && codes[1] === 409, JSON.stringify(codes));
      const got = await sumOf();
      ok('and the lot is booked once, at one of the two totals',
         Math.abs(got - 60000) < 1e-9 || Math.abs(got - 90000) < 1e-9, `sum ${got}`);
      const { rows: [g] } = await db.query(
        `SELECT COUNT(DISTINCT sale_batch)::int b FROM cattle_animals WHERE cycle_id=$1`, [CYC]);
      ok('under one sale reference, not two', g.b === 1, JSON.stringify(g));
    }

    console.log('\nwhen the write itself fails');
    {
      /* A date Postgres cannot parse throws partway through the loop. The
         transaction has to be rolled back on the way out or the connection
         goes back to the pool inside a failed transaction and poisons the
         next request that borrows it — which is a different operator's. */
      await seed(4);
      const bad = await call('POST', `/cycles/${CYC}/sell-animals`,
        { animal_ids: ids(4), total_value: 4000, sale_date: 'the day after the rains' });
      ok('the request fails rather than writing half a sale', bad.status >= 400, JSON.stringify(bad.body).slice(0,80));
      ok('and nothing was written', (await sumOf()) === 0);

      const after = await call('POST', `/cycles/${CYC}/sell-animals`,
        { animal_ids: ids(4), total_value: 4000 });
      ok('the next sale still goes through', after.status === 200 && after.body.sold === 4,
         `status ${after.status} ${JSON.stringify(after.body).slice(0,90)}`);
      ok('and it is the one that lands', Math.abs(await sumOf() - 4000) < 1e-9);
    }

    console.log('\nall of it, or none of it');
    {
      const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'cattle.js'), 'utf8');
      const route = src.slice(src.indexOf("router.post('/cycles/:id/sell-animals'"));
      const body  = route.slice(0, route.indexOf('\nrouter.'));
      ok('the sale runs in a transaction', /BEGIN/.test(body) && /COMMIT/.test(body));
      ok('and rolls back on anything thrown', /ROLLBACK/.test(body));
      ok('the cycle is locked before it is read',
         /FROM cattle_cycles WHERE id = \$1 FOR UPDATE/.test(body));
      ok('and the animals are locked in the statement that selects them',
         /FROM cattle_animals[\s\S]*?FOR UPDATE/.test(body),
         'two operators selling the same lot would otherwise both succeed');
      ok('and the arithmetic is asserted before the commit',
         /\n\s*if \(allocated !== totalCents\) \{/.test(body),
         'a split that did not add up must not be written');
    }

    await db.query(`DELETE FROM cattle_animals WHERE cycle_id IN ($1,'CYC-CBSOTHER')`, [CYC]);
    await db.query(`DELETE FROM cattle_cycles  WHERE id IN ($1,'CYC-CBSOTHER')`, [CYC]);
  } catch (err) {
    console.error('\n  ✗ threw:', err.stack || err.message);
    fail++;
  } finally {
    await db.end().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
