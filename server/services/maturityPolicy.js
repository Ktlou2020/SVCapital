/* ═══════════════════════════════════════════════════════════
   Maturity policy — which instructions a product may carry.

   Most products may be reinvested, switched, or split at maturity. Two
   families may not, for different reasons, and both have to be settled in
   cash when the term ends:

     • Ethical & Interest-Free (product_type `eif_*`). Each EIF pool is a
       discrete contract — a murabaha sale, an ijara lease, a mudarabah
       venture. It is concluded when the underlying transaction concludes;
       there is nothing to roll. "Reinvesting" would silently enter the
       client into a NEW contract they never agreed, which is the one thing
       an interest-free client came here to avoid. So: payout only, and
       payout by default.

     • Delivery bikes, which have always paid out rather than reinvested.
       Unlike EIF, a switch into another product is still offered there; only
       the reinvest default is overridden.

   Matched on the `eif_` PREFIX rather than a list of the three products that
   exist today. product_type is the category's naming convention (setup.js
   seeds eif_murabaha, eif_ijara, eif_mudarabah; agreements.js keys off the
   same names), so a fourth EIF structure added later inherits the rule
   instead of quietly defaulting to reinvest — which is the failure that
   would cost a client their compliance.

   The portal mirrors this in Utils.isPayoutOnlyProduct; a check asserts the
   two agree, because a client-side form that offers an option the server
   refuses is a dead end the client cannot get out of.
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* The only instruction a payout-only product may carry. */
const PAYOUT_ONLY_INSTRUCTION = 'payout_all';

function isPayoutOnlyProduct(productType) {
  return /^eif(_|$)/i.test(String(productType == null ? '' : productType).trim());
}

/* What the maturity engine will ACTUALLY do with an investment, as opposed to
   what its column says. Used by the engine, by the pre-flight that previews
   the engine, and by the instruction report — one expression, so a preview
   cannot predict something the engine will not do. */
function effectiveInstruction(instruction, productType) {
  if (isPayoutOnlyProduct(productType)) return PAYOUT_ONLY_INSTRUCTION;
  const raw = String(instruction == null ? '' : instruction).trim();
  const pt  = String(productType == null ? '' : productType);
  if ((!raw || raw === 'pending' || raw === 'reinvest') && pt.includes('delivery_bike')) {
    return PAYOUT_ONLY_INSTRUCTION;
  }
  return (!raw || raw === 'pending') ? 'reinvest' : raw;
}

/* Returns an error string when this product may not carry this instruction,
   or null when the combination is allowed. */
function instructionRefusal(instruction, productType) {
  if (!isPayoutOnlyProduct(productType)) return null;
  if (instruction === PAYOUT_ONLY_INSTRUCTION) return null;
  return 'Ethical & Interest-Free investments are settled in cash at maturity. ' +
         'Each pool is its own contract, so it cannot be reinvested or switched — ' +
         'the only instruction available is to pay out the full capital and return.';
}

module.exports = {
  PAYOUT_ONLY_INSTRUCTION,
  isPayoutOnlyProduct,
  effectiveInstruction,
  instructionRefusal,
};
