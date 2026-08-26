#!/usr/bin/env node
/* A cancelled investment is an administrative record, not a holding.
 * Clients must not see it; admin must still see everything.
 *
 * It was showing on the client's own dashboard as a card, alongside real
 * holdings, complete with term progress and days remaining on money that had
 * been refunded.
 *
 * Filtered on the server rather than in the UI, so it never reaches the
 * browser and no screen can reintroduce it by forgetting a filter. This runs
 * the real WHERE clauses the route builds, against a real database — a string
 * match on the source would not prove the SQL is valid or that the condition
 * survives the alias rewrite the investments query applies.
 *
 * Needs a database:
 *   DATABASE_URL=postgres://… DATABASE_SSL=false node server/scripts/check-cancelled-hidden.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-cancelled-hidden.cjs header');
  process.exit(0);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const INV = 'CHK-CANCEL-INVESTOR';
const ACTIVE = 'CHK-CANCEL-ACTIVE';
const CANCELLED = 'CHK-CANCEL-CANCELLED';
const MATURED = 'CHK-CANCEL-MATURED';

async function schema() {
  await pool.query('DROP TABLE IF EXISTS investments, investors, investment_pools CASCADE');
  await pool.query(`
    CREATE TABLE investment_pools (
      id TEXT PRIMARY KEY, name TEXT, product_type TEXT, status TEXT,
      annual_rate NUMERIC(8,4) DEFAULT 0, actual_rate NUMERIC(8,4) DEFAULT 0
    );
    CREATE TABLE investors (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT);
    CREATE TABLE investments (
      id TEXT PRIMARY KEY, investor_id TEXT, pool_id TEXT, pool_name TEXT,
      amount NUMERIC(18,2) DEFAULT 0, annual_rate NUMERIC(8,4) DEFAULT 0,
      status TEXT, start_date DATE, end_date DATE, product_type TEXT
    );`);
  await pool.query(`INSERT INTO investors (id, first_name, last_name) VALUES ($1,'Christian','Eyssen')`, [INV]);
  await pool.query(`INSERT INTO investment_pools (id, name, product_type, status) VALUES ('CHK-POOL','Cattle August 2026','other','open')`);
  for (const [id, status] of [[ACTIVE, 'active'], [CANCELLED, 'cancelled'], [MATURED, 'matured']]) {
    await pool.query(
      `INSERT INTO investments (id, investor_id, pool_id, amount, status, product_type)
       VALUES ($1, $2, 'CHK-POOL', 6039.60, $3, 'other')`, [id, INV, status]);
  }
}

/* The route builds `conditions`, joins them into `where`, then for the
   investments table rewrites bare column names with an `i.` prefix. Both steps
   are reproduced here so the test exercises what actually runs. */
function buildInvestmentsQuery({ asInvestor }) {
  const params = [];
  const conditions = [];
  if (asInvestor) {
    params.push(INV);
    conditions.push(`investor_id = $${params.length}`);
    conditions.push(`COALESCE(status, '') <> 'cancelled'`);
  } else {
    params.push(INV);
    conditions.push(`investor_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const invWhere = where.replace(/\b(id|investor_id|pool_id|status|product_type|created_at|start_date|end_date|amount)\b/g, 'i.$1');
  return {
    text: `SELECT i.*, COALESCE(ip.product_type, i.product_type) AS product_type,
                  ip.actual_rate AS pool_actual_rate
           FROM investments i
           LEFT JOIN investment_pools ip ON ip.id = i.pool_id
           ${invWhere}`,
    params,
    invWhere,
  };
}

(async () => {
  try {
    await schema();
    console.log('\nseeded one active, one cancelled, one matured investment\n');

    const asClient = buildInvestmentsQuery({ asInvestor: true });
    const asAdmin  = buildInvestmentsQuery({ asInvestor: false });

    // The alias rewrite must not mangle the string literal 'cancelled'.
    ok("the alias rewrite leaves the literal 'cancelled' intact",
       asClient.invWhere.includes("<> 'cancelled'"),
       asClient.invWhere);
    ok('and it does prefix the column', /i\.status/.test(asClient.invWhere), asClient.invWhere);

    const client = await pool.query(asClient.text, asClient.params);
    const admin  = await pool.query(asAdmin.text, asAdmin.params);

    const ids = r => r.rows.map(x => x.id).sort();
    ok('the client does not receive the cancelled investment',
       !ids(client).includes(CANCELLED), JSON.stringify(ids(client)));
    ok('the client still receives the active one',
       ids(client).includes(ACTIVE), JSON.stringify(ids(client)));
    ok('the client still receives the matured one — that is a real holding',
       ids(client).includes(MATURED), JSON.stringify(ids(client)));
    ok('admin still sees all three',
       ids(admin).length === 3, JSON.stringify(ids(admin)));
    ok('admin still sees the cancelled one specifically',
       ids(admin).includes(CANCELLED), JSON.stringify(ids(admin)));

    // A NULL status must not be swallowed by the comparison — plain
    // `status <> 'cancelled'` is NULL for a NULL status, which is not true,
    // so the row would vanish. COALESCE is what stops that.
    await pool.query(`INSERT INTO investments (id, investor_id, pool_id, amount, status)
                      VALUES ('CHK-CANCEL-NULL', $1, 'CHK-POOL', 100, NULL)`, [INV]);
    const withNull = await pool.query(asClient.text, asClient.params);
    ok('an investment with a NULL status is still returned, not silently dropped',
       withNull.rows.some(r => r.id === 'CHK-CANCEL-NULL'),
       'COALESCE(status, \'\') is what prevents NULL <> \'cancelled\' returning NULL');

    /* The queries above reproduce the route's logic. Pin them to the real
       source, or this passes while the route drifts away from it. */
    console.log('\nthe running code actually carries these conditions');
    const ROOT = path.join(__dirname, '..', '..');
    const tables = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'tables.js'), 'utf8');
    ok('the list route excludes cancelled for investors',
       /COALESCE\(status, ''\) <> 'cancelled'/.test(tables),
       'server/routes/tables.js no longer filters it');
    ok('and only inside the investor-isolation branch, so staff are unaffected',
       (() => {
         const at = tables.indexOf("COALESCE(status, '') <> 'cancelled'");
         const branch = tables.lastIndexOf("req.user.role === 'investor'", at);
         const nextRole = tables.indexOf("req.user.role === 'ifa'", branch);
         return branch !== -1 && (nextRole === -1 || at < nextRole);
       })(),
       'the condition escaped the investor branch — admin would lose the record too');
    ok('the single-record route 404s a cancelled investment for a client',
       /table === 'investments' && rows\[0\]\.status === 'cancelled'/.test(tables));

    const invRoute = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'investments.js'), 'utf8');
    ok('a client cannot set a maturity instruction on a cancelled investment',
       /inv\.status === 'cancelled'/.test(invRoute),
       'the single-investment path never checked status');

    for (const rel of ['portal/js/portal.js', 'mobile/src/js/portal.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // Matched on the investments list specifically — a loose 'cancelled'
      // regex also hits the transaction filters and passes without the guard.
      ok(`${rel} also filters it client-side`,
         /myInvests = myInvests\.filter\(i => \(i\.status \|\| ''\) !== 'cancelled'\)/.test(src),
         'a cached bundle could put the card back on screen');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    try { await pool.query('DROP TABLE IF EXISTS investments, investors, investment_pools CASCADE'); } catch (_) {}
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
