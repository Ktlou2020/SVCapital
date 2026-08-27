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
 * Fixed. creditWallet now resolves the sub-account against the paying investor
 * before crediting it, falls back to that investor's own wallet when it does
 * not resolve — the money has already been taken, so refusing outright would
 * be worse — annotates the transaction row when it reroutes, and checks
 * rowCount on both branches so a credit that applied to nothing cannot reach
 * COMMIT looking like one that worked.
 *
 * The wallet-transfer route had the same missing rowCount on its credit leg,
 * which was worse: the debit was guarded, so a sub-account vanishing mid-
 * transfer took money out of the investor's wallet and put it nowhere.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-subaccount-deposit-routing.cjs
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

    /* The shipped helper, driven the way the webhook drives it. */
    const payments = require(path.join(ROOT, 'server', 'routes', 'payments.js'));
    const creditWallet = payments.creditWallet;
    ok('creditWallet is reachable from the module', typeof creditWallet === 'function',
       'the test must exercise the shipped function, not a copy of it');
    if (typeof creditWallet !== 'function') {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(1);
    }
    const credit = (investorId, amount, reference, subAccountId) =>
      creditWallet(investorId, amount, reference, null, 'webhook', subAccountId);

    console.log('\na deposit naming a sub-account that does not exist');
    await credit('DP-PAYER', 1000, 'DP-REF-GHOST', 'DSUB-DELETED');
    {
      const tx = await txFor('DP-REF-GHOST');
      ok('the ledger still records the deposit', tx && tx.status === 'completed', JSON.stringify(tx));
      eqN('and the money reaches the investor who paid it', await walletOf('DP-PAYER'), 1000,
          'refusing would leave a real payment with no home; rerouting keeps it visible');
      ok('the row no longer claims a sub-account it never reached',
         tx && tx.sub_account_id === null, `sub_account_id=${tx && tx.sub_account_id}`);
      ok('and says why it was rerouted',
         /routed to main wallet/.test((await pool.query(
           `SELECT description FROM transactions WHERE reference='DP-REF-GHOST'`)).rows[0].description),
         'a log line is not enough — the investor sees this row, not the log');
    }

    console.log('\na deposit naming someone else\'s sub-account');
    await credit('DP-PAYER', 500, 'DP-REF-WRONG', 'DSUB-THEIRS');
    {
      eqN('another investor\'s sub-account is not credited', await subOf('DSUB-THEIRS'), 0);
      eqN('the payer receives their own money', await walletOf('DP-PAYER'), 1500,
          'R1,000 from the first case plus R500 from this one');
    }

    console.log('\na deposit naming a sub-account the payer does own');
    await credit('DP-PAYER', 250, 'DP-REF-GOOD', 'DSUB-MINE');
    {
      eqN('goes to that sub-account', await subOf('DSUB-MINE'), 250);
      eqN('and not to the parent wallet', await walletOf('DP-PAYER'), 1500);
      const tx = await txFor('DP-REF-GOOD');
      ok('with the row carrying the sub-account', tx && tx.sub_account_id === 'DSUB-MINE',
         JSON.stringify(tx));
    }

    console.log('\nthe idempotency guard still holds');
    {
      const again = await credit('DP-PAYER', 250, 'DP-REF-GOOD', 'DSUB-MINE');
      ok('a replayed reference is skipped', again && again.alreadyProcessed === true,
         JSON.stringify(again));
      eqN('and credits nothing a second time', await subOf('DSUB-MINE'), 250);
    }

    console.log('\nboth credit branches check they applied');
    {
      const fs = require('fs');
      const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'payments.js'), 'utf8');
      ok('the deposit credit is refused when it lands on nothing',
         /if \(!credit\.rowCount\)/.test(src) && /applied to no wallet/.test(src));
      ok('the transfer credit is too',
         /if \(!credited\)/.test(src) && /no longer available\. Nothing was transferred/.test(src),
         'the debit was guarded and the credit was not — the worse way round');
      /* Slice the actual function, not a fixed number of characters. A
         comment added above the SQL pushed it past an arbitrary 3,000-char
         window and the assertion failed on the test's own arithmetic rather
         than on the code. */
      const cw = (() => {
        const i = src.indexOf('async function creditWallet');
        return src.slice(i, src.indexOf('\n}\n', i));
      })();
      ok('and the deposit resolves ownership before crediting',
         /parent_investor_id = \$2/.test(cw),
         'creditWallet must scope the sub-account to the paying investor');
      ok('the notifications follow where the money went, not where it was asked to go',
         /creditedSubAccountId/.test(cw),
         'naming the requested sub-account told an investor it had been credited when it had not');
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
