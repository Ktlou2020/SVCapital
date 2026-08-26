#!/usr/bin/env node
/* The EFT audit must find each gap it claims to find — and must NOT claim to
 * find the one it cannot see.
 *
 * The last point is the one worth testing. Georgina paid R505 and typed R500;
 * the platform recorded R500 in every place it records anything. An audit that
 * reported her as a decidable finding would be inventing evidence. She must
 * appear only in the review worklist, alongside everyone else whose proof a
 * human still has to open.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-eft-audit.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see server/scripts/check-eft-audit.cjs header');
  process.exit(0);
}

const { execFileSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const AUDIT = path.join(__dirname, 'audit-eft-approvals.cjs');

async function seed() {
  await pool.query(`DROP TABLE IF EXISTS support_tickets, transactions, investors CASCADE`);
  await pool.query(`
    CREATE TABLE investors (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT,
      wallet_balance NUMERIC(18,2) DEFAULT 0);
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, investor_id TEXT, sub_account_id TEXT, type TEXT,
      amount NUMERIC(18,2), status TEXT, reference TEXT, description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY, investor_id TEXT, investor_name TEXT, subject TEXT,
      message TEXT, category TEXT, status TEXT, admin_response TEXT,
      proof_attached BOOLEAN DEFAULT false, proof_filename TEXT, file_url TEXT,
      responded_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());`);

  const inv = async (id, first, last) => pool.query(
    `INSERT INTO investors (id, first_name, last_name, email) VALUES ($1,$2,$3,$4)`,
    [id, first, last, `${first.toLowerCase()}@example.test`]);

  const ticket = async (id, investorId, amtLabel, ref, status, opts = {}) => pool.query(
    `INSERT INTO support_tickets
       (id, investor_id, subject, category, status, admin_response, proof_attached, proof_filename, file_url, responded_at)
     VALUES ($1,$2,$3,'payment_proof',$4,$5,$6,$7,$8,$9)`,
    [id, investorId, `EFT Proof of Payment — Someone — ${amtLabel} — ${ref}`, status,
     opts.response || null, !!opts.proof, opts.proof || null,
     opts.proof ? 'data:image/png;base64,AAAA' : null,
     status === 'resolved' ? new Date() : null]);

  const tx = async (id, investorId, amount, status, ref, desc) => pool.query(
    `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
     VALUES ($1,$2,'deposit',$3,$4,$5,$6)`, [id, investorId, amount, status, ref, desc || null]);

  /* GEORGINA — paid R505, typed R500. Every platform record says R500. */
  await inv('INV-G', 'Georgina', 'Case');
  await ticket('TKT-G', 'INV-G', 'R500.00', 'EFT-1001', 'resolved', { proof: 'pop.pdf' });
  await tx('TX-G', 'INV-G', 500, 'completed', 'EFT-1001', 'EFT wallet top-up approved by admin.');

  /* A — credited 750 against a submitted 500, with nothing explaining it. */
  await inv('INV-A', 'Anna', 'Mismatch');
  await ticket('TKT-A', 'INV-A', 'R500.00', 'EFT-1002', 'resolved', { proof: 'pop.jpg' });
  await tx('TX-A', 'INV-A', 750, 'completed', 'EFT-1002', 'EFT wallet top-up approved by admin.');

  /* A-explained — same shape, but the correction is recorded. */
  await inv('INV-AE', 'Amos', 'Explained');
  await ticket('TKT-AE', 'INV-AE', 'R500.00', 'EFT-1003', 'resolved', { proof: 'pop.jpg' });
  await tx('TX-AE', 'INV-AE', 505, 'completed', 'EFT-1003',
    'EFT wallet top-up approved by admin. Ref: EFT-1003 · Amount corrected from R500.00 to R505.00 — proof shows R505');

  /* B — ticket resolved and the investor told so; deposit still pending. */
  await inv('INV-B', 'Bongi', 'Untold');
  await ticket('TKT-B', 'INV-B', 'R1,200.00', 'EFT-1004', 'resolved',
    { response: 'Your EFT deposit of R1200.00 has been approved and credited to your wallet.' });
  await tx('TX-B', 'INV-B', 1200, 'pending', 'EFT-1004', null);

  /* C — two completed credits on one reference. */
  await inv('INV-C', 'Cara', 'Twice');
  await ticket('TKT-C', 'INV-C', 'R300.00', 'EFT-1005', 'resolved');
  await tx('TX-C1', 'INV-C', 300, 'completed', 'EFT-1005', null);
  await tx('TX-C2', 'INV-C', 300, 'completed', 'EFT-1005', null);

  /* D — credited, ticket never closed. */
  await inv('INV-D', 'Dan', 'Openticket');
  await ticket('TKT-D', 'INV-D', 'R250.00', 'EFT-1006', 'open');
  await tx('TX-D', 'INV-D', 250, 'completed', 'EFT-1006', null);

  /* Clean — submitted, credited, resolved, no proof attached. */
  await inv('INV-OK', 'Olwethu', 'Clean');
  await ticket('TKT-OK', 'INV-OK', 'R2,500.00', 'EFT-1007', 'resolved');
  await tx('TX-OK', 'INV-OK', 2500, 'completed', 'EFT-1007', null);

  /* en-ZA decimal comma. Must be read as R505.50, NOT as R50,550 — stripping
     the comma would multiply by 100 and manufacture a 100x over-credit. */
  await inv('INV-Z', 'Zanele', 'Comma');
  await ticket('TKT-Z', 'INV-Z', 'R505,50', 'EFT-1008', 'resolved');
  await tx('TX-Z', 'INV-Z', 505.5, 'completed', 'EFT-1008', null);

  /* Genuinely unreadable — neither grouping nor decimal fits. Must be set
     aside rather than compared against anything. */
  await inv('INV-U', 'Unathi', 'Unreadable');
  await ticket('TKT-U', 'INV-U', 'R1,2345', 'EFT-1009', 'resolved');
  await tx('TX-U', 'INV-U', 1234.5, 'completed', 'EFT-1009', null);
}

(async () => {
  try {
    await seed();
    const out = execFileSync('node', [AUDIT], {
      env: { ...process.env }, encoding: 'utf8',
    });

    const section = name => {
      const i = out.indexOf(name);
      if (i < 0) return '';
      const rest = out.slice(i);
      const next = rest.slice(name.length).search(/\n[A-Z] — |\nSummary|\nsubjects whose/);
      return next < 0 ? rest : rest.slice(0, name.length + next);
    };

    console.log('\nit finds the gaps that the data can actually decide');
    ok('A: an unexplained change from R500 to R750',
       /TKT-A\b/.test(section('A — the credited amount')) &&
       /submitted R500\.00 → credited R750\.00/.test(out) && /NO recorded reason/.test(out),
       out.slice(0, 400));
    ok('B: resolved, investor told, wallet never moved',
       /TKT-B\b/.test(section('B — the ticket says approved')));
    ok('C: two credits on one reference',
       /TKT-C\b/.test(section('C — more than one completed')) && /2 credits totalling R600\.00/.test(out));
    ok('D: credited but the ticket was left open',
       /TKT-D\b/.test(section('D — credited, but the ticket')));

    console.log('\nit does not invent the gap it cannot see');
    ok('Georgina is NOT reported as a decidable finding',
       !/TKT-G\b/.test(section('A — the credited amount')) &&
       !/TKT-G\b/.test(section('B — the ticket says approved')) &&
       !/TKT-G\b/.test(section('C — more than one completed')) &&
       !/TKT-G\b/.test(section('D — credited, but the ticket')),
       'her records all say R500 — nothing in the data shows the R5');
    ok('she appears in the review worklist instead',
       /TKT-G\b/.test(section('E — approvals to check')));
    ok('and the report says the bank amount is not held',
       /platform holds no bank-side amount/.test(out));

    console.log('\nit does not cry wolf');
    ok('a clean approval is not flagged',
       !/TKT-OK\b/.test(section('A — the credited amount')) &&
       !/TKT-OK\b/.test(section('B — the ticket says approved')) &&
       !/TKT-OK\b/.test(section('D — credited, but the ticket')));
    ok('a recorded correction is not treated as unexplained',
       !/TKT-AE[\s\S]{0,200}NO recorded reason/.test(out),
       'R500→R505 with a reason in the ledger note is the fix working, not a gap');
    ok('and it is not counted among the gaps needing action',
       !/TKT-AE\b/.test(section('A — the credited amount')) &&
       /TKT-AE\b/.test(section('corrections that were made and explained')),
       'sending someone to re-investigate finished work is its own cost');
    ok('the action count covers only the unexplained ones',
       /A  credited ≠ submitted, unexplained\s+1\b/.test(out) &&
       /4 decidable gap\(s\)/.test(out),
       out.split('\n').filter(l => /decidable|unexplained/.test(l)).join(' | '));

    console.log('\nan amount is read at the right scale, or not read at all');
    ok('"R505,50" is not read as R50 550',
       !/50,?550/.test(out), 'stripping an en-ZA decimal comma multiplies by 100');
    ok('so it agrees with the R505.50 ledger row and is not flagged',
       !/TKT-Z\b/.test(section('A — the credited amount')),
       'a false 100x over-credit is worse than reporting nothing');
    ok('a subject that fits neither format is set aside, not compared',
       /TKT-U\b/.test(section('subjects whose amount could not be read')) &&
       !/TKT-U\b/.test(section('A — the credited amount')));

    console.log('\nthe worklist puts the likely candidates first');
    {
      const e = section('E — approvals to check');
      const gPos  = e.indexOf('TKT-G');   // R500 — round to 100
      const zPos  = e.indexOf('TKT-AE');  // R505 — not round
      ok('a round R500 sorts above an odd R505', gPos > -1 && (zPos === -1 || gPos < zPos),
         `G at ${gPos}, AE at ${zPos}`);
    }

    console.log('\nit is safe to point at production');
    {
      /* Strip comments first. The header explains what an ALTER-added column
         is, and scanning raw text flags that prose as if it were a statement —
         the scanner reading its own explanation as the thing it warns about. */
      const src = require('fs').readFileSync(AUDIT, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      const writes = src.match(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b\s/gi) || [];
      ok('the script issues no writes', writes.length === 0,
         `found: ${writes.join(', ')}`);
      ok('and bounds its statements with a timeout', /statement_timeout/.test(src));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, err.stdout || '');
    fail++;
  } finally {
    // KEEP_SEED=1 leaves the fixtures in place so the report can be eyeballed.
    if (!process.env.KEEP_SEED) {
      await pool.query(`DROP TABLE IF EXISTS support_tickets, transactions, investors CASCADE`).catch(() => {});
    }
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
