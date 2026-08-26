#!/usr/bin/env node
/* Audit past EFT approvals for gaps between what was submitted, what was
 * credited, and what the investor was told.
 *
 * WHY: a client paid R505 and typed R500 on the platform. The console asked
 * "Credit R500?" and offered only yes or no, so R500 was credited and the R5
 * went nowhere. The approval path now confirms the figure against the proof
 * and records any correction, but that only helps from here on.
 *
 * WHAT THIS CAN AND CANNOT SEE — read this before trusting the output.
 *
 * The platform never learns the real bank amount. When an investor submits an
 * EFT, one figure (`_pmAmount`) is written to three places: the pending
 * transactions row, the ticket subject, and the ticket message. The actual
 * amount that hit the bank exists only inside the attached proof of payment,
 * which is a base64 image or PDF in support_tickets.file_url. There is no bank
 * statement table on this platform — nothing imports the bank side at all.
 *
 * So the R505-vs-R500 gap is NOT detectable from platform data. Anything
 * claiming otherwise would be guessing. What this script does instead:
 *
 *   - reports the gaps that ARE decidable from the data (A-D below), each of
 *     which is money-affecting in its own right, and
 *   - prints a review worklist (E) of approvals with a proof attached, so the
 *     R505 class can be settled by opening the proofs — the only way it can be
 *     settled — with the most likely candidates first.
 *
 * Findings:
 *   A  credited amount differs from the amount in the ticket subject
 *   B  ticket resolved but nothing was ever credited   (told approved, no money)
 *   C  more than one completed deposit on one reference (double credit)
 *   D  credited but the ticket was left open           (told nothing)
 *   E  approved with a proof attached — needs a human to open the proof
 *
 * B, C and D are the old browser-side approval flow's failure modes: it did a
 * lookup, a PATCH and a ticket update as three separate calls with no
 * transaction and no double-credit guard. Any of them could fail alone.
 *
 * READ-ONLY. Every statement is a SELECT. Safe against production.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/audit-eft-approvals.cjs
 *   …add --csv to write eft-audit.csv alongside the report.
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
  // A read-only audit should never hold production up.
  statement_timeout: 60000,
});

const rand = n => 'R' + Number(n).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

/* The subject is built with Utils.rand, which formats en-US: "R1,234.56".
   Comma is the thousands separator there, so stripping it is correct. It would
   NOT be correct for en-ZA ("R505,50"), where the comma is the decimal point
   and stripping it multiplies by 100. Rather than guess on a string that could
   be either, return null and let the caller report it as unparseable. A false
   "100x over-credit" finding would be worse than no finding. */
function amountFromSubject(subject) {
  const m = String(subject || '').match(/R\s?([\d.,]+)/);
  if (!m) return null;
  const raw = m[1];
  if (/\.\d{2}$/.test(raw))  return parseFloat(raw.replace(/,/g, ''));   // en-US
  if (/,\d{2}$/.test(raw))   return parseFloat(raw.replace(/\./g, '').replace(',', '.')); // en-ZA
  if (/^[\d,]+$/.test(raw) && /,\d{3}$/.test(raw)) return parseFloat(raw.replace(/,/g, ''));
  const plain = parseFloat(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(plain) && !/[.,]/.test(raw) ? plain : null;
}

const refFromSubject = s => (String(s || '').match(/EFT-[\w]+/) || [null])[0];

async function hasColumn(table, column) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column]);
  return rows.length > 0;
}

(async () => {
  const findings = { A: [], B: [], C: [], D: [], E: [], explained: [], unparseable: [] };

  try {
    /* Production has columns added by ALTER that a lean schema may lack.
       Probe rather than assume, so this cannot fail halfway through. */
    const cols = {};
    for (const c of ['proof_attached', 'proof_filename', 'file_url', 'admin_response', 'investor_name']) {
      cols[c] = await hasColumn('support_tickets', c);
    }
    const sel = c => (cols[c] ? `t.${c}` : `NULL AS ${c}`);

    const { rows: tickets } = await pool.query(`
      SELECT t.id, t.investor_id, t.subject, t.status, t.created_at, t.responded_at,
             ${sel('investor_name')}, ${sel('proof_attached')},
             ${sel('proof_filename')}, ${sel('admin_response')},
             (${cols.file_url ? 't.file_url IS NOT NULL AND t.file_url <> \'\'' : 'false'}) AS has_proof_file,
             i.first_name, i.last_name, i.email
        FROM support_tickets t
        LEFT JOIN investors i ON i.id = t.investor_id
       WHERE t.category = 'payment_proof'
       ORDER BY t.created_at`);

    if (!tickets.length) {
      console.log('\nNo payment_proof tickets found. Nothing to audit.\n');
      await pool.end();
      return;
    }

    for (const t of tickets) {
      const reference = refFromSubject(t.subject) || t.id;
      const who = [t.first_name, t.last_name].filter(Boolean).join(' ')
        || t.investor_name || t.investor_id || '(unknown)';

      const { rows: txs } = await pool.query(
        `SELECT id, amount, status, description, created_at, updated_at, sub_account_id
           FROM transactions
          WHERE investor_id = $1 AND reference = $2 AND type = 'deposit'
          ORDER BY created_at`, [t.investor_id, reference]);

      const completed = txs.filter(x => x.status === 'completed');
      const subjectAmt = amountFromSubject(t.subject);
      const resolved = t.status === 'resolved' || t.status === 'closed';
      const base = { ticket: t.id, who, reference, when: t.created_at, ticketStatus: t.status };

      if (subjectAmt === null && t.subject) {
        findings.unparseable.push({ ...base, subject: t.subject });
      }

      // C — more than one completed deposit against a single reference.
      if (completed.length > 1) {
        findings.C.push({ ...base, count: completed.length,
          amounts: completed.map(x => Number(x.amount)),
          total: completed.reduce((s, x) => s + Number(x.amount), 0) });
      }

      // B — the investor was told it was approved; no money ever moved.
      if (resolved && completed.length === 0) {
        findings.B.push({ ...base, declared: txs[0] ? Number(txs[0].amount) : subjectAmt,
          pendingRows: txs.length, respondedAt: t.responded_at,
          told: (t.admin_response || '').slice(0, 120) });
      }

      // D — credited, but the ticket was left open, so nobody was told.
      if (!resolved && completed.length > 0) {
        findings.D.push({ ...base, credited: Number(completed[0].amount) });
      }

      // A — what was credited is not what the subject says was submitted.
      if (completed.length === 1 && subjectAmt !== null) {
        const got = Number(completed[0].amount);
        if (!near(got, subjectAmt)) {
          /* A correction recorded by the new approval path is not a gap — it
             is the gap already found and fixed, with the reason on the row.
             Counting it as outstanding would send someone to re-investigate
             work that is done. */
          const corrected = /corrected from/i.test(completed[0].description || '');
          (corrected ? findings.explained : findings.A).push({
            ...base, submitted: subjectAmt, credited: got,
            delta: got - subjectAmt, explained: corrected,
            note: (completed[0].description || '').slice(0, 160) });
        }
      }

      // E — the R505 class. Only a human opening the proof can settle it.
      if (completed.length === 1 && (t.has_proof_file || t.proof_attached)) {
        const amt = Number(completed[0].amount);
        findings.E.push({ ...base, credited: amt,
          proof: t.proof_filename || (t.has_proof_file ? '(attached)' : ''),
          email: t.email || '',
          // A round figure is what a person types when they are approximating.
          round: amt % 100 === 0 ? 100 : amt % 50 === 0 ? 50 : amt % 10 === 0 ? 10 : 0 });
      }
    }

    /* ── Report ──────────────────────────────────────────────────────── */
    const H = s => `\n${s}\n${'─'.repeat(s.length)}`;
    console.log(H(`EFT approval audit — ${tickets.length} proof-of-payment ticket(s)`));

    console.log(`\nA  credited ≠ submitted, unexplained     ${findings.A.length}`);
    console.log(`B  resolved but never credited          ${findings.B.length}`);
    console.log(`C  double credit on one reference       ${findings.C.length}`);
    console.log(`D  credited but ticket left open        ${findings.D.length}`);
    console.log(`E  approved with a proof to check       ${findings.E.length}`);
    if (findings.explained.length)
      console.log(`   (corrections already explained     ${findings.explained.length} — no action)`);
    if (findings.unparseable.length)
      console.log(`   (subject amount unreadable          ${findings.unparseable.length})`);

    if (findings.A.length) {
      console.log(H('A — the credited amount is not the submitted amount'));
      for (const f of findings.A) {
        console.log(`  ${f.ticket}  ${f.who}`);
        console.log(`     submitted ${rand(f.submitted)} → credited ${rand(f.credited)}` +
                    `   (${f.delta > 0 ? '+' : ''}${rand(f.delta)})` +
                    `   ${f.explained ? 'explained in the ledger note' : 'NO recorded reason'}`);
        if (f.note) console.log(`     note: ${f.note}`);
      }
    }

    if (findings.B.length) {
      console.log(H('B — the ticket says approved, but the wallet never moved'));
      console.log('  Each of these is an investor who was told their money was credited.');
      for (const f of findings.B) {
        console.log(`  ${f.ticket}  ${f.who}  ref ${f.reference}`);
        console.log(`     declared ${f.declared != null ? rand(f.declared) : '(unknown)'}` +
                    `   deposit rows ${f.pendingRows}   ticket ${f.ticketStatus}`);
        if (f.told) console.log(`     told: "${f.told}"`);
      }
    }

    if (findings.C.length) {
      console.log(H('C — more than one completed deposit on a single reference'));
      for (const f of findings.C) {
        console.log(`  ${f.ticket}  ${f.who}  ref ${f.reference}`);
        console.log(`     ${f.count} credits totalling ${rand(f.total)}` +
                    `  [${f.amounts.map(rand).join(', ')}]`);
      }
    }

    if (findings.D.length) {
      console.log(H('D — credited, but the ticket was never resolved'));
      for (const f of findings.D) {
        console.log(`  ${f.ticket}  ${f.who}  credited ${rand(f.credited)}  ticket still ${f.ticketStatus}`);
      }
    }

    if (findings.explained.length) {
      console.log(H('corrections that were made and explained — listed for completeness'));
      for (const f of findings.explained) {
        console.log(`  ${f.ticket}  ${f.who}  ${rand(f.submitted)} → ${rand(f.credited)}` +
                    `  (${f.delta > 0 ? '+' : ''}${rand(f.delta)})`);
        console.log(`     ${f.note}`);
      }
    }

    if (findings.unparseable.length) {
      console.log(H('subjects whose amount could not be read safely'));
      console.log('  Not treated as findings — the figure is ambiguous, so no comparison was made.');
      for (const f of findings.unparseable) console.log(`  ${f.ticket}  ${f.subject}`);
    }

    if (findings.E.length) {
      console.log(H('E — approvals to check against their proof'));
      console.log('  The platform never recorded the bank amount, so this is the only way the');
      console.log('  R505/R500 gap can be found. Round figures first — a round number is what');
      console.log('  someone types when they are approximating what they paid.');
      const ranked = findings.E.slice().sort((a, b) => b.round - a.round ||
        new Date(b.when) - new Date(a.when));
      for (const f of ranked.slice(0, 40)) {
        console.log(`  ${String(f.credited).padStart(12)}  ${rand(f.credited).padStart(14)}` +
                    `  ${f.who}  ${f.ticket}  ${f.proof}`);
      }
      if (ranked.length > 40) console.log(`  … and ${ranked.length - 40} more (use --csv for the full list)`);

      if (WANT_CSV) {
        const out = path.join(process.cwd(), 'eft-audit.csv');
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        fs.writeFileSync(out, [
          'ticket,investor,email,reference,credited,proof_filename,submitted_at,round_marker',
          ...ranked.map(f => [f.ticket, f.who, f.email, f.reference, f.credited,
            f.proof, f.when ? new Date(f.when).toISOString() : '', f.round].map(esc).join(',')),
        ].join('\n'));
        console.log(`\n  wrote ${out} (${ranked.length} rows)`);
      }
    }

    const decidable = findings.A.length + findings.B.length + findings.C.length + findings.D.length;
    console.log(H('Summary'));
    if (!decidable) {
      console.log('  No decidable gap found: every approval credited what was submitted, once,');
      console.log('  and every resolved ticket has money behind it.');
    } else {
      console.log(`  ${decidable} decidable gap(s) above need action.`);
    }
    console.log(`  ${findings.E.length} approval(s) can only be settled by opening the proof.`);
    console.log('  The platform holds no bank-side amount, so nothing here can confirm or');
    console.log('  rule out a Georgina-style shortfall on its own.\n');
  } catch (err) {
    console.error('\naudit failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
