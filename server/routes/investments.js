/* ═══════════════════════════════════════════════════════════
   Investment maturity instructions
   POST /api/investments/:id/instruction
     Body: { instruction }
   Clients may set their own instruction up to 17:00 SAST on the
   maturity day. Admin/director/staff may set it on behalf of a
   client at any time (bypasses the cutoff).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router = require('express').Router();
const pool   = require('../db/pool');
const audit  = require('../services/audit');
const email  = require('../services/email');
const { requireAuth } = require('../middleware/auth');

const VALID_INSTRUCTIONS = ['payout_all', 'payout_return', 'payout_custom', 'reinvest', 'switch_product', 'custom_switch', 'switch_amount'];
const STAFF_ROLES = ['admin', 'director', 'fund_manager', 'staff'];

// Instructions that are meaningless without their companion field. Saving
// 'payout_custom' with no amount, or 'switch_product' with no target, leaves an
// investment that says pay out / switch but cannot say how much or into what.
const NEEDS_AMOUNT  = ['payout_custom', 'custom_switch', 'switch_amount'];
const NEEDS_PRODUCT = ['switch_product', 'custom_switch', 'switch_amount'];

/* What the amount MEANS differs, and the error text has to say which.
   On payout_custom and custom_switch the amount is paid to the wallet; on
   switch_amount it is moved into another product and nothing is paid out.
   Calling it a "payout amount" there would describe the opposite of what the
   instruction does. */
const AMOUNT_IS_SWITCH = ['switch_amount'];
const amountNoun = i => (AMOUNT_IS_SWITCH.includes(i) ? 'switch amount' : 'payout amount');

/* Returns an error string, or null when the combination is coherent. */
function validateInstruction(instruction, amount, productType) {
  if (!VALID_INSTRUCTIONS.includes(instruction)) return 'Invalid instruction.';

  if (NEEDS_AMOUNT.includes(instruction)) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return `A ${amountNoun(instruction)} greater than zero is required for this instruction.`;
  } else if (amount != null && amount !== '') {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return `Invalid ${amountNoun(instruction)}.`;
  }

  if (NEEDS_PRODUCT.includes(instruction) && !productType) {
    return 'A product to switch into is required for this instruction.';
  }
  return null;
}

const rand = v => `R${Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* The UI caps the custom payout at capital + posted return, and only once a
   return has actually been posted. Mirror that here so the cap is not merely a
   suggestion made by an input element the caller controls.
   Returns the ceiling, or null when no return has been posted and so no cap
   applies — the caller needs the figure to say what went wrong. */
function investmentCeiling(inv) {
  const posted = Number(inv.actual_return_amount ?? inv.actual_return ?? 0);
  if (!posted) return null;
  return Number(inv.amount || 0) + posted;
}

function payoutExceedsInvestment(inv, amount) {
  const ceiling = investmentCeiling(inv);
  if (ceiling === null) return false;
  return Number(amount) > ceiling + 0.005;         // tolerate cent rounding
}

router.post('/:id/instruction', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { instruction, custom_payout_amount, switch_product_type } = req.body || {};

  /* The companion fields used to be a second request (PATCH tables/investments)
     issued after this one. Between the two the investment read 'payout_custom'
     with no amount, and if the second call failed it stayed that way. They are
     part of the instruction, so they are written with it. */
  const invalid = validateInstruction(instruction, custom_payout_amount, switch_product_type);
  if (invalid) return res.status(400).json({ error: invalid });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]);
    const inv = rows[0];
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Investment not found.' }); }

    const isStaff = STAFF_ROLES.includes(req.user.role);

    // Clients may only manage their own investment.
    if (!isStaff) {
      if (!req.user.investorId || inv.investor_id !== req.user.investorId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Forbidden.' });
      }
      /* A cancelled investment is not a holding — clients cannot see it and
         must not be able to act on it either. The pool-level route already
         filters on status = 'active'; this single-investment path did not,
         so a stale page or a direct call could still set an instruction on
         money that had been refunded. 404, matching what the read returns. */
      if (inv.status === 'cancelled') {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Investment not found.' });
      }
      // Cutoff: 17:00 SAST on the maturity (end_date) day = 15:00 UTC that date.
      if (inv.end_date) {
        const { rows: [chk] } = await client.query(
          `SELECT (end_date::timestamp + interval '15 hours') <= NOW() AS past_cutoff
             FROM investments WHERE id = $1`,
          [id]
        );
        if (chk && chk.past_cutoff) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Instructions close at 17:00 (SA time) on the maturity date. Please contact support.',
            code: 'INSTRUCTION_CUTOFF',
          });
        }
      }
      // Also block once the investment is no longer active.
      if (inv.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This investment can no longer be changed.' });
      }
    }

    if (NEEDS_AMOUNT.includes(instruction) && payoutExceedsInvestment(inv, custom_payout_amount)) {
      await client.query('ROLLBACK');
      // Name both figures: "exceeds the value" alone leaves the client guessing
      // what the ceiling is and re-typing until something sticks.
      return res.status(400).json({
        error: `${rand(custom_payout_amount)} is more than this investment is worth (${rand(investmentCeiling(inv))}).`,
      });
    }

    await client.query(
      `UPDATE investments
          SET maturity_instruction = $1,
              custom_payout_amount = $2,
              switch_product_type  = $3,
              updated_at           = NOW()
        WHERE id = $4`,
      [
        instruction,
        NEEDS_AMOUNT.includes(instruction)  ? Number(custom_payout_amount) : null,
        NEEDS_PRODUCT.includes(instruction) ? switch_product_type          : null,
        id,
      ]
    );
    await client.query('COMMIT');

    audit.log({
      actorId: req.user.id || req.user.investorId, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'investment.instruction_set', entityType: 'investments', entityId: id,
      description: `Maturity instruction set to '${instruction}'${isStaff ? ' by staff on behalf of investor' : ''}`,
      platform: req.headers['x-platform'] || null,
    }).catch(() => {});

    // Fire-and-forget confirmation email to the investor
    const _invId = inv.investor_id;
    const _poolName = inv.pool_name || inv.pool_id;
    const _endDate = inv.end_date;
    setImmediate(async () => {
      try {
        const { rows: [investor] } = await pool.query(
          'SELECT first_name, last_name, email FROM investors WHERE id = $1',
          [_invId]
        );
        if (investor && investor.email) {
          email.sendMaturityInstructionConfirmed(investor, {
            poolName: _poolName,
            endDate: _endDate,
            instruction,
            onBehalf: isStaff,
          }).catch(() => {});
        }
      } catch (_) {}
    });

    res.json({ success: true, instruction, onBehalf: isStaff });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[investments/instruction] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/investments/pool/:poolId/instruction
     Body: { instruction, custom_payout_amount?, switch_product_type?, investor_id? }

   Applies one instruction to every active investment the caller holds in a
   pool, in a single transaction.

   The portal used to do this client-side: Promise.all over the investments,
   one or two requests each, no transaction. A failure partway left some
   investments carrying the new instruction and the rest on the old one, on
   the setting that decides whether the money pays out or reinvests — and the
   client saw a single generic error with no way to tell which had taken. It
   also sent one confirmation e-mail per investment for one decision.

   All-or-nothing: if any investment in the set fails a check, none change.
   ═══════════════════════════════════════════════════════════ */
router.post('/pool/:poolId/instruction', requireAuth, async (req, res) => {
  const { poolId } = req.params;
  const { instruction, custom_payout_amount, switch_product_type, investor_id } = req.body || {};

  const invalid = validateInstruction(instruction, custom_payout_amount, switch_product_type);
  if (invalid) return res.status(400).json({ error: invalid });

  const isStaff    = STAFF_ROLES.includes(req.user.role);
  const investorId = isStaff ? (investor_id || req.user.investorId) : req.user.investorId;
  if (!investorId) return res.status(403).json({ error: 'Forbidden.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock every row up front so a concurrent single-investment update cannot
    // interleave and leave the pool split across two instructions.
    const { rows: invs } = await client.query(
      `SELECT *, (end_date::timestamp + interval '15 hours') <= NOW() AS past_cutoff
         FROM investments
        WHERE pool_id = $1 AND investor_id = $2 AND status = 'active'
        ORDER BY id
          FOR UPDATE`,
      [poolId, investorId]
    );

    if (!invs.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No active investments found in this pool.' });
    }

    if (!isStaff && invs.some(i => i.end_date && i.past_cutoff)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Instructions close at 17:00 (SA time) on the maturity date. Please contact support.',
        code: 'INSTRUCTION_CUTOFF',
      });
    }

    if (NEEDS_AMOUNT.includes(instruction)) {
      const blocked = invs.filter(i => payoutExceedsInvestment(i, custom_payout_amount));
      if (blocked.length) {
        await client.query('ROLLBACK');
        /* Name the smallest ceiling, and restate that the amount lands on each
           investment. That per-investment behaviour is the reason the number
           looked reasonable to whoever typed it, so the error is the right
           place to say it rather than leaving them to re-type blind. */
        const smallest = Math.min(...blocked.map(investmentCeiling));
        return res.status(400).json({
          error: `${rand(custom_payout_amount)} is applied to each investment. The smallest in this pool is worth ${rand(smallest)}, so it cannot ${AMOUNT_IS_SWITCH.includes(instruction) ? 'switch' : 'pay out'} that much.`,
        });
      }
    }

    // Re-stating the predicate rather than passing ids: the rows are already
    // locked by the SELECT above, so this touches exactly that set.
    const { rowCount } = await client.query(
      `UPDATE investments
          SET maturity_instruction = $1,
              custom_payout_amount = $2,
              switch_product_type  = $3,
              updated_at           = NOW()
        WHERE pool_id = $4 AND investor_id = $5 AND status = 'active'`,
      [
        instruction,
        NEEDS_AMOUNT.includes(instruction)  ? Number(custom_payout_amount) : null,
        NEEDS_PRODUCT.includes(instruction) ? switch_product_type          : null,
        poolId,
        investorId,
      ]
    );

    await client.query('COMMIT');

    audit.log({
      actorId: req.user.id || req.user.investorId, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'investment.instruction_set_pool', entityType: 'investment_pools', entityId: poolId,
      description: `Maturity instruction set to '${instruction}' for ${rowCount} investment(s) in pool ${poolId}${isStaff ? ' by staff on behalf of investor' : ''}`,
      platform: req.headers['x-platform'] || null,
    }).catch(() => {});

    // One decision, one e-mail — previously one per investment in the pool.
    const _poolName = invs[0].pool_name || poolId;
    const _endDate  = invs[0].end_date;
    setImmediate(async () => {
      try {
        const { rows: [investor] } = await pool.query(
          'SELECT first_name, last_name, email FROM investors WHERE id = $1',
          [investorId]
        );
        if (investor && investor.email) {
          email.sendMaturityInstructionConfirmed(investor, {
            poolName: _poolName,
            endDate:  _endDate,
            instruction,
            onBehalf: isStaff,
          }).catch(() => {});
        }
      } catch (_) {}
    });

    res.json({ success: true, instruction, updated: rowCount, onBehalf: isStaff });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[investments/pool-instruction] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /api/investments/:id/cancel  (admin/staff only)
   Cancels an active investment and credits the full amount
   plus any platform fee back to the investor's wallet.
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  if (!STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden — staff only.' });
  }

  const { id } = req.params;
  const { reason } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the investment row
    const { rows } = await client.query(
      'SELECT * FROM investments WHERE id = $1 FOR UPDATE',
      [id]
    );
    const inv = rows[0];
    if (!inv) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Investment not found.' });
    }
    if (['cancelled', 'matured', 'paid_out'].includes(inv.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Investment is already ${inv.status} and cannot be cancelled.` });
    }

    const amount = parseFloat(inv.amount) || 0;

    // Find the platform fee paid for this investment (negative amount, type='fee')
    const { rows: feeTxns } = await client.query(
      `SELECT id, amount FROM transactions
        WHERE investment_id = $1
          AND type = 'fee'
          AND status = 'completed'
        LIMIT 1`,
      [id]
    );
    const platformFee = feeTxns.length ? Math.abs(parseFloat(feeTxns[0].amount) || 0) : 0;
    const totalRefund = amount + platformFee;

    // Cancel the investment
    await client.query(
      `UPDATE investments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Cancel all associated transactions (investment + fee)
    await client.query(
      `UPDATE transactions SET status = 'cancelled', updated_at = NOW()
        WHERE investment_id = $1 AND status = 'completed'`,
      [id]
    );

    // Credit wallet: principal + platform fee
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
      [totalRefund, inv.investor_id]
    );

    // Record the refund as a deposit transaction
    const refundDesc = platformFee > 0
      ? `Investment cancellation refund — ${inv.pool_name || inv.pool_id} (R${amount.toFixed(2)} principal + R${platformFee.toFixed(2)} platform fee)`
      : `Investment cancellation refund — ${inv.pool_name || inv.pool_id}`;

    await client.query(
      `INSERT INTO transactions
         (id, investor_id, type, amount, status, reference, description, investment_id, pool_id, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'deposit', $2, 'completed', $3, $4, $5, $6, NOW(), NOW(), NOW())`,
      [inv.investor_id, totalRefund, 'REV-' + id, refundDesc, id, inv.pool_id]
    );

    // Reduce pool totals
    if (inv.pool_id) {
      await client.query(
        `UPDATE investment_pools
            SET current_invested = GREATEST(0, COALESCE(current_invested, 0) - $1),
                raised_amount    = GREATEST(0, COALESCE(raised_amount,    0) - $1),
                updated_at       = NOW()
          WHERE id = $2`,
        [amount, inv.pool_id]
      );
    }

    await client.query('COMMIT');

    audit.log({
      actorId: req.user.id || req.user.investorId, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'investment.cancelled', entityType: 'investments', entityId: id,
      description: `Investment cancelled — R${amount.toFixed(2)}${platformFee > 0 ? ` + R${platformFee.toFixed(2)} fee` : ''} refunded to wallet${reason ? ` — Reason: ${reason}` : ''}`,
      platform: req.headers['x-platform'] || null,
    }).catch(() => {});

    res.json({ success: true, refunded: totalRefund, principal: amount, platformFee });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[investments/cancel] error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  } finally {
    client.release();
  }
});

module.exports = router;
