'use strict';
/* Turning a fund run into the records it implies: a payout schedule per
 * investor, and the fee entries the fund earned.
 *
 * Both tables existed and neither had a writer. The console could calculate a
 * run's returns and store the totals on the run itself, and that was the end of
 * it — nothing said who was owed what, and nothing recorded the management and
 * performance fees as anything other than two numbers on a row. The Payout
 * Schedules and Fee Ledger screens were empty because nothing had ever put
 * anything in them.
 *
 * WHAT THIS DOES AND DOES NOT DO
 *
 * It does not move money. It writes what is OWED (return_schedules, status
 * 'pending') and what the fund has EARNED (fee_ledger, status 'accrued').
 * Paying an investor is a separate, deliberate act — Mark Paid — and crediting
 * a wallet happens nowhere near here. Generation is safe to get wrong twice;
 * a payout is not, which is exactly why they are separate.
 *
 * WHO IS IN A RUN
 *
 * The investments in the run's pool. investor_allocations looks like the
 * obvious source but nothing populates it except a prompt-based quick-add in
 * the console, whereas investments is where an investor's money actually is.
 * A run with no pool_id therefore cannot be generated, and says so rather than
 * producing an empty schedule that looks finished.
 *
 * THE ARITHMETIC HAS TO TIE
 *
 * A schedule whose rows sum to R0.03 less than the run is not a rounding
 * detail, it is a set of books that do not balance — and it is the first thing
 * anyone reconciling a payout run will find. Every distribution here goes
 * through largestRemainder, which allocates in whole cents and hands the
 * leftover cents to the largest fractional shares, so the parts always sum to
 * the whole exactly.
 */

const { v4: uuidv4 } = require('uuid');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const cents  = n => Math.round((Number(n) || 0) * 100);
const num    = v => Number(v) || 0;

/* Split `totalCents` across `weights` so the parts are whole cents and sum to
 * the total EXACTLY.
 *
 * Each part gets the floor of its ideal share; the cents left over go to the
 * largest fractional remainders, one each. Ties break on the larger weight and
 * then on position, so the same inputs always give the same answer — a
 * distribution that shuffles between runs would make two regenerations of one
 * run disagree for no reason.
 *
 * Negative totals (a run that lost money) are distributed by sign-flipping
 * rather than by trusting Math.floor, which rounds toward negative infinity and
 * would hand out one cent too many.
 */
function largestRemainder(totalCents, weights) {
  const n = weights.length;
  if (!n) return [];
  const W = weights.reduce((s, w) => s + w, 0);
  if (W <= 0) return new Array(n).fill(0);

  const sign = totalCents < 0 ? -1 : 1;
  const T = Math.abs(Math.round(totalCents));

  const ideal = weights.map(w => (T * w) / W);
  const base  = ideal.map(Math.floor);
  let left    = T - base.reduce((s, v) => s + v, 0);

  const order = ideal
    .map((v, i) => ({ i, frac: v - Math.floor(v), w: weights[i] }))
    .sort((a, b) => (b.frac - a.frac) || (b.w - a.w) || (a.i - b.i));

  for (let k = 0; k < left; k++) base[order[k % n].i] += 1;
  return base.map(v => sign * v);
}

/* The fee lines a run implies. Only non-zero ones are written: a ledger padded
   with R0.00 rows for fees this run never charged is harder to read, not more
   complete. `basis` is what the rate was applied to, so a person can check the
   arithmetic without recomputing the run. */
function feeLinesFor(run) {
  const principal = num(run.principal_amount);
  const gross     = num(run.gross_return);
  const lines = [
    { fee_type: 'management',  amount: num(run.management_fee),  rate: num(run.management_fee_pct)  || null, basis: principal,
      description: 'Management fee on capital deployed' },
    { fee_type: 'performance', amount: num(run.performance_fee), rate: num(run.performance_fee_pct) || null, basis: gross,
      description: 'Performance fee on gross return' },
    { fee_type: 'structuring', amount: num(run.structuring_fee), rate: null, basis: principal,
      description: 'Structuring fee' },
    { fee_type: 'admin',       amount: num(run.admin_fee),       rate: null, basis: principal,
      description: 'Administration fee' },
  ];
  return lines.filter(l => round2(l.amount) !== 0);
}

/* The net return this run would have produced at the rate it was SOLD at.
 *
 * Same arithmetic the console already uses to show alpha on the calculate-
 * returns modal — simple interest on the principal over the term, less the same
 * fee percentages — so the benchmark on a schedule and the benchmark in the
 * modal cannot disagree. A run with no benchmark rate has no promise to measure
 * against and gets zero rather than a fabricated one. */
function benchmarkNet(run) {
  const principal = num(run.principal_amount);
  const rate      = num(run.annual_rate);
  const days      = num(run.term_days);
  if (!principal || !rate || !days) return 0;
  const years  = days / 365;
  const gross  = principal * rate * years;
  const mgmt   = principal * num(run.management_fee_pct) * years;
  const perf   = num(run.performance_fee_pct) > 0 ? gross * num(run.performance_fee_pct) : 0;
  return Math.max(0, gross - mgmt - perf);
}

/* When the run is due. end_date if it has one, otherwise start + term. A run
   with neither cannot be scheduled, and saying so beats writing null dates that
   sort to the top of every payout list forever. */
function dueDate(run) {
  if (run.end_date) return new Date(run.end_date);
  if (run.start_date && num(run.term_days) > 0)
    return new Date(new Date(run.start_date).getTime() + num(run.term_days) * 86400000);
  return null;
}

const PARTICIPANTS = `
  SELECT v.id, v.investor_id, v.amount, v.status,
         i.first_name, i.last_name, i.email
    FROM investments v
    LEFT JOIN investors i ON i.id = v.investor_id
   WHERE v.pool_id = $1
     AND COALESCE(v.status, '') IN ('active', 'matured')
     AND COALESCE(v.amount, 0) > 0
   ORDER BY v.amount DESC, v.id`;

/* A dry run: everything that would be written, and every reason it might not
 * be. Called on its own by the preview, and by the writer immediately before it
 * writes, so the console can never show one plan and commit another. */
async function planRun(db, runId) {
  const { rows: [run] } = await db.query('SELECT * FROM fund_runs WHERE id = $1', [runId]);
  if (!run) return { ok: false, error: 'not_found', message: 'Fund run not found.' };

  const blockers = [], warnings = [];

  if (!run.pool_id)
    blockers.push('This run is not linked to a pool, so there is no way to tell who is in it. Set the pool on the run first.');

  const due = dueDate(run);
  if (!due)
    blockers.push('This run has neither an end date nor a start date and term, so payouts cannot be dated.');

  const gross = num(run.gross_return);
  if (gross === 0)
    blockers.push('This run has no gross return recorded. Calculate returns first — generating a schedule of zeros helps no one.');

  let participants = [];
  if (run.pool_id) {
    ({ rows: participants } = await db.query(PARTICIPANTS, [run.pool_id]));
  }
  if (run.pool_id && !participants.length)
    blockers.push('No active investments in this run\'s pool. Nobody to pay.');

  const invested = round2(participants.reduce((s, p) => s + num(p.amount), 0));
  const principal = round2(num(run.principal_amount));
  /* Reported, never corrected. If the pool holds R1.9m and the run says R2m,
     one of the two is wrong and only a person knows which; silently allocating
     against either would hide it. Allocation is by SHARE, so the split is right
     regardless — but the discrepancy still needs saying. */
  if (participants.length && Math.abs(invested - principal) >= 0.01)
    warnings.push(`The pool holds ${invested.toFixed(2)} but the run records ${principal.toFixed(2)} as capital deployed — a difference of ${Math.abs(invested - principal).toFixed(2)}. Returns are split by each investor's share, so the split is unaffected, but one of the two figures is wrong.`);

  /* Existing rows. Anything already paid or received is history and this must
     not touch it. */
  const { rows: [sched] } = await db.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid
       FROM return_schedules WHERE fund_run_id = $1`, [runId]);
  const { rows: [fees] } = await db.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE status = 'received')::int AS received
       FROM fee_ledger WHERE fund_run_id = $1`, [runId]);

  if (sched.paid > 0)
    blockers.push(`${sched.paid} payout${sched.paid === 1 ? ' has' : 's have'} already been marked paid for this run. Regenerating would rewrite settled history.`);
  if (fees.received > 0)
    blockers.push(`${fees.received} fee entr${fees.received === 1 ? 'y has' : 'ies have'} already been marked received for this run.`);

  const replacing = { schedules: sched.n - sched.paid, fees: fees.n - fees.received };

  /* The split. Weights are the investors' capital; the totals come off the run,
     so the schedule always ties back to it. */
  const weights   = participants.map(p => num(p.amount));
  const totalFees = num(run.total_fees) ||
                    (num(run.management_fee) + num(run.performance_fee) +
                     num(run.structuring_fee) + num(run.admin_fee));
  const grossC    = largestRemainder(cents(run.gross_return), weights);
  const feesC     = largestRemainder(cents(totalFees), weights);
  const netC      = largestRemainder(cents(run.net_return), weights);

  /* expected_return is what the run was SOLD at, not what it delivered.
     annual_rate is the benchmark and actual_rate is the outcome, so the run's
     own gross/net are the actual and this is the promise they are measured
     against. Filling both columns with the same figure would make the column
     decorative; this way the schedule shows, per investor, whether the run beat
     what they were told to expect. */
  const benchNet = benchmarkNet(run);
  const benchC   = largestRemainder(cents(benchNet), weights);

  const schedules = participants.map((p, i) => ({
    investmentId:  p.id,
    investorId:    p.investor_id,
    investorName:  `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || p.investor_id,
    amountInvested: round2(p.amount),
    expectedReturn: benchC[i] / 100,
    grossReturn:   grossC[i] / 100,
    fees:          feesC[i] / 100,
    netReturn:     netC[i] / 100,
    expectedDate:  due,
  }));

  const feeLines = feeLinesFor(run);

  return {
    ok: blockers.length === 0,
    blockers, warnings,
    run: { id: run.id, name: run.run_name, poolId: run.pool_id,
           principal, grossReturn: round2(run.gross_return), netReturn: round2(run.net_return),
           dueDate: due },
    schedules, feeLines, replacing,
    totals: {
      investors:   schedules.length,
      invested,
      gross:       round2(grossC.reduce((s, c) => s + c, 0) / 100),
      fees:        round2(feesC.reduce((s, c) => s + c, 0) / 100),
      net:         round2(netC.reduce((s, c) => s + c, 0) / 100),
      feeLedger:   round2(feeLines.reduce((s, l) => s + num(l.amount), 0)),
    },
  };
}

/* Writes the plan, in one transaction.
 *
 * The plan is recomputed here rather than accepted from the caller. A console
 * that posted a list of amounts could pay the wrong investor the wrong figure
 * by sending it — through a stale page, or deliberately — and the guarantee
 * that a schedule matches its run has to hold where the rows are written, not
 * where they are previewed. */
async function generateForRun(db, runId, { actorEmail = null } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    /* The run is locked for the length of the write so two operators pressing
       Generate at once cannot interleave a delete with the other's insert. */
    await client.query('SELECT id FROM fund_runs WHERE id = $1 FOR UPDATE', [runId]);

    const plan = await planRun(client, runId);
    if (!plan.ok) { await client.query('ROLLBACK'); return { ...plan, written: null }; }

    /* Replace the unsettled rows only. The status filters repeat the blocker
       checked above deliberately: that one stops a person, this one stops a
       race, and only the second is still true at the moment of the DELETE. */
    const { rowCount: delSched } = await client.query(
      `DELETE FROM return_schedules WHERE fund_run_id = $1 AND COALESCE(status,'pending') <> 'paid'`, [runId]);
    const { rowCount: delFees } = await client.query(
      `DELETE FROM fee_ledger WHERE fund_run_id = $1 AND COALESCE(status,'accrued') <> 'received'`, [runId]);

    const note = `Generated from fund run ${runId}${actorEmail ? ` by ${actorEmail}` : ''}`;

    for (const s of plan.schedules) {
      await client.query(
        `INSERT INTO return_schedules
           (id, fund_run_id, investor_id, amount_invested, expected_return,
            gross_return, fees, net_return, expected_date, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`,
        [`RS-${uuidv4().slice(0, 12).toUpperCase()}`, runId, s.investorId,
         s.amountInvested, s.expectedReturn, s.grossReturn, s.fees, s.netReturn,
         s.expectedDate, note]);
    }

    for (const l of plan.feeLines) {
      await client.query(
        `INSERT INTO fee_ledger
           (id, fund_run_id, fee_type, amount, rate, basis, description, accrued_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'accrued')`,
        [`FEE-${uuidv4().slice(0, 12).toUpperCase()}`, runId, l.fee_type,
         round2(l.amount), l.rate, round2(l.basis), l.description, plan.run.dueDate]);
    }

    await client.query('COMMIT');
    return {
      ...plan,
      written: { schedules: plan.schedules.length, fees: plan.feeLines.length,
                 replacedSchedules: delSched, replacedFees: delFees },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { planRun, generateForRun, largestRemainder, feeLinesFor, benchmarkNet, dueDate, PARTICIPANTS };
