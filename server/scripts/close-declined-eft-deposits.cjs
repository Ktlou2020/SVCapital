#!/usr/bin/env node
/* Close the deposits left Pending by a decline that only closed the ticket.
 *
 * The console's EFT decline updated the support ticket and nothing else, so the
 * pending deposit the portal creates when proof is submitted stayed 'pending'
 * forever. The client was told their proof was rejected and went on seeing the
 * deposit as Pending in their transactions. Fixed going forward; this is for
 * the rows already stranded.
 *
 * HOW ONE IS IDENTIFIED
 *
 * A payment_proof ticket that is resolved, whose deposit is still pending. If
 * it had been approved the deposit would read 'completed', so a resolved ticket
 * over a pending deposit means the ticket was actioned and the deposit was not.
 *
 * That is necessary but not sufficient, and the difference matters, so the
 * candidates are split by what the admin actually told the client:
 *
 *   DECLINED   the response says declined or rejected. The client has been told
 *              the money is not coming. Marking the deposit rejected agrees
 *              with what they were told. Safe to apply.
 *   APPROVED   the response says approved or credited — an approval that did
 *              not finish. The client may well have paid. Marking it rejected
 *              would be the opposite of the truth, so these are REPORTED AND
 *              NEVER TOUCHED, by --apply or otherwise.
 *   UNCLEAR    no response, or one that says neither. A person has to read it.
 *
 * Only the first group is ever written, and only with --apply.
 *
 * No money moves either way: the balance hooks in tables.js credit a deposit on
 * 'completed' and refund only withdrawals on 'rejected'.
 *
 *   node server/scripts/close-declined-eft-deposits.cjs            # report only
 *   node server/scripts/close-declined-eft-deposits.cjs --apply    # close the DECLINED group
 *   …--csv out.csv                                                 # the full list
 *
 * The query and the grouping live in services/strandedEftDeposits.js because
 * the ops console runs the same backfill. Two implementations would eventually
 * disagree about which group a client falls into, and that decision is the
 * difference between owing them an explanation and owing them money.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { findStrandedEftDeposits, closeDeclinedEftDeposits } =
  require(path.join(__dirname, '..', 'services', 'strandedEftDeposits'));

const ARGV  = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const CSV   = (i => i > -1 ? ARGV[i + 1] : null)(ARGV.indexOf('--csv'));

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

(async () => {
  const client = await pool.connect();
  let exitCode = 0;
  try {
    await client.query(`SET statement_timeout = '120s'`);
    await client.query('BEGIN');
    if (!APPLY) await client.query('SET TRANSACTION READ ONLY');

    console.log(APPLY
      ? '\nCLOSING STRANDED EFT DEPOSITS — writing the DECLINED group only.\n'
      : '\nSTRANDED EFT DEPOSITS — report only, this transaction cannot write.\n');

    const report = await findStrandedEftDeposits(client);
    if (report.verdict === 'clean') {
      console.log('No resolved payment-proof ticket has a deposit still sitting at pending.');
      await client.query('ROLLBACK'); client.release(); await pool.end(); process.exit(0);
    }

    const show = (key, blurb) => {
      const g = report.groups[key];
      const t = report.totals[key.toLowerCase()];
      console.log('─'.repeat(76));
      console.log(`${key}: ${t.n}   ${R(t.value)}`);
      console.log('─'.repeat(76));
      console.log(blurb);
      if (!g.length) return;
      console.log(`\n${pad('Investor', 24)}${pad('Reference', 18)}${pad('Amount', 14)}Declined`);
      for (const r of g.slice(0, 25)) {
        console.log(pad((r.name || r.investorId).slice(0, 23), 24) +
                    pad(String(r.reference).slice(0, 17), 18) +
                    pad(R(r.amount), 14) +
                    String(r.respondedAt || '').slice(0, 10));
      }
      if (g.length > 25) console.log(`…and ${g.length - 25} more (use --csv for the full list)`);
      console.log('');
    };

    show('DECLINED',
      'The client was told the payment was refused, and the deposit still reads Pending\n' +
      'to them. Marking it Rejected agrees with what they were already told.');
    show('APPROVED',
      'The response says the deposit was APPROVED, but it never completed — so the money\n' +
      'may genuinely have arrived and simply not been credited. Marking these rejected\n' +
      'would be the opposite of the truth. NEVER written, by --apply or otherwise.\n' +
      'Work these by hand: approve them properly, or find out what happened.');
    show('UNCLEAR',
      'No response recorded, or one that says neither. A person has to read the ticket\n' +
      'before anything is decided. Not written.');

    if (APPLY && report.totals.declined.n) {
      const { closed } = await closeDeclinedEftDeposits(client);
      await client.query('COMMIT');
      console.log(`Applied. ${closed} deposit(s) moved from Pending to Rejected.`);
      console.log('No wallet was touched — a rejected deposit moves no money.');
    } else {
      await client.query('ROLLBACK');
      console.log(APPLY
        ? 'Nothing in the DECLINED group to apply.'
        : `Nothing was written. Re-run with --apply to close the ${report.totals.declined.n} DECLINED deposit(s).`);
    }

    if (CSV) {
      const esc = v => { const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const head = ['group', 'investor_id', 'name', 'email', 'reference', 'amount',
                    'deposit_id', 'deposit_created', 'ticket_id', 'responded_at', 'admin_response'];
      const lines = [head.join(',')];
      for (const [key, g] of Object.entries(report.groups)) for (const r of g) {
        lines.push([key, r.investorId, r.name, r.email, r.reference, r.amount.toFixed(2),
          r.depositId, String(r.depositCreated).slice(0, 19), r.ticketId,
          String(r.respondedAt || '').slice(0, 19), r.adminResponse].map(esc).join(','));
      }
      fs.writeFileSync(CSV, lines.join('\n') + '\n');
      console.log(`\nWrote ${report.count} row(s) to ${CSV}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFailed, nothing was written:', err.message);
    exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
})();
