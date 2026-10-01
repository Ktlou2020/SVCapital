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
 * --only <investment id,…> narrows the run. Correcting a switch means a second
 * run at the pool of the product the client actually chose, and without --only
 * the --include-switches that allows it would sweep everything else in too.
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

const path = require('path');
const { Pool } = require('pg');

const ARGV  = process.argv.slice(2);
const flag  = n => { const i = ARGV.indexOf(n); return i > -1 ? (ARGV[i + 1] || '') : ''; };
const APPLY = ARGV.includes('--apply');
const SWITCHES = ARGV.includes('--include-switches');
const EXCLUDE  = new Set((flag('--exclude') || '').split(',').map(x => x.trim()).filter(Boolean));
/* --only narrows the run to named investments: correcting a switch means a
   second run at a different target, and without this --include-switches would
   sweep every other row into that pool too. */
const ONLY     = new Set((flag('--only') || '').split(',').map(x => x.trim()).filter(Boolean));
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


(async () => {
  try {
    const { planReinvest, applyReinvest } = require(
      path.join(__dirname, '..', 'services', 'walletFallbackReinvest'));
    const opts = {
      sourcePoolId: SRC, targetPoolId: TGT,
      includeSwitches: SWITCHES,
      only: [...ONLY], exclude: [...EXCLUDE],
    };

    const plan = await planReinvest(pool, opts);
    const t = plan.target;

    H('Destination');
    console.log(`  ${t.id}  "${t.name}"`);
    console.log(`  product_type ${t.product_type} · status ${t.status} · ` +
                `${t.term_months} months at ${(Number(t.annual_rate) * 100).toFixed(2)}% · ` +
                `closes ${t.end_date ? new Date(t.end_date).toISOString().slice(0, 10) : '—'}`);
    for (const w of plan.warnings) console.log(`  ⚠  ${w}`);

    if (plan.skipped.length) {
      H(`Left out (${plan.skipped.length})`);
      const by = {};
      for (const sk of plan.skipped) (by[sk.why] = by[sk.why] || []).push(sk);
      for (const [why, list] of Object.entries(by)) {
        console.log(`  ${why} — ${list.length}, ${rand(list.reduce((a, x) => a + x.amount, 0))}`);
        for (const sk of list.slice(0, 8)) {
          console.log(`     ${pad(sk.who, 26)} ${pad(sk.instruction || '(none set)', 16)} ${rand(sk.amount).padStart(14)}`);
        }
        if (list.length > 8) console.log(`     …and ${list.length - 8} more`);
      }
    }

    H(APPLY ? `Applying ${plan.count} reinvestment(s)` : `Plan — ${plan.count} reinvestment(s), nothing written yet`);
    console.log(`  ${rand(plan.total)} out of wallets and into ${t.id}\n`);
    console.log(`  ${pad('investor', 26)} ${pad('instruction', 16)} ${'amount'.padStart(14)} ${'wallet after'.padStart(15)}`);
    for (const c of plan.chosen) {
      console.log(`  ${pad(c.who, 26)} ${pad(c.instruction || '(none set)', 16)} ` +
                  `${rand(c.amount).padStart(14)} ${rand(c.balance_after).padStart(15)}`);
    }

    if (plan.blocked) { console.error('\n  Refusing: ' + plan.warnings.join(' ')); process.exit(1); }

    if (!APPLY) {
      H('Nothing was written');
      console.log('  Add --apply to execute exactly this plan.\n');
      await pool.end(); process.exit(0);
    }

    const result = await applyReinvest(pool, opts);
    console.log('');
    for (const a of result.applied) {
      console.log(`  ✓ ${pad(a.who, 26)} ${rand(a.amount).padStart(14)} → ${a.new_investment_id}`);
    }
    for (const f of result.failed) console.log(`  ✗ ${pad(f.who, 26)} ${f.error}`);

    H('Summary');
    console.log(`  reinvested          ${result.appliedCount}  ${rand(result.appliedTotal)}`);
    console.log(`  failed              ${result.failedCount}`);
    console.log(`  left out            ${result.skipped.length}`);
    console.log('\n  The product_type on these investments is still wrong. Until it is corrected');
    console.log('  with remap-pool-product-type.cjs, the next maturity does the same thing.\n');
  } catch (err) {
    console.error('\n' + err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
