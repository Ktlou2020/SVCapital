#!/usr/bin/env node
/* A fund run's payout schedule and fee entries, generated from the run.
 *
 * return_schedules and fee_ledger both existed and neither had a writer. The
 * console could calculate a run's returns and store the totals on the run, and
 * that was the end of it: nothing recorded who was owed what, and the Payout
 * Schedules and Fee Ledger screens were empty because nothing had ever put a
 * row in them.
 *
 * The part that has to be right is the arithmetic. A schedule whose rows sum to
 * three cents less than the run it came from is not a rounding detail — it is
 * the first thing anyone reconciling a payout will find, and it makes every
 * figure on the screen suspect. So the totals are asserted to tie EXACTLY, on
 * shares chosen to force the awkward cases: three equal thirds of a cent-odd
 * total, one investor holding almost everything, and a run that lost money.
 *
 * The other half is refusal. Generation is safe to repeat — right up until
 * someone has been paid, at which point the schedule is history and must not be
 * rewritten. That boundary is checked in both directions.
 *
 * Run: DATABASE_URL=… DATABASE_SSL=false node server/scripts/check-fund-run-generation.cjs
 */
'use strict';

if (!process.env.DATABASE_URL) {
  console.log('  SKIP  DATABASE_URL not set — see the header of this file');
  process.exit(0);
}

const path    = require('path');
const http    = require('http');
const express = require('express');
const pool    = require(path.join(__dirname, '..', 'db', 'pool'));
const { largestRemainder, benchmarkNet } =
  require(path.join(__dirname, '..', 'services', 'fundRunGeneration'));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const sum = a => a.reduce((s, v) => s + v, 0);

/* ── The distribution, on its own ───────────────────────────────────────── */
console.log('\nthe cents always add up');
{
  const cases = [
    ['three equal shares of a total that does not divide by three', 100003, [1, 1, 1]],
    ['one holder with almost everything',                           1234567, [999999, 1, 1, 1]],
    ['wildly uneven shares',                                        7777777, [3, 17, 1041, 5, 88, 2]],
    ['a total of one cent across four holders',                     1, [25, 25, 25, 25]],
    ['a run that lost money',                                       -50001, [1, 1, 1]],
    ['a total of zero',                                             0, [5, 3, 2]],
  ];
  for (const [name, total, weights] of cases) {
    const parts = largestRemainder(total, weights);
    ok(`${name} sum to the total exactly`, sum(parts) === total,
       `${sum(parts)} vs ${total} — parts ${JSON.stringify(parts)}`);
    ok(`  …and every part is a whole cent`, parts.every(Number.isInteger), JSON.stringify(parts));
  }

  /* Proportionality, not just conservation: a conserving function that gives
     everything to the first holder would pass the assertions above. */
  const p = largestRemainder(1000000, [50, 30, 20]);
  ok('the split follows the shares', JSON.stringify(p) === '[500000,300000,200000]', JSON.stringify(p));

  /* Determinism: two runs of the same input must not disagree, or regenerating
     a run would silently move cents between investors. */
  const a = largestRemainder(100003, [7, 7, 7, 1]);
  const b = largestRemainder(100003, [7, 7, 7, 1]);
  ok('the same input always gives the same answer', JSON.stringify(a) === JSON.stringify(b));

  ok('no holders is not a crash', JSON.stringify(largestRemainder(500, [])) === '[]');
  ok('zero total weight pays nobody', JSON.stringify(largestRemainder(500, [0, 0])) === '[0,0]');
}

console.log('\nthe benchmark is the rate the run was sold at');
{
  /* R1,000,000 at 10% for 365 days, 2% management, no performance fee:
     gross 100 000, management 20 000, net 80 000. */
  const n = benchmarkNet({ principal_amount: 1000000, annual_rate: 0.10, term_days: 365,
                           management_fee_pct: 0.02, performance_fee_pct: 0 });
  ok('simple interest less the same fees', Math.abs(n - 80000) < 0.005, String(n));
  ok('a run with no benchmark rate gets zero, not a guess',
     benchmarkNet({ principal_amount: 1000000, term_days: 365 }) === 0);
}

/* ── Against a real database ────────────────────────────────────────────── */
const authMod = require.resolve(path.join(__dirname, '..', 'middleware', 'auth'));
const realAuth = require(authMod);
require.cache[authMod].exports = {
  ...realAuth,
  requireAuth: (req, _r, next) => {
    req.user = { role: req.headers['x-role'] || 'investor', id: 'u-fr', email: 'fund@chk.test' };
    next();
  },
};

const app = express();
app.use(express.json());
app.use('/api/fund', require(path.join(__dirname, '..', 'routes', 'fundRuns')));

let server;
const call = (method, p, role, body) => new Promise(res => {
  const d = body ? JSON.stringify(body) : null;
  const headers = { 'x-role': role };
  if (d) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(d); }
  const r = http.request({ port: server.address().port, path: p, method, headers }, x => {
    let s = ''; x.on('data', c => s += c);
    x.on('end', () => { let j = {}; try { j = JSON.parse(s); } catch (_) {} res({ status: x.statusCode, body: j }); });
  });
  r.on('error', () => res({ status: 0, body: {} }));
  if (d) r.write(d);
  r.end();
});

const RUN = 'FR-CHK-1', POOL = 'POOL-CHK-1';
async function cleanup() {
  await pool.query(`DELETE FROM return_schedules WHERE fund_run_id LIKE 'FR-CHK-%'`);
  await pool.query(`DELETE FROM fee_ledger       WHERE fund_run_id LIKE 'FR-CHK-%'`);
  await pool.query(`DELETE FROM investments      WHERE id LIKE 'INVCHK-%'`);
  await pool.query(`DELETE FROM investors        WHERE id LIKE 'INV-CHK-%'`);
  await pool.query(`DELETE FROM fund_runs        WHERE id LIKE 'FR-CHK-%'`);
  await pool.query(`DELETE FROM investment_pools WHERE id LIKE 'POOL-CHK-%'`);
}

/* Three investors whose shares do not divide evenly into the return — the
   whole point of the exercise. */
const HOLDINGS = [['INV-CHK-1', 'Thandi', 'Nkosi', 333333.33],
                  ['INV-CHK-2', "S'busiso", 'Dlamini', 333333.33],
                  ['INV-CHK-3', 'Johan', 'van der Merwe', 333333.34]];

async function seed({ grossReturn = 148300, netReturn = 118640, mgmt = 20000, perf = 9660 } = {}) {
  await cleanup();
  await pool.query(
    `INSERT INTO investment_pools (id, name, product_type, status, annual_rate)
     VALUES ($1,'Check Pool','cattle','open',0.1483)`, [POOL]);
  await pool.query(
    `INSERT INTO fund_runs (id, run_name, product_type, status, pool_id,
        principal_amount, annual_rate, actual_rate, term_days, start_date, end_date,
        gross_return, management_fee, performance_fee, total_fees, net_return,
        management_fee_pct, performance_fee_pct)
     VALUES ($1,'Check Run','cattle','in_progress',$2,
        1000000, 0.1483, 0.1483, 365, '2026-01-01', '2026-12-31',
        $3, $4, $5, $6, $7, 0.02, 0.20)`,
    [RUN, POOL, grossReturn, mgmt, perf, mgmt + perf, netReturn]);
  for (const [id, fn, ln, amt] of HOLDINGS) {
    await pool.query(
      `INSERT INTO investors (id, first_name, last_name, email)
       VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [id, fn, ln, `${id.toLowerCase()}@chk.test`]);
    await pool.query(
      `INSERT INTO investments (id, investor_id, pool_id, amount, status, annual_rate)
       VALUES ($1,$2,$3,$4,'active',0.1483)`,
      [`INVCHK-${id}`, id, POOL, amt]);
  }
}

(async () => {
  try {
    server = app.listen(0);
    await new Promise(r => server.on('listening', r));

    console.log('\nwho may generate');
    {
      await seed();
      for (const role of ['investor', 'staff']) {
        const r = await call('POST', `/api/fund/runs/${RUN}/generate`, role);
        ok(`a ${role} is refused`, r.status === 403, `got ${r.status}`);
      }
      const p = await call('GET', `/api/fund/runs/${RUN}/plan`, 'investor');
      ok('and cannot even see the plan', p.status === 403, `got ${p.status}`);
    }

    console.log('\nthe plan before anything is written');
    {
      const r = await call('GET', `/api/fund/runs/${RUN}/plan`, 'fund_manager');
      ok('a director-role user gets a plan', r.status === 200 && r.body.ok === true,
         JSON.stringify(r.body.blockers));
      ok('with a row per investor', r.body.schedules.length === 3);
      ok('and the fee lines the run implies',
         r.body.feeLines.map(l => l.fee_type).sort().join(',') === 'management,performance',
         JSON.stringify(r.body.feeLines.map(l => l.fee_type)));
      ok('planning writes nothing',
         (await pool.query(`SELECT 1 FROM return_schedules WHERE fund_run_id = $1`, [RUN])).rows.length === 0);
    }

    console.log('\ngenerating, and tying back to the run');
    {
      const r = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      ok('it writes', r.status === 200 && r.body.written.schedules === 3, JSON.stringify(r.body.blockers || r.body));

      const { rows: [t] } = await pool.query(
        `SELECT COUNT(*)::int n,
                SUM(amount_invested)  inv,
                SUM(gross_return)     gross,
                SUM(fees)             fees,
                SUM(net_return)       net
           FROM return_schedules WHERE fund_run_id = $1`, [RUN]);
      ok('one schedule per investor', t.n === 3);
      ok('the capital ties to the pool', Number(t.inv) === 1000000, String(t.inv));
      ok('THE GROSS TIES TO THE RUN EXACTLY', Number(t.gross) === 148300,
         `${t.gross} vs 148300 — a schedule that does not tie makes every figure suspect`);
      ok('the fees tie exactly',  Number(t.fees) === 29660, String(t.fees));
      ok('the net ties exactly',  Number(t.net)  === 118640, String(t.net));

      const { rows: [f] } = await pool.query(
        `SELECT COUNT(*)::int n, SUM(amount) total FROM fee_ledger WHERE fund_run_id = $1`, [RUN]);
      ok('the fee ledger carries both fees', f.n === 2);
      ok('and totals what the run charged', Number(f.total) === 29660, String(f.total));

      const { rows: fl } = await pool.query(
        `SELECT fee_type, rate, basis FROM fee_ledger WHERE fund_run_id = $1 ORDER BY fee_type`, [RUN]);
      ok('a management fee records the capital it was charged on',
         Number(fl[0].basis) === 1000000 && Number(fl[0].rate) === 0.02, JSON.stringify(fl[0]));
      ok('and a performance fee records the gross it was charged on',
         Number(fl[1].basis) === 148300, JSON.stringify(fl[1]));

      const { rows: st } = await pool.query(
        `SELECT DISTINCT status FROM return_schedules WHERE fund_run_id = $1`, [RUN]);
      ok('schedules are written pending, not paid', st.length === 1 && st[0].status === 'pending',
         JSON.stringify(st));
      const { rows: fs2 } = await pool.query(
        `SELECT DISTINCT status FROM fee_ledger WHERE fund_run_id = $1`, [RUN]);
      ok('and fees accrued, not received', fs2.length === 1 && fs2[0].status === 'accrued',
         JSON.stringify(fs2));

      ok('nobody was paid anything',
         (await pool.query(`SELECT 1 FROM return_schedules WHERE fund_run_id=$1 AND paid_at IS NOT NULL`, [RUN])).rows.length === 0,
         'generating a schedule must not move money');
    }

    console.log('\ngenerating twice');
    {
      const before = (await pool.query(`SELECT COUNT(*)::int n FROM return_schedules WHERE fund_run_id=$1`, [RUN])).rows[0].n;
      const r = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      const after = (await pool.query(`SELECT COUNT(*)::int n FROM return_schedules WHERE fund_run_id=$1`, [RUN])).rows[0].n;
      ok('replaces rather than duplicates', r.status === 200 && after === before,
         `${before} → ${after}`);
      ok('and says what it replaced', r.body.written.replacedSchedules === 3,
         JSON.stringify(r.body.written));
      const { rows: [t] } = await pool.query(
        `SELECT SUM(net_return) net FROM return_schedules WHERE fund_run_id = $1`, [RUN]);
      ok('and still ties', Number(t.net) === 118640, String(t.net));
    }

    console.log('\nonce someone has been paid, the schedule is history');
    {
      await pool.query(
        `UPDATE return_schedules SET status='paid', paid_at=NOW()
          WHERE id = (SELECT id FROM return_schedules WHERE fund_run_id=$1 LIMIT 1)`, [RUN]);
      const r = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      ok('regeneration is refused', r.status === 409, `got ${r.status}`);
      ok('and says why', (r.body.blockers || []).some(b => /already been marked paid/.test(b)),
         JSON.stringify(r.body.blockers));
      const { rows: [t] } = await pool.query(
        `SELECT COUNT(*)::int n FROM return_schedules WHERE fund_run_id=$1`, [RUN]);
      ok('the paid row and its siblings are untouched', t.n === 3, String(t.n));
    }

    console.log('\nwhat it refuses to generate from');
    {
      /* No pool: nothing says who is in the run. */
      await seed();
      await pool.query(`UPDATE fund_runs SET pool_id = NULL WHERE id = $1`, [RUN]);
      let r = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      ok('a run with no pool', r.status === 409 && /not linked to a pool/.test(String(r.body.blockers)),
         JSON.stringify(r.body.blockers));

      /* No return calculated: a schedule of zeros looks finished and is not. */
      await seed({ grossReturn: 0, netReturn: 0, mgmt: 0, perf: 0 });
      r = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      ok('a run with no gross return', r.status === 409 && /no gross return/.test(String(r.body.blockers)),
         JSON.stringify(r.body.blockers));

      /* Nobody in the pool. */
      await seed();
      await pool.query(`DELETE FROM investments WHERE pool_id = $1`, [POOL]);
      r = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      ok('a pool with no investments', r.status === 409 && /Nobody to pay/.test(String(r.body.blockers)),
         JSON.stringify(r.body.blockers));

      r = await call('POST', `/api/fund/runs/FR-CHK-NOPE/generate`, 'director');
      ok('a run that does not exist', r.status === 404, `got ${r.status}`);
    }

    console.log('\na discrepancy is reported, not corrected');
    {
      await seed();
      /* The pool holds R900k; the run claims R1m. */
      await pool.query(`UPDATE investments SET amount = 300000 WHERE pool_id = $1`, [POOL]);
      const r = await call('GET', `/api/fund/runs/${RUN}/plan`, 'director');
      ok('the plan still succeeds', r.body.ok === true, JSON.stringify(r.body.blockers));
      ok('and warns that the two figures disagree',
         (r.body.warnings || []).some(w => /900000\.00.*1000000\.00|difference/.test(w)),
         JSON.stringify(r.body.warnings));
      const g = await call('POST', `/api/fund/runs/${RUN}/generate`, 'director');
      const { rows: [t] } = await pool.query(
        `SELECT SUM(net_return) net, SUM(amount_invested) inv FROM return_schedules WHERE fund_run_id=$1`, [RUN]);
      ok('the split is by share, so the return still ties to the run',
         Number(t.net) === 118640, String(t.net));
      ok('while the capital reflects what is actually invested',
         Number(t.inv) === 900000, String(t.inv));
      ok('and the generate response repeats the warning',
         (g.body.warnings || []).length > 0, JSON.stringify(g.body.warnings));
    }

    console.log('\nit is recorded in the audit trail');
    {
      const { rows } = await pool.query(
        `SELECT event_type, description FROM audit_events
          WHERE entity_id = $1 AND event_type = 'fund_run.generate_schedule'
          ORDER BY created_at DESC LIMIT 1`, [RUN]);
      ok('the generation is audited', rows.length === 1, 'no audit event was written');
      if (rows.length) ok('and says what it produced', /payout schedule/.test(rows[0].description), rows[0].description);
    }

    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
  } catch (err) {
    console.error('\n  ✗ threw:', err.message, '\n', err.stack);
    fail++;
    await cleanup().catch(() => {});
  } finally {
    try { server && server.close(); } catch (_) { /* already down */ }
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
