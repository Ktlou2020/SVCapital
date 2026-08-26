#!/usr/bin/env node
/* Pre-flight for a month-end maturity run — command-line front end.
 *
 * The checks themselves live in server/services/maturityPreflight.js, shared
 * with GET /api/admin/maturity-preflight. This file only renders them. Two
 * copies of a money-adjacent check drift, and then they disagree at the worst
 * possible moment.
 *
 * Most people should use the admin console instead: Operations Console →
 * Maturity Pre-flight. This exists for when the console is not an option.
 *
 * READ-ONLY.
 *
 * Run:
 *   DATABASE_URL="<production url>" node server/scripts/preflight-maturity.cjs
 *   …optionally with a horizon in days (default 14):
 *   DATABASE_URL=… node server/scripts/preflight-maturity.cjs 21
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const { Pool } = require('pg');
const { runMaturityPreflight } = require('../services/maturityPreflight');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 60000,
});

const money = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct  = r => (Number(r || 0) * 100).toFixed(2) + '%';
const day  = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const H    = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

(async () => {
  try {
    const r = await runMaturityPreflight(pool, { horizonDays: process.argv[2] });

    console.log(`\nMaturity pre-flight — database time ${new Date(r.serverTime).toISOString()} ` +
                `(server TZ ${r.timeZone})`);
    console.log(`Horizon: investments maturing in the next ${r.horizonDays} day(s).`);
    console.log('The engine runs at 23:00 Africa/Johannesburg on each maturity day.');

    if (r.nothingDue) {
      console.log(`\nNothing matures in the next ${r.horizonDays} days.\n`);
      await pool.end();
      return;
    }

    H('1. What is due to mature');
    for (const p of r.pools) {
      console.log(`  ${p.poolId}  ${p.poolName}`);
      console.log(`     ${p.count} investment(s), capital ${money(p.capital)}, ` +
                  `maturing ${day(p.maturesOn)}, pool status "${p.poolStatus || '?'}"`);
      if (p.ratePosted) {
        console.log(`     actual rate ${pct(p.actualRate)} for the period → ` +
                    `${money(p.postedTotal)} in returns` +
                    `  (projection was ${money(p.projected)}, difference ${money(p.difference)})`);
      } else {
        console.log('     no actual rate posted — HELD BACK until it is entered');
      }
    }

    H('2. Where reinvested money will go');
    console.log(`  ${r.totals.rollingOver} of ${r.totals.investments} investment(s) roll over in whole or part.`);
    for (const t of r.reinvestTargets) {
      console.log(t.poolId
        ? `  ${t.productType} → ${t.poolId} "${t.poolName}"  closes ${day(t.endDate)}` +
          (t.room != null ? `  (room ${money(t.room)}, incoming ~${money(t.incoming)})` : '')
        : `  ${t.productType} → no open pool; ~${money(t.incoming)} becomes wallet payouts`);
    }

    if (r.stalePools.length) {
      H('3. Pools left open past their close date');
      for (const s of r.stalePools) {
        console.log(`  ${s.poolId}  ${s.name}  (${s.productType})  closed ${day(s.endDate)}` +
                    `, ${s.daysClosed} days ago` +
                    (s.beyondCyclerWindow ? '  — beyond the cycler\'s window, will never self-clear' : ''));
      }
    }

    H('4. Maturity instructions');
    for (const [k, v] of Object.entries(r.instructions.counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k === 'none' ? '(none — defaults to reinvest)' : k}`);
    }

    H('Findings');
    const order = { STOP: 0, ATTENTION: 1, OK: 2 };
    for (const f of [...r.findings].sort((a, b) => order[a.level] - order[b.level])) {
      console.log(`  ${f.level.padEnd(9)} ${f.message}`);
    }

    H('Verdict');
    if (r.summary.verdict === 'blocked') {
      console.log(`  ${r.summary.stops} STOP(s) and ${r.summary.attentions} ATTENTION(s).`);
      console.log('  Something will not happen as intended if the run goes ahead as things stand.');
    } else if (r.summary.verdict === 'review') {
      console.log(`  No blockers, ${r.summary.attentions} thing(s) worth a look before tonight.`);
    } else {
      console.log('  Everything this can check is in place.');
    }
    console.log('');
  } catch (err) {
    console.error('\npre-flight failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
