#!/usr/bin/env node
/* Put matured money that fell through to a wallet back into a pool.
 *
 * reinvestAmount matches the rollover target on product_type and nothing else.
 * Investments migrated in carry product_type 'other', which no pool uses, so on
 * 30 September 2026 the target lookup found nothing for 57 of them and the
 * money went to wallets under reference MAT-FALLBACK-<investment id>.
 *
 * This moves it into the pool it should have reached. It is NOT the same
 * operation the engine performs: the engine never touches the wallet, because
 * matured funds go straight into the new investment. Here the money is already
 * in the wallet, so it has to be debited back out — and that is only possible
 * if the investor still has it.
 *
 * ── What it will and will not touch ───────────────────────────────────
 *
 * By default every instruction that reinvests into the SAME product:
 * reinvest, auto_reinvest, blank — and also payout_return and payout_custom,
 * because the fallback amount on those is precisely the portion the engine
 * tried to reinvest, the cash part having already been paid out.
 *
 * It EXCLUDES, unless --include-switches is given:
 *   switch_product  the investor asked for a DIFFERENT product
 *   custom_switch   the same, for part of it
 * Those name a product this target is not, so the pool their money belongs in
 * is a different one. --include-switches overrides it; --exclude <id,…> drops
 * any row by investment id. Everything excluded is listed either way.
 *
 * It skips, and reports, any account whose wallet no longer holds the amount.
 *
 * ── Three modes, one of which writes ──────────────────────────────────
 *
 *   (default)   Plan. Prints every line it would write. Changes nothing.
 *   --apply     Executes it. One transaction per investor.
 *
 * Idempotent: each correction writes transactions.reference 'REINV-FIX-<id>',
 * which is UNIQUE, and an investment already carrying one is skipped. Running
 * it twice does not reinvest twice.
 *
 * Run:
 *   DATABASE_URL="…" node server/scripts/reinvest-wallet-fallbacks.cjs \
 *       --pool POOL-X --target POOL-SHO-1788239642173
 *   …then add --apply.
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const { Pool } = require('pg');

const ARGV  = process.argv.slice(2);
const flag  = n => { const i = ARGV.indexOf(n); return i > -1 ? (ARGV[i + 1] || '') : ''; };
const APPLY = ARGV.includes('--apply');
const SWITCHES = ARGV.includes('--include-switches');
const EXCLUDE  = new Set((flag('--exclude') || '').split(',').map(x => x.trim()).filter(Boolean));
const SRC   = flag('--pool');
const TGT   = flag('--target');

if (!SRC || !TGT) {
  console.error('Both --pool <source pool id> and --target <destination pool id> are required.');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 120000,
});

const r2   = n => Math.round((Number(n) || 0) * 100) / 100;
const rand = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad  = (s, n) => String(s == null ? '—' : s).padEnd(n).slice(0, n);
const H    = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

/* A MAT-FALLBACK credit is never the whole maturity: whatever the client
   asked to take in cash was paid out first, and only the portion the engine
   then tried to reinvest can fall through. payout_return and payout_custom
   both reinvest into inv.product_type — the SAME product — so moving their
   fallback amount completes the instruction rather than overruling it.

   The switches are the exception: they name a different product, so the pool
   this money belongs in is not the one being targeted here.

   payout_option is NOT consulted: it carries a column default of 'reinvest'
   and would report every row as a reinvest. */
const SAME_PRODUCT = new Set(['reinvest', 'auto_reinvest', '', 'pending',
                              'payout_return', 'payout_custom']);

(async () => {
  let planned = 0, skippedShort = 0, skippedDone = 0, held = 0, wrote = 0, failed = 0;
  try {
    const { rows: [tgt] } = await pool.query(
      `SELECT id, name, product_type, status, term_months, annual_rate,
              current_invested, max_investment, end_date
         FROM investment_pools WHERE id = $1`, [TGT]);
    if (!tgt) { console.error(`Target pool ${TGT} not found.`); process.exit(2); }

    H('Destination');
    console.log(`  ${tgt.id}  "${tgt.name}"`);
    console.log(`  product_type ${tgt.product_type} · status ${tgt.status} · ` +
                `${tgt.term_months} months at ${(Number(tgt.annual_rate) * 100).toFixed(2)}% · ` +
                `closes ${tgt.end_date ? new Date(tgt.end_date).toISOString().slice(0, 10) : '—'}`);
    if (tgt.status !== 'open') {
      console.log(`  ⚠  This pool is "${tgt.status}", not open. It has stopped raising, and once it`);
      console.log('     has deployed, money added here joins a round that is already running.');
    } else if (tgt.end_date) {
      /* status 'open' is not the same as still raising. A pool keeps that
         status until the cycler deploys it, which happens at 00:01 on its
         investment start date — so between its close date and that moment it
         reads as open while being shut. Putting money in then is a decision,
         not an accident, so it is named rather than silently allowed. */
      const closes = new Date(tgt.end_date).toISOString().slice(0, 10);
      const today  = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10); // SAST
      if (closes < today) {
        console.log(`  ⚠  This pool closed raising on ${closes}. Its status is still "open" only`);
        console.log('     because the cycler has not deployed it yet. Adding money now puts it into');
        console.log('     a round that has stopped taking subscriptions — deliberate, or a mistake?');
      }
    }

    /* Every fallback credit out of the source pool, with the instruction the
       investment carried and the wallet that received it. */
    const { rows } = await pool.query(`
      SELECT t.id AS txn_id, t.reference, t.amount, t.sub_account_id,
             i.id AS investment_id, i.investor_id, i.product_type, i.pool_name AS src_name,
             COALESCE(NULLIF(TRIM(i.maturity_instruction), ''), '') AS instruction,
             inv.first_name, inv.last_name, inv.wallet_balance,
             sa.wallet_balance AS sub_balance,
             EXISTS (SELECT 1 FROM transactions d
                      WHERE d.reference = 'REINV-FIX-' || i.id) AS already_done
        FROM transactions t
        JOIN investments      i   ON i.id  = t.investment_id
        LEFT JOIN investors   inv ON inv.id = i.investor_id
        LEFT JOIN sub_accounts sa ON sa.id  = t.sub_account_id
       WHERE t.reference LIKE 'MAT-FALLBACK-%'
         AND i.pool_id = $1
       ORDER BY t.amount DESC`, [SRC]);

    if (!rows.length) {
      console.log(`\nNo wallet-fallback credits found for pool ${SRC}. Nothing to do.`);
      await pool.end(); process.exit(0);
    }

    const chosen = [], excluded = [], short = [], done = [];
    for (const r of rows) {
      const amt = r2(r.amount);
      const bal = r.sub_account_id ? Number(r.sub_balance || 0) : Number(r.wallet_balance || 0);
      const rec = { ...r, amt, bal,
                    who: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.investor_id };
      if (r.already_done) { done.push(rec); continue; }
      if (EXCLUDE.has(r.investment_id)) { rec.why = 'named in --exclude'; excluded.push(rec); continue; }
      const same = SAME_PRODUCT.has(r.instruction);
      if (!same && !SWITCHES) { rec.why = 'asked for a different product'; excluded.push(rec); continue; }
      if (bal + 0.005 < amt) { short.push(rec); continue; }
      chosen.push(rec);
    }
    skippedDone = done.length; skippedShort = short.length; planned = chosen.length;

    if (excluded.length) {
      H(`Excluded (${excluded.length})`);
      for (const e of excluded.sort((a, b) => b.amt - a.amt)) {
        console.log(`  ${pad(e.who, 26)} ${pad(e.instruction, 16)} ${rand(e.amt).padStart(14)}  ${e.why || ''}`);
      }
      console.log('\n  A switch names a DIFFERENT product, so this target is not where that money');
      console.log('  belongs. --include-switches overrides that; --exclude <id,…> drops any row.');
    }
    if (short.length) {
      H(`Skipped — the wallet no longer holds the money (${short.length})`);
      for (const s of short.sort((a, b) => (b.amt - b.bal) - (a.amt - a.bal))) {
        console.log(`  ${pad(s.who, 26)} needs ${rand(s.amt).padStart(14)} · has ${rand(s.bal).padStart(14)}`);
      }
      console.log('\n  Debiting these would take the wallet negative. They need a decision of their own.');
    }
    if (done.length) {
      H(`Already corrected (${done.length})`);
      console.log('  These carry a REINV-FIX- reference already and are left alone.');
    }

    const total = chosen.reduce((a, c) => a + c.amt, 0);
    held = total;
    H(APPLY ? `Applying ${chosen.length} reinvestment(s)` : `Plan — ${chosen.length} reinvestment(s), nothing written yet`);
    console.log(`  ${rand(total)} out of wallets and into ${tgt.id}\n`);
    console.log(`  ${pad('investor', 26)} ${pad('instruction', 16)} ${'amount'.padStart(14)} ${'wallet after'.padStart(15)}`);
    for (const c of chosen) {
      console.log(`  ${pad(c.who, 26)} ${pad(c.instruction || '(none set)', 16)} ` +
                  `${rand(c.amt).padStart(14)} ${rand(c.bal - c.amt).padStart(15)}`);
    }

    if (tgt.max_investment != null &&
        Number(tgt.current_invested || 0) + total > Number(tgt.max_investment)) {
      console.log(`\n  ⚠  ${tgt.id} would exceed its maximum ` +
                  `(${rand(tgt.current_invested)} + ${rand(total)} > ${rand(tgt.max_investment)}).`);
      if (APPLY) { console.error('  Refusing to apply. Raise the pool maximum or split this.'); process.exit(1); }
    }

    if (!APPLY) {
      H('Nothing was written');
      console.log('  Add --apply to execute exactly this plan.\n');
      await pool.end(); process.exit(0);
    }

    /* ── Write, one investor at a time ───────────────────────────────── */
    for (const c of chosen) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        /* Re-read the balance under a lock: the plan above was a snapshot, and
           a client spending between the plan and here must not go negative. */
        const bal = c.sub_account_id
          ? (await client.query('SELECT wallet_balance b FROM sub_accounts WHERE id=$1 FOR UPDATE', [c.sub_account_id])).rows[0]
          : (await client.query('SELECT wallet_balance b FROM investors    WHERE id=$1 FOR UPDATE', [c.investor_id])).rows[0];
        if (!bal || Number(bal.b) + 0.005 < c.amt) {
          await client.query('ROLLBACK');
          console.log(`  ✗ ${c.who} — balance moved to ${rand(bal && bal.b)}, skipped`);
          failed++; continue;
        }

        const { rows: [lock] } = await client.query(
          'SELECT current_invested, max_investment FROM investment_pools WHERE id=$1 FOR UPDATE', [TGT]);
        if (lock.max_investment != null &&
            Number(lock.current_invested || 0) + c.amt > Number(lock.max_investment)) {
          await client.query('ROLLBACK');
          console.log(`  ✗ ${c.who} — target pool at capacity, skipped`);
          failed++; continue;
        }

        const term  = tgt.term_months || 6;
        const start = new Date();
        const end   = new Date(start); end.setMonth(end.getMonth() + term);
        const newId = 'INV-RIFIX-' + Date.now() + '-' + String(c.investor_id).replace(/[^A-Z0-9]/gi, '').slice(-6);
        const expct = r2(c.amt * (parseFloat(tgt.annual_rate) || 0) * (term / 12));

        /* The wallet gives the money back. Fee-free, exactly as the rollover
           would have been — the 1% is charged on a client's own investment,
           not on a correction of ours. */
        if (c.sub_account_id) {
          await client.query('UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
                             [c.amt, c.sub_account_id]);
        } else {
          await client.query('UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
                             [c.amt, c.investor_id]);
        }

        await client.query(
          `INSERT INTO investments
             (id, investor_id, sub_account_id, pool_id, pool_name, amount, status, start_date, end_date,
              annual_rate, term_months, expected_return, actual_return, product_type,
              maturity_instruction, is_reinvestment, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,0,$12,'reinvest',true,NOW(),NOW())`,
          [newId, c.investor_id, c.sub_account_id || null, tgt.id, tgt.name, c.amt,
           start.toISOString().slice(0, 10), end.toISOString().slice(0, 10),
           tgt.annual_rate, term, expct, tgt.product_type]);

        /* UNIQUE on reference, so this is what makes a second run a no-op. */
        await client.query(
          `INSERT INTO transactions
             (id, investor_id, sub_account_id, type, amount, status, reference, description,
              investment_id, pool_id, transaction_date, created_at, updated_at)
           VALUES (gen_random_uuid(),$1,$2,'investment',$3,'completed',$4,$5,$6,$7,NOW(),NOW(),NOW())`,
          [c.investor_id, c.sub_account_id || null, c.amt, 'REINV-FIX-' + c.investment_id,
           `Reinvested into ${tgt.name} — corrects the maturity of ${c.src_name || SRC}, ` +
           `which was paid to the wallet because no pool matched its product type`,
           newId, tgt.id]);

        await client.query(
          `UPDATE investment_pools
              SET current_invested = COALESCE(current_invested,0) + $1,
                  raised_amount    = COALESCE(raised_amount,0) + $1,
                  investor_count   = COALESCE(investor_count,0) + 1,
                  updated_at = NOW()
            WHERE id = $2`, [c.amt, tgt.id]);

        await client.query('COMMIT');
        wrote++;
        console.log(`  ✓ ${pad(c.who, 26)} ${rand(c.amt).padStart(14)} → ${newId}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        failed++;
        console.error(`  ✗ ${c.who} — ${err.message}`);
      } finally {
        client.release();
      }
    }

    H('Summary');
    console.log(`  reinvested          ${wrote}`);
    console.log(`  failed              ${failed}`);
    console.log(`  skipped (wallet)    ${skippedShort}`);
    console.log(`  skipped (done)      ${skippedDone}`);
    if (excluded.length) console.log(`  excluded            ${excluded.length}`);
    console.log('\n  The product_type on these investments is still wrong. Until it is corrected');
    console.log('  with remap-pool-product-type.cjs, the next maturity does the same thing.\n');
  } catch (err) {
    console.error('\nFailed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
