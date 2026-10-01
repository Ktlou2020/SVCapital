#!/usr/bin/env node
/* Maturities that were paid to the wallet because no pool could be found.
 *
 * On the night of 30 September 2026 the maturity run logged this, dozens of
 * times:
 *
 *   [maturity] no open other pool — paid R373260.11 to wallet for S-111628
 *
 * reinvestAmount looks for the pool to roll into with
 *
 *   WHERE status = 'open' AND product_type = $1 AND (end_date IS NULL OR …)
 *
 * and $1 is the INVESTMENT's own product_type. Where that is 'other' — a value
 * no pool carries and the maturity policy does not recognise, left on rows that
 * came in through the migration — nothing matches, `target` is null, and the
 * money goes to the investor's wallet instead with a reference of
 * MAT-FALLBACK-<investment id>.
 *
 * So the instruction was not the problem: a blank instruction already defaults
 * to reinvest. The target lookup was. And the money is not lost — it is in
 * wallets, which is why putting it back into a pool is a debit-and-reinvest
 * rather than finishing something half-done.
 *
 * This report says exactly who, how much, out of which pool, under which
 * instruction, and WHETHER THE WALLET STILL HOLDS IT — because an investor who
 * has since withdrawn or invested that money cannot be rolled over without
 * taking their balance negative.
 *
 * It also names the pool each one WOULD have gone to had the product_type been
 * right, so the correction has a target that is derived rather than assumed.
 *
 * READ-ONLY. Every statement is a SELECT, under a statement timeout. It writes
 * nothing, and it is safe to point at production.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/audit-maturity-wallet-fallbacks.cjs
 *     --since 2026-09-01   only maturities on or after this date (default: all)
 *     --csv                also write maturity-wallet-fallbacks.csv
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const argv     = process.argv.slice(2);
const WANT_CSV = argv.includes('--csv');
const SINCE    = (argv[argv.indexOf('--since') + 1] || '').match(/^\d{4}-\d{2}-\d{2}$/)
                 ? argv[argv.indexOf('--since') + 1] : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const rand = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day  = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const pad  = (s, n) => String(s == null ? '—' : s).padEnd(n).slice(0, n);
const H    = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

async function hasTable(t) {
  const { rows } = await pool.query(`SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`, [t]);
  return rows[0].ok;
}

(async () => {
  try {
    for (const t of ['transactions', 'investments', 'investment_pools', 'investors']) {
      if (!await hasTable(t)) {
        console.error(`Table ${t} not found — is DATABASE_URL pointing at the platform database?`);
        process.exit(2);
      }
    }

    /* ── Every fallback credit, with the investment behind it ─────────
       Matched on the reference reinvestAmount writes, not on the wording of
       the description, which has changed before. */
    const { rows } = await pool.query(`
      SELECT t.id              AS txn_id,
             t.reference,
             t.amount,
             t.description,
             COALESCE(t.transaction_date, t.created_at) AS paid_at,
             t.sub_account_id,
             i.id              AS investment_id,
             i.investor_id,
             i.product_type    AS investment_product_type,
             i.maturity_instruction,
             i.payout_option,
             i.pool_id,
             p.name            AS pool_name,
             p.product_type    AS pool_product_type,
             p.end_date        AS pool_end_date,
             inv.first_name, inv.last_name, inv.email,
             inv.wallet_balance        AS investor_wallet,
             sa.wallet_balance         AS sub_wallet,
             sa.name                   AS sub_name
        FROM transactions t
        LEFT JOIN investments      i   ON i.id  = t.investment_id
        LEFT JOIN investment_pools p   ON p.id  = i.pool_id
        LEFT JOIN investors        inv ON inv.id = t.investor_id
        LEFT JOIN sub_accounts     sa  ON sa.id  = t.sub_account_id
       WHERE t.reference LIKE 'MAT-FALLBACK-%'
         ${SINCE ? `AND COALESCE(t.transaction_date, t.created_at) >= DATE '${SINCE}'` : ''}
       ORDER BY COALESCE(t.transaction_date, t.created_at), t.amount DESC`);

    if (!rows.length) {
      console.log('\nNo maturity wallet-fallback credits found' + (SINCE ? ` since ${SINCE}` : '') + '.');
      await pool.end();
      process.exit(0);
    }

    const total = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
    H(`Maturities paid to a wallet because no pool matched${SINCE ? ` (since ${SINCE})` : ''}`);
    console.log(`${rows.length} credit(s), ${rand(total)} in all.\n`);

    /* ── Why: which product_type sent them down the fallback ─────────── */
    H('By the product type on the investment');
    const byType = {};
    for (const r of rows) {
      const k = r.investment_product_type || '(null)';
      (byType[k] = byType[k] || { n: 0, amt: 0 }).n++;
      byType[k].amt += Number(r.amount || 0);
    }
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].amt - a[1].amt)) {
      const known = ['cattle', 'short_term'].includes(k);
      console.log(`  ${pad(k, 22)} ${String(v.n).padStart(4)}  ${rand(v.amt).padStart(16)}` +
                  (known ? '   (a real product — look closer, this one should have matched)'
                         : '   ← no pool carries this type, so nothing could match'));
    }

    /* ── Where they came from ─────────────────────────────────────────── */
    H('By the pool they matured out of');
    const byPool = {};
    for (const r of rows) {
      const k = `${r.pool_id || '(none)'}|${r.pool_name || '—'}|${r.pool_product_type || '—'}`;
      (byPool[k] = byPool[k] || { n: 0, amt: 0 }).n++;
      byPool[k].amt += Number(r.amount || 0);
    }
    for (const [k, v] of Object.entries(byPool).sort((a, b) => b[1].amt - a[1].amt)) {
      const [id, name, ptype] = k.split('|');
      console.log(`  ${pad(name, 38)} ${pad(ptype, 12)} ${String(v.n).padStart(4)}  ${rand(v.amt).padStart(16)}`);
      console.log(`    ${id}`);
    }

    /* ── What instruction each carried ────────────────────────────────
       The question is which of these had NO instruction, and only one column
       can answer it.

       investments.payout_option carries a column DEFAULT of 'reinvest', so
       every row has it whether or not a client ever chose anything. Reading
       the two together — or falling back from one to the other — reports
       every investment as "reinvest" and answers the question wrongly.
       maturity_instruction is the one that is NULL when nothing was set, so
       the two are counted apart and never coalesced. */
    H('Did the investment carry a maturity instruction?');
    const byInstr = {};
    for (const r of rows) {
      const raw = (r.maturity_instruction || '').trim();
      const k = (!raw || raw === 'pending') ? '(none set)' : raw;
      (byInstr[k] = byInstr[k] || { n: 0, amt: 0 }).n++;
      byInstr[k].amt += Number(r.amount || 0);
    }
    for (const [k, v] of Object.entries(byInstr).sort((a, b) => b[1].amt - a[1].amt)) {
      console.log(`  ${pad(k, 22)} ${String(v.n).padStart(4)}  ${rand(v.amt).padStart(16)}` +
                  (k === '(none set)' ? '   ← would default to reinvest' : ''));
    }
    const noInstr = byInstr['(none set)'];
    console.log(`\n  A blank instruction already defaults to reinvest, so ${noInstr ? noInstr.n : 0} of these`);
    console.log('  were ALREADY meant to roll over. They went to a wallet because no pool');
    console.log('  matched the investment\'s product_type, not because nothing was chosen.');

    const payoutVals = [...new Set(rows.map(r => r.payout_option || '(null)'))];
    console.log(`\n  (payout_option on these rows: ${payoutVals.join(', ')} — that column defaults to`);
    console.log('   \'reinvest\' in the schema, so it says nothing about what a client picked.)');

    /* ── Where it would go now ────────────────────────────────────────
       The same lookup reinvestAmount makes, run per product type that is
       actually open, so a correction has a target it derived rather than one
       somebody typed. */
    H('The pool each product type would roll into today');
    const { rows: targets } = await pool.query(`
      SELECT DISTINCT ON (product_type)
             product_type, id, name, end_date, status,
             current_invested, max_investment
        FROM investment_pools
       WHERE status = 'open'
         AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'Africa/Johannesburg')::date)
         AND (max_investment IS NULL OR COALESCE(current_invested,0) < max_investment)
       ORDER BY product_type, end_date ASC NULLS LAST, created_at ASC`);
    if (!targets.length) console.log('  (no pool is open and still raising for any product type)');
    for (const t of targets) {
      console.log(`  ${pad(t.product_type, 14)} → ${pad(t.name, 36)} ${t.id}  closes ${day(t.end_date)}`);
    }
    console.log(`\n  Note: a pool whose end_date has passed is NOT listed — it has stopped raising.`);

    /* ── Can it actually be moved? ────────────────────────────────────
       The money is in a wallet. Rolling it over means debiting that wallet, so
       the balance has to still be there. Checked per account, and against the
       TOTAL owed where an investor has several. */
    H('Does the wallet still hold it?');
    const perAccount = {};
    for (const r of rows) {
      const key = r.sub_account_id ? `sa:${r.sub_account_id}` : `inv:${r.investor_id}`;
      const bal = r.sub_account_id ? Number(r.sub_wallet || 0) : Number(r.investor_wallet || 0);
      const a = perAccount[key] = perAccount[key] || {
        who: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.investor_id,
        email: r.email, sub: r.sub_name || null, balance: bal, owed: 0, n: 0,
      };
      a.owed += Number(r.amount || 0); a.n++;
    }
    const accounts = Object.values(perAccount);
    const short    = accounts.filter(a => a.balance + 0.005 < a.owed);
    const ok       = accounts.length - short.length;
    console.log(`  ${accounts.length} account(s) received these credits.`);
    console.log(`  ${ok} still hold at least the full amount — these could be rolled over as they stand.`);
    console.log(`  ${short.length} do NOT: the money has been spent, withdrawn or reinvested since.`);
    if (short.length) {
      console.log('\n  Short accounts — moving these would take the wallet negative:');
      console.log(`    ${pad('who', 28)} ${pad('account', 10)} ${'owed'.padStart(14)} ${'balance'.padStart(14)}`);
      for (const a of short.sort((x, y) => (y.owed - y.balance) - (x.owed - x.balance))) {
        console.log(`    ${pad(a.who, 28)} ${pad(a.sub ? 'sub' : 'main', 10)} ` +
                    `${rand(a.owed).padStart(14)} ${rand(a.balance).padStart(14)}`);
      }
    }

    /* ── Line by line ─────────────────────────────────────────────────── */
    H('Every credit');
    console.log(`  ${pad('paid', 11)} ${pad('investor', 24)} ${pad('from pool', 30)} ` +
                `${pad('type', 12)} ${pad('instruction', 16)} ${'amount'.padStart(14)}`);
    for (const r of rows) {
      console.log(`  ${pad(day(r.paid_at), 11)} ` +
                  `${pad(`${r.first_name || ''} ${r.last_name || ''}`.trim() || r.investor_id, 24)} ` +
                  `${pad(r.pool_name, 30)} ${pad(r.investment_product_type, 12)} ` +
                  `${pad(!(r.maturity_instruction || '').trim() ? '(none set)' : r.maturity_instruction, 16)} ` +
                  `${rand(r.amount).padStart(14)}`);
    }

    if (WANT_CSV) {
      const out = path.join(process.cwd(), 'maturity-wallet-fallbacks.csv');
      const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      const head = ['paid_at', 'txn_id', 'reference', 'investment_id', 'investor_id', 'first_name',
                    'last_name', 'email', 'sub_account_id', 'pool_id', 'pool_name',
                    'pool_product_type', 'investment_product_type', 'maturity_instruction',
                    'payout_option', 'amount', 'wallet_balance_now'];
      fs.writeFileSync(out, [head.join(',')].concat(rows.map(r => [
        day(r.paid_at), r.txn_id, r.reference, r.investment_id, r.investor_id, r.first_name,
        r.last_name, r.email, r.sub_account_id, r.pool_id, r.pool_name, r.pool_product_type,
        r.investment_product_type, r.maturity_instruction, r.payout_option, r.amount,
        r.sub_account_id ? r.sub_wallet : r.investor_wallet,
      ].map(esc).join(','))).join('\n'));
      console.log(`\nWrote ${out}`);
    }

    H('What this does not do');
    console.log('  Nothing was changed. Every statement above is a SELECT.');
    console.log('  Deciding WHERE these should go, and what to do about the short accounts,');
    console.log('  is the next step — and the product_type on these investments wants fixing');
    console.log('  too, or the same thing happens at the next month end.\n');
  } catch (err) {
    console.error('\nAudit failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
