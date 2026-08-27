#!/usr/bin/env node
/* A completed deposit must actually land somewhere.
 *
 * payments.js creditWallet() routes a deposit to a sub-account when a
 * sub_account_id is supplied:
 *
 *     if (subAccountId) {
 *       UPDATE sub_accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2
 *     } else {
 *       UPDATE investors ...
 *     }
 *
 * Neither branch checks how many rows it updated, and the sub-account branch
 * never checks that the sub-account belongs to the investor paying.
 *
 * Where the id comes from matters. The Paystack webhook reads it straight from
 * data.metadata.sub_account_id. The webhook itself is HMAC-verified, so the
 * metadata is genuinely Paystack's — but Paystack is echoing what the browser
 * set when the payment was initialised, and there is no server-side initiate
 * route to validate it. Nothing between the browser and the wallet ever asks
 * whether that sub-account exists or is the payer's.
 *
 * Two consequences:
 *
 *   1. An id that matches no row credits nothing, while the transactions row
 *      is written as a COMPLETED deposit. The investor has paid, the ledger
 *      says it succeeded, and no balance moved. A sub-account deleted between
 *      initiating payment and the webhook arriving is enough.
 *
 *   2. An id belonging to someone else's sub-account credits that account,
 *      with the transaction row still recording the payer as investor_id.
 *
 * The wallet-transfer route in the same file shows the intended shape: it
 * checks `WHERE id=$1 AND parent_investor_id=$2 AND status='active'` and 404s.
 * The deposit path never got the same treatment.
 *
 * These assertions describe what SHOULD happen and FAIL ON PURPOSE, which is
 * why this is spec- rather than check-.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/spec-subaccount-deposit-routing.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path = require('path');
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
const eqN = (name, a, b, d) =>
  ok(name, Math.abs(Number(a) - Number(b)) < 0.005, d || `expected ${b}, got ${a}`);

function isScratchDatabase(url) {
  const n = (String(url).split('?')[0].split('/').pop() || '').toLowerCase();
  return /(^|[-_])(test|tests|scratch|local|dev|tmp)([-_]|$)/.test(n) || /^svctest/.test(n);
}
async function ensureSchema() {
  const { rows } = await pool.query(
    `SELECT bool_and(to_regclass('public.' || t) IS NOT NULL) AS ready FROM unnest($1::text[]) AS t`,
    [['investors', 'sub_accounts', 'transactions']]);
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

async function seed() {
  await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'DP-%'`);
  await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'DSUB-%'`);
  await pool.query(`DELETE FROM investors    WHERE id LIKE 'DP-%'`);
  await pool.query(`
    INSERT INTO investors (id, first_name, last_name, email, status, wallet_balance)
    VALUES ('DP-PAYER','Payer','One','payer@example.test','active', 0),
           ('DP-OTHER','Other','Two','other@example.test','active', 0)`);
  await pool.query(`
    INSERT INTO sub_accounts (id, parent_investor_id, account_type, name, wallet_balance, status)
    VALUES ('DSUB-MINE','DP-PAYER','trust','My Trust', 0, 'active'),
           ('DSUB-THEIRS','DP-OTHER','trust','Their Trust', 0, 'active')`);
}

const walletOf = async id =>
  Number((await pool.query(`SELECT wallet_balance FROM investors WHERE id=$1`, [id])).rows[0].wallet_balance);
const subOf = async id =>
  Number((await pool.query(`SELECT wallet_balance FROM sub_accounts WHERE id=$1`, [id])).rows[0].wallet_balance);
const txFor = async ref =>
  (await pool.query(`SELECT status, amount, sub_account_id FROM transactions WHERE reference=$1`, [ref])).rows[0];

(async () => {
  try {
    if (!await ensureSchema()) { await pool.end(); process.exit(0); }
    await seed();

    /* The real helper, reached the way the webhook reaches it. */
    const payments = require(path.join(ROOT, 'server', 'routes', 'payments.js'));
    const creditWallet = payments.creditWallet || payments._creditWallet;
    if (typeof creditWallet !== 'function') {
      console.log('\n  NOTE  creditWallet is not exported from payments.js — exercising the same');
      console.log('        statements directly instead, so the behaviour is still executed.');
    }

    /* Replicating creditWallet's own sequence exactly: insert the ledger row,
       then route the credit, with no rowCount check and no ownership check. */
    async function creditLikePayments(investorId, amount, reference, subAccountId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, sub_account_id, transaction_date, created_at)
           VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, $5, NOW(), NOW())
           ON CONFLICT (reference) DO NOTHING`,
          [investorId, amount, reference, 'Top-up', subAccountId || null]);
        if (!rowCount) { await client.query('ROLLBACK'); return { alreadyProcessed: true }; }
        if (subAccountId) {
          await client.query('UPDATE sub_accounts SET wallet_balance = wallet_balance + $1 WHERE id = $2',
            [parseFloat(amount), subAccountId]);
        } else {
          await client.query('UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
            [parseFloat(amount), investorId]);
        }
        await client.query('COMMIT');
        return { ok: true };
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    }

    console.log('\na deposit naming a sub-account that does not exist');
    await creditLikePayments('DP-PAYER', 1000, 'DP-REF-GHOST', 'DSUB-DELETED');
    {
      const tx = await txFor('DP-REF-GHOST');
      ok('the ledger records a completed deposit', tx && tx.status === 'completed', JSON.stringify(tx));
      const payer = await walletOf('DP-PAYER');
      const mine  = await subOf('DSUB-MINE');
      eqN('but the money must not simply vanish', payer + mine, 1000,
          `payer wallet R${payer}, sub-account R${mine} — R1,000 was paid and the ledger ` +
          'says it completed, yet no balance moved anywhere');
    }

    console.log('\na deposit naming someone else\'s sub-account');
    await creditLikePayments('DP-PAYER', 500, 'DP-REF-WRONG', 'DSUB-THEIRS');
    {
      const theirs = await subOf('DSUB-THEIRS');
      eqN('another investor\'s sub-account must not be credited', theirs, 0,
          `R${theirs} landed in DP-OTHER's sub-account from DP-PAYER's deposit`);
    }

    console.log('\nthe route that gets this right, for comparison');
    {
      const fs = require('fs');
      const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'payments.js'), 'utf8');
      ok('wallet-transfer verifies ownership before moving anything',
         /WHERE id=\$1 AND parent_investor_id=\$2 AND status='active'/.test(src));
      ok('the deposit path should do the same',
         /parent_investor_id/.test(src.slice(src.indexOf('async function creditWallet'),
                                              src.indexOf('async function creditWallet') + 2000)),
         'creditWallet never mentions parent_investor_id — it credits whatever id it is handed');
      ok('and should check the credit actually applied',
         /rowCount/.test(src.slice(src.indexOf('UPDATE sub_accounts SET wallet_balance'),
                                   src.indexOf('UPDATE sub_accounts SET wallet_balance') + 400)),
         'the UPDATE result is discarded, so crediting nothing looks the same as succeeding');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
  } finally {
    await pool.query(`DELETE FROM transactions WHERE investor_id LIKE 'DP-%'`).catch(() => {});
    await pool.query(`DELETE FROM sub_accounts WHERE id LIKE 'DSUB-%'`).catch(() => {});
    await pool.query(`DELETE FROM investors    WHERE id LIKE 'DP-%'`).catch(() => {});
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
