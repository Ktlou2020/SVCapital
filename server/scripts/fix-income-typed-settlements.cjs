#!/usr/bin/env node
/* Correct the ledger rows where a matured investment coming back is typed as
 * income.
 *
 * A client found this during a SARS verification. One row — dated the day
 * after an investment matured, described "PAYOUT", R678,00 — was typed as
 * income. R678,00 was R600,00 of their own capital plus the R78,00 return on
 * it, and the R78,00 was already counted under Returns Realised at Maturity.
 * Their Investment Income Reference therefore showed two figures that
 * overlapped, and adding them, which is the obvious thing to do, would have
 * declared R600 of their own money to SARS as earnings.
 *
 * services/incomeReference.js now keeps such a row out of the income total and
 * names it on the document, so the DOCUMENT is honest either way. This script
 * is the other half: making the LEDGER right, so the row stops needing to be
 * explained.
 *
 * ── WHY THIS IS NOT A ONE-LINE UPDATE ──────────────────────────────────
 *
 * Because the retype is NOT always cash-neutral. cashMovement signs a row by
 * its type, and the lists are not symmetrical:
 *
 *     interest  → a cash CREDIT        payout → a cash CREDIT
 *     return    → NO cash effect at all
 *
 * So `interest` → `payout` moves no money. But `return` → `payout` turns a row
 * that counted for nothing into a credit, and every balance derived from the
 * ledger moves by that amount. That is very likely a CORRECTION — the client
 * did receive the money — but it is a client-visible balance change, and on an
 * account already disputing an opening balance it must be a decision somebody
 * makes with the figures in front of them, not a side effect of a cleanup.
 *
 * So this script sorts candidates into three piles and only ever writes the
 * first two:
 *
 *   NEUTRAL   `interest` → `payout`. Nothing moves. Applied by --apply.
 *   SHIFTS    `return` → `payout`. The investor's derived balance moves by the
 *             amount. Reported with the delta per investor, and applied only
 *             with --allow-balance-shift, deliberately.
 *   SKIPPED   Something already credits that money, so retyping would count it
 *             twice. Named and never written, whatever flags are passed.
 *
 * ── PREVIEWS BY DEFAULT ────────────────────────────────────────────────
 *
 * Nothing is written without --apply, following backfill-stokvel-shares.cjs.
 * Anything that cannot be made safe is NAMED and SKIPPED rather than forced.
 *
 * Usage:
 *   DATABASE_URL=… node server/scripts/fix-income-typed-settlements.cjs
 *   …                                                   --investor=S-112276
 *   …                                                   --apply
 *   …                                                   --apply --allow-balance-shift
 */
'use strict';

const { Pool } = require('pg');

const APPLY   = process.argv.includes('--apply');
const SHIFTOK = process.argv.includes('--allow-balance-shift');
const ONLY    = (process.argv.find(a => a.startsWith('--investor=')) || '').split('=')[1] || null;
const WINDOW_DAYS = 31;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const rand = v => 'R' + Number(v || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = s => String(s || '').slice(0, 10);

/* The same rule services/incomeReference.js applies, in SQL.

   The realised return mirrors postedReturn exactly: the amount posted on the
   investment where there is one, otherwise the pool's achieved rate applied to
   the capital. An investment with NEITHER has no figure to compare and is left
   out — reading an unposted return as zero would make capital alone look like
   a settlement and would retype genuine income. */
const CANDIDATES = `
  WITH matured AS (
    SELECT i.id, i.investor_id, i.sub_account_id, i.pool_id, i.pool_name,
           i.amount, i.end_date,
           CASE WHEN COALESCE(i.actual_return, 0) > 0 THEN i.actual_return
                WHEN COALESCE(p.actual_rate, 0)  > 0 THEN i.amount * p.actual_rate
                ELSE NULL END AS realised
      FROM investments i
      LEFT JOIN investment_pools p ON p.id = i.pool_id
     WHERE i.status IN ('matured', 'paid_out')
  )
  SELECT t.id              AS txn_id,
         t.investor_id,
         t.sub_account_id,
         t.type            AS txn_type,
         t.description,
         t.reference,
         t.investment_id,
         ABS(t.amount)     AS amount,
         COALESCE(t.transaction_date, t.created_at) AS txn_at,
         m.id              AS inv_id,
         m.pool_id         AS inv_pool_id,
         m.pool_name,
         m.amount          AS capital,
         m.realised,
         m.end_date,
         inv.first_name, inv.last_name, inv.email
    FROM transactions t
    JOIN matured m
      ON m.realised IS NOT NULL
     AND ABS(ABS(t.amount) - (m.amount + m.realised)) <= 0.005
     AND (
           (t.investment_id IS NOT NULL AND t.investment_id = m.id)
        OR ABS(EXTRACT(EPOCH FROM (COALESCE(t.transaction_date, t.created_at) - m.end_date))) <= $1 * 86400
         )
     AND (m.investor_id = t.investor_id
          OR (t.sub_account_id IS NOT NULL AND m.sub_account_id = t.sub_account_id))
    LEFT JOIN investors inv ON inv.id = t.investor_id
   WHERE t.type IN ('return', 'interest')
     AND COALESCE(t.status, '') = 'completed'
     AND ($2::text IS NULL OR t.investor_id = $2::text)
   ORDER BY t.investor_id, COALESCE(t.transaction_date, t.created_at)`;

/* Is that money already credited by some other row? If it is, retyping this
   one makes the platform count it twice, and no flag should let that through.

   Matched on the investment where the row names one, and otherwise on the same
   investor, the same amount and the same few days — which is as close as the
   data lets anyone get to "this is the same money". */
async function alreadyCredited(db, c) {
  const { rows } = await db.query(`
    SELECT id, type, ABS(amount) AS amount,
           COALESCE(transaction_date, created_at) AS at
      FROM transactions
     WHERE id <> $1
       AND COALESCE(status, '') = 'completed'
       AND type IN ('payout', 'matured_funds', 'deposit', 'interest')
       AND investor_id = $2
       AND ABS(ABS(amount) - $3::numeric) <= 0.005
       AND (
             ($4::text IS NOT NULL AND investment_id = $4::text)
          OR ABS(EXTRACT(EPOCH FROM (COALESCE(transaction_date, created_at) - $5::timestamptz))) <= 5 * 86400
           )
     LIMIT 5`,
    [c.txn_id, c.investor_id, c.amount, c.inv_id, c.txn_at]);
  return rows;
}

(async () => {
  let exitCode = 0;
  try {
    const { rows: candidates } = await pool.query(CANDIDATES, [WINDOW_DAYS, ONLY]);

    console.log(`\nIncome-typed maturity settlements${ONLY ? ` for ${ONLY}` : ''}`);
    console.log(APPLY
      ? `  MODE: APPLY${SHIFTOK ? ' (balance-shifting rows included)' : ''}`
      : '  MODE: preview only — nothing will be written. Add --apply to write.');

    if (!candidates.length) {
      console.log('\n  Nothing to correct. No income-typed row matches a matured investment’s');
      console.log('  capital plus its realised return.\n');
      return;
    }

    const neutral = [], shifts = [], skipped = [];
    for (const c of candidates) {
      const clash = await alreadyCredited(pool, c);
      if (clash.length) { skipped.push({ c, clash }); continue; }
      (c.txn_type === 'interest' ? neutral : shifts).push(c);
    }

    const show = (c, note) => {
      const who = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.investor_id;
      console.log(`\n  ${day(c.txn_at)}  ${rand(c.amount)}  ${c.txn_type} → payout`);
      console.log(`    ${who} (${c.investor_id})${c.email ? ' · ' + c.email : ''}`);
      console.log(`    txn ${c.txn_id}${c.description ? ` · "${c.description}"` : ''}`);
      console.log(`    settles ${c.pool_name || c.inv_id} — matured ${day(c.end_date)}, ` +
                  `capital ${rand(c.capital)} + return ${rand(c.realised)}`);
      if (note) console.log(`    ${note}`);
    };

    if (neutral.length) {
      console.log(`\n── CASH-NEUTRAL (${neutral.length}) — interest → payout, no balance moves `
                  + '─'.repeat(8));
      neutral.forEach(c => show(c));
    }

    if (shifts.length) {
      console.log(`\n── BALANCE-SHIFTING (${shifts.length}) — return → payout `
                  + '─'.repeat(20));
      console.log('  A `return` row has NO cash effect; a `payout` is a credit. Retyping these');
      console.log('  moves each investor’s derived balance UP by the amount. That is almost');
      console.log('  certainly a correction — the money did reach the wallet — but it is');
      console.log('  client-visible, so it needs --allow-balance-shift as well as --apply.');
      shifts.forEach(c => show(c));
      const byInvestor = new Map();
      for (const c of shifts) {
        byInvestor.set(c.investor_id,
          (byInvestor.get(c.investor_id) || 0) + Number(c.amount));
      }
      console.log('\n  Balance change per investor if applied:');
      for (const [id, delta] of byInvestor) console.log(`    ${id}  +${rand(delta)}`);
    }

    if (skipped.length) {
      console.log(`\n── SKIPPED (${skipped.length}) — that money is already credited elsewhere `
                  + '─'.repeat(6));
      console.log('  Retyping these would count the same money twice. Never written, whatever');
      console.log('  flags are passed. Look at them by hand.');
      for (const { c, clash } of skipped) {
        show(c, 'already credited by: ' +
          clash.map(x => `${x.id} (${x.type}, ${rand(x.amount)}, ${day(x.at)})`).join('; '));
      }
      exitCode = 0;   // reporting, not failing — the operator decides
    }

    const toWrite = [...neutral, ...(SHIFTOK ? shifts : [])];

    if (!APPLY) {
      console.log(`\n  Preview only. --apply would write ${neutral.length} cash-neutral row(s)` +
                  `${shifts.length ? `, and ${shifts.length} balance-shifting row(s) with --allow-balance-shift` : ''}.\n`);
      return;
    }
    if (!toWrite.length) {
      console.log('\n  Nothing to write under the flags given.\n');
      return;
    }

    /* One transaction. A half-applied correction across a client's ledger is
       worse than none: the documents would disagree with each other and
       nobody could say which rows had moved. */
    const client = await pool.connect();
    let written = 0;
    try {
      await client.query('BEGIN');
      for (const c of toWrite) {
        const note = `Type corrected ${c.txn_type} → payout on ${new Date().toISOString().slice(0, 10)} ` +
          `by fix-income-typed-settlements: this row is the settlement of investment ${c.inv_id} ` +
          `(capital ${rand(c.capital)} + return ${rand(c.realised)}), not investment income. ` +
          `It was being counted as income on tax documents.`;
        const { rowCount } = await client.query(`
          UPDATE transactions
             SET type = 'payout',
                 investment_id = COALESCE(investment_id, $2),
                 pool_id       = COALESCE(pool_id, $3),
                 notes         = CASE WHEN COALESCE(notes, '') = '' THEN $4
                                      ELSE notes || E'\\n' || $4 END,
                 updated_at    = NOW()
           WHERE id = $1 AND type = $5`,
          [c.txn_id, c.inv_id, c.inv_pool_id, note, c.txn_type]);
        written += rowCount;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    console.log(`\n  ✅ ${written} row(s) corrected.`);
    console.log('  Reissue the Investment Income Reference for each investor named above —');
    console.log('  it is generated from live data, so reopening it is enough.\n');
  } catch (err) {
    console.error('\n  Failed:', err.message);
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
})();
