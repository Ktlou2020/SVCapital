#!/usr/bin/env node
/* An interest credit must depend on the transaction row being written.
 *
 * The apply route inserted the transaction with ON CONFLICT (reference) DO
 * NOTHING and then credited the wallet regardless. So a reference that already
 * existed produced a second credit against a single ledger row.
 *
 * A straight re-apply never reached it: interest_distributions carries a
 * partial unique index on (period) WHERE status = 'applied', and the whole
 * apply runs in one transaction, so the duplicate period aborts everything.
 * That index — not the ON CONFLICT — is what has been holding this up.
 *
 * It becomes reachable the moment a period moves out from under that index: a
 * run voided, a status corrected by hand, or a reverse feature added later.
 * Then the wallets double and the ledger still shows one row.
 *
 * interestCron.js does the same job correctly, gating on rowCount and calling
 * the INSERT "the idempotency gate".
 *
 * Needs a database:
 *   DATABASE_URL=postgres://… DATABASE_SSL=false node server/scripts/check-interest-credit.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-interest-credit.cjs header');
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
const eqN = (name, a, b) => ok(name, Math.abs(Number(a) - Number(b)) < 0.005, `expected ${b}, got ${a}`);

const ROOT = path.join(__dirname, '..', '..');

async function schema() {
  await pool.query(`DROP TABLE IF EXISTS interest_distribution_items, interest_distributions,
                                        transactions, investors CASCADE`);
  await pool.query(`
    CREATE TABLE investors (id TEXT PRIMARY KEY, wallet_balance NUMERIC(18,2) DEFAULT 0);
    CREATE TABLE transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), investor_id TEXT, sub_account_id TEXT,
      type TEXT, amount NUMERIC(18,2), status TEXT, reference TEXT UNIQUE,
      description TEXT, transaction_date TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE interest_distributions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), period TEXT NOT NULL,
      total_interest NUMERIC(18,2) DEFAULT 0, accounts_credited INT DEFAULT 0,
      accounts_skipped INT DEFAULT 0, status TEXT);
    CREATE UNIQUE INDEX id_period_applied_idx
      ON interest_distributions(period) WHERE status = 'applied';
    CREATE TABLE interest_distribution_items (
      id SERIAL PRIMARY KEY, distribution_id UUID, investor_id TEXT,
      interest_amount NUMERIC(18,2), transaction_id UUID, status TEXT, notes TEXT);`);
  await pool.query(`INSERT INTO investors (id, wallet_balance) VALUES ('S-INT', 0)`);
}

const bal = async () =>
  Number((await pool.query(`SELECT wallet_balance FROM investors WHERE id='S-INT'`)).rows[0].wallet_balance);
const ledgerRows = async ref =>
  Number((await pool.query(`SELECT count(*)::int n FROM transactions WHERE reference=$1`, [ref])).rows[0].n);

/* The apply loop, gated the way the route now gates it. */
async function apply({ period, amount, gated }) {
  const client = await pool.connect();
  const ref = `INT-${period}-S-INT`;
  try {
    await client.query('BEGIN');
    const { rows: [d] } = await client.query(
      `INSERT INTO interest_distributions (period, status) VALUES ($1,'applied') RETURNING id`, [period]);

    const tx = await client.query(
      `INSERT INTO transactions (investor_id, type, amount, status, reference)
       VALUES ('S-INT','interest',$1,'completed',$2)
       ON CONFLICT (reference) DO NOTHING RETURNING id`, [amount, ref]);
    const txId = tx.rows[0]?.id || null;

    let credited = 0, skipped = 0;
    if (!txId && gated) {
      skipped = 1;
      await client.query(
        `INSERT INTO interest_distribution_items (distribution_id, investor_id, interest_amount, status, notes)
         VALUES ($1,'S-INT',$2,'skipped_duplicate',$3)`,
        [d.id, amount, `Already credited under ${ref} — wallet left unchanged.`]);
    } else {
      credited = 1;
      await client.query(
        `UPDATE investors SET wallet_balance = wallet_balance + $1 WHERE id='S-INT'`, [amount]);
    }
    await client.query(
      `UPDATE interest_distributions SET accounts_credited=$2, accounts_skipped=$3, total_interest=$4 WHERE id=$1`,
      [d.id, credited, skipped, credited ? amount : 0]);
    await client.query('COMMIT');
    return { credited, skipped, blocked: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (/duplicate key/.test(err.message)) return { blocked: true };
    throw err;
  } finally { client.release(); }
}

(async () => {
  try {
    await schema();
    const REF = 'INT-2026-08-S-INT';

    console.log('\napplying a period credits once');
    await apply({ period: '2026-08', amount: 250, gated: true });
    eqN('the wallet is credited', await bal(), 250);
    eqN('and the ledger has one row', await ledgerRows(REF), 1);

    console.log('\nthe partial unique index blocks a straight re-apply');
    const again = await apply({ period: '2026-08', amount: 250, gated: true });
    ok('the second apply is refused outright', again.blocked === true, JSON.stringify(again));
    eqN('so the wallet is unchanged', await bal(), 250);

    console.log('\nthe case that index does not cover: the run is voided, then re-applied');
    await pool.query(`UPDATE interest_distributions SET status='reversed' WHERE period='2026-08'`);

    // What the code did before: credit regardless of the insert.
    const ungated = await apply({ period: '2026-08', amount: 250, gated: false });
    eqN('ungated, the wallet doubles', await bal(), 500);
    eqN('while the ledger still shows one row', await ledgerRows(REF), 1);
    ok('— that is the defect', ungated.credited === 1);

    // Reset and do it the way the route now does.
    await pool.query(`UPDATE investors SET wallet_balance = 250 WHERE id='S-INT'`);
    await pool.query(`UPDATE interest_distributions SET status='reversed' WHERE period='2026-08'`);

    const gated = await apply({ period: '2026-08', amount: 250, gated: true });
    eqN('gated on the insert, the wallet is left alone', await bal(), 250);
    ok('and the item is recorded as already credited', gated.skipped === 1, JSON.stringify(gated));
    const item = (await pool.query(
      `SELECT status, notes FROM interest_distribution_items WHERE status='skipped_duplicate' LIMIT 1`)).rows[0];
    ok('with a note saying so', item && /Already credited/.test(item.notes), JSON.stringify(item));
    eqN('the ledger still shows one row', await ledgerRows(REF), 1);

    console.log('\nthe run reports what actually moved');
    const d = (await pool.query(
      `SELECT accounts_credited, accounts_skipped, total_interest FROM interest_distributions
        WHERE status='applied' ORDER BY id DESC LIMIT 1`)).rows[0];
    ok('credited 0, skipped 1, total R0 — not the figure it set out to apply',
       d && d.accounts_credited === 0 && d.accounts_skipped === 1 && Number(d.total_interest) === 0,
       JSON.stringify(d));

    console.log('\nthe route carries the gate');
    const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'interest.js'), 'utf8');
    ok('the credit is skipped when the insert did nothing',
       /if \(!txId\) \{[\s\S]*?continue;/.test(src) &&
       src.indexOf('continue;', src.indexOf('if (!txId) {')) <
         src.indexOf('wallet_balance = wallet_balance +', src.indexOf('if (!txId) {')),
       'the credit still runs whether or not the transaction row was written');
    ok('the skip is recorded rather than passed over silently',
       /'skipped_duplicate'/.test(src));
    ok('and the stored totals are corrected from what happened',
       /SET accounts_credited = \$2[\s\S]{0,200}total_interest    = \$4/.test(src),
       'the row keeps the pre-loop estimate, which overstates the money moved');

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message);
    fail++;
  } finally {
    await pool.query(`DROP TABLE IF EXISTS interest_distribution_items, interest_distributions,
                                          transactions, investors CASCADE`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
