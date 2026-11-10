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
 * somebody reading a ledger by eye.
 *
 * THE ARITHMETIC IS IN services/ledgerGap — this file is the terminal's view
 * of it. The admin console reads the same service through
 * GET /api/admin/ledger-gap (Ops Console → Ledger Gap Explained), so a figure
 * quoted to a client from a screen and one printed here cannot disagree. That
 * mattered as soon as the question arrived from somebody without production
 * credentials: the answer should not be gated on who has a DATABASE_URL.
 *
 * READ-ONLY. This writes nothing, ever. The repairs live elsewhere, and each
 * is named against the part of the gap it would close.
 *
 * Usage:
 *   DATABASE_URL=… node server/scripts/explain-ledger-gap.cjs
 *   …                                                  --investor=S-112415
 *   …                                                  --min=100
 */
'use strict';

const { Pool } = require('pg');
const { explain } = require('../services/ledgerGap');

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

(async () => {
  try {
    const out = await explain(pool, { investorId: ONLY, min: MIN });

    if (ONLY && !out.found) {
      console.log(`\n  No account with id ${ONLY}. Nothing was checked — this is not a clean result.\n`);
      process.exitCode = 1;
      return;
    }

    if (!out.accounts.length) {
      console.log(`\n  Every account ties${ONLY ? ` (${ONLY})` : ''}: the wallet equals the sum of its ledger.\n`);
      return;
    }

    console.log(`\n${out.accounts.length} account(s) where the wallet and the ledger disagree` +
                `${ONLY ? '' : ` (threshold ${rand(out.threshold)})`}\n`);

    for (const a of out.accounts) {
      const c = a.causes;
      console.log('═'.repeat(74));
      console.log(`${a.name} (${a.id})${a.email ? ' · ' + a.email : ''}`);
      console.log(`  wallet ${rand(a.wallet)}   ledger ${rand(a.derived)}   ` +
                  `GAP ${a.gap > 0 ? '+' : ''}${rand(a.gap)}`);
      console.log(a.direction === 'ledger-under-accounts'
        ? '  The ledger UNDER-accounts: the wallet holds more than the history explains.'
        : '  The ledger OVER-accounts: the history explains more than the wallet holds.');

      if (c.unpairedReinvestments.count) {
        const u = c.unpairedReinvestments;
        console.log(`\n  1. REINVESTMENTS WITH NO MATURED-FUNDS CREDIT — ${u.count}, ${rand(u.total)}`);
        console.log('     The pair is a bookkeeping device: the matured money arrives and is');
        console.log('     spent in the same breath. The debit alone leaves the ledger short by');
        console.log('     the whole amount, once per rollover.');
        for (const r of u.rows.slice(0, 8)) {
          console.log(`       ${r.at}  ${rand(r.amount)}  ${r.reference}`);
        }
        if (u.rows.length > 8) console.log(`       … and ${u.rows.length - 8} more`);
        console.log(`     FIX: ${u.remedy}`);
        console.log(`     That would close ${rand(u.total)} of the gap.`);
      }

      if (c.unpairableReinvestments.count) {
        const u = c.unpairableReinvestments;
        console.log(`\n  1b. REINVESTMENTS THE BACKFILL CANNOT PAIR — ${u.count}, ${rand(u.total)}`);
        console.log('     Their reference is not in the REINV-<investment id> shape that repair');
        console.log('     matches on, so it will not touch them. By hand.');
        for (const r of u.rows.slice(0, 5)) {
          console.log(`       ${r.at}  ${rand(r.amount)}  ${r.reference || '(no reference)'}  ${r.id}`);
        }
      }

      if (c.noCashEffect.byType.length) {
        const n = c.noCashEffect;
        console.log(`\n  2. ROWS CARRYING NO CASH EFFECT — ${rand(n.total)} across ` +
                    `${n.byType.map(r => r.type).join(', ')}`);
        for (const r of n.byType) {
          console.log(`       ${String(r.type).padEnd(16)} ${String(r.n).padStart(4)} row(s)  ${rand(r.total)}`);
        }
        console.log('     NOT automatically part of the gap. `return` is an accrual by design,');
        console.log('     and counting a genuine accrual as cash would invent money. It is a');
        console.log('     cause only where that money really did reach the wallet — which is the');
        console.log('     mis-typed settlement fix-income-typed-settlements.cjs reports on.');
      }

      console.log(`\n  ACCOUNTED FOR: ${rand(a.accountedFor)} by missing matured-funds credits.`);
      if (Math.abs(a.unexplained) < 0.005) {
        console.log('  UNEXPLAINED: nothing. Running that backfill should make this account tie.');
      } else {
        console.log(`  UNEXPLAINED: ${rand(a.unexplained)}.`);
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
