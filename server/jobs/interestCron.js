/* ═══════════════════════════════════════════════════════════
   Interest Cron
   Runs on the 1st of each month at 04:00 UTC (06:00 SAST).
   Credits monthly interest to every active investment,
   updates investor total_returns and investment actual_return.
   Idempotent: skips investments already credited this month.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');
const emailService = require('../services/email');
const smsService   = require('../services/sms');
const pushService  = require('../services/pushService');

async function runInterestCrediting() {
  console.log('[interestCron] Running monthly interest crediting…');

  const now  = new Date();
  const yyyy = now.getUTCFullYear();
  const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${yyyy}-${mm}`; // e.g. '2026-06'

  const BATCH_SIZE = 200;
  let offset = 0;
  let totalCredited = 0, totalSkipped = 0, totalErrors = 0;

  while (true) {
    const { rows: investments } = await pool.query(
      `SELECT inv.*, i.email, i.first_name, i.phone
       FROM investments inv
       JOIN investors i ON i.id = inv.investor_id
       WHERE inv.status = 'active'
       ORDER BY inv.id
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );
    if (!investments.length) break;
    offset += investments.length;

    console.log(`[interestCron] Processing batch offset=${offset - investments.length}, count=${investments.length}`);

    let credited = 0;
    let skipped  = 0;
    let errors   = 0;

    for (const investment of investments) {
      const reference = `INT-${investment.id}-${yearMonth}`;

      try {
        // Calculate monthly interest
        const annualRate      = Number(investment.annual_rate) || 0;
        const amount          = Number(investment.amount)      || 0;
        const monthlyInterest = Math.round(amount * annualRate / 12 * 100) / 100;

        if (monthlyInterest <= 0) {
          skipped++;
          continue;
        }

        const poolName    = investment.pool_name || investment.pool_id || 'your investment';
        const description = `Return Earned — ${poolName} (${yearMonth})`;

        // FIX 1 + FIX 2: Single client transaction; idempotency via INSERT ON CONFLICT DO NOTHING
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          // FIX 2: INSERT is the idempotency gate — if the reference already exists, rowCount === 0
          const { rowCount } = await client.query(
            `INSERT INTO transactions
               (id, investor_id, type, amount, status, reference, description, transaction_date, created_at)
             VALUES (gen_random_uuid(), $1, 'return', $2, 'completed', $3, $4, NOW(), NOW())
             ON CONFLICT (reference) DO NOTHING`,
            [investment.investor_id, monthlyInterest, reference, description]
          );

          if (!rowCount) {
            await client.query('ROLLBACK');
            skipped++;
            continue; // already processed — finally releases the client
          }

          // FIX 1: All three writes inside a single transaction
          await client.query(
            `UPDATE investors
                SET total_returns = total_returns + $1, updated_at = NOW()
              WHERE id = $2`,
            [monthlyInterest, investment.investor_id]
          );

          await client.query(
            `UPDATE investments
                SET actual_return = actual_return + $1, updated_at = NOW()
              WHERE id = $2`,
            [monthlyInterest, investment.id]
          );

          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw txErr;
        } finally {
          client.release();
        }

        // Send notifications best-effort after commit
        if (investment.email) {
          emailService.sendReturnCredited?.({
            email: investment.email,
            first_name: investment.first_name,
          }, {
            amount: monthlyInterest,
            poolName: investment.pool_name || investment.pool_id || 'your investment',
            yearMonth,
          }).catch(e => console.warn('[interestCron] email failed:', e.message));
        }
        if (investment.phone) {
          smsService.sendReturnCredited?.(
            investment.phone,
            investment.first_name,
            monthlyInterest,
            investment.pool_name || 'your investment'
          ).catch(e => console.warn('[interestCron] SMS failed:', e.message));
        }
        pushService.sendPushToInvestor(investment.investor_id, {
          title: 'Returns Credited 💰',
          body: `R${monthlyInterest.toFixed(2)} has been credited to your account for ${investment.pool_name || 'your investment'}.`,
          url: '/portal/',
          icon: '/assets/logo.png',
          badge: '/assets/logo.png',
          tag: 'sv-return',
        }).catch(e => console.warn('[interestCron] push failed:', e.message));

        console.log(
          `[interestCron] R${monthlyInterest} interest → investor ${investment.investor_id}, investment ${investment.id}`
        );
        credited++;

      } catch (err) {
        console.error(
          `[interestCron] Failed for investment ${investment.id}:`,
          err.message
        );
        errors++;
      }
    }

    totalCredited += credited;
    totalSkipped  += skipped;
    totalErrors   += errors;
  }

  console.log(
    `[interestCron] Done — ${totalCredited} credited, ${totalSkipped} skipped, ${totalErrors} errors`
  );
}

function startInterestCron() {
  // 1st of each month at 04:00 UTC (06:00 SAST)
  cron.schedule('0 4 1 * *', () => runInterestCrediting().catch(err => console.error('[interestCron] error:', err.message)), { timezone: 'UTC' });
  console.log('[interestCron] Scheduled: 1st of each month at 04:00 UTC (06:00 SAST)');
}

module.exports = { startInterestCron, runInterestCrediting };
