'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   historicalInvestment — record an investment that ALREADY HAPPENED.

   This is not the investment route with the dates made editable. It is a
   deliberately different operation, because every safeguard on the real route
   exists to protect a client whose money is about to move, and here the money
   moved long ago.

   ── WHAT IT MUST NOT DO, AND WHY ───────────────────────────────────────

   POST /api/investments does six things that are correct when a client is
   placing money today and WRONG when staff are recording history:

     debits the wallet            the money already left. Debiting takes it a
                                  second time.
     charges the 1% platform fee  already charged, or never charged. Either
                                  way, not now.
     demands a signed agreement   it was signed on paper, or before this
                                  platform existed. A 412 here is a false
                                  refusal.
     overwrites end_date with     the pool's canonical maturity is right for a
     the pool's maturity_date     live placement and wrong for a holding that
                                  ran a different term.
     emails the client            "Your investment has been created" about
                                  something from last year is alarming, and it
                                  is sent fire-and-forget, so nobody can stop
                                  it once the row is written.
     leaves it to the crons       see below. This is the one that costs money.

   ── THE PART THAT WOULD HAVE PAID TWICE ────────────────────────────────

   A backdated investment whose maturity has passed is picked up by the
   nightly engine like any other:

     jobs/maturityCron    WHERE status = 'active' AND end_date <= NOW()
                          → matures it, and rolls it over or credits a wallet
     jobs/payoutCron      WHERE status = 'matured'
                            AND maturity_instruction IN (payout_all, payout_return)
                            AND maturity_processed_at IS NULL
                          → pays principal + return into the wallet

   A holding that matured in March and was settled in March would therefore be
   settled AGAIN on the night it was recorded. So anything whose end date has
   passed is written 'matured' WITH maturity_processed_at set — which is what
   takes it out of both queries at once. Writing 'matured' alone is not
   enough: payoutCron keys on the stamp, not the status, and would still pay.

   check-historical-investment runs both jobs against a row this service wrote
   and asserts neither touched it. A grep would not have caught the stamp.

   ── WHAT IT DOES NOT KNOW ──────────────────────────────────────────────

   actual_return is left at zero unless the caller states it. The contracted
   rate says what the holding SHOULD have earned; only a human knows what was
   paid, and inventing the difference would put money on a tax document.
   expected_return is computed from the pool's rate and reported as the
   contracted figure it is.

   READ-ONLY UNTIL APPLIED. survey() writes nothing and returns exactly what
   execute() would do.
   ───────────────────────────────────────────────────────────────────────────── */

const { recordTransaction } = require('./ledger');
const audit = require('./audit');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const day = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

/* Africa/Johannesburg, not the server's UTC midnight. An investment recorded
   at 01:00 SAST with today's date is not a future date, and CURRENT_DATE would
   have called it one. */
async function businessToday(db) {
  const { rows } = await db.query(
    `SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date AS d`);
  return day(rows[0].d);
}

const addMonths = (iso, months) => {
  const [y, m, d] = iso.split('-').map(Number);
  /* Day 0 of the following month is the last day of the target month, which
     is how a 31st start lands on the 28th rather than sliding into March. */
  const last = new Date(Date.UTC(y, m - 1 + Number(months) + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + Number(months), Math.min(d, last)))
    .toISOString().slice(0, 10);
};

/* ── survey ───────────────────────────────────────────────────────────────
   db        a pool or a client
   poolId    the pool every record in this run belongs to
   records   [{ investorId, subAccountId?, amount, startDate, endDate?,
               termMonths?, actualReturn?, notes? }]
   ledger    true to also write the matching `investment` debit

   Returns { pool, today, plan: [...], totals, refusals }. Nothing is written.
   ──────────────────────────────────────────────────────────────────────── */
async function survey(db, opts = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('historicalInvestment needs a pool or client');
  const poolId  = opts.poolId || null;
  const records = Array.isArray(opts.records) ? opts.records : [];
  const ledger  = opts.ledger === true;

  if (!poolId) { const e = new Error('Choose the pool these investments belong to.'); e.status = 400; throw e; }
  if (!records.length) { const e = new Error('There is nothing to record.'); e.status = 400; throw e; }

  const { rows: [p] } = await db.query(
    `SELECT id, name, product_type, status, annual_rate, term_months,
            start_date, end_date, maturity_date
       FROM investment_pools WHERE id = $1`, [poolId]);
  if (!p) { const e = new Error('No such pool.'); e.status = 404; throw e; }

  const today = await businessToday(db);
  const plan = [], refusals = [];

  for (const [i, raw] of records.entries()) {
    const where = `row ${i + 1}`;
    const investorId = String(raw.investorId || raw.investor_id || '').trim();
    const amount     = r2(raw.amount);
    const startDate  = day(raw.startDate || raw.start_date);
    const subId      = (raw.subAccountId || raw.sub_account_id || '') || null;

    const refuse = reason => refusals.push({ where, investorId, reason });

    if (!investorId) { refuse('No account number.'); continue; }
    if (!(amount > 0)) { refuse('The amount must be more than zero.'); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { refuse('The start date must be a date, as YYYY-MM-DD.'); continue; }
    /* This records history. A future start date is a typo, and writing it
       would create a live holding nobody placed. */
    if (startDate > today) { refuse(`The start date ${startDate} is in the future — this records what already happened.`); continue; }

    const { rows: [inv] } = await db.query(
      `SELECT id, first_name, last_name, email FROM investors WHERE id = $1`, [investorId]);
    if (!inv) { refuse('No client with that account number.'); continue; }

    /* A sub-account's money is the group's, not the parent's. Recording a
       stokvel's holding against the chairperson personally is the same class
       of error as the CSV that read R0,00 for a group. */
    let sub = null;
    if (subId) {
      const { rows: [s] } = await db.query(
        `SELECT id, name, parent_investor_id FROM sub_accounts WHERE id = $1`, [subId]);
      if (!s) { refuse('No such sub-account.'); continue; }
      if (s.parent_investor_id !== investorId) {
        refuse('That sub-account does not belong to that client.'); continue;
      }
      sub = s;
    }

    const termMonths = Number(raw.termMonths ?? raw.term_months ?? p.term_months) || null;
    const endDate = raw.endDate || raw.end_date
      ? day(raw.endDate || raw.end_date)
      : (termMonths ? addMonths(startDate, termMonths) : null);
    if (endDate && endDate < startDate) { refuse('The maturity date is before the start date.'); continue; }

    /* Already there? Matched on what identifies a holding to a person reading
       a statement — who, which pool, how much, which day — so pressing Apply
       twice records it once. */
    const { rows: dupe } = await db.query(
      `SELECT id, status FROM investments
        WHERE investor_id = $1 AND pool_id = $2
          AND COALESCE(sub_account_id, '') = COALESCE($3, '')
          AND amount = $4 AND start_date = $5::date`,
      [investorId, poolId, subId, amount, startDate]);

    const settled = !!(endDate && endDate <= today);
    const rate = Number(raw.annualRate ?? raw.annual_rate ?? p.annual_rate) || 0;

    plan.push({
      where,
      investorId,
      name: [inv.first_name, inv.last_name].filter(Boolean).join(' ') || investorId,
      subAccountId: sub ? sub.id : null,
      subAccountName: sub ? sub.name : null,
      amount,
      startDate,
      endDate,
      termMonths,
      annualRate: rate,
      productType: raw.productType || raw.product_type || p.product_type || null,
      /* Contracted, not earned. */
      expectedReturn: endDate && termMonths ? r2(amount * rate * (termMonths / 12)) : 0,
      actualReturn: raw.actualReturn == null && raw.actual_return == null
        ? 0 : r2(raw.actualReturn ?? raw.actual_return),
      status: settled ? 'matured' : 'active',
      /* THE STAMP. Without it payoutCron pays this a second time. Dated to the
         maturity it actually had, not to now, so the row says when it was
         settled rather than when it was typed. */
      maturityProcessedAt: settled ? endDate : null,
      settled,
      ledgerRow: ledger,
      notes: raw.notes ? String(raw.notes).slice(0, 500) : null,
      alreadyRecorded: dupe.length ? dupe[0].id : null,
    });
  }

  const writing = plan.filter(x => !x.alreadyRecorded);
  return {
    pool: { id: p.id, name: p.name, productType: p.product_type, status: p.status,
            annualRate: Number(p.annual_rate) || 0, termMonths: p.term_months,
            maturityDate: p.maturity_date ? day(p.maturity_date) : null },
    today,
    ledger,
    plan,
    refusals,
    totals: {
      records: plan.length,
      willWrite: writing.length,
      alreadyRecorded: plan.filter(x => x.alreadyRecorded).length,
      refused: refusals.length,
      amount: r2(writing.reduce((s, x) => s + x.amount, 0)),
      settled: writing.filter(x => x.settled).length,
      active: writing.filter(x => !x.settled).length,
    },
    /* Said plainly, because it is the whole difference between this and the
       investment route, and somebody will press Apply without reading. */
    willNot: ['debit any wallet', 'charge a platform fee', 'email anybody',
              'require a signed agreement'],
  };
}

/* ── execute ──────────────────────────────────────────────────────────────
   Writes the plan survey() produced. One transaction: a half-recorded batch
   is worse than none, because the second run would then skip what it wrote.
   ──────────────────────────────────────────────────────────────────────── */
async function execute(db, opts = {}) {
  const plan  = (opts.survey && opts.survey.plan) || [];
  const pool  = opts.survey && opts.survey.pool;
  const actor = opts.actor || {};
  if (!pool) { const e = new Error('Run the preview first.'); e.status = 400; throw e; }

  const todo = plan.filter(x => !x.alreadyRecorded);
  if (!todo.length) { const e = new Error('There is nothing left to record.'); e.status = 400; throw e; }

  const written = [];
  await db.query('BEGIN');
  try {
    for (const x of todo) {
      const id = `HINV-${x.investorId}-${x.startDate.replace(/-/g, '')}-${
        Math.round(x.amount * 100)}${x.subAccountId ? '-' + x.subAccountId : ''}`.slice(0, 80);

      await db.query(
        `INSERT INTO investments
           (id, investor_id, sub_account_id, pool_id, amount, status,
            start_date, end_date, expected_return, actual_return, annual_rate,
            product_type, term_months, maturity_processed_at, notes,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14::date,$15,
                 $7::date, NOW())`,
        [id, x.investorId, x.subAccountId, pool.id, x.amount, x.status,
         x.startDate, x.endDate, x.expectedReturn, x.actualReturn, x.annualRate,
         x.productType, x.termMonths, x.maturityProcessedAt,
         x.notes || 'Recorded from history by staff']);

      /* created_at is the START DATE, not now. Several reports group by
         COALESCE(start_date, created_at), and a row stamped today would put a
         holding from last March into this month's new business. */

      /* The pool's own counters. The holding really existed, so the pool's
         raise really included it. Same expression the investment route uses,
         so a pool filled partly by hand and partly by clients adds up. */
      await db.query(
        `UPDATE investment_pools
            SET raised_amount    = COALESCE(raised_amount, 0) + $1,
                current_invested = COALESCE(current_invested, 0) + $1,
                investor_count   = (
                  SELECT COUNT(DISTINCT CASE WHEN sub_account_id IS NOT NULL
                                             THEN 'sa:' || sub_account_id
                                             ELSE 'inv:' || investor_id END)
                    FROM investments
                   WHERE pool_id = $2 AND status IN ('active','matured','paid_out')),
                updated_at = NOW()
          WHERE id = $2`, [x.amount, pool.id]);

      /* The matching ledger debit, when asked for. `investment` is a cash
         DEBIT, so this is what makes a wallet that already paid for the
         holding tie to its own history — and why it is OPTIONAL: where the
         debit is already on the ledger, writing a second one would make the
         account under-account by the amount all over again. The preview says
         which case the account is in. */
      if (x.ledgerRow) {
        await recordTransaction(db, {
          id: `TXN-${id}`,
          investorId: x.investorId,
          subAccountId: x.subAccountId,
          type: 'investment',
          amount: x.amount,
          status: 'completed',
          reference: `HIST-${id}`,
          description: `Investment — ${pool.name}`,
          investmentId: id,
          poolId: pool.id,
          transactionDate: x.startDate,
        }, { kind: 'staff', id: actor.id || null, email: actor.email || 'staff',
             role: actor.role || 'admin', ip: actor.ip || null },
        { onConflict: 'id' });
      }

      written.push({ id, investorId: x.investorId, amount: x.amount,
                     startDate: x.startDate, endDate: x.endDate, status: x.status });
    }

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }

  /* Outside the transaction: an audit write that fails must not undo the
     record, and every one of these is a staff member adding money to the
     books by hand, so each is logged by name. */
  for (const w of written) {
    await audit.log({
      actorId: actor.id || null, actorEmail: actor.email || 'staff',
      actorRole: actor.role || 'admin',
      action: 'investment.recorded_from_history',
      entityType: 'investment', entityId: w.id,
      description: `Recorded a historical investment of R${w.amount} for ${w.investorId} `
        + `in ${pool.name}, ${w.startDate} to ${w.endDate || 'no maturity'} (${w.status})`,
      after: w,
    }).catch(() => {});
  }

  return { written: written.length, investments: written, pool: pool.id };
}

module.exports = { survey, execute, _addMonths: addMonths };
