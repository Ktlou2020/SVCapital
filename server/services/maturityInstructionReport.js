/* ═══════════════════════════════════════════════════════════
   Pool maturity instruction report — where a maturing pool's money goes.

   One pool, every investment in it, each client's maturity instruction, and
   the split that instruction produces: how much reaches the wallet as cash,
   how much is reinvested, and into WHICH pool.

   The last part is the reason this is a service and not a GROUP BY. An
   instruction does not name a destination — it names a product type, and the
   pool that type lands in is chosen at 23:00 by resolveRolloverTarget: the
   open pool of that product closing soonest with room left. "Switched to
   short_term" is not an answer anyone can act on; "switched into Short Term
   Investment - October 2026, closing 31 Oct" is.

   ── The allocation mirrors maturityCron's switch statement ──────────────
   Deliberately, line for line. This report is read before the money moves and
   is the basis on which someone decides to let it. A report that computes the
   split its own way is a second implementation of the payout rules, and the
   day the two disagree is the day it does damage rather than none — so any
   change to that switch belongs here in the same commit, and
   check-pool-maturity-report holds the two together.

   ── The return is the POSTED return ────────────────────────────────────
   postedReturn, imported rather than restated: the amount on the investment
   if there is one, otherwise capital x the pool's posted actual_rate,
   otherwise NULL. maturityCron never writes actual_return back to the
   investment, so for real data the pool's rate is the only source there is.

   NULL matters here. The engine HOLDS BACK an investment whose return is not
   posted — it is skipped and retried the next night — so those rows are not
   part of tonight's allocation at all, and the report says so rather than
   quietly totalling them at their capital.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const { postedReturn, resolveRolloverTarget } = require('./maturityPreflight');

const num    = v => parseFloat(v) || 0;
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* The label a client's choice carries on the report.

   A blank instruction is not a missing answer to be chased; it is the default
   the platform applies, and maturityCron reads it as 'reinvest'. Tagging it
   auto_reinvest says which money moved by choice and which moved by default —
   the two look identical in a total and are very different in a conversation
   with a client. */
const AUTO_REINVEST = 'auto_reinvest';

const INSTRUCTION_LABELS = {
  auto_reinvest:  'Auto-reinvest (no instruction given)',
  reinvest:       'Reinvest',
  payout_all:     'Pay out in full',
  payout_return:  'Pay out the return, reinvest the capital',
  payout_custom:  'Pay out a set amount, reinvest the rest',
  custom_switch:  'Pay out a set amount, switch the rest',
  switch_amount:  'Switch a set amount, reinvest the rest',
  switch_product: 'Switch in full to another product',
};

const label = k => INSTRUCTION_LABELS[k] || k;

/* ── The split ──────────────────────────────────────────────────────────
   Returns { toWallet, legs: [{ amount, productType, isSwitch }] }, mirroring
   the switch in maturityCron.runMaturityProcessing. */
function allocate({ instruction, principal, actualReturn, custom, switchType, ownType }) {
  const gross = round2(principal + actualReturn);
  const c     = Math.max(0, Math.min(gross, round2(custom)));

  switch (instruction) {
    case 'payout_all':
      return { toWallet: gross, legs: [] };

    case 'payout_return':
      return { toWallet: round2(actualReturn),
               legs: [{ amount: round2(principal), productType: ownType, isSwitch: false }] };

    case 'payout_custom':
      return { toWallet: c,
               legs: [{ amount: round2(gross - c), productType: ownType, isSwitch: false }] };

    case 'custom_switch':
      return { toWallet: c,
               legs: [{ amount: round2(gross - c), productType: switchType, isSwitch: true }] };

    /* The only instruction that puts a named amount into a PRODUCT rather than
       the wallet, and the only one with two destinations. */
    case 'switch_amount':
      return { toWallet: 0, legs: [
        { amount: c,                     productType: switchType, isSwitch: true },
        { amount: round2(gross - c),     productType: ownType,    isSwitch: false },
      ] };

    case 'switch_product':
      return { toWallet: 0, legs: [{ amount: gross, productType: switchType, isSwitch: true }] };

    case 'reinvest':
    default:
      return { toWallet: 0, legs: [{ amount: gross, productType: ownType, isSwitch: false }] };
  }
}

/* Build the report for one pool. READ ONLY — every statement is a SELECT. */
async function buildMaturityReport(db, poolId) {
  const { rows: pools } = await db.query(
    `SELECT id, name, product_type, status, actual_rate, annual_rate, term_months,
            start_date, end_date, maturity_date, current_invested, investor_count
       FROM investment_pools WHERE id = $1`, [poolId]);
  if (!pools.length) return { error: 'not_found' };
  const pool = pools[0];

  /* Sub-account holdings belong to the sub-account, not the parent, so the
     name shown is the one whose money it is. */
  const { rows: invs } = await db.query(`
    SELECT i.id, i.investor_id, i.sub_account_id, i.amount, i.status,
           i.actual_return, i.expected_return, i.product_type, i.end_date,
           i.maturity_instruction, i.custom_payout_amount, i.switch_product_type,
           i.maturity_processed_at,
           p.actual_rate AS pool_actual_rate,
           COALESCE(sa.name, TRIM(CONCAT(inv.first_name, ' ', inv.last_name))) AS holder_name,
           COALESCE(sa.id, inv.id) AS holder_id,
           sa.id IS NOT NULL AS is_sub_account
      FROM investments i
      LEFT JOIN investment_pools p ON p.id = i.pool_id
      LEFT JOIN investors    inv   ON inv.id = i.investor_id
      LEFT JOIN sub_accounts sa    ON sa.id = i.sub_account_id
     WHERE i.pool_id = $1
       AND i.status IN ('active', 'matured', 'paid_out')
     ORDER BY holder_name NULLS LAST, i.id`, [poolId]);

  /* Destinations, resolved once per product type. The same query the payout
     engine runs, so the pool named here is the pool the money reaches. */
  const targets = new Map();
  const targetFor = async type => {
    const key = String(type || '');
    if (!targets.has(key)) targets.set(key, await resolveRolloverTarget(db, key));
    return targets.get(key);
  };

  const rows = [], heldBack = [];
  for (const i of invs) {
    const principal = num(i.amount);
    const ret = postedReturn({
      amount: i.amount, actualReturn: i.actual_return, poolActualRate: i.pool_actual_rate });

    /* What the client chose, and what the engine will do with it. They differ
       for exactly one case, and it is not cosmetic: a delivery-bike holding
       left on reinvest is paid OUT. Reporting the tag alone would put that
       money in the reinvest column and understate the cash leaving. */
    const raw  = String(i.maturity_instruction || '').trim();
    const tag  = raw === '' ? AUTO_REINVEST : raw;
    const asEngine = raw === '' ? 'reinvest' : raw;
    const effective = (asEngine === 'reinvest' && String(i.product_type || '').includes('delivery_bike'))
      ? 'payout_all' : asEngine;

    if (ret === null) {
      /* The engine skips these and retries the next night. They are not part
         of tonight's allocation, and totalling them at capital alone would
         report money as destined somewhere it is not yet going. */
      heldBack.push({
        investmentId: i.id, holderId: i.holder_id, holderName: i.holder_name,
        isSubAccount: i.is_sub_account === true,
        principal: round2(principal), instruction: tag, instructionLabel: label(tag),
        reason: 'No return posted — the pool has no actual_rate, so this investment is held back.',
      });
      continue;
    }

    const gross = round2(principal + ret);
    const { toWallet, legs } = allocate({
      instruction: effective, principal, actualReturn: ret,
      custom: i.custom_payout_amount, switchType: i.switch_product_type || i.product_type,
      ownType: i.product_type,
    });

    const resolvedLegs = [];
    for (const leg of legs) {
      if (leg.amount <= 0) continue;
      const t = await targetFor(leg.productType);
      resolvedLegs.push({
        amount: leg.amount, productType: leg.productType, isSwitch: leg.isSwitch,
        /* No open pool of that product means reinvestAmount pays the amount to
           the wallet instead, with a description saying why. A report that
           still called it a switch would name a destination the money never
           reaches. */
        destinationPoolId:   t ? t.id : null,
        destinationPoolName: t ? t.name : null,
        destinationEndDate:  t ? t.end_date : null,
        fallsBackToWallet:   !t,
      });
    }

    rows.push({
      investmentId: i.id, holderId: i.holder_id, holderName: i.holder_name,
      isSubAccount: i.is_sub_account === true,
      principal: round2(principal), actualReturn: round2(ret), gross,
      instruction: tag, instructionLabel: label(tag),
      /* Present only when the engine will not do what the tag says. */
      effectiveInstruction: effective !== asEngine ? effective : null,
      customAmount: num(i.custom_payout_amount) > 0 ? round2(num(i.custom_payout_amount)) : null,
      switchProductType: i.switch_product_type || null,
      /* Three figures, and the distinction between them is the point.

         `instructedToWallet` is what the instruction says to pay out.
         `fallbackToWallet` is money the instruction sends to a product that
         has no open pool — reinvestAmount pays that to the wallet instead.
         `toWallet` is what actually reaches the wallet, and `reinvested` is
         what actually reaches a pool.

         An earlier version totalled the legs as "reinvested" regardless, and
         put the fallback in a separate cashOut figure. The summary cards then
         used one and the table totals the other, and the same page reported
         R375 000 of cash in one place and R270 000 in another. Where the money
         goes is the whole question this report answers; it cannot have two
         answers. */
      instructedToWallet: round2(toWallet),
      fallbackToWallet: round2(resolvedLegs.filter(l => l.fallsBackToWallet)
                                           .reduce((s, l) => s + l.amount, 0)),
      toWallet: round2(toWallet + resolvedLegs.filter(l => l.fallsBackToWallet)
                                              .reduce((s, l) => s + l.amount, 0)),
      reinvested: round2(resolvedLegs.filter(l => !l.fallsBackToWallet)
                                     .reduce((s, l) => s + l.amount, 0)),
      legs: resolvedLegs,
      processed: i.maturity_processed_at != null,
    });
  }

  /* ── Grouped by the instruction as tagged ───────────────────────────── */
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.instruction)) {
      groups.set(r.instruction, {
        instruction: r.instruction, label: r.instructionLabel,
        count: 0, principal: 0, actualReturn: 0, gross: 0,
        toWallet: 0, reinvested: 0, fallbackToWallet: 0, destinations: new Map(),
      });
    }
    const g = groups.get(r.instruction);
    g.count++;
    g.principal    = round2(g.principal + r.principal);
    g.actualReturn = round2(g.actualReturn + r.actualReturn);
    g.gross        = round2(g.gross + r.gross);
    g.toWallet     = round2(g.toWallet + r.toWallet);
    g.reinvested   = round2(g.reinvested + r.reinvested);
    g.fallbackToWallet = round2(g.fallbackToWallet + r.fallbackToWallet);
    for (const leg of r.legs) {
      const key = leg.destinationPoolId || `wallet:${leg.productType}`;
      if (!g.destinations.has(key)) {
        g.destinations.set(key, {
          poolId: leg.destinationPoolId, poolName: leg.destinationPoolName,
          endDate: leg.destinationEndDate, productType: leg.productType,
          isSwitch: leg.isSwitch, fallsBackToWallet: leg.fallsBackToWallet,
          count: 0, amount: 0,
        });
      }
      const d = g.destinations.get(key);
      d.count++;
      d.amount = round2(d.amount + leg.amount);
      /* A destination reached by both a switch and a plain reinvest is a
         switch destination for at least someone. */
      if (leg.isSwitch) d.isSwitch = true;
    }
  }

  /* Largest allocation first: the report is read to answer "where is most of
     this money going", and alphabetical order answers a question nobody asked. */
  const byInstruction = [...groups.values()]
    .map(g => ({ ...g, destinations: [...g.destinations.values()].sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => b.gross - a.gross);

  /* Every destination across every instruction, which is the other question
     asked of this report: what is each open pool about to receive? */
  const destTotals = new Map();
  for (const r of rows) {
    for (const leg of r.legs) {
      const key = leg.destinationPoolId || `wallet:${leg.productType}`;
      if (!destTotals.has(key)) {
        destTotals.set(key, {
          poolId: leg.destinationPoolId, poolName: leg.destinationPoolName,
          endDate: leg.destinationEndDate, productType: leg.productType,
          fallsBackToWallet: leg.fallsBackToWallet, count: 0, amount: 0, switchedIn: 0,
        });
      }
      const d = destTotals.get(key);
      d.count++;
      d.amount = round2(d.amount + leg.amount);
      if (leg.isSwitch) d.switchedIn = round2(d.switchedIn + leg.amount);
    }
  }

  const sum = (f) => round2(rows.reduce((s, r) => s + f(r), 0));

  return {
    generatedAt: new Date().toISOString(),
    pool: {
      id: pool.id, name: pool.name, productType: pool.product_type, status: pool.status,
      actualRate: pool.actual_rate == null ? null : num(pool.actual_rate),
      ratePosted: num(pool.actual_rate) > 0,
      endDate: pool.end_date, maturityDate: pool.maturity_date, termMonths: pool.term_months,
    },
    totals: {
      investments: rows.length,
      investors:   new Set(rows.map(r => r.holderId)).size,
      principal:     sum(r => r.principal),
      actualReturn:  sum(r => r.actualReturn),
      gross:         sum(r => r.gross),
      toWallet:      sum(r => r.toWallet),
      reinvested:    sum(r => r.reinvested),
      instructedToWallet: sum(r => r.instructedToWallet),
      fallbackToWallet:   sum(r => r.fallbackToWallet),
    },
    byInstruction,
    destinations: [...destTotals.values()].sort((a, b) => b.amount - a.amount),
    rows,
    /* Reported, never silently dropped: these are investments in this pool
       whose money is not in any figure above. */
    heldBack,
    heldBackPrincipal: round2(heldBack.reduce((s, h) => s + h.principal, 0)),
  };
}

module.exports = { buildMaturityReport, allocate, INSTRUCTION_LABELS, AUTO_REINVEST, label };
