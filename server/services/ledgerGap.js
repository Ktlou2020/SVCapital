'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ledgerGap — why a wallet and its transaction history disagree, and by how
   much, decomposed by cause.

   A client asked: "There's a R33 237,71 opening balance discrepancy flagged on
   the statement. Can you please explain or correct this?" Nobody could, because
   accountStatement states the SIZE of the gap (`ledger_gap`) and not its cause.
   This names the causes.

   ── WHAT THE NUMBER IS ─────────────────────────────────────────────────

   accountStatement anchors the balances to the wallet and reports the derived
   opening beside them:

       ledger_gap = opening − derivedOpen
                  = (wallet − after_period − periodMovement) − before_period
                  = wallet − SUM(cashMovement over the WHOLE ledger)

   The period cancels. So the gap is one fact about the ACCOUNT, not about the
   dates on a statement: the wallet holds this much more than the history
   accounts for. Any period gives the same figure, which is itself worth
   knowing — it is not a date-range artefact, and a client who moves the dates
   to make it go away will not succeed.

   ── WHERE IT COMES FROM ────────────────────────────────────────────────

   A positive gap means the ledger UNDER-accounts, and three things do that:

     1. A reinvestment whose paired `matured_funds` credit was never written.
        The pair is a bookkeeping device — the matured money arrives and is
        spent in the same breath — so the debit alone leaves the ledger short
        by the whole amount, once per rollover, compounding on an account that
        has rolled over for years.

     2. A row recorded under a type that carries no cash effect. `return` is
        deliberately one of those (an accrual is not cash), so such a row is a
        cause only where that money really did reach the wallet. Reported by
        type, never assumed: calling a genuine accrual cash invents money.

     3. The wallet moved with no row written at all. Nothing here can name
        those, so whatever 1 and 2 do not explain is reported as UNEXPLAINED
        rather than folded into them.

   ── WHY THIS IS A SERVICE AND NOT A SCRIPT ─────────────────────────────

   It began as scripts/explain-ledger-gap.cjs, which needed a DATABASE_URL and
   therefore a person at a terminal with production credentials — so the answer
   to "why does this client's statement not tie?" was gated on whoever had
   those. The arithmetic now lives here and the script and
   GET /api/admin/ledger-gap both read it, so a figure quoted to a client from
   the console and one from a terminal cannot disagree.

   READ-ONLY. Nothing here writes, ever. Each remedy is a separate, deliberate
   step named against the part of the gap it would close.
   ───────────────────────────────────────────────────────────────────────────── */

const { cashMovementSQL } = require('./ledger');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* The gap, per investor, exactly as accountStatement derives it: the wallet
   less the cash effect of every completed row, through the one shared
   definition rather than a copy of it. */
const GAPS = `
  SELECT i.id, i.first_name, i.last_name, i.email,
         COALESCE(i.wallet_balance, 0)                          AS wallet,
         COALESCE(t.derived, 0)                                 AS derived,
         COALESCE(i.wallet_balance, 0) - COALESCE(t.derived, 0) AS gap
    FROM investors i
    LEFT JOIN (
      SELECT investor_id, SUM(${cashMovementSQL()}) AS derived
        FROM transactions
       WHERE status = 'completed' AND investor_id IS NOT NULL
       GROUP BY investor_id
    ) t ON t.investor_id = i.id
   WHERE ($1::text IS NULL OR i.id = $1::text)
   ORDER BY ABS(COALESCE(i.wallet_balance, 0) - COALESCE(t.derived, 0)) DESC`;

/* Cause 1. A reinvestment with no paired matured_funds credit.

   Paired on the reference POST /api/admin/backfill-matured-funds pairs on, so
   what this attributes is exactly what that repair would write — a figure that
   says "this much of the gap closes if you run it" rather than a resemblance. */
const UNPAIRED = `
  SELECT t.id, t.reference, ABS(t.amount) AS amount,
         COALESCE(t.transaction_date, t.created_at) AS at
    FROM transactions t
   WHERE t.investor_id = $1
     AND t.status = 'completed'
     AND t.type = 'reinvestment'
     AND t.reference LIKE 'REINV-%'
     AND NOT EXISTS (
       SELECT 1 FROM transactions t2
        WHERE t2.reference = 'MATF-' || REPLACE(t.reference, 'REINV-', ''))
   ORDER BY COALESCE(t.transaction_date, t.created_at)`;

/* A reinvestment the backfill CANNOT pair, because its reference is not in the
   shape that repair matches on. Named separately: counting it under cause 1
   would promise a repair that will not touch it. */
const UNPAIRABLE = `
  SELECT t.id, t.type, t.reference, ABS(t.amount) AS amount,
         COALESCE(t.transaction_date, t.created_at) AS at
    FROM transactions t
   WHERE t.investor_id = $1
     AND t.status = 'completed'
     AND t.type = 'reinvestment'
     AND (t.reference IS NULL OR t.reference NOT LIKE 'REINV-%')
   ORDER BY COALESCE(t.transaction_date, t.created_at)`;

/* Cause 2. Rows carrying no cash effect, by type. Reported, not assumed. */
const NOCASH = `
  SELECT t.type, COUNT(*)::int AS n, SUM(ABS(t.amount)) AS total
    FROM transactions t
   WHERE t.investor_id = $1
     AND t.status = 'completed'
     AND (${cashMovementSQL('t.')}) = 0
   GROUP BY t.type
   ORDER BY SUM(ABS(t.amount)) DESC`;

/* The ledger either side of the gap, so somebody reading the explanation can
   see the rows it is about without opening a second screen. Newest first and
   capped: this is context, not a statement. */
const RECENT = `
  SELECT t.id, t.type, t.amount, t.reference, t.description,
         COALESCE(t.transaction_date, t.created_at) AS at,
         (${cashMovementSQL('t.')}) AS cash
    FROM transactions t
   WHERE t.investor_id = $1 AND t.status = 'completed'
   ORDER BY COALESCE(t.transaction_date, t.created_at) DESC, t.created_at DESC
   LIMIT $2`;

/* ── explain ──────────────────────────────────────────────────────────────
   db           a pool or a client
   investorId   one account, or null for every account over the threshold
   min          the smallest gap worth reporting, in rand
   recent       how many recent rows to carry as context (0 for none)

   Returns { scope, threshold, accounts: [ … ] }. An account carries its own
   arithmetic rather than a rendered sentence, so the console, the script and a
   check all read the same numbers.
   ──────────────────────────────────────────────────────────────────────── */
async function explain(db, opts = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('ledgerGap.explain needs a pool or client');
  }
  const investorId = opts.investorId || null;
  /* Half a cent. Rounding in NUMERIC(18,2) cannot produce a gap smaller than
     this, so anything below it is noise rather than a finding. */
  const min    = Number.isFinite(Number(opts.min)) && Number(opts.min) > 0
    ? Number(opts.min) : 0.005;
  const recent = Number.isFinite(Number(opts.recent)) ? Math.max(0, Math.min(200, Number(opts.recent))) : 0;

  const { rows: all } = await db.query(GAPS, [investorId]);

  /* An id that matches nobody is not "every account ties" — it is a question
     that was never asked. The caller is told which it was. */
  if (investorId && !all.length) {
    return { scope: investorId, threshold: min, found: false, accounts: [] };
  }

  const affected = all.filter(r => Math.abs(Number(r.gap)) >= min);
  const accounts = [];

  for (const a of affected) {
    /* SEQUENTIAL, deliberately. `db` is a pool OR a client already inside a
       transaction — the route passes a client, because the whole report has to
       be READ ONLY and a pool cannot be. A single pg client cannot run queries
       concurrently: Promise.all over one raises pg's "client is already
       executing a query" deprecation today and fails outright in pg@9. The
       four round trips per affected account are not worth that. */
    const { rows: unpaired }   = await db.query(UNPAIRED,   [a.id]);
    const { rows: unpairable } = await db.query(UNPAIRABLE, [a.id]);
    const { rows: nocash }     = await db.query(NOCASH,     [a.id]);
    const rec = recent ? await db.query(RECENT, [a.id, recent]) : { rows: [] };

    const gap           = r2(a.gap);
    const unpairedTotal = r2(unpaired.reduce((s, r) => s + Number(r.amount), 0));

    accounts.push({
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.id,
      email: a.email || null,
      wallet:  r2(a.wallet),
      derived: r2(a.derived),
      gap,
      /* A positive gap means the ledger under-accounts: the wallet holds more
         than the history explains, so rows are MISSING. A negative gap means
         the opposite, and the remedy is the opposite too — stated rather than
         left for the reader to work out from a sign. */
      direction: gap > 0 ? 'ledger-under-accounts' : 'ledger-over-accounts',
      causes: {
        unpairedReinvestments: {
          count: unpaired.length,
          total: unpairedTotal,
          rows: unpaired.map(r => ({
            id: r.id, reference: r.reference,
            amount: r2(r.amount), at: _day(r.at),
          })),
          remedy: 'POST /api/admin/backfill-matured-funds — {"dry_run":true} first',
        },
        unpairableReinvestments: {
          count: unpairable.length,
          total: r2(unpairable.reduce((s, r) => s + Number(r.amount), 0)),
          rows: unpairable.map(r => ({
            id: r.id, reference: r.reference || null,
            amount: r2(r.amount), at: _day(r.at),
          })),
          remedy: 'By hand — the reference is not in the shape that repair matches on',
        },
        noCashEffect: {
          total: r2(nocash.reduce((s, r) => s + Number(r.total), 0)),
          byType: nocash.map(r => ({ type: r.type, n: r.n, total: r2(r.total) })),
          /* Deliberately not counted as explained. */
          counted: false,
        },
      },
      /* Only cause 1 is arithmetic. Everything else is a candidate, so the
         remainder is stated against cause 1 alone — overstating what is
         explained is how a reconciliation stops being one. */
      accountedFor: unpairedTotal,
      unexplained:  r2(gap - unpairedTotal),
      recent: rec.rows.map(r => ({
        id: r.id, type: r.type, amount: r2(r.amount),
        reference: r.reference || null, description: r.description || null,
        at: _day(r.at), cash: r2(r.cash),
      })),
    });
  }

  return {
    scope: investorId || 'all',
    threshold: min,
    found: true,
    scanned: all.length,
    accounts,
  };
}

const _day = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

module.exports = { explain, _sql: { GAPS, UNPAIRED, UNPAIRABLE, NOCASH, RECENT } };
