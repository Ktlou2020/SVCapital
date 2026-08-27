#!/usr/bin/env node
/* Find money that went to the wrong sub-account, or to none at all.
 *
 * Three defects were fixed on 27 August 2026. Each ran in production for some
 * time before that, and each leaves a signature in the rows it wrote. This
 * finds them. It changes nothing.
 *
 *   A  DEPOSIT CREDITED NOWHERE
 *      creditWallet credited whatever sub_account_id it was handed and threw
 *      away the UPDATE result. An id matching no row credited nothing while
 *      the ledger recorded a completed deposit. Signature: a completed deposit
 *      naming a sub-account that does not exist. The payer is short by the
 *      full amount and nothing on the platform says so.
 *
 *   B  DEPOSIT CREDITED TO SOMEONE ELSE'S SUB-ACCOUNT
 *      Same helper, no ownership check. Signature: a completed deposit whose
 *      sub_account_id belongs to an investor other than the one on the row.
 *      The money is real and it is in the wrong household.
 *
 *   C  MATURITY PAID TO THE PARENT INSTEAD OF THE SUB-ACCOUNT
 *      maturityCron's creditWallet always credited `investors` and omitted
 *      sub_account_id from the payout row. Signature: a payout transaction
 *      whose investment carries a sub_account_id while the payout row does
 *      not. The money stayed inside the same investor's household, so nothing
 *      was lost — but the sub-account's balance and total_returns are wrong,
 *      and its statement never showed the payout.
 *
 * Severity differs and the report keeps them apart. A is a shortfall against
 * the investor. B is money in the wrong hands. C is misattribution within one
 * household. Only A and B involve money that is not where the payer put it.
 *
 * READ-ONLY. Every statement is a SELECT.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/audit-subaccount-money.cjs
 *   …add --csv to write subaccount-money-audit.csv alongside the report.
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const WANT_CSV = process.argv.includes('--csv');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const rand = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

async function hasTable(t) {
  const { rows } = await pool.query(`SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`, [t]);
  return rows[0].ok;
}

(async () => {
  try {
    for (const t of ['transactions', 'sub_accounts', 'investors']) {
      if (!await hasTable(t)) {
        console.error(`Table ${t} not found — is DATABASE_URL pointing at the platform database?`);
        process.exit(2);
      }
    }

    /* ── A: deposits naming a sub-account that does not exist ────────── */
    const { rows: orphans } = await pool.query(`
      SELECT t.id, t.reference, t.investor_id, t.sub_account_id, t.amount,
             COALESCE(t.transaction_date, t.created_at) AS when_, t.description,
             i.first_name, i.last_name, i.email
        FROM transactions t
        LEFT JOIN sub_accounts sa ON sa.id = t.sub_account_id
        LEFT JOIN investors    i  ON i.id  = t.investor_id
       WHERE t.type = 'deposit'
         AND t.status = 'completed'
         AND t.sub_account_id IS NOT NULL
         AND sa.id IS NULL
       ORDER BY COALESCE(t.transaction_date, t.created_at)`);

    /* ── B: deposits credited to another investor's sub-account ──────── */
    const { rows: wrongOwner } = await pool.query(`
      SELECT t.id, t.reference, t.investor_id, t.sub_account_id, t.amount,
             COALESCE(t.transaction_date, t.created_at) AS when_,
             sa.parent_investor_id, sa.name AS sub_name,
             i.first_name, i.last_name, i.email,
             o.first_name AS owner_first, o.last_name AS owner_last, o.email AS owner_email
        FROM transactions t
        JOIN sub_accounts sa ON sa.id = t.sub_account_id
        LEFT JOIN investors i ON i.id = t.investor_id
        LEFT JOIN investors o ON o.id = sa.parent_investor_id
       WHERE t.type = 'deposit'
         AND t.status = 'completed'
         AND sa.parent_investor_id IS DISTINCT FROM t.investor_id
       ORDER BY COALESCE(t.transaction_date, t.created_at)`);

    /* ── C: maturity paid to the parent instead of the sub-account ───── */
    const { rows: maturityMisrouted } = await pool.query(`
      SELECT t.id, t.reference, t.investor_id, t.amount,
             COALESCE(t.transaction_date, t.created_at) AS when_,
             inv.id AS investment_id, inv.sub_account_id AS should_have_been,
             inv.pool_name, sa.name AS sub_name,
             i.first_name, i.last_name, i.email
        FROM transactions t
        JOIN investments inv ON inv.id = t.investment_id
        LEFT JOIN sub_accounts sa ON sa.id = inv.sub_account_id
        LEFT JOIN investors    i  ON i.id  = t.investor_id
       WHERE t.type = 'payout'
         AND t.status = 'completed'
         AND inv.sub_account_id IS NOT NULL
         AND t.sub_account_id IS NULL
       ORDER BY COALESCE(t.transaction_date, t.created_at)`);

    const sum = rows => rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);
    const who = r => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.investor_id;

    H('Sub-account money audit');
    console.log(`\nA  deposits credited nowhere               ${orphans.length}  ${rand(sum(orphans))}`);
    console.log(`B  deposits credited to the wrong owner    ${wrongOwner.length}  ${rand(sum(wrongOwner))}`);
    console.log(`C  maturity paid to the parent             ${maturityMisrouted.length}  ${rand(sum(maturityMisrouted))}`);

    if (orphans.length) {
      H('A — the investor paid and nothing was credited');
      console.log('  These name a sub-account that does not exist. The deposit row says completed;');
      console.log('  no wallet moved. The investor is short by the full amount.');
      for (const r of orphans) {
        console.log(`  ${day(r.when_)}  ${rand(r.amount)}  ${who(r)} <${r.email || 'no email'}>`);
        console.log(`     ref ${r.reference} · named sub-account ${r.sub_account_id} (missing)`);
      }
      console.log('\n  Each needs the amount credited to that investor by hand.');
    }

    if (wrongOwner.length) {
      H('B — the money is in someone else\'s account');
      for (const r of wrongOwner) {
        const owner = [r.owner_first, r.owner_last].filter(Boolean).join(' ') || r.parent_investor_id;
        console.log(`  ${day(r.when_)}  ${rand(r.amount)}  paid by ${who(r)} <${r.email || 'no email'}>`);
        console.log(`     ref ${r.reference} · credited to "${r.sub_name}" (${r.sub_account_id}),`);
        console.log(`     which belongs to ${owner} <${r.owner_email || 'no email'}>`);
      }
      console.log('\n  Moving these needs a decision per case — the receiving account may have');
      console.log('  spent or invested the money since.');
    }

    if (maturityMisrouted.length) {
      H('C — maturity paid the parent, not the sub-account');
      console.log('  The money stayed within the same investor, so none is missing. What is wrong');
      console.log('  is the sub-account\'s balance and total_returns, and that its statement never');
      console.log('  showed the payout.');
      for (const r of maturityMisrouted) {
        console.log(`  ${day(r.when_)}  ${rand(r.amount)}  ${who(r)} <${r.email || 'no email'}>`);
        console.log(`     ref ${r.reference} · investment ${r.investment_id} (${r.pool_name || '—'})`);
        console.log(`     belonged to ${r.sub_name ? `"${r.sub_name}"` : 'a sub-account'} ${r.should_have_been}`);
      }
    }

    if (WANT_CSV) {
      const out = path.join(process.cwd(), 'subaccount-money-audit.csv');
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['finding,severity,date,amount,reference,investor,email,investor_id,sub_account_id,detail'];
      for (const r of orphans) lines.push([
        'A_credited_nowhere', 'shortfall', day(r.when_), Math.abs(Number(r.amount) || 0), r.reference,
        who(r), r.email || '', r.investor_id, r.sub_account_id,
        'named sub-account does not exist — no wallet was credited'].map(esc).join(','));
      for (const r of wrongOwner) lines.push([
        'B_wrong_owner', 'misplaced', day(r.when_), Math.abs(Number(r.amount) || 0), r.reference,
        who(r), r.email || '', r.investor_id, r.sub_account_id,
        `credited to ${r.sub_name}, owned by ${r.parent_investor_id}`].map(esc).join(','));
      for (const r of maturityMisrouted) lines.push([
        'C_maturity_to_parent', 'misattributed', day(r.when_), Math.abs(Number(r.amount) || 0), r.reference,
        who(r), r.email || '', r.investor_id, r.should_have_been,
        `payout credited the parent; investment ${r.investment_id} belonged to the sub-account`].map(esc).join(','));
      fs.writeFileSync(out, lines.join('\n'));
      console.log(`\n  wrote ${out} (${lines.length - 1} rows)`);
    }

    H('Summary');
    const moneyAstray = sum(orphans) + sum(wrongOwner);
    if (!orphans.length && !wrongOwner.length && !maturityMisrouted.length) {
      console.log('  Nothing found. No deposit went to a sub-account that does not exist or is not');
      console.log('  the payer\'s, and no maturity payout bypassed the sub-account it belonged to.');
    } else {
      console.log(`  ${rand(moneyAstray)} is not where the payer put it (A and B).`);
      console.log(`  ${rand(sum(maturityMisrouted))} is with the right investor but the wrong account (C).`);
    }
    console.log('\n  Signatures only. A deposit whose sub-account was later deleted looks the same');
    console.log('  as one that named a bad id at the time — both mean nothing was credited, which');
    console.log('  is what matters, but the cause needs the payment record to tell apart.');
    console.log('  Nothing was changed by running this.\n');
  } catch (err) {
    console.error('\naudit failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
