#!/usr/bin/env node
/* Every money movement says who made it.
 *
 * A transactions row carried what moved, to whom, and when, and never who
 * did it. A staff member crediting a wallet from the console, posting
 * interest, or settling a reconciliation wrote a row indistinguishable from
 * one the client caused themselves. For an FSP holding client money that is
 * the first question a dispute or a regulator asks, and it is the one answer
 * that cannot be reconstructed afterwards.
 *
 * Forty INSERT INTO transactions statements across eighteen files is how it
 * happened. Adding a column to forty call sites is how it would happen
 * again — the forty-first gets written without one and nothing says so. So
 * there is ONE writer, services/ledger.js recordTransaction, it refuses a
 * row with no actor, and this check refuses a second writer.
 *
 * Run: DATABASE_URL=… node server/scripts/check-transaction-actor.cjs
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* The writer itself, plus the places that legitimately build a database from
   nothing: a seed and a one-off import are not money moving, they are a
   database being created. */
const ALLOWED = new Set([
  'server/services/ledger.js',
  'server/db/seed.js',
  'server/db/setup.js',
  'server/scripts/migrate-from-firebase.js',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, abs));
  }
  return out;
}

const files = walk(path.join(ROOT, 'server'));

console.log('one writer, and it is the one that knows about actors');
{
  const writers = files.filter(rel =>
    !ALLOWED.has(rel) && /INSERT\s+INTO\s+transactions\b/i.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  ok('nothing writes a transaction except the ledger',
     writers.length === 0,
     writers.join('\n      ')
     + '\n      use recordTransaction(db, tx, actor) from services/ledger.js');

  const ledger = fs.readFileSync(path.join(ROOT, 'server', 'services', 'ledger.js'), 'utf8');
  ok('and the writer refuses a row with no actor',
     /ACTOR_KINDS\.includes\(actor\.kind\)/.test(ledger)
     && /throw new Error/.test(ledger),
     'a writer that accepts a missing actor is the forty-first call site');
  ok('a cron has to name itself',
     /systemActor\(jobName\)[\s\S]{0,200}throw new Error/.test(ledger),
     'an unattended credit recorded as "system" with no job name says no more '
     + 'than no record at all');
}

console.log('\nand it writes what it says it writes');
{
  const { recordTransaction, actorFromRequest, systemActor } =
    require(path.join(ROOT, 'server', 'services', 'ledger.js'));

  /* A fake db that records the statement rather than running it, so the
     shape of the INSERT is checked without a database. */
  const seen = [];
  const db = { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ id: 'x' }] }; } };

  (async () => {
    const actor = { kind: 'staff', id: 'u1', email: 'k@svcapital.co.za', role: 'admin', ip: '1.2.3.4' };
    await recordTransaction(db, { investorId: 'INV-1', type: 'deposit', amount: 500 }, actor);
    const { sql, params } = seen[0];

    ok('the actor columns are in the statement',
       /actor_kind/.test(sql) && /actor_email/.test(sql) && /actor_ip/.test(sql));
    ok('and carry the actor it was given',
       params.includes('staff') && params.includes('k@svcapital.co.za')
       && params.includes('1.2.3.4'),
       JSON.stringify(params));

    /* The numbering bug this almost shipped with: two columns take no
       parameter, so numbering by column position and then dropping them
       reads every argument one place to the left. */
    const highest = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    ok('every placeholder has an argument, and every argument a placeholder',
       highest === params.length,
       `$${highest} is the highest placeholder and ${params.length} arguments were passed`);

    let refused = null;
    try { await recordTransaction(db, { investorId: 'INV-1', type: 'deposit', amount: 500 }, null); }
    catch (e) { refused = e.message; }
    ok('a row with no actor is refused', !!refused, 'it was written anyway');
    ok('and the refusal says what was being written',
       /deposit/.test(refused || '') && /500/.test(refused || ''),
       refused || '(nothing thrown)');

    let named = null;
    try { systemActor(); } catch (e) { named = e.message; }
    ok('a system actor with no job name is refused', !!named, named || '(accepted)');

    const staff = actorFromRequest({ user: { id: 'u9', email: 'a@b.c', role: 'admin' }, ip: '9.9.9.9' });
    ok('a staff request reads as staff', staff.kind === 'staff', JSON.stringify(staff));
    const client = actorFromRequest({ user: { investorId: 'INV-7', email: 'c@d.e', role: 'investor' }, ip: '8.8.8.8' });
    ok('and a client request as a client',
       client.kind === 'client' && client.id === 'INV-7', JSON.stringify(client));
    const anon = actorFromRequest({});
    ok('and a request with no user is still a client, not a staff member',
       anon.kind === 'client' && anon.id === null,
       JSON.stringify(anon) + ' — defaulting an unknown caller to staff would '
       + 'put a name on money nobody can account for');

    await schemaAndRoundTrip();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

/* The part that needs a database. Two things source alone cannot tell you:
   that every column the writer names actually exists — a writer naming one
   the schema has not got fails with "column does not exist", which reads
   like a product bug and is not — and that an actor survives the round trip
   into the row. */
async function schemaAndRoundTrip() {
  if (!process.env.DATABASE_URL) {
    /* Not a skip: the source half above is the whole check on a machine with
       no database, and the runner holds the count either way. */
    console.log('\n  (no DATABASE_URL — the schema half did not run)');
    fail++;
    console.log('  ✗ the schema half needs a database');
    return;
  }
  const { Pool } = require(path.join(ROOT, 'server', 'node_modules', 'pg'));
  const db = new Pool({ connectionString: process.env.DATABASE_URL,
                        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  try {
    console.log('\nand the columns it names are really there');
    const { TX_COLUMNS } = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'`);
    const have = new Set(rows.map(r => r.column_name));
    const missing = (TX_COLUMNS || []).filter(c => !have.has(c));
    ok('every column the writer writes exists in the schema',
       (TX_COLUMNS || []).length > 0 && missing.length === 0,
       missing.length ? `missing: ${missing.join(', ')}` : 'TX_COLUMNS is not exported');

    console.log('\nand an actor survives the round trip');
    const { recordTransaction } = require(path.join(ROOT, 'server', 'services', 'ledger.js'));
    await db.query(`INSERT INTO investors (id, first_name, last_name, email, wallet_balance)
                    VALUES ('INV-ACTOR','A','B','actor@example.test',0)
                    ON CONFLICT (id) DO NOTHING`);
    const ref = 'ACTOR-' + Date.now();
    await recordTransaction(db, {
      investorId: 'INV-ACTOR', type: 'deposit', amount: 12.34, reference: ref,
      description: 'round trip',
    }, { kind: 'staff', id: 'u-1', email: 'kagiso@svcapital.co.za', role: 'admin', ip: '41.0.0.1' });
    const { rows: back } = await db.query(
      'SELECT actor_kind, actor_id, actor_email, actor_role, actor_ip FROM transactions WHERE reference = $1', [ref]);
    const r = back[0] || {};
    console.log('\nand the client is not handed our own people with it');
    const { stripSensitive } = require(path.join(ROOT, 'server', 'routes', 'tables.js'));
    const asRow = [{ id: 't1', amount: 10, actor_kind: 'staff', actor_id: 'u-1',
                     actor_email: 'kagiso@svcapital.co.za', actor_role: 'admin',
                     actor_ip: '41.0.0.1' }];
    const toClient = stripSensitive('transactions', asRow, null, 'investor')[0];
    const toStaff  = stripSensitive('transactions', asRow, null, 'admin')[0];
    ok('a client sees no staff email, role or address',
       !('actor_email' in toClient) && !('actor_role' in toClient)
       && !('actor_ip' in toClient) && !('actor_id' in toClient),
       JSON.stringify(toClient));
    ok('but is still told it was not their own doing',
       toClient.actor_kind === 'staff',
       'a client is entitled to know a row was ours; actor_kind names nobody');
    ok('and staff see all of it',
       toStaff.actor_email === 'kagiso@svcapital.co.za' && toStaff.actor_ip === '41.0.0.1',
       JSON.stringify(toStaff));

    ok('the row says who moved the money',
       r.actor_kind === 'staff' && r.actor_email === 'kagiso@svcapital.co.za'
       && r.actor_role === 'admin' && r.actor_ip === '41.0.0.1' && r.actor_id === 'u-1',
       JSON.stringify(r));
  } catch (err) {
    fail++;
    console.log(`  ✗ the schema half threw\n      ${err.message}`);
  } finally {
    await db.end().catch(() => {});
  }
}
