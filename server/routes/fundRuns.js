'use strict';
/* Fund run generation — the payout schedule and fee entries a run implies.
 *
 * Server-side and atomic, for the same reason the admin console's wallet writes
 * were moved off the browser: a client that computes each investor's share and
 * posts a list of amounts can be wrong, or stale, or edited, and the rows it
 * writes are what someone is later paid from. The console asks for a plan and
 * shows it; the server recomputes that plan and writes it in one transaction.
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { planRun, generateForRun } = require('../services/fundRunGeneration');
const audit = require('../services/audit');

/* Same roles the generic table API applies to fund_runs, return_schedules and
   fee_ledger. These endpoints exist to do in one transaction what that API
   would do in several, not to widen who may do it. */
const requireFund = [requireAuth, requireRole('admin', 'director', 'fund_manager')];

/* ── GET /api/fund/runs/:id/plan ────────────────────────────
   What would be written, and every reason it might not be. READ ONLY. */
router.get('/runs/:id/plan', requireFund, async (req, res) => {
  try {
    const plan = await planRun(pool, req.params.id);
    if (plan.error === 'not_found') return res.status(404).json(plan);
    res.json(plan);
  } catch (err) {
    console.error('[fund/runs/plan]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/* ── POST /api/fund/runs/:id/generate ───────────────────────
   Writes it. Refuses, with reasons, when the plan is not ok. */
router.post('/runs/:id/generate', requireFund, async (req, res) => {
  try {
    const result = await generateForRun(pool, req.params.id, { actorEmail: req.user && req.user.email });
    if (result.error === 'not_found') return res.status(404).json(result);
    /* 409, not 400: nothing is wrong with the request — the run is not in a
       state where this can be done, and the blockers say which. */
    if (!result.ok) return res.status(409).json(result);

    /* Recorded AFTER the commit, deliberately. The schedule is the thing that
       matters and it is already durable; an audit write that failed inside the
       transaction would roll back a correct payout schedule to preserve a note
       about it. audit.log swallows its own failures loudly rather than
       throwing, so this cannot take the response down either. */
    await audit.log({
      action:      'fund_run.generate_schedule',
      entityType:  'fund_run',
      entityId:    req.params.id,
      actorId:     req.user && req.user.id,
      actorEmail:  req.user && req.user.email,
      actorRole:   req.user && req.user.role,
      description: `Generated ${result.written.schedules} payout schedule(s) and ` +
                   `${result.written.fees} fee entr${result.written.fees === 1 ? 'y' : 'ies'} for ${result.run.name}`,
      after:       { totals: result.totals, replaced: result.written, warnings: result.warnings },
      ip:          req.ip,
    });

    res.json(result);
  } catch (err) {
    console.error('[fund/runs/generate]', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
