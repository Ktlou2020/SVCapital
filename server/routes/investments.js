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
const { requireAuth } = require('../middleware/auth');

const VALID_INSTRUCTIONS = ['payout_all', 'payout_return', 'payout_custom', 'reinvest', 'switch_product', 'custom_switch'];
const STAFF_ROLES = ['admin', 'director', 'fund_manager', 'staff'];

router.post('/:id/instruction', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { instruction } = req.body || {};

  if (!VALID_INSTRUCTIONS.includes(instruction)) {
    return res.status(400).json({ error: 'Invalid instruction.' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM investments WHERE id = $1 LIMIT 1', [id]);
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: 'Investment not found.' });

    const isStaff = STAFF_ROLES.includes(req.user.role);

    // Clients may only manage their own investment.
    if (!isStaff) {
      if (!req.user.investorId || inv.investor_id !== req.user.investorId) {
        return res.status(403).json({ error: 'Forbidden.' });
      }
      // Cutoff: 17:00 SAST on the maturity (end_date) day = 15:00 UTC that date.
      if (inv.end_date) {
        const { rows: [chk] } = await pool.query(
          `SELECT (end_date::timestamp + interval '15 hours') <= NOW() AS past_cutoff
             FROM investments WHERE id = $1`,
          [id]
        );
        if (chk && chk.past_cutoff) {
          return res.status(403).json({
            error: 'Instructions close at 17:00 (SA time) on the maturity date. Please contact support.',
            code: 'INSTRUCTION_CUTOFF',
          });
        }
      }
      // Also block once the investment is no longer active.
      if (inv.status !== 'active') {
        return res.status(409).json({ error: 'This investment can no longer be changed.' });
      }
    }

    await pool.query(
      'UPDATE investments SET maturity_instruction = $1, updated_at = NOW() WHERE id = $2',
      [instruction, id]
    );

    audit.log({
      actorId: req.user.id || req.user.investorId, actorEmail: req.user.email, actorRole: req.user.role,
      action: 'investment.instruction_set', entityType: 'investments', entityId: id,
      description: `Maturity instruction set to '${instruction}'${isStaff ? ' by staff on behalf of investor' : ''}`,
      platform: req.headers['x-platform'] || null,
    }).catch(() => {});

    res.json({ success: true, instruction, onBehalf: isStaff });
  } catch (err) {
    console.error('[investments/instruction] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
