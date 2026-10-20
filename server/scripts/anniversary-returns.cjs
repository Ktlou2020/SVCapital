#!/usr/bin/env node
/* What the solar anniversaries owe, and what they have paid.
 *
 * A five-year solar holding earns five returns, one on each anniversary of
 * the day the client invested, each paid to their wallet. The platform has
 * promised that on the public site for as long as the product has existed and
 * has never done it: every investment sat until end_date and settled once.
 *
 * So there is a backlog, and it is somebody's money. This prints it before
 * anything moves: every anniversary that has fallen due, what it would pay,
 * and which of three states it is in.
 *
 *   paid           a distribution transaction already exists for that year
 *   payable        a rate is posted for that year and nothing has been paid
 *   awaiting-rate  the year has come round and nobody has closed it out
 *
 * The third is not a fault to fix here. This platform does not pay a
 * projection — the maturity engine refuses rather than paying the contracted
 * figure when nothing has been posted — and the same rule holds for a year.
 * A director posts the year's achieved rate against the pool and it becomes
 * payable; until then it shows here as waiting, with the amount it WOULD pay
 * at the contracted rate shown for scale only, never paid.
 *
 * Run:
 *   DATABASE_URL="<url>" node server/scripts/anniversary-returns.cjs
 *   …--as-of 2026-12-31   what will have fallen due by then
 *   …--investor S-111946  one client
 *   …--apply              pay everything payable (the cron does this daily)
 *   …--csv                write anniversary-returns.csv alongside
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See the header of this file.');
  process.exit(2);
}

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const annual = require(path.join(__dirname, '..', 'services', 'anniversaryReturns'));

const ARGV = process.argv.slice(2);
const val  = n => { const i = ARGV.indexOf(n); return i > -1 ? (ARGV[i + 1] || '') : ''; };
const AS_OF    = val('--as-of') || new Date().toISOString().slice(0, 10);
const INVESTOR = val('--investor');
const APPLY    = ARGV.includes('--apply');
const WANT_CSV = ARGV.includes('--csv');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  statement_timeout: 120000,
});

const money = n => 'R' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const H = s => console.log(`\n${s}\n${'─'.repeat(s.length)}`);
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');

(async () => {
  try {
    let items = await annual.due(db, { asOf: AS_OF });
    if (INVESTOR) items = items.filter(x => x.investorId === INVESTOR);

    H(`Solar anniversaries fallen due by ${AS_OF}` + (INVESTOR ? ` · ${INVESTOR}` : ''));
    if (!items.length) {
      console.log('  None. Either no solar investment has reached an anniversary yet,');
      console.log('  or none is held — check the product types in the investments table.');
      return;
    }

    const by = st => items.filter(x => x.state === st);
    const sum = xs => xs.reduce((a, x) => a + (x.wouldPay || x.paidAmount || 0), 0);
    for (const [state, label] of [
      ['paid',          'already distributed'],
      ['payable',       'a rate is posted and nothing has been paid — payable now'],
      ['awaiting-rate', 'the year has come round and nobody has posted a rate'],
    ]) {
      const xs = by(state);
      if (xs.length) console.log(`  ${String(xs.length).padStart(4)}  ${money(sum(xs)).padStart(15)}  ${label}`);
    }

    for (const [state, label] of [
      ['payable',       'Payable now'],
      ['awaiting-rate', 'Waiting on a posted rate'],
      ['paid',          'Already distributed'],
    ]) {
      const xs = by(state);
      if (!xs.length) continue;
      H(label);
      for (const x of xs) {
        console.log(`  ${day(x.dueOn)}  year ${x.yearIndex}  ${x.investorId.padEnd(16)} ` +
          `${money(x.amount).padStart(14)} invested  ${x.poolName || x.poolId}`);
        if (state === 'paid') {
          console.log(`      paid ${money(x.paidAmount)} on ${day(x.paidOn)}`);
        } else if (state === 'payable') {
          console.log(`      rate ${x.rate} → ${money(x.wouldPay)}` + (x.note ? `  (${x.note})` : ''));
        } else {
          console.log('      no rate posted for year ' + x.yearIndex + ' of this pool — pays nothing until one is');
        }
      }
    }

    if (by('awaiting-rate').length) {
      H('Posting a year\'s rate');
      const pools = [...new Set(by('awaiting-rate').map(x => `${x.poolId} · year ${x.yearIndex}`))];
      pools.forEach(p => console.log(`  ${p}`));
      console.log('\n  POST /api/admin/pool-annual-return  { pool_id, year_index, rate, note }');
      console.log('  Director only, audited. The daily job distributes whatever is posted.');
    }

    if (!APPLY) {
      H('Nothing was changed');
      console.log(`  --apply pays the ${by('payable').length} payable distribution(s), ` +
                  `${money(sum(by('payable')))} in all.`);
      console.log('  The daily job does the same thing at 06:10 SAST, so this is only');
      console.log('  for settling a backlog deliberately rather than waiting for it.');
      return;
    }

    let paid = 0, total = 0;
    for (const item of by('payable')) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const res = await annual.payOne(client, item);
        await client.query('COMMIT');
        if (res.paid) { paid++; total = annual.round2(total + res.amount); }
        console.log(`  ${res.paid ? '✓' : '·'} ${item.investorId} year ${item.yearIndex} — ` +
                    (res.paid ? money(res.amount) : res.reason));
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log(`  ✗ ${item.investorId} year ${item.yearIndex} — ${err.message}`);
      } finally { client.release(); }
    }
    H('Written');
    console.log(`  ${paid} distribution(s) paid, ${money(total)} in all.`);

    if (WANT_CSV) {
      const out = path.join(process.cwd(), 'anniversary-returns.csv');
      const head = 'due_on,investor,investment,pool,year,invested,state,rate,amount\n';
      fs.writeFileSync(out, head + items.map(x =>
        [day(x.dueOn), x.investorId, x.investmentId, x.poolId, x.yearIndex,
         x.amount, x.state, x.rate == null ? '' : x.rate,
         x.paid ? x.paidAmount : (x.wouldPay == null ? '' : x.wouldPay)].join(',')).join('\n') + '\n');
      console.log(`\n  Written: ${out}`);
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
    await require(path.join(__dirname, '..', 'db', 'pool')).end().catch(() => {});
  }
})();
