/* ═══════════════════════════════════════════════════════════
   Can this maturity actually be switched into that product?

   A pool minimum is a rule about the POOL — CLAUDE.md is explicit, and the
   product's own min_investment and its pools' drift apart because they are
   set in different places in the console. So the minimum for a PRODUCT is
   its cheapest OPEN pool: the cheapest thing that can be bought today.

   Open is defined the way the maturity engine defines it, because the engine
   is what will have to honour the instruction: status 'open', not past its
   close date, and not already full. A waitlist pool is not a destination —
   reinvestAmount will not place into one.

   The portal filters its destination list by the same rule, so a client is
   never offered a product this will refuse. This exists for the case the
   filter cannot cover: a stale page, a direct call, or a payout that moved
   after the list was drawn.

   NOT ENFORCED FOR STAFF, deliberately, and unlike the payout-only refusal
   next to it. That one is about what a contract can carry, so acting on a
   client's behalf cannot create it. This one is about whether a sum clears a
   threshold today, and staff setting an instruction may know something the
   threshold does not — a larger pool opening, a top-up coming. The same
   division the 17:00 cutoff already makes.

   WHAT THIS DOES NOT FIX. The engine still does not check the minimum when
   it places the money: reinvestAmount takes the first open pool by end_date
   and writes the investment whatever the amount. So an instruction that was
   valid when it was saved can still land below a minimum if the pool it
   lands in is not the cheapest one, or if anniversary distributions have
   already taken part of the return. That is a change to what happens to a
   client's money at maturity and wants its own decision.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* Instructions that put money INTO another product, and how much. */
const SWITCHING_INSTRUCTIONS = ['switch_product', 'custom_switch', 'switch_amount'];

function isSwitchingInstruction(instruction) {
  return SWITCHING_INSTRUCTIONS.includes(String(instruction || ''));
}

/* What an investment is worth for this purpose: capital plus the return that
   has actually been DECLARED. Never an expected or benchmark figure — the
   portal caps the custom payout with the same number, and a filter using a
   more generous one would offer a destination the cap then refuses to fund.
   Nothing posted means the capital alone, which is a true statement.

   THE PRECEDENCE IS Utils.postedReturn's, not investmentCeiling's, and the
   difference is the third source. A rate posted on the POOL but not yet
   written onto the investment row is a declared return the portal counts and
   a narrower reading would not — so the form would offer a destination and
   this would refuse it, which is the dead end the filter exists to remove.
   Three fields, in the order js/api.js resolves them:

     investments.actual_return / actual_return_amount   realised rand amount
     investment_pools.actual_rate                       posted achieved rate

   `poolActualRate` is passed in because the route selects the investment
   without joining its pool; switchRefusal fetches it when it is missing. */
function investmentValue(inv, poolActualRate) {
  const capital = Number(inv && inv.amount) || 0;
  const posted  = Number((inv && (inv.actual_return != null ? inv.actual_return
                                                            : inv.actual_return_amount)) || 0);
  if (posted > 0) return capital + posted;

  const fromRow  = Number((inv && inv.pool_actual_rate) || 0);
  const rate     = fromRow > 0 ? fromRow : Number(poolActualRate || 0);
  return rate > 0 ? capital + capital * rate : capital;
}

/* The amount this instruction sends into the NEW product.

   Three different answers, which is the whole reason this is a function:
   switch_product sends the lot, custom_switch sends what is left after the
   client's cash, and switch_amount sends the named amount and reinvests the
   rest where it is. Reading switch_amount as "value minus the amount" would
   test the wrong leg against the wrong minimum.

   No platform fee enters it: both legs of a maturity go through the engine's
   reinvestAmount and are fee-free. */
function amountSwitched(inv, instruction, customAmount, poolActualRate) {
  const value = investmentValue(inv, poolActualRate);
  const take  = Number(customAmount);
  /* Clamped to the value here, which is what keeps the custom_switch
     remainder non-negative below — a client cannot take out more than the
     investment is worth, and the route refuses it separately. A Math.max on
     the subtraction would be dead code resting on this line. */
  const named = Number.isFinite(take) && take > 0 ? Math.min(take, value) : 0;

  if (instruction === 'switch_amount')  return named;
  if (instruction === 'custom_switch')  return value - named;
  return value;                                     // switch_product
}

/* The cheapest open pool for one product type, or null when it has none.
   Takes a pg client or pool so it can join a transaction already in flight. */
async function cheapestOpenMinimum(db, productType) {
  const { rows } = await db.query(
    `SELECT MIN(COALESCE(min_investment, 0)) AS min_investment,
            COUNT(*)                         AS pools
       FROM investment_pools
      WHERE status = 'open'
        AND product_type = $1
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
        AND (max_investment IS NULL OR COALESCE(current_invested, 0) < max_investment)`,
    [productType]
  );
  const row = rows[0];
  if (!row || Number(row.pools) === 0) return null;
  return Number(row.min_investment) || 0;
}

const rand = v => 'R' + Number(v || 0).toLocaleString('en-ZA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* The achieved rate posted on the pool these investments are maturing out of,
   when the row itself does not carry it. One query for the set: every
   investment in a pool-wide instruction shares the pool. */
async function postedPoolRate(db, inv) {
  if (!inv || inv.pool_actual_rate != null) return null;
  if (!inv.pool_id) return null;
  const { rows } = await db.query(
    'SELECT actual_rate FROM investment_pools WHERE id = $1', [inv.pool_id]);
  return rows[0] ? Number(rows[0].actual_rate) || 0 : 0;
}

/* Returns an error string when this instruction cannot be honoured, or null.
   A cent of tolerance: a minimum met exactly must not fail on a rounding
   artefact of money arithmetic. */
async function switchRefusal(db, inv, instruction, productType, customAmount) {
  if (!isSwitchingInstruction(instruction)) return null;
  if (!productType) return null;                    // validateInstruction owns that

  const min = await cheapestOpenMinimum(db, productType);
  if (min === null) {
    return 'That product has no open pool to switch into. Choose another product, ' +
           'or have the payout go to your wallet.';
  }

  const going = amountSwitched(inv, instruction, customAmount, await postedPoolRate(db, inv));
  if (min > going + 0.005) {
    return `${rand(going)} would be switched into this product, which will not take ` +
           `less than ${rand(min)}. Switch a larger amount, choose a different product, ` +
           'or have the payout go to your wallet.';
  }
  return null;
}

/* The same rule for a whole pool, where one instruction is applied to each
   investment separately — and so is the cash amount.

   Cleared by the SMALLEST amount being switched, not by their total. A
   destination the big holdings can reach and the small one cannot would place
   that one below the pool's minimum, which is the thing being prevented. The
   error names the smallest figure and restates the per-investment behaviour,
   because that behaviour is why the number looked reasonable to whoever typed
   it — the same shape as the payout ceiling error beside it.

   One query for the minimum regardless of how many investments are in the
   set. */
async function switchRefusalForSet(db, invs, instruction, productType, customAmount) {
  if (!isSwitchingInstruction(instruction)) return null;
  if (!productType) return null;
  if (!Array.isArray(invs) || !invs.length) return null;

  const min = await cheapestOpenMinimum(db, productType);
  if (min === null) {
    return 'That product has no open pool to switch into. Choose another product, ' +
           'or have the payout go to your wallet.';
  }

  const rate     = await postedPoolRate(db, invs[0]);
  const amounts  = invs.map(i => amountSwitched(i, instruction, customAmount, rate));
  const smallest = Math.min(...amounts);
  if (min > smallest + 0.005) {
    const many = invs.length > 1;
    return `${rand(smallest)} would be switched${many ? ' from the smallest investment in this pool' : ''}, ` +
           `and this product will not take less than ${rand(min)}. ` +
           (many
             ? 'The amount applies to each investment separately, so set that one on its own, switch a larger amount, or choose a different product.'
             : 'Switch a larger amount, choose a different product, or have the payout go to your wallet.');
  }
  return null;
}

module.exports = {
  SWITCHING_INSTRUCTIONS,
  switchRefusalForSet,
  isSwitchingInstruction,
  investmentValue,
  amountSwitched,
  cheapestOpenMinimum,
  switchRefusal,
};
