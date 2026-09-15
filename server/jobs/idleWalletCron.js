/* ═══════════════════════════════════════════════════════════
   Idle Wallet Cron — weekly, Tuesday 09:00 SAST.

   Money already on the platform is the easiest money there is to put to work:
   it is past FICA, past the deposit, past every barrier that stops anybody
   else. Both dashboard panels surface it, but only to somebody who visits.
   A client who deposited and did not come back sees nothing at all.

   This is the only unsolicited mail the platform sends about somebody's own
   money, so it is deliberately conservative:

     · It is silent unless the balance can actually DO something — the cheapest
       open pool's minimum PLUS the 1% fee charged on top of it. Telling
       somebody with R300 that their money is idle, when nothing on the shelf
       is reachable, is a nuisance rather than a service.
     · Once a month per person at most, read from email_logs rather than a new
       column, so a redeploy or a second instance cannot reset the clock.
     · Not within three days of a deposit. Somebody who has just funded their
       wallet is mid-decision and does not need chasing.
     · Not while a withdrawal is pending. That money is on its way out and they
       have said so.
     · Only FICA-approved, active investors — anybody else cannot invest even
       if they wanted to, so the email would be an invitation to a dead end.

   And it does not send at all until somebody turns it on. IDLE_NUDGE_ENABLED
   must be 'true'; until then it does the full selection and logs what it WOULD
   have sent. A first outbound run against four and a half thousand clients is
   worth looking at before it leaves.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

/* Same rule as the portal: the fee is charged ON TOP, so the wallet must cover
   the minimum plus 1% of it. svcMinWalletFor in js/portal-core.js is the
   client-side half of this and they must not drift. */
const FEE_RATE     = 0.01;
const minWalletFor = min => Math.round(min * (1 + FEE_RATE) * 100) / 100;

const BATCH_LIMIT   = 200;   // a cap, so a misconfiguration cannot mail everybody at once
const COOLDOWN_DAYS = 30;
const DEPOSIT_GRACE_DAYS = 3;

async function runIdleWalletNudge() {
  const live = String(process.env.IDLE_NUDGE_ENABLED || '').toLowerCase() === 'true';
  console.log(`[idleWallet] scanning${live ? '' : ' (dry run — set IDLE_NUDGE_ENABLED=true to send)'}…`);

  try {
    /* What is actually buyable right now. If nothing is open there is nothing
       to nudge towards, and saying "your money is idle" with no next step is
       worse than saying nothing. */
    const { rows: pools } = await pool.query(`
      SELECT id, name, min_investment
        FROM investment_pools
       WHERE status = 'open'
         AND end_date IS NOT NULL
         AND end_date >= CURRENT_DATE
         AND COALESCE(min_investment, 0) > 0
       ORDER BY min_investment ASC`);

    if (!pools.length) {
      console.log('[idleWallet] no open pool is currently reachable — nothing to suggest, skipping.');
      return { sent: 0, skipped: 0 };
    }

    const cheapest  = pools[0];
    const minNeeded = minWalletFor(parseFloat(cheapest.min_investment) || 0);

    const { rows: candidates } = await pool.query(`
      SELECT i.id, i.email, i.first_name, i.wallet_balance
        FROM investors i
       WHERE COALESCE(i.wallet_balance, 0) >= $1
         AND i.email IS NOT NULL AND btrim(i.email) <> ''
         AND COALESCE(i.status, '') = 'active'
         AND COALESCE(i.kyc_status, '') = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.investor_id = i.id
              AND t.type = 'withdrawal' AND t.status = 'pending')
         AND NOT EXISTS (
           SELECT 1 FROM transactions t
            WHERE t.investor_id = i.id
              AND t.type = 'deposit' AND t.status = 'completed'
              AND t.created_at > NOW() - ($2 || ' days')::INTERVAL)
         AND NOT EXISTS (
           SELECT 1 FROM email_logs e
            WHERE lower(e.to_email) = lower(i.email)
              AND e.type = 'idle_wallet'
              AND e.status = 'sent'
              AND e.sent_at > NOW() - ($3 || ' days')::INTERVAL)
       ORDER BY i.wallet_balance DESC
       LIMIT $4`,
      [minNeeded, DEPOSIT_GRACE_DAYS, COOLDOWN_DAYS, BATCH_LIMIT]);

    if (!candidates.length) {
      console.log(`[idleWallet] nobody is holding ${minNeeded.toFixed(2)} or more and eligible — skipping.`);
      return { sent: 0, skipped: 0 };
    }

    const total = candidates.reduce((s, c) => s + (parseFloat(c.wallet_balance) || 0), 0);
    console.log(`[idleWallet] ${candidates.length} investor(s) holding R${total.toFixed(2)} idle; ` +
                `cheapest reachable pool is ${cheapest.name} at R${minNeeded.toFixed(2)} (fee included).`);

    if (!live) {
      console.log('[idleWallet] dry run — no email sent. Set IDLE_NUDGE_ENABLED=true when the numbers above look right.');
      return { sent: 0, skipped: candidates.length };
    }

    let sent = 0, failed = 0;
    for (const c of candidates) {
      /* Per-recipient. One bad address must not stop the rest of the run. */
      try {
        await emailService.sendIdleWalletNudge(c, {
          balance:   parseFloat(c.wallet_balance) || 0,
          poolName:  cheapest.name,
          minNeeded,
          poolCount: pools.length,
        });
        sent++;
      } catch (e) {
        failed++;
        console.error(`[idleWallet] send failed for ${c.id}:`, e.message);
      }
    }

    console.log(`[idleWallet] done — ${sent} sent, ${failed} failed.`);
    return { sent, failed };
  } catch (e) {
    console.error('[idleWallet] Fatal error:', e.message);
    return { sent: 0, error: e.message };
  }
}

function startIdleWalletCron() {
  /* Tuesday 09:00 SAST = 07:00 UTC. Weekly, not daily: the cooldown already
     limits a person to once a month, and a weekly scan is enough to catch
     somebody whose deposit cleared on a Thursday. */
  cron.schedule('0 7 * * 2', () => {
    runIdleWalletNudge().catch(e => console.error('[idleWallet] cron error:', e.message));
  }, { timezone: 'UTC' });
  console.log('[idleWallet] scheduled: Tuesdays 09:00 SAST' +
              (String(process.env.IDLE_NUDGE_ENABLED || '').toLowerCase() === 'true'
                ? '' : ' — DRY RUN until IDLE_NUDGE_ENABLED=true'));
}

module.exports = { startIdleWalletCron, runIdleWalletNudge, minWalletFor };
