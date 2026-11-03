#!/usr/bin/env node
/* Why a statement says the balances do not tie, and by how much, and what to
 * do about each part of it.
 *
 * A client asked: "There's a R33 237,71 opening balance discrepancy flagged on
 * the statement. Can you please explain or correct this?"
 *
 * Nobody could, because the statement states the SIZE of the gap and not its
 * cause. Its note says "a transaction is missing or recorded under a type that
 * carries no cash effect", which is the right shortlist and still leaves
 * somebody reading a ledger by eye. This decomposes it.
 *
 * ── WHAT THE NUMBER IS ─────────────────────────────────────────────────
 *
 * accountStatement anchors the balances to the wallet and reports the derived
 * opening beside them:
 *
 *     ledger_gap = opening − derivedOpen
 *                = (wallet − after_period − periodMovement) − before_period
 *                = wallet − SUM(cashMovement over the WHOLE ledger)
 *
 * The period cancels. So the gap is one fact about the account and not about
 * the dates on the statement: the wallet holds this much more than the
 * transaction history accounts for. Running this for any period gives the same
 * figure, which is itself worth knowing — it is not a date-range artefact.
 *
 * ── WHERE IT COMES FROM ────────────────────────────────────────────────
 *
 * A positive gap means the ledger UNDER-accounts, and three things do that:
 *
 *   1. A reinvestment whose paired `matured_funds` credit was never written.
 *      The pair is a bookkeeping device — the matured money arrives and is
 *      immediately spent — so the debit alone leaves the ledger short by the
 *      whole amount. This is the known historical gap that
 *      POST /api/admin/backfill-matured-funds exists to repair, and on an
 *      account that has rolled over for years it compounds, one rollover at a
 *      time.
 *
 *   2. A row recorded under a type that carries no cash effect. `return` is
 *      deliberately one of those — an accrual is not cash — so a `return` row
 *      is only a cause when that money really did reach the wallet, which is
 *      the mis-typed settlement that services/incomeReference.js also catches.
 *      Reported by type, never assumed: calling a genuine accrual cash would
 *      invent money.
 *
 *   3. The wallet moved with no row written at all. Nothing here can name
 *      those, so whatever 1 and 2 do not explain is reported as UNEXPLAINED
 *      rather than folded into them.
 *
 * READ-ONLY. This writes nothing, ever. The repairs live elsewhere, and each
 * is named against the part of the gap it would close.
 *
 * Usage:
 *   DATABASE_URL=… node server/scripts/explain-ledger-gap.cjs
 *   …                                                  --investor=S-112276
 *   …                                                  --min=100
 */
'use strict';

const { Pool } = require('pg');
const { cashMovementSQL } = require('../services/ledger');

const ONLY = (process.argv.find(a => a.startsWith('--investor=')) || '').split('=')[1] || null;
const MIN  = parseFloat((process.argv.find(a => a.startsWith('--min=')) || '').split('=')[1]) || 0.005;

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
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* The gap, per investor, exactly as accountStatement derives it: the wallet
   less the cash effect of every completed row, using the one shared
   definition rather than a copy of it. */
const GAPS = `
  SELECT i.id, i.first_name, i.last_name, i.email,
         COALESCE(i.wallet_balance, 0)                      AS wallet,
         COALESCE(t.derived, 0)                             AS derived,
         COALESCE(i.wallet_balance, 0) - COALESCE(t.derived, 0) AS gap
    FROM investors i
    LEFT JOIN (
      SELECT investor_id, SUM(${cashMovementSQL()}) AS derived
        FROM transactions
       WHERE status = 'completed' AND investor_id IS NOT NULL
       GROUP BY investor_id
    ) t ON t.investor_id = i.id
   WHERE ($1::text IS NULL OR i.id = $1::text)
   ORDER BY ABS(COALESCE(i.wallet_balance, 0) - COALESCE(t.derived, 0)) DESC`;

/* Cause 1. A reinvestment with no paired matured_funds credit.

   Paired on the reference the backfill endpoint pairs on, so what this
   attributes is exactly what that repair would write — a figure that says
   "this much of the gap closes if you run it" rather than a resemblance. */
const UNPAIRED = `
  SELECT t.id, t.reference, ABS(t.amount) AS amount,
         COALESCE(t.transaction_date, t.created_at) AS at
    FROM transactions t
   WHERE t.investor_id = $1
     AND t.status = 'completed'
     AND t.type = 'reinvestment'
     AND t.reference LIKE 'REINV-%'
     AND NOT EXISTS (
       SELECT 1 FROM transactions t2
        WHERE t2.reference = 'MATF-' || REPLACE(t.reference, 'REINV-', ''))
   ORDER BY COALESCE(t.transaction_date, t.created_at)`;

/* A reinvestment the backfill CANNOT pair, because its reference is not in
   the shape that repair matches on. Named separately: counting it under
   cause 1 would promise a repair that will not touch it. */
const UNPAIRABLE = `
  SELECT t.id, t.type, t.reference, ABS(t.amount) AS amount,
         COALESCE(t.transaction_date, t.created_at) AS at
    FROM transactions t
   WHERE t.investor_id = $1
     AND t.status = 'completed'
     AND t.type = 'reinvestment'
     AND (t.reference IS NULL OR t.reference NOT LIKE 'REINV-%')
   ORDER BY COALESCE(t.transaction_date, t.created_at)`;

/* Cause 2. Rows carrying no cash effect, by type. Reported, not assumed:
   `return` is an accrual by design and only counts when that money really
   moved. */
const NOCASH = `
  SELECT t.type, COUNT(*) AS n, SUM(ABS(t.amount)) AS total
    FROM transactions t
   WHERE t.investor_id = $1
     AND t.status = 'completed'
     AND (${cashMovementSQL('t.')}) = 0
   GROUP BY t.type
   ORDER BY SUM(ABS(t.amount)) DESC`;

(async () => {
  try {
    const { rows: investors } = await pool.query(GAPS, [ONLY]);
    const affected = investors.filter(r => Math.abs(Number(r.gap)) >= MIN);

    if (!affected.length) {
      console.log(`\n  Every account ties${ONLY ? ` (${ONLY})` : ''}: the wallet equals the sum of its ledger.\n`);
      return;
    }

    console.log(`\n${affected.length} account(s) where the wallet and the ledger disagree` +
                `${ONLY ? '' : ` (threshold ${rand(MIN)})`}\n`);

    for (const a of affected) {
      const who = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.id;
      const gap = r2(a.gap);
      console.log('═'.repeat(74));
      console.log(`${who} (${a.id})${a.email ? ' · ' + a.email : ''}`);
      console.log(`  wallet ${rand(a.wallet)}   ledger ${rand(a.derived)}   ` +
                  `GAP ${gap > 0 ? '+' : ''}${rand(gap)}`);
      console.log(gap > 0
        ? '  The ledger UNDER-accounts: the wallet holds more than the history explains.'
        : '  The ledger OVER-accounts: the history explains more than the wallet holds.');

      const [{ rows: unpaired }, { rows: unpairable }, { rows: nocash }] = await Promise.all([
        pool.query(UNPAIRED,   [a.id]),
        pool.query(UNPAIRABLE, [a.id]),
        pool.query(NOCASH,     [a.id]),
      ]);

      const unpairedTotal = r2(unpaired.reduce((s, r) => s + Number(r.amount), 0));
      const nocashTotal   = r2(nocash.reduce((s, r) => s + Number(r.total), 0));

      if (unpaired.length) {
        console.log(`\n  1. REINVESTMENTS WITH NO MATURED-FUNDS CREDIT — ${unpaired.length}, ` +
                    `${rand(unpairedTotal)}`);
        console.log('     The pair is a bookkeeping device: the matured money arrives and is');
        console.log('     spent in the same breath. The debit alone leaves the ledger short by');
        console.log('     the whole amount, once per rollover.');
        for (const r of unpaired.slice(0, 8)) {
          console.log(`       ${String(r.at).slice(0, 10)}  ${rand(r.amount)}  ${r.reference}`);
        }
        if (unpaired.length > 8) console.log(`       … and ${unpaired.length - 8} more`);
        console.log('     FIX: POST /api/admin/backfill-matured-funds with {"dry_run":true} first.');
        console.log(`     That would close ${rand(unpairedTotal)} of the gap.`);
      }

      if (unpairable.length) {
        const t = r2(unpairable.reduce((s, r) => s + Number(r.amount), 0));
        console.log(`\n  1b. REINVESTMENTS THE BACKFILL CANNOT PAIR — ${unpairable.length}, ${rand(t)}`);
        console.log('     Their reference is not in the REINV-<investment id> shape that repair');
        console.log('     matches on, so it will not touch them. By hand.');
        for (const r of unpairable.slice(0, 5)) {
          console.log(`       ${String(r.at).slice(0, 10)}  ${rand(r.amount)}  ${r.reference || '(no reference)'}  ${r.id}`);
        }
      }

      if (nocash.length) {
        console.log(`\n  2. ROWS CARRYING NO CASH EFFECT — ${rand(nocashTotal)} across ` +
                    `${nocash.map(r => r.type).join(', ')}`);
        for (const r of nocash) {
          console.log(`       ${String(r.type).padEnd(16)} ${String(r.n).padStart(4)} row(s)  ${rand(r.total)}`);
        }
        console.log('     NOT automatically part of the gap. `return` is an accrual by design,');
        console.log('     and counting a genuine accrual as cash would invent money. It is a');
        console.log('     cause only where that money really did reach the wallet — which is the');
        console.log('     mis-typed settlement fix-income-typed-settlements.cjs reports on.');
      }

      /* Only cause 1 is arithmetic. Everything else is a candidate, so the
         remainder is stated against cause 1 alone — overstating what is
         explained is how a reconciliation stops being one. */
      const unexplained = r2(gap - unpairedTotal);
      console.log(`\n  ACCOUNTED FOR: ${rand(unpairedTotal)} by missing matured-funds credits.`);
      if (Math.abs(unexplained) < 0.005) {
        console.log('  UNEXPLAINED: nothing. Running that backfill should make this account tie.');
      } else {
        console.log(`  UNEXPLAINED: ${rand(unexplained)}.`);
        console.log('  Look at cause 2 above first; beyond that it is a wallet that moved with');
        console.log('  no row written, which this cannot name from the ledger alone.');
      }
      console.log('');
    }

    console.log('═'.repeat(74));
    console.log('Nothing was written. Each remedy above is a separate, deliberate step.\n');
  } catch (err) {
    console.error('\n  Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
