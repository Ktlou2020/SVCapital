/* ═══════════════════════════════════════════════════════════
   Maturity Cron
   Runs daily at 08:00 SAST.
   1. runMaturityProcessing — marks matured investments as
      'matured', sends email + SMS to the investor.
   2. runMaturityAlerts     — sends 30-day and 7-day advance
      warning emails. Tracks sent alerts via
      investments.maturity_alert_sent_at to avoid duplicates.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');
const smsService   = require('../services/sms');

async function runMaturityProcessing() {
  console.log('[maturityCron] running maturity processing…');

  const { rows: investments } = await pool.query(`
    SELECT i.*, inv.email, inv.first_name, inv.last_name, inv.phone, inv.id AS investor_row_id
    FROM investments i
    JOIN investors inv ON inv.id = i.investor_id
    WHERE i.status = 'active'
      AND i.end_date IS NOT NULL
      AND i.end_date <= NOW()
      AND i.maturity_processed_at IS NULL
  `);

  let processed = 0;
  for (const inv of investments) {
    try {
      const principal    = parseFloat(inv.amount) || 0;
      const actualReturn = parseFloat(inv.actual_return) || parseFloat(inv.expected_return) || 0;
      const instruction  = inv.maturity_instruction || 'reinvest';
      const poolName     = inv.pool_name || inv.pool_id || 'your investment';

      // 1. Mark the investment as matured
      await pool.query(
        `UPDATE investments SET status = 'matured', maturity_processed_at = NOW() WHERE id = $1`,
        [inv.id]
      );

      // 2. Execute maturity instruction
      if (instruction === 'reinvest') {
        // Find next open pool of same product type
        const { rows: nextPools } = await pool.query(
          `SELECT * FROM investment_pools
           WHERE status = 'open'
             AND product_type = $1
             AND (max_capacity IS NULL OR current_invested < max_capacity)
           ORDER BY created_at ASC LIMIT 1`,
          [inv.product_type || 'general']
        );
        const nextPool = nextPools[0];

        if (nextPool) {
          const reinvestAmt    = principal + actualReturn;
          const newInvId       = 'INV-RI-' + Date.now() + '-' + inv.investor_id.replace(/[^A-Z0-9]/g, '');
          const startDate      = new Date();
          const endDate        = new Date(startDate);
          endDate.setMonth(endDate.getMonth() + (nextPool.term_months || 6));
          const newExpReturn   = Math.round(reinvestAmt * (parseFloat(nextPool.annual_rate) || 0) * ((nextPool.term_months || 6) / 12) * 100) / 100;

          await pool.query(
            `INSERT INTO investments
               (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
                annual_rate, term_months, expected_return, actual_return, product_type,
                maturity_instruction, is_reinvestment, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,0,$11,'reinvest',true,NOW(),NOW())`,
            [
              newInvId, inv.investor_id, nextPool.id, nextPool.name,
              reinvestAmt,
              startDate.toISOString().slice(0, 10),
              endDate.toISOString().slice(0, 10),
              nextPool.annual_rate, nextPool.term_months || 6,
              newExpReturn, nextPool.product_type,
            ]
          );
          // Record as a reinvestment transaction (wallet not involved)
          await pool.query(
            `INSERT INTO transactions
               (id, investor_id, type, amount, status, reference, description, investment_id, pool_id, created_at, updated_at)
             VALUES (gen_random_uuid(),$1,'investment',$2,'completed',$3,$4,$5,$6,NOW(),NOW())`,
            [
              inv.investor_id, reinvestAmt, 'REINV-' + inv.id,
              `Maturity reinvestment — ${poolName} → ${nextPool.name}`,
              newInvId, nextPool.id,
            ]
          );
          // Update pool invested amount
          await pool.query(
            'UPDATE investment_pools SET current_invested = COALESCE(current_invested,0) + $1, raised_amount = COALESCE(raised_amount,0) + $1 WHERE id = $2',
            [reinvestAmt, nextPool.id]
          );
          console.log(`[maturityCron] reinvested ${inv.id} → ${newInvId} in pool ${nextPool.id}`);
        } else {
          // No open pool found — credit wallet with principal + return instead
          await pool.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, total_returns = COALESCE(total_returns,0) + $2, updated_at = NOW() WHERE id = $3',
            [principal + actualReturn, actualReturn, inv.investor_id]
          );
          await pool.query(
            `INSERT INTO transactions
               (id, investor_id, type, amount, status, reference, description, investment_id, created_at, updated_at)
             VALUES (gen_random_uuid(),$1,'return',$2,'completed',$3,$4,$5,NOW(),NOW())`,
            [
              inv.investor_id, principal + actualReturn, 'MAT-' + inv.id,
              `Maturity payout — ${poolName} (no open pool for reinvestment)`, inv.id,
            ]
          );
          console.log(`[maturityCron] no open pool for reinvestment — credited wallet for ${inv.investor_id}`);
        }
      } else {
        // payout_all / payout_return / default: credit principal + return to wallet
        const payoutAmt = (instruction === 'payout_return') ? actualReturn : principal + actualReturn;
        if (payoutAmt > 0) {
          await pool.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, total_returns = COALESCE(total_returns,0) + $2, updated_at = NOW() WHERE id = $3',
            [payoutAmt, actualReturn, inv.investor_id]
          );
          await pool.query(
            `INSERT INTO transactions
               (id, investor_id, type, amount, status, reference, description, investment_id, created_at, updated_at)
             VALUES (gen_random_uuid(),$1,'return',$2,'completed',$3,$4,$5,NOW(),NOW())`,
            [
              inv.investor_id, payoutAmt, 'MAT-' + inv.id,
              `Maturity payout — ${poolName}`, inv.id,
            ]
          );
          console.log(`[maturityCron] paid out ${payoutAmt} to wallet for ${inv.investor_id} (instruction: ${instruction})`);
        }
      }

      // 3. Send maturity email
      await emailService.sendInvestmentMatured(
        { email: inv.email, first_name: inv.first_name },
        { poolName, amount: principal, actualReturn }
      ).catch(err => console.error('[maturityCron] email failed:', err.message));

      // 4. Send maturity SMS
      await smsService.sendMaturityAlert(
        inv.phone, inv.first_name, principal, poolName
      ).catch(err => console.error('[maturityCron] SMS failed:', err.message));

      console.log(`[maturityCron] processed ${inv.id} — instruction: ${instruction}`);
      processed++;
    } catch (err) {
      console.error(`[maturityCron] failed to process investment ${inv.id}:`, err.message);
    }
  }

  console.log(`[maturityCron] processing done — ${processed} investment(s) matured`);
  return processed;
}

async function runMaturityAlerts() {
  console.log('[maturityCron] running maturity alert scan…');
  try {
    const now = new Date();

    // Find active investments where end_date is within 31 days
    // AND we haven't sent an alert in the last 6 days (to avoid duplicate daily sends)
    const { rows: investments } = await pool.query(`
      SELECT i.*, inv.email, inv.first_name
      FROM investments i
      JOIN investors inv ON inv.id = i.investor_id
      WHERE i.status = 'active'
        AND i.end_date IS NOT NULL
        AND i.end_date > NOW()
        AND i.end_date <= NOW() + INTERVAL '31 days'
        AND (i.maturity_alert_sent_at IS NULL
             OR i.maturity_alert_sent_at < NOW() - INTERVAL '6 days')
    `);

    let sent = 0;
    for (const inv of investments) {
      const daysLeft = Math.ceil((new Date(inv.end_date) - now) / 86400000);
      // Only send at the 30-day or 7-day milestone (±1 day tolerance)
      if (!(daysLeft <= 31 && daysLeft >= 29) && !(daysLeft <= 8 && daysLeft >= 6)) continue;

      await emailService.sendMaturityAlert(
        { email: inv.email, first_name: inv.first_name },
        {
          poolName:       inv.pool_name || inv.pool_id || 'your investment',
          amount:         inv.amount,
          expectedReturn: inv.expected_return || 0,
          endDate:        inv.end_date,
          daysLeft,
        }
      );

      // Mark alert sent
      await pool.query(
        'UPDATE investments SET maturity_alert_sent_at = NOW() WHERE id = $1',
        [inv.id]
      );
      sent++;
    }

    console.log(`[maturityCron] done — ${sent} alert(s) sent`);
  } catch (err) {
    console.error('[maturityCron] error:', err.message);
  }
}

function startMaturityCron() {
  // 08:00 SAST daily (UTC+2 → 06:00 UTC)
  // Processing runs first (marks matured investments), then alerts scan.
  cron.schedule('0 6 * * *', async () => {
    await runMaturityProcessing();
    await runMaturityAlerts();
  }, {
    timezone: 'Africa/Johannesburg',
  });
  console.log('[maturityCron] scheduled: daily at 08:00 SAST — maturity processing + alert scan');
}

module.exports = { startMaturityCron, runMaturityProcessing, runMaturityAlerts };
