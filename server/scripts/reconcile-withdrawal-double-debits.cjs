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
 *   node server/scripts/reconcile-withdrawal-double-debits.cjs
 *   …--since 2025-01-01     only events on or after this date
 *   …--until 2026-08-28     only events before the end of this date
 *   …--window 30            seconds allowed between the two PATCHes (default 30)
 *   …--csv out.csv          write the per-withdrawal detail to a file
 *   …--investor S-11470     scope to one investor
 */
'use strict';

const fs = require('fs');
const { Pool } = require('pg');

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

    const bounds = [];
    const params = [];
    if (SINCE)    { params.push(SINCE); bounds.push(`a.created_at >= $${params.length}::date`); }
    if (UNTIL)    { params.push(UNTIL); bounds.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const whereExtra = bounds.length ? ' AND ' + bounds.join(' AND ') : '';

    /* What the audit log actually covers. Totals below mean nothing without it:
       a clean report over a window that starts after the fix shipped is not
       evidence that nobody was charged twice. */
    const { rows: [cover] } = await client.query(
      `SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*)::int AS n
         FROM audit_events`);
    if (!cover.n) {
      console.log('The audit log is empty. This report has nothing to work from.');
      await client.query('ROLLBACK'); client.release(); await pool.end(); process.exit(0);
    }
    console.log(`audit log covers ${String(cover.first).slice(0, 19)} → ${String(cover.last).slice(0, 19)}  (${cover.n.toLocaleString()} events)`);
    if (SINCE || UNTIL) console.log(`scoped to ${SINCE || 'the beginning'} … ${UNTIL || 'now'}`);
    console.log(`pairing window: ${WINDOW}s\n`);

    /* Every bare wallet write through the generic table API, paired with the
       transaction event that provoked it — same actor, same investor, closest
       one within the window. The deliberate override is a different event type
       and never appears here. */
    const sql = `
      WITH wallet_writes AS (
        SELECT a.id, a.entity_id AS investor_id, a.user_email, a.actor_role, a.created_at,
               (a.metadata->'after'->>'wallet_balance')::numeric AS written
          FROM audit_events a
         WHERE a.event_type = 'investors.updated'
           AND a.metadata->'after' ? 'wallet_balance'
           ${INVESTOR ? `AND a.entity_id = $${params.length + 1}` : ''}
           ${whereExtra}
      ),
      txn_completions AS (
        SELECT a.entity_id AS txn_id, a.user_email, a.created_at,
               t.investor_id, t.type, t.reference, t.sub_account_id,
               ABS(COALESCE(t.amount, 0)) AS amount
          FROM audit_events a
          JOIN transactions t ON t.id = a.entity_id
         WHERE a.event_type = 'transactions.updated'
           AND a.metadata->'after'->>'status' = 'completed'
      )
      SELECT w.id AS audit_id, w.investor_id, w.user_email, w.actor_role,
             w.created_at, w.written,
             c.txn_id, c.type, c.amount, c.reference, c.sub_account_id,
             i.first_name, i.last_name, i.email, i.wallet_balance AS wallet_now
        FROM wallet_writes w
        LEFT JOIN LATERAL (
          SELECT * FROM txn_completions t
           WHERE t.investor_id = w.investor_id
             AND COALESCE(t.user_email, '') = COALESCE(w.user_email, '')
             AND t.created_at <= w.created_at
             AND t.created_at > w.created_at - ($${params.length + (INVESTOR ? 2 : 1)} || ' seconds')::interval
           ORDER BY t.created_at DESC
           LIMIT 1
        ) c ON TRUE
        LEFT JOIN investors i ON i.id = w.investor_id
       ORDER BY w.created_at ASC`;

    if (INVESTOR) params.push(INVESTOR);
    params.push(String(WINDOW));
    const { rows } = await client.query(sql, params);

    const debits   = rows.filter(r => r.type === 'withdrawal');
    const credits  = rows.filter(r => r.type === 'deposit');
    const others   = rows.filter(r => r.type && r.type !== 'withdrawal' && r.type !== 'deposit');
    const unpaired = rows.filter(r => !r.type);

    /* ── The answer ──────────────────────────────────────────────────── */
    const exact  = debits.filter(r => Number(r.written) > 0);
    const capped = debits.filter(r => Number(r.written) === 0);
    const owedExact = exact.reduce((s, r) => s + Number(r.amount || 0), 0);
    const owedMax   = capped.reduce((s, r) => s + Number(r.amount || 0), 0);

    console.log('─'.repeat(78));
    console.log(`DOUBLE-DEBITED WITHDRAWALS: ${debits.length}`);
    console.log('─'.repeat(78));
    if (!debits.length) {
      console.log('None found in the window above.');
    } else {
      const byInv = new Map();
      for (const r of debits) {
        const k = r.investor_id;
        if (!byInv.has(k)) byInv.set(k, { r, exact: 0, capped: 0, n: 0 });
        const e = byInv.get(k);
        e.n++;
        if (Number(r.written) > 0) e.exact += Number(r.amount || 0);
        else e.capped += Number(r.amount || 0);
      }
      console.log(`\n${pad('Investor', 26)}${pad('ID', 14)}${lpad('Owed', 14)}${lpad('Needs review', 16)}  n`);
      console.log('─'.repeat(78));
      for (const [id, e] of [...byInv].sort((a, b) => (b[1].exact + b[1].capped) - (a[1].exact + a[1].capped))) {
        const name = `${e.r.first_name || ''} ${e.r.last_name || ''}`.trim() || '(deleted investor)';
        console.log(pad(name.slice(0, 25), 26) + pad(id.slice(0, 13), 14) +
                    lpad(e.exact ? R(e.exact) : '—', 14) +
                    lpad(e.capped ? '≤ ' + R(e.capped) : '—', 16) + '  ' + e.n);
      }
      console.log('─'.repeat(78));
      console.log(`${pad('', 40)}${lpad(R(owedExact), 14)}${lpad(owedMax ? '≤ ' + R(owedMax) : '—', 16)}`);
      console.log(`\n  ${exact.length} refundable exactly — the write landed above zero, so nothing was clamped.`);
      if (capped.length) {
        console.log(`  ${capped.length} landed on a zero balance. The Math.max(0, …) clamp may have absorbed`);
        console.log(`  part of the second debit, so each is AT MOST the amount shown and needs a`);
        console.log(`  person to settle. These are NOT added to the refundable total.`);
      }
    }

    /* ── The same bug running the other way ──────────────────────────── */
    if (credits.length) {
      const subAcct = credits.filter(r => r.sub_account_id);
      console.log('\n' + '─'.repeat(78));
      console.log(`DEPOSITS WITH A BARE WALLET WRITE: ${credits.length}` +
                  (subAcct.length ? `  (${subAcct.length} on a SUB-ACCOUNT)` : ''));
      console.log('─'.repeat(78));
      console.log('Same defect, opposite direction. On a sub-account deposit the server credited');
      console.log('the sub-account and the console credited the parent as well, so these created');
      console.log('money rather than taking it. The rest landed on the right figure but overwrote');
      console.log('anything that changed in between.');
      if (subAcct.length) {
        const overpaid = subAcct.reduce((s, r) => s + Number(r.amount || 0), 0);
        console.log(`\n  ${subAcct.length} sub-account deposits, ${R(overpaid)} credited to parent wallets in error.`);
        for (const r of subAcct.slice(0, 15)) {
          console.log(`    ${pad(`${r.first_name || ''} ${r.last_name || ''}`.trim().slice(0, 24), 25)}` +
                      `${lpad(R(r.amount), 13)}  ${String(r.created_at).slice(0, 10)}  ${r.reference || r.txn_id}`);
        }
        if (subAcct.length > 15) console.log(`    …and ${subAcct.length - 15} more (use --csv for the full list)`);
      }
    }

    if (others.length) {
      const kinds = [...new Set(others.map(r => r.type))].join(', ');
      console.log(`\n${others.length} wallet write(s) paired with another transaction type (${kinds}) — listed in the CSV.`);
    }

    /* ── How much to trust the number ────────────────────────────────── */
    console.log('\n' + '─'.repeat(78));
    console.log('COVERAGE');
    console.log('─'.repeat(78));
    if (unpaired.length) {
      console.log(`${unpaired.length} bare wallet write(s) had no transaction event within ${WINDOW}s.`);
      console.log('Either a slower round trip, or a wallet write from somewhere this report does');
      console.log('not model. Raise --window and see whether they pair up before treating them as');
      console.log('a separate problem.');
    }

    /* The reverse gap: an approved withdrawal with no wallet write recorded
       against it. The audit insert is fire-and-forget, so a missing row means
       missing evidence, not a clean approval. */
    const { rows: [gap] } = await client.query(`
      SELECT COUNT(*)::int AS n
        FROM audit_events a
        JOIN transactions t ON t.id = a.entity_id
       WHERE a.event_type = 'transactions.updated'
         AND a.metadata->'after'->>'status' = 'completed'
         AND t.type = 'withdrawal'
         ${SINCE ? `AND a.created_at >= '${SINCE}'::date` : ''}
         ${UNTIL ? `AND a.created_at < ('${UNTIL}'::date + INTERVAL '1 day')` : ''}
         AND NOT EXISTS (
           SELECT 1 FROM audit_events w
            WHERE w.event_type = 'investors.updated'
              AND w.metadata->'after' ? 'wallet_balance'
              AND w.entity_id = t.investor_id
              AND w.created_at BETWEEN a.created_at AND a.created_at + ($1 || ' seconds')::interval
         )`, [String(WINDOW)]);
    console.log(`${gap.n} approved withdrawal(s) in this window have no paired wallet write.`);
    if (gap.n) {
      console.log('Those are either approvals made after the fix shipped, approvals made outside');
      console.log('the console, or approvals whose audit row never landed — the audit write is');
      console.log('fire-and-forget. Where it is the third, the totals above are a floor.');
    }

    /* ── CSV ─────────────────────────────────────────────────────────── */
    if (CSV) {
      const esc = v => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const head = ['when', 'investor_id', 'first_name', 'last_name', 'email', 'txn_type',
                    'txn_id', 'reference', 'sub_account_id', 'amount', 'balance_written',
                    'clamped_at_zero', 'extra_debit', 'wallet_now', 'actor', 'actor_role'];
      const lines = [head.join(',')];
      for (const r of rows) {
        const isDebit = r.type === 'withdrawal';
        const clamped = Number(r.written) === 0;
        lines.push([
          String(r.created_at).slice(0, 19), r.investor_id, r.first_name, r.last_name, r.email,
          r.type || '(unpaired)', r.txn_id, r.reference, r.sub_account_id,
          r.amount == null ? '' : Number(r.amount).toFixed(2),
          r.written == null ? '' : Number(r.written).toFixed(2),
          isDebit ? (clamped ? 'yes' : 'no') : '',
          isDebit ? (clamped ? `<=${Number(r.amount || 0).toFixed(2)}` : Number(r.amount || 0).toFixed(2)) : '',
          r.wallet_now == null ? '' : Number(r.wallet_now).toFixed(2),
          r.user_email, r.actor_role,
        ].map(esc).join(','));
      }
      fs.writeFileSync(CSV, lines.join('\n') + '\n');
      console.log(`\nWrote ${rows.length} row(s) to ${CSV}`);
    } else if (rows.length) {
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
