#!/usr/bin/env node
/* Give the stokvels that already exist a share ledger.
 *
 * The ledger starts empty, and a stokvel that has been running since before
 * it existed has contributions, interest and maturities behind it with no
 * allocations against any of them. Until this runs, every member of those
 * groups has a share of nothing while the pot plainly holds money.
 *
 * WHAT IT DOES, per stokvel:
 *
 *   1. One `contribution` allocation per settled contribution, to the member
 *      who paid it. That is the part we genuinely know who owns.
 *   2. One reconcile, which places whatever is left — interest, maturities,
 *      fees, deposits nobody attributed — pro-rata across the members in
 *      proportion to what step 1 just gave them.
 *
 * Step 2 is an assumption, and it is worth being honest about: the platform
 * does not know WHEN past interest arrived, so it cannot know whether a
 * member who joined last month should share in a return the group earned last
 * year. Splitting on contributions-to-date is the fairest thing available
 * from the data that exists, and it is right whenever the group's membership
 * has been stable. Where it is not, the figures are a starting point the
 * committee can have corrected with an `adjustment` — which is what that
 * allocation kind is for.
 *
 * PREVIEWS BY DEFAULT. Nothing is written without --apply, following
 * backfill-maturity-dates.js. Any group whose books cannot be made to balance
 * is NAMED and SKIPPED rather than forced, because a silent forcing is how a
 * reconciliation becomes the thing nobody can explain later.
 *
 *   DATABASE_URL=… node server/scripts/backfill-stokvel-shares.cjs
 *   …--apply     write them
 *   …--group ID  one stokvel only
 */
'use strict';

const path = require('path');
const { Pool } = require('pg');

const ARGV  = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const ONLY  = (() => { const i = ARGV.indexOf('--group'); return i > -1 ? ARGV[i + 1] : null; })();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
const shares = require(path.join(__dirname, '..', 'services', 'stokvelShares.js'));
const rand = v => 'R' + Number(v || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  let done = 0, skipped = 0;
  try {
    const { rows: groups } = await db.query(
      `SELECT a.id, a.name, a.wallet_balance, a.share_basis
         FROM sub_accounts a
        WHERE a.account_type = 'stokvel'
          AND ($1::text IS NULL OR a.id = $1)
        ORDER BY a.name`, [ONLY]);

    if (!groups.length) { console.log('No stokvels found.'); return; }
    console.log(`\n${APPLY ? 'APPLYING' : 'PREVIEW'} — ${groups.length} stokvel(s)\n`);

    for (const g of groups) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');

        const { rows: [existing] } = await client.query(
          `SELECT COUNT(*)::int AS n FROM stokvel_allocations WHERE sub_account_id = $1`, [g.id]);
        const assets  = await shares.netAssets(client, g.id);
        const members = await shares.activeMembers(client, g.id);

        console.log(`${g.name}  (${g.id})`);
        console.log(`  members ${members.length} · basis ${g.share_basis}`
          + ` · wallet ${rand(assets.wallet)} · invested ${rand(assets.invested)}`
          + ` · net ${rand(assets.total)}`);

        if (existing.n) {
          console.log(`  SKIP — already has ${existing.n} allocation(s); nothing to backfill.\n`);
          await client.query('ROLLBACK');
          skipped++;
          continue;
        }
        if (!members.length) {
          console.log('  SKIP — no active members, so there is nobody to allocate to.\n');
          await client.query('ROLLBACK');
          skipped++;
          continue;
        }

        const { rows: paidUp } = await client.query(
          `SELECT investor_id, period_label, amount_paid
             FROM stokvel_contributions
            WHERE sub_account_id = $1 AND amount_paid > 0
            ORDER BY due_date ASC`, [g.id]);
        let contributed = 0;
        for (const c of paidUp) {
          await shares.allocateContribution(client, {
            subAccountId: g.id, investorId: c.investor_id, amount: c.amount_paid,
            periodLabel: c.period_label, reference: 'BACKFILL',
          });
          contributed += Number(c.amount_paid);
        }
        console.log(`  ${paidUp.length} contribution(s) allocated, ${rand(contributed)}`);

        const out = await shares.reconcile(client, g.id, { reason: 'Opening share ledger', reference: 'BACKFILL' });
        if (out.allocated) {
          console.log(`  ${out.kind === 'cost' ? 'costs' : 'earnings'} shared out: ${rand(Math.abs(out.allocated))}`
            + `  (interest, maturities and fees this ledger could not attribute)`);
        }

        const audit = await shares.audit(client, g.id);
        if (Math.abs(audit.difference) >= 0.005) {
          /* Named, not forced. */
          console.log(`  SKIP — the books will not balance: assets ${rand(audit.assets)}`
            + ` vs shares ${rand(audit.shares)}, out by ${rand(audit.difference)}.`);
          console.log('         Nothing written for this group. Worth a look before it is forced.\n');
          await client.query('ROLLBACK');
          skipped++;
          continue;
        }

        const final = await shares.sharesOf(client, g.id);
        for (const s of final.shares) {
          console.log(`    ${s.investor_id}  ${rand(s.share)}`
            + (s.arrears > 0 ? `   (owes ${rand(s.arrears)})` : ''));
        }

        if (APPLY) { await client.query('COMMIT'); console.log('  WRITTEN\n'); }
        else       { await client.query('ROLLBACK'); console.log('  (preview only)\n'); }
        done++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`  FAILED — ${err.message}\n`);
        skipped++;
      } finally {
        client.release();
      }
    }

    console.log(`${APPLY ? 'Wrote' : 'Would write'} ${done} stokvel(s); skipped ${skipped}.`);
    if (!APPLY && done) console.log('Re-run with --apply to write them.');
  } catch (err) {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
})();
