/* ═══════════════════════════════════════════════════════
   FICA / KYC Automation Routes

   GET  /api/fica/status/:investorId  — check history + next due date
   POST /api/fica/trigger/:investorId — manual admin trigger
   GET  /api/fica/queue               — investors due for (re-)check
   POST /api/fica/webhook/smile       — Smile Identity async callback
   POST /api/fica/webhook/stitch      — Stitch async callback
   ═══════════════════════════════════════════════════════ */
'use strict';

const router      = require('express').Router();
const pool        = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runFicaCheck } = require('../services/ficaService');
const smile       = require('../services/smileIdentity');

/* ═══════════════════════════════════════════════════════
   GET /api/fica/status/:investorId
   Returns check history, current status, and next due date.
   Accessible by the investor themselves or admin/director/fund_manager.
   ═══════════════════════════════════════════════════════ */
router.get('/status/:investorId', requireAuth, async (req, res) => {
  const { investorId } = req.params;
  const { role, investorId: userInvId } = req.user;

  const allowed = ['admin', 'director', 'fund_manager'].includes(role)
    || (role === 'investor' && userInvId === investorId);
  if (!allowed) return res.status(403).json({ error: 'Access denied.' });

  try {
    const { rows: inv } = await pool.query(
      `SELECT id, first_name, last_name, kyc_status, last_auto_fica_check, fica_auto_status
       FROM investors WHERE id = $1`,
      [investorId]
    );
    if (!inv.length) return res.status(404).json({ error: 'Investor not found.' });

    const { rows: checks } = await pool.query(
      `SELECT id, trigger, id_check_status, bank_check_status, overall_status, check_date
       FROM fica_checks
       WHERE investor_id = $1
       ORDER BY check_date DESC
       LIMIT 20`,
      [investorId]
    );

    /* Next annual check due date */
    const lastCheck = inv[0].last_auto_fica_check;
    const nextDue   = lastCheck
      ? new Date(new Date(lastCheck).setFullYear(new Date(lastCheck).getFullYear() + 1))
      : null;
    const daysUntil = nextDue
      ? Math.ceil((nextDue - Date.now()) / 86_400_000)
      : null;

    res.json({
      investor:   inv[0],
      checks,
      nextCheckDue: nextDue,
      daysUntilNextCheck: daysUntil,
    });
  } catch (err) {
    console.error('FICA status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════
   POST /api/fica/trigger/:investorId
   Manually kick off a FICA check (admin / fund_manager only).
   Body: { trigger: 'manual' } (optional)
   ═══════════════════════════════════════════════════════ */
router.post(
  '/trigger/:investorId',
  requireAuth,
  requireRole('admin', 'director', 'fund_manager'),
  async (req, res) => {
    const { investorId } = req.params;
    try {
      const { rows } = await pool.query(
        'SELECT * FROM investors WHERE id = $1',
        [investorId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Investor not found.' });

      const result = await runFicaCheck(rows[0], req.body?.trigger || 'manual');
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('FICA trigger error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/* ═══════════════════════════════════════════════════════
   GET /api/fica/queue
   Returns investors due for annual re-check or never checked after deposit.
   Admin / director / fund_manager only.
   ═══════════════════════════════════════════════════════ */
router.get(
  '/queue',
  requireAuth,
  requireRole('admin', 'director', 'fund_manager'),
  async (req, res) => {
    try {
      const { rows: annual } = await pool.query(`
        SELECT id, first_name, last_name, kyc_status, last_auto_fica_check, fica_auto_status
        FROM investors
        WHERE last_auto_fica_check IS NOT NULL
          AND last_auto_fica_check < NOW() - INTERVAL '1 year'
          AND status != 'suspended'
        ORDER BY last_auto_fica_check ASC
        LIMIT 100
      `);

      const { rows: firstDeposit } = await pool.query(`
        SELECT i.id, i.first_name, i.last_name, i.kyc_status,
               i.last_auto_fica_check, i.fica_auto_status
        FROM investors i
        WHERE i.last_auto_fica_check IS NULL
          AND EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.investor_id = i.id
              AND t.type = 'deposit'
              AND t.status = 'completed'
          )
          AND i.status != 'suspended'
        LIMIT 100
      `);

      res.json({
        annualRecheck:   annual,
        firstDeposit:    firstDeposit,
        totalPending:    annual.length + firstDeposit.length,
      });
    } catch (err) {
      console.error('FICA queue error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/* ═══════════════════════════════════════════════════════
   POST /api/fica/webhook/smile
   Smile Identity async result callback.
   Smile retries if no 200 within 10 s — always acknowledge first.
   ═══════════════════════════════════════════════════════ */
router.post('/webhook/smile', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  try {
    const payload   = req.body;
    const sigHeader = req.headers['x-smile-signature'] || payload.signature || '';

    if (!smile.verifyWebhook(payload, sigHeader)) {
      console.warn('[Smile Webhook] Invalid signature — ignored.');
      return;
    }

    /* Smile embeds the investor ID we passed as partner_params.user_id */
    const investorId = payload.PartnerParams?.user_id || payload.partner_params?.user_id;
    if (!investorId) {
      console.warn('[Smile Webhook] No user_id in PartnerParams — ignored.');
      return;
    }

    const status = smile.mapResult(payload);

    /* Update the most recent fica_check for this investor */
    await pool.query(
      `UPDATE fica_checks
       SET overall_status = $1, id_result = id_result || $2::jsonb
       WHERE investor_id = $3
         AND id = (SELECT id FROM fica_checks WHERE investor_id = $3 ORDER BY check_date DESC LIMIT 1)`,
      [status, JSON.stringify({ smile_callback: payload }), investorId]
    );

    /* Mirror result to investor record */
    if (status === 'pass') {
      await pool.query(
        `UPDATE investors SET kyc_status='verified', fica_auto_status='pass', updated_at=NOW() WHERE id=$1`,
        [investorId]
      );
    } else if (status === 'fail') {
      await pool.query(
        `UPDATE investors SET kyc_status='rejected', fica_auto_status='fail', updated_at=NOW() WHERE id=$1`,
        [investorId]
      );
    }

    console.log(`[Smile Webhook] ${investorId} → ${status}`);
  } catch (err) {
    console.error('[Smile Webhook] Error:', err.message);
  }
});

/* ═══════════════════════════════════════════════════════
   POST /api/fica/webhook/stitch
   Stitch async result callback (for async bank verification flows).
   ═══════════════════════════════════════════════════════ */
router.post('/webhook/stitch', async (req, res) => {
  // TODO(security): Implement Stitch webhook signature verification
  // The Stitch docs describe HMAC-SHA256 signing. Verify before processing:
  // const sig = req.headers['x-stitch-signature'];
  // if (!sig || !verifyStitchSignature(req.rawBody, sig)) return res.status(401).json({ error: 'Invalid signature' });
  // For now, only process if a STITCH_WEBHOOK_SECRET env var is set:
  if (!process.env.STITCH_WEBHOOK_SECRET) {
    console.warn('[fica] STITCH_WEBHOOK_SECRET not set — rejecting Stitch webhook');
    return res.status(500).json({ error: 'Webhook verification not configured' });
  }
  res.sendStatus(200);
  console.log('[Stitch Webhook] Received:', JSON.stringify(req.body).slice(0, 300));
  /* Extend here if using Stitch async flows */
});

module.exports = router;
