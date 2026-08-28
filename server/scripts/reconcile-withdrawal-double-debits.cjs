#!/usr/bin/env node
/* Who was charged twice for one withdrawal, and how much they are owed.
 *
 * THE DEFECT
 *
 * The wallet is debited when a withdrawal REQUEST is created (withdrawals.js),
 * which is why tables.js refunds it when one is rejected. The admin console's
 * approveWithdrawal then deducted it a SECOND time: it PATCHed the transaction
 * to completed — which the server correctly treats as a no-op for the balance —
 * and then PATCHed investors.wallet_balance to
 *
 *     Math.max(0, <the console's own copy of the wallet> - amount)
 *
 * So every admin-approved withdrawal took the money twice. Probed against the
 * real route before the fix: R1,000 out of a R5,000 wallet left R3,000.
 *
 * HOW IT IS FOUND
 *
 * That second write left no transaction row — it was a bare balance write — so
 * the ledger cannot see it. The audit log can. Every PATCH through the table API
 * records an `investors.updated` event whose metadata->'after' is the request
 * body, so the offending write appears as an `investors.updated` carrying a
 * wallet_balance.
 *
 * That signature is unambiguous. The one legitimate absolute wallet write in the
 * platform — the admin's deliberate, confirmed override — goes through
 * /api/admin/override-wallet and logs `wallet.balance_override` instead. Nothing
 * else writes investors.wallet_balance through the generic table API.
 *
 * Each such write is then paired with the transaction event that provoked it:
 * the same actor, the same investor, moments earlier. A withdrawal going to
 * completed means a double DEBIT — the client is owed money. A deposit means the
 * other bug in the same family, a double CREDIT on a sub-account deposit, which
 * is reported separately because it runs the other way.
 *
 * HOW MUCH
 *
 * The console wrote max(0, stale - amount), so the extra debit is
 * min(amount, wallet at that moment).
 *
 *   · the write landed above zero  → no clamp → the extra debit is EXACTLY the
 *                                    withdrawal amount
 *   · the write landed on zero     → the clamp may have absorbed part of it, so
 *                                    the extra debit is AT MOST the amount and
 *                                    needs a human to settle
 *
 * Those two are never added together. The first is a figure you can refund; the
 * second is a list to work through.
 *
 * WHAT THIS DOES NOT COVER
 *
 * The audit write is fire-and-forget, so a failed audit insert means a double
 * debit with no evidence here. The report prints the audit window it actually
 * saw, and the count of approved withdrawals in that window with no paired
 * wallet write — if that number is large, the audit log is not complete and
 * these totals are a floor, not a total.
 *
 * READ ONLY. It opens a READ ONLY transaction and only ever SELECTs. There is
 * no --apply: this is a report, and refunding is a decision, not a script.
 *
 * The query lives in services/withdrawalReconciliation.js because the ops
 * console runs the same report. A money report with two implementations is a
 * money report you cannot quote.
 *
 *   node server/scripts/reconcile-withdrawal-double-debits.cjs
 *   …--since 2025-01-01     only events on or after this date
 *   …--until 2026-08-28     only events before the end of this date
 *   …--window 30            seconds allowed between the two PATCHes (default 30)
 *   …--csv out.csv          write the per-withdrawal detail to a file
 *   …--investor S-11470     scope to one investor
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { runWithdrawalReconciliation } = require(path.join(__dirname, '..', 'services', 'withdrawalReconciliation'));

const ARGV = process.argv.slice(2);
const arg  = n => { const i = ARGV.indexOf(n); return i > -1 ? ARGV[i + 1] : null; };

const SINCE    = arg('--since');
const UNTIL    = arg('--until');
const INVESTOR = arg('--investor');
const CSV      = arg('--csv');
const WINDOW   = Math.max(1, parseInt(arg('--window') || '30', 10));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2,
});

const R = n => 'R' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const lpad = (s, n) => String(s == null ? '' : s).padStart(n);


(async () => {
  const client = await pool.connect();
  let exitCode = 0;
  try {
    await client.query(`SET statement_timeout = '180s'`);
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    console.log('\nWITHDRAWAL DOUBLE-DEBIT RECONCILIATION');
    console.log('READ ONLY — this transaction cannot write.\n');

    const rep = await runWithdrawalReconciliation(client,
      { since: SINCE, until: UNTIL, investor: INVESTOR, window: WINDOW });

    if (rep.verdict === 'no-evidence') {
      console.log('The audit log is empty. This report has nothing to work from.');
      await client.query('ROLLBACK'); client.release(); await pool.end(); process.exit(0);
    }

    console.log(`audit log covers ${String(rep.coverage.first).slice(0, 19)} → ${String(rep.coverage.last).slice(0, 19)}` +
                `  (${rep.coverage.events.toLocaleString()} events)`);
    if (SINCE || UNTIL) console.log(`scoped to ${SINCE || 'the beginning'} … ${UNTIL || 'now'}`);
    console.log(`pairing window: ${rep.window}s\n`);

    const t = rep.totals;
    console.log('─'.repeat(78));
    console.log(`DOUBLE-DEBITED WITHDRAWALS: ${rep.doubleDebits.length}`);
    console.log('─'.repeat(78));
    if (!rep.doubleDebits.length) {
      console.log('None found in the window above.');
    } else {
      console.log(`\n${pad('Investor', 26)}${pad('ID', 14)}${lpad('Owed', 14)}${lpad('Needs review', 16)}  n`);
      console.log('─'.repeat(78));
      for (const e of rep.byInvestor) {
        console.log(pad((e.name || '(deleted investor)').slice(0, 25), 26) +
                    pad(String(e.investorId).slice(0, 13), 14) +
                    lpad(e.owed ? R(e.owed) : '—', 14) +
                    lpad(e.needsReview ? '≤ ' + R(e.needsReview) : '—', 16) + '  ' + e.n);
      }
      console.log('─'.repeat(78));
      console.log(`${pad('', 40)}${lpad(R(t.owed), 14)}${lpad(t.needsReview ? '≤ ' + R(t.needsReview) : '—', 16)}`);
      console.log(`\n  ${t.exactCount} refundable exactly — the write landed above zero, so nothing was clamped.`);
      if (t.cappedCount) {
        console.log(`  ${t.cappedCount} landed on a zero balance. The Math.max(0, …) clamp may have absorbed`);
        console.log(`  part of the second debit, so each is AT MOST the amount shown and needs a`);
        console.log(`  person to settle. These are NOT added to the refundable total.`);
      }
    }

    if (rep.deposits.length) {
      console.log('\n' + '─'.repeat(78));
      console.log(`DEPOSITS WITH A BARE WALLET WRITE: ${rep.deposits.length}` +
                  (t.subAccountCount ? `  (${t.subAccountCount} on a SUB-ACCOUNT)` : ''));
      console.log('─'.repeat(78));
      console.log('Same defect, opposite direction. On a sub-account deposit the server credited');
      console.log('the sub-account and the console credited the parent as well, so these created');
      console.log('money rather than taking it. The rest landed on the right figure but overwrote');
      console.log('anything that changed in between.');
      const sub = rep.deposits.filter(d => d.subAccountId);
      if (sub.length) {
        console.log(`\n  ${sub.length} sub-account deposits, ${R(t.subAccountTotal)} credited to parent wallets in error.`);
        for (const r of sub.slice(0, 15)) {
          console.log(`    ${pad((r.name || r.investorId).slice(0, 24), 25)}${lpad(R(r.amount), 13)}` +
                      `  ${String(r.when).slice(0, 10)}  ${r.reference || r.txnId}`);
        }
        if (sub.length > 15) console.log(`    …and ${sub.length - 15} more (use --csv for the full list)`);
      }
    }

    if (rep.other.length) {
      console.log(`\n${rep.other.length} wallet write(s) paired with another transaction type — listed in the CSV.`);
    }

    console.log('\n' + '─'.repeat(78));
    console.log('COVERAGE');
    console.log('─'.repeat(78));
    if (rep.unpaired) {
      console.log(`${rep.unpaired} bare wallet write(s) had no transaction event within ${rep.window}s.`);
      console.log('Either a slower round trip, or a wallet write from somewhere this report does');
      console.log('not model. Raise --window and see whether they pair up before treating them as');
      console.log('a separate problem.');
    }
    console.log(`${rep.approvedWithoutWrite} approved withdrawal(s) in this window have no paired wallet write.`);
    if (rep.approvedWithoutWrite) {
      console.log('Those are either approvals made after the fix shipped, approvals made outside');
      console.log('the console, or approvals whose audit row never landed — the audit write is');
      console.log('fire-and-forget. Where it is the third, the totals above are a floor.');
    }

    if (CSV) {
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const head = ['when', 'investor_id', 'name', 'email', 'txn_type', 'txn_id', 'reference',
                    'sub_account_id', 'amount', 'balance_written', 'clamped_at_zero',
                    'extra_debit', 'wallet_now', 'actor', 'actor_role'];
      const lines = [head.join(',')];
      const kind = r => rep.doubleDebits.includes(r) ? 'withdrawal'
                      : rep.deposits.includes(r) ? 'deposit'
                      : rep.other.includes(r) ? 'other' : '(unpaired)';
      for (const r of [...rep.doubleDebits, ...rep.deposits, ...rep.other]) {
        const isDebit = kind(r) === 'withdrawal';
        lines.push([
          String(r.when).slice(0, 19), r.investorId, r.name, r.email, kind(r), r.txnId, r.reference,
          r.subAccountId,
          r.amount == null ? '' : r.amount.toFixed(2),
          r.written == null ? '' : r.written.toFixed(2),
          isDebit ? (r.clamped ? 'yes' : 'no') : '',
          /* An upper bound is marked, so a refund run cannot read it as an amount. */
          isDebit ? (r.clamped ? `<=${(r.amount || 0).toFixed(2)}` : (r.amount || 0).toFixed(2)) : '',
          r.walletNow == null ? '' : r.walletNow.toFixed(2),
          r.actor, r.actorRole,
        ].map(esc).join(','));
      }
      fs.writeFileSync(CSV, lines.join('\n') + '\n');
      console.log(`\nWrote ${lines.length - 1} row(s) to ${CSV}`);
    } else if (rep.rowCount) {
      console.log('\nRe-run with --csv <file> for the per-withdrawal detail.');
    }

    await client.query('ROLLBACK');
    console.log('\nNothing was written.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFailed:', err.message);
    exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
})();
