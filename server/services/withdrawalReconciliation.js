'use strict';
/* Who was charged twice for one withdrawal.
 *
 * The wallet is debited when a withdrawal REQUEST is created (withdrawals.js),
 * which is why tables.js refunds it when one is rejected. The admin console's
 * approveWithdrawal deducted it a SECOND time — it PATCHed the transaction to
 * completed, which the server correctly treats as a no-op for the balance, and
 * then PATCHed investors.wallet_balance to max(0, its own stale copy - amount).
 * Fixed; this finds who it happened to.
 *
 * That second write left no transaction row, so the ledger cannot see it. The
 * audit log can: every PATCH through the table API records an
 * `investors.updated` whose metadata->'after' is the request body, so the
 * offending write appears as an `investors.updated` carrying a wallet_balance.
 *
 * The signature is unambiguous. The one legitimate absolute wallet write on the
 * platform — the admin's deliberate, confirmed override — goes through
 * /api/admin/override-wallet and logs `wallet.balance_override`. Nothing else
 * writes investors.wallet_balance through the generic table API.
 *
 * SELECT only. It is called from a CLI report and from the ops console, and
 * lives here so those two can never drift: a money report with two
 * implementations is a money report you cannot quote.
 */

/* The console wrote max(0, stale - amount), so the extra debit is
   min(amount, wallet at that moment):

     written > 0   nothing was clamped, so the extra debit is EXACTLY the
                   withdrawal amount and can be refunded as stated
     written = 0   the clamp may have absorbed part of it, so the extra debit
                   is AT MOST the amount and needs a person to settle

   The two are never summed. */
const isClamped = row => Number(row.written) === 0;

const PAIRED = `
  WITH wallet_writes AS (
    SELECT a.id, a.entity_id AS investor_id, a.user_email, a.actor_role, a.created_at,
           (a.metadata->'after'->>'wallet_balance')::numeric AS written
      FROM audit_events a
     WHERE a.event_type = 'investors.updated'
       AND a.metadata->'after' ? 'wallet_balance'
       AND ($1::date IS NULL OR a.created_at >= $1::date)
       AND ($2::date IS NULL OR a.created_at < $2::date + INTERVAL '1 day')
       AND ($3::text IS NULL OR a.entity_id = $3::text)
  ),
  txn_completions AS (
    SELECT a.entity_id AS txn_id, a.user_email, a.created_at,
           t.investor_id, t.type, t.reference, t.sub_account_id,
           ABS(COALESCE(t.amount, 0)) AS amount
      FROM audit_events a
      JOIN transactions t ON t.id = a.entity_id
     WHERE a.event_type = 'transactions.updated'
       AND a.metadata->'after'->>'status' = 'completed'
  )
  SELECT w.id AS audit_id, w.investor_id, w.user_email, w.actor_role,
         w.created_at, w.written,
         c.txn_id, c.type, c.amount, c.reference, c.sub_account_id,
         i.first_name, i.last_name, i.email, i.wallet_balance AS wallet_now
    FROM wallet_writes w
    LEFT JOIN LATERAL (
      SELECT * FROM txn_completions t
       WHERE t.investor_id = w.investor_id
         AND COALESCE(t.user_email, '') = COALESCE(w.user_email, '')
         AND t.created_at <= w.created_at
         AND t.created_at > w.created_at - ($4 || ' seconds')::interval
       ORDER BY t.created_at DESC
       LIMIT 1
    ) c ON TRUE
    LEFT JOIN investors i ON i.id = w.investor_id
   ORDER BY w.created_at ASC`;

/* Approved withdrawals with NO wallet write recorded against them. The audit
   insert is fire-and-forget, so a missing row is missing evidence rather than a
   clean approval — this is what turns the totals into a floor. */
const UNWITNESSED = `
  SELECT COUNT(*)::int AS n
    FROM audit_events a
    JOIN transactions t ON t.id = a.entity_id
   WHERE a.event_type = 'transactions.updated'
     AND a.metadata->'after'->>'status' = 'completed'
     AND t.type = 'withdrawal'
     AND ($1::date IS NULL OR a.created_at >= $1::date)
     AND ($2::date IS NULL OR a.created_at < $2::date + INTERVAL '1 day')
     AND ($3::text IS NULL OR t.investor_id = $3::text)
     AND NOT EXISTS (
       SELECT 1 FROM audit_events w
        WHERE w.event_type = 'investors.updated'
          AND w.metadata->'after' ? 'wallet_balance'
          AND w.entity_id = t.investor_id
          AND w.created_at BETWEEN a.created_at AND a.created_at + ($4 || ' seconds')::interval
     )`;

const num = v => Number(v || 0);
const nameOf = r => `${r.first_name || ''} ${r.last_name || ''}`.trim() || null;

async function runWithdrawalReconciliation(db, opts = {}) {
  const since    = opts.since    || null;
  const until    = opts.until    || null;
  const investor = opts.investor || null;
  const windowS  = Math.max(1, Math.min(86400, parseInt(opts.window, 10) || 30));
  const params   = [since, until, investor, String(windowS)];

  const { rows: [cover] } = await db.query(
    `SELECT MIN(created_at) AS first, MAX(created_at) AS last, COUNT(*)::int AS n FROM audit_events`);

  if (!cover.n) {
    return {
      verdict: 'no-evidence',
      coverage: { first: null, last: null, events: 0 },
      window: windowS, scope: { since, until, investor },
      doubleDebits: [], byInvestor: [], deposits: [], other: [],
      totals: { owed: 0, needsReview: 0, exactCount: 0, cappedCount: 0,
                subAccountCount: 0, subAccountTotal: 0 },
      unpaired: 0, approvedWithoutWrite: 0,
    };
  }

  const { rows } = await db.query(PAIRED, params);
  const { rows: [gap] } = await db.query(UNWITNESSED, params);

  const shape = r => ({
    investorId: r.investor_id,
    name:       nameOf(r),
    email:      r.email || null,
    txnId:      r.txn_id || null,
    reference:  r.reference || null,
    subAccountId: r.sub_account_id || null,
    amount:     r.amount == null ? null : num(r.amount),
    written:    r.written == null ? null : num(r.written),
    clamped:    isClamped(r),
    when:       r.created_at,
    walletNow:  r.wallet_now == null ? null : num(r.wallet_now),
    actor:      r.user_email || null,
    actorRole:  r.actor_role || null,
  });

  const all      = rows.map(shape);
  const withType = (t) => rows.filter(r => r.type === t).map(shape);
  const doubleDebits = withType('withdrawal');
  const deposits     = withType('deposit');
  const other        = rows.filter(r => r.type && r.type !== 'withdrawal' && r.type !== 'deposit').map(shape);
  const unpaired     = rows.filter(r => !r.type).length;

  const byInvestor = [];
  for (const d of doubleDebits) {
    let e = byInvestor.find(x => x.investorId === d.investorId);
    if (!e) { e = { investorId: d.investorId, name: d.name, email: d.email, owed: 0, needsReview: 0, n: 0 }; byInvestor.push(e); }
    e.n++;
    if (d.clamped) e.needsReview += d.amount || 0;
    else           e.owed        += d.amount || 0;
  }
  byInvestor.sort((a, b) => (b.owed + b.needsReview) - (a.owed + a.needsReview));

  const round2 = n => Math.round(n * 100) / 100;
  const subAccount = deposits.filter(d => d.subAccountId);

  return {
    verdict: doubleDebits.length ? 'found' : 'clean',
    coverage: { first: cover.first, last: cover.last, events: cover.n },
    window: windowS,
    scope: { since, until, investor },
    doubleDebits, deposits, other, byInvestor,
    totals: {
      owed:        round2(doubleDebits.filter(d => !d.clamped).reduce((s, d) => s + (d.amount || 0), 0)),
      needsReview: round2(doubleDebits.filter(d =>  d.clamped).reduce((s, d) => s + (d.amount || 0), 0)),
      exactCount:  doubleDebits.filter(d => !d.clamped).length,
      cappedCount: doubleDebits.filter(d =>  d.clamped).length,
      subAccountCount: subAccount.length,
      subAccountTotal: round2(subAccount.reduce((s, d) => s + (d.amount || 0), 0)),
    },
    unpaired,
    approvedWithoutWrite: gap.n,
    rowCount: all.length,
  };
}

module.exports = { runWithdrawalReconciliation };
