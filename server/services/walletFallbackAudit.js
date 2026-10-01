'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Maturities that fell through to a wallet because no pool matched.

   reinvestAmount picks the pool to roll into on product_type and nothing
   else. An investment carrying 'other' — a value no pool uses, left on rows
   that came in through the migration — matches nothing, so the money is
   credited to the investor's wallet under reference MAT-FALLBACK-<id>.

   The question that cannot be answered from the maturity CSV is whether the
   wallet STILL holds it. A client who has since spent or withdrawn cannot be
   rolled over without going negative, and that is the figure that decides
   whether a correction runs in one pass or needs a second decision.

   One module so the console panel and the CLI audit cannot describe the same
   money differently — the same reason maturityPreflight is shared.

   READ-ONLY. Every statement here is a SELECT.
   ═══════════════════════════════════════════════════════════════════ */

/* Which instructions meant "put this back into a pool of the SAME product".

   A MAT-FALLBACK credit is never the whole maturity. The engine pays out
   whatever the client asked to take in cash FIRST, and only the portion it
   then tried to reinvest can fall through to the wallet. So the amount on
   one of these rows is, by construction, money that was meant to reach a
   pool — including for the instructions that sound like a payout:

     payout_return   reinvestAmount(principal,      inv.product_type)
     payout_custom   reinvestAmount(gross - custom, inv.product_type)

   Both route to the investment's OWN product type, so reinvesting that
   amount completes the instruction rather than overruling it. Roderick
   Harris asked for his R221.47 return in cash and got it; the R9,931.22 of
   capital he asked to keep invested is what fell through.

   The switches are the exception, and the only real one:

     switch_product  reinvestAmount(gross,          switchType)
     custom_switch   reinvestAmount(gross - custom, switchType)

   Those name a DIFFERENT product, so the pool they belong in is not the one
   this product's money goes to. They are kept apart for that reason alone.

   investments.payout_option is deliberately NOT consulted anywhere: it
   carries a column DEFAULT of 'reinvest' and would report every row as a
   reinvest, which is how this question gets answered wrongly. */
const SAME_PRODUCT = new Set(['reinvest', 'auto_reinvest', '', 'pending',
                              'payout_return', 'payout_custom']);

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function runWalletFallbackAudit(db, opts = {}) {
  const since  = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.since || '')) ? opts.since : null;
  const poolId = opts.poolId ? String(opts.poolId) : null;

  const params = [];
  const where  = [`t.reference LIKE 'MAT-FALLBACK-%'`];
  if (since)  { params.push(since);  where.push(`COALESCE(t.transaction_date, t.created_at) >= $${params.length}::date`); }
  if (poolId) { params.push(poolId); where.push(`i.pool_id = $${params.length}`); }

  const { rows } = await db.query(`
    SELECT t.id AS txn_id, t.reference, t.amount,
           COALESCE(t.transaction_date, t.created_at) AS paid_at,
           t.sub_account_id,
           i.id   AS investment_id,
           i.investor_id,
           i.product_type AS investment_product_type,
           COALESCE(NULLIF(TRIM(i.maturity_instruction), ''), '') AS instruction,
           i.pool_id, i.pool_name,
           p.name AS pool_name_now, p.product_type AS pool_product_type,
           inv.first_name, inv.last_name, inv.email,
           inv.wallet_balance AS investor_wallet,
           sa.wallet_balance  AS sub_wallet, sa.name AS sub_name,
           EXISTS (SELECT 1 FROM transactions d
                    WHERE d.reference = 'REINV-FIX-' || i.id) AS already_corrected
      FROM transactions t
      JOIN investments       i   ON i.id  = t.investment_id
      LEFT JOIN investment_pools p ON p.id = i.pool_id
      LEFT JOIN investors    inv ON inv.id = i.investor_id
      LEFT JOIN sub_accounts sa  ON sa.id  = t.sub_account_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.amount DESC`, params);

  /* The pool each product type would roll into today — the same lookup the
     engine makes, so a correction gets a target it derived. */
  const { rows: targets } = await db.query(`
    SELECT DISTINCT ON (product_type)
           product_type, id, name, end_date, status, current_invested, max_investment
      FROM investment_pools
     WHERE status = 'open'
       AND (end_date IS NULL OR end_date >= (now() AT TIME ZONE 'Africa/Johannesburg')::date)
       AND (max_investment IS NULL OR COALESCE(current_invested,0) < max_investment)
     ORDER BY product_type, end_date ASC NULLS LAST, created_at ASC`);

  /* One entry per account, because the wallet is per account and an investor
     with two fallback credits has to cover both to be movable. */
  const accounts = new Map();
  for (const r of rows) {
    const key = r.sub_account_id ? `sa:${r.sub_account_id}` : `inv:${r.investor_id}`;
    const bal = r2(r.sub_account_id ? r.sub_wallet : r.investor_wallet);
    const a = accounts.get(key) || {
      key, investor_id: r.investor_id, sub_account_id: r.sub_account_id || null,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.investor_id,
      email: r.email || null, sub_name: r.sub_name || null,
      balance: bal, owed: 0, movable: 0, n: 0,
    };
    a.owed += r2(r.amount); a.n++;
    accounts.set(key, a);
  }
  for (const a of accounts.values()) {
    a.owed = r2(a.owed);
    a.holds = a.balance + 0.005 >= a.owed;
    a.shortfall = a.holds ? 0 : r2(a.owed - a.balance);
  }

  const items = rows.map(r => {
    const key = r.sub_account_id ? `sa:${r.sub_account_id}` : `inv:${r.investor_id}`;
    const acc = accounts.get(key);
    return {
      investment_id: r.investment_id, investor_id: r.investor_id,
      name: acc.name, email: r.email || null,
      sub_account_id: r.sub_account_id || null, sub_name: r.sub_name || null,
      pool_id: r.pool_id, pool_name: r.pool_name_now || r.pool_name,
      pool_product_type: r.pool_product_type || null,
      investment_product_type: r.investment_product_type || null,
      instruction: r.instruction,
      same_product: SAME_PRODUCT.has(r.instruction),
      amount: r2(r.amount),
      paid_at: r.paid_at,
      wallet_balance: acc.balance,
      wallet_holds_it: acc.holds,
      already_corrected: !!r.already_corrected,
    };
  });

  const sum = xs => r2(xs.reduce((a, x) => a + x.amount, 0));
  const outstanding  = items.filter(i => !i.already_corrected);
  const sameProduct  = outstanding.filter(i => i.same_product);
  const otherProduct = outstanding.filter(i => !i.same_product);
  const movable      = sameProduct.filter(i => i.wallet_holds_it);
  const blocked      = sameProduct.filter(i => !i.wallet_holds_it);

  const byType = {};
  for (const i of outstanding) {
    const k = i.investment_product_type || '(none)';
    (byType[k] = byType[k] || { count: 0, total: 0 }).count++;
    byType[k].total = r2(byType[k].total + i.amount);
  }
  const byPool = {};
  for (const i of outstanding) {
    const k = i.pool_id || '(none)';
    const b = byPool[k] = byPool[k] || { pool_id: i.pool_id, pool_name: i.pool_name, count: 0, total: 0 };
    b.count++; b.total = r2(b.total + i.amount);
  }

  return {
    generatedAt: new Date().toISOString(),
    filters: { since, poolId },
    summary: {
      credits: items.length,
      total: sum(items),
      alreadyCorrected: items.filter(i => i.already_corrected).length,
      outstanding: outstanding.length,
      outstandingTotal: sum(outstanding),
      sameProduct: sameProduct.length,
      sameProductTotal: sum(sameProduct),
      movable: movable.length,
      movableTotal: sum(movable),
      blocked: blocked.length,
      blockedTotal: sum(blocked),
      otherProduct: otherProduct.length,
      otherProductTotal: sum(otherProduct),
      accounts: accounts.size,
    },
    byProductType: byType,
    byPool: Object.values(byPool).sort((a, b) => b.total - a.total),
    rolloverTargets: targets.map(t => ({
      product_type: t.product_type, id: t.id, name: t.name,
      end_date: t.end_date, current_invested: t.current_invested, max_investment: t.max_investment,
    })),
    blockedAccounts: [...accounts.values()].filter(a => !a.holds)
      .sort((a, b) => b.shortfall - a.shortfall),
    items,
  };
}

module.exports = { runWalletFallbackAudit, SAME_PRODUCT };
