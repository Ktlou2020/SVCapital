/* ═══════════════════════════════════════════════════════════
   Recurring Investment Cron
   Runs on the 1st of each month at 03:00 UTC (05:00 SAST).
   For each investor with recurring_enabled=true, a positive
   recurring_amount, and a recurring_pool_id set:
     • Check wallet_balance >= recurring_amount
     • If yes: deduct wallet, create investment + transaction
     • If no:  log skip

   Auto Top-Up Cron (Paystack charge_authorization)
   Runs daily at 04:00 UTC (06:00 SAST).
   For each investor with auto_topup_enabled=true whose
   auto_topup_day matches today's day-of-month:
     • Call Paystack charge_authorization
     • On success: creditWallet()
     • On failure: log error + push notification
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');

async function runRecurringInvestments() {
  const todayDay = new Date().getDate(); // 1–31
  console.log(`[recurringCron] Running recurring investment processing for day ${todayDay}…`);

  // Fetch investors whose recurring_day matches today AND who have opted in
  const { rows: investors } = await pool.query(
    `SELECT i.id, i.first_name, i.last_name, i.email,
            i.wallet_balance, i.recurring_amount, i.recurring_product_type, i.recurring_day
     FROM investors i
     WHERE i.recurring_enabled = true
       AND i.recurring_amount  > 0
       AND i.recurring_product_type IS NOT NULL
       AND COALESCE(i.recurring_day, 1) = $1
       AND i.status = 'active'`,
    [todayDay]
  );

  console.log(`[recurringCron] ${investors.length} investor(s) scheduled for today (day ${todayDay})`);

  let processed = 0, skipped = 0, errors = 0;

  for (const investor of investors) {
    try {
      const amount      = parseFloat(investor.recurring_amount);
      const balance     = parseFloat(investor.wallet_balance);
      const productType = investor.recurring_product_type;

      if (balance < amount) {
        console.log(`[recurringCron] Skipping ${investor.id} — insufficient funds (have: ${balance}, need: ${amount})`);
        skipped++;
        continue;
      }

      // Find the first open pool for this product type
      const { rows: [pool_row] } = await pool.query(
        `SELECT id, name, annual_rate, term_months, product_type
         FROM investment_pools
         WHERE product_type = $1
           AND status = 'open'
         ORDER BY created_at ASC
         LIMIT 1`,
        [productType]
      );
      if (!pool_row) {
        console.log(`[recurringCron] Skipping ${investor.id} — no open pool for product type '${productType}'`);
        skipped++;
        continue;
      }

      const annualRate     = parseFloat(pool_row.annual_rate) || 0;
      const termMonths     = parseInt(pool_row.term_months, 10) || 6;
      const startDate      = new Date();
      const endDate        = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + termMonths);
      const expectedReturn = Math.round(amount * annualRate * (termMonths / 12) * 100) / 100;
      const investmentId   = 'INV-RC-' + Date.now() + '-' + investor.id.replace(/[^A-Z0-9]/g, '');
      const txRef          = 'RC-' + Date.now();

      // Deduct wallet with floor safety
      const { rowCount } = await pool.query(
        'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2 AND wallet_balance >= $1',
        [amount, investor.id]
      );
      if (!rowCount) {
        console.log(`[recurringCron] Skipping ${investor.id} — balance check failed at deduction`);
        skipped++;
        continue;
      }

      await pool.query(
        `INSERT INTO investments
           (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
            annual_rate, term_months, expected_return, actual_return, product_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,0,$11,NOW(),NOW())`,
        [
          investmentId, investor.id, pool_row.id, pool_row.name,
          amount,
          startDate.toISOString().slice(0, 10),
          endDate.toISOString().slice(0, 10),
          annualRate, termMonths, expectedReturn, pool_row.product_type,
        ]
      );

      await pool.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, transaction_date, investment_id, pool_id, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,'investment',$2,'completed',$3,$4,NOW(),$5,$6,NOW(),NOW())`,
        [investor.id, amount, txRef, `Recurring investment — ${pool_row.name}`, investmentId, pool_row.id]
      );

      await pool.query(
        'UPDATE investors SET total_invested = COALESCE(total_invested,0) + $1, updated_at = NOW() WHERE id = $2',
        [amount, investor.id]
      );

      setImmediate(() => emailService.sendInvestmentCreated(investor, {
        poolName: pool_row.name, amount, annualRate, termMonths, expectedReturn,
        endDate:  endDate.toISOString(),
      }).catch(err => console.error('[email] sendInvestmentCreated (recurring) failed:', err.message)));

      console.log(`[recurringCron] R${amount} into pool ${pool_row.id} (${productType}) for investor ${investor.id}`);
      processed++;

    } catch (err) {
      console.error(`[recurringCron] Error processing investor ${investor.id}:`, err.message);
      errors++;
    }
  }

  console.log(`[recurringCron] Done — ${processed} processed, ${skipped} skipped, ${errors} errors`);
}

/* ═══════════════════════════════════════════════════════════
   AUTO WALLET TOP-UP via Paystack charge_authorization
   ═══════════════════════════════════════════════════════════ */
async function runAutoTopUps() {
  const todayDay = new Date().getDate(); // 1-31
  console.log(`[autoTopUp] Running for day ${todayDay}…`);

  const secretKey = (process.env.PAYSTACK_SECRET_KEY || '').trim();
  if (!secretKey) {
    console.warn('[autoTopUp] PAYSTACK_SECRET_KEY not set — skipping auto top-up run');
    return;
  }

  const { rows: investors } = await pool.query(
    `SELECT i.id, i.first_name, i.last_name, i.email, i.auto_topup_amount,
            pa.authorization_code, pa.email AS auth_email
     FROM investors i
     JOIN paystack_authorizations pa ON pa.investor_id = i.id
     WHERE i.auto_topup_enabled = true
       AND i.auto_topup_amount  > 0
       AND i.auto_topup_day     = $1
       AND i.status             = 'active'`,
    [todayDay]
  );

  console.log(`[autoTopUp] ${investors.length} investor(s) scheduled for top-up today`);
  let processed = 0, failed = 0;

  for (const inv of investors) {
    const amount   = parseFloat(inv.auto_topup_amount);
    const amtKobo  = Math.round(amount * 100);
    const reference = `ATU-${Date.now()}-${inv.id.replace(/[^A-Z0-9]/g, '')}`;

    try {
      const psRes = await fetch('https://api.paystack.co/transaction/charge_authorization', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorization_code: inv.authorization_code,
          email:              inv.auth_email,
          amount:             amtKobo,
          reference,
          metadata: {
            investor_id:   inv.id,
            wallet_credit: amount,
            source:        'auto_topup',
          },
        }),
      });
      const psData = await psRes.json();

      if (psData.status && psData.data?.status === 'success') {
        // Re-use the shared creditWallet helper from payments.js
        const { rows: [invRow] } = await pool.query('SELECT * FROM investors WHERE id=$1', [inv.id]);
        if (invRow) {
          // Inline credit (same logic as creditWallet in payments.js)
          await pool.query(
            'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at=NOW() WHERE id=$2',
            [amount, inv.id]
          );
          const desc = `Auto top-up via Paystack — R${amount.toLocaleString('en-ZA')} credited`;
          await pool.query(
            `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description, transaction_date, created_at)
             VALUES (gen_random_uuid(),$1,'deposit',$2,'completed',$3,$4,NOW(),NOW())`,
            [inv.id, amount, reference, desc]
          );
          emailService.sendDepositConfirmed(invRow, amount, reference, 'Auto Top-Up (Paystack)').catch(() => {});
          console.log(`[autoTopUp] R${amount} credited to ${inv.id}, ref: ${reference}`);
          processed++;
        }
      } else {
        console.error(`[autoTopUp] Charge failed for ${inv.id}:`, psData.message || JSON.stringify(psData));
        // Disable auto top-up after failure so we don't keep retrying a bad card
        await pool.query('UPDATE investors SET auto_topup_enabled=false WHERE id=$1', [inv.id]);
        failed++;
      }
    } catch (err) {
      console.error(`[autoTopUp] Error for investor ${inv.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[autoTopUp] Done — ${processed} credited, ${failed} failed`);
}

function startRecurringCron() {
  // Daily at 03:00 UTC (05:00 SAST) — processes investors whose recurring_day matches today
  cron.schedule('0 3 * * *', runRecurringInvestments, { timezone: 'UTC' });
  console.log('[recurringCron] Scheduled: daily at 03:00 UTC (each investor runs on their chosen day)');

  // Daily at 04:00 UTC (06:00 SAST) — auto wallet top-ups
  cron.schedule('0 4 * * *', runAutoTopUps, { timezone: 'UTC' });
  console.log('[recurringCron] Auto top-up scheduled: daily at 04:00 UTC');
}

module.exports = { startRecurringCron, runRecurringInvestments, runAutoTopUps };
