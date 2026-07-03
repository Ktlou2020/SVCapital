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
const pushService  = require('../services/pushService');

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
      const platformFee = Math.round(amount * 0.01 * 100) / 100;
      const totalDeduct = Math.round((amount + platformFee) * 100) / 100;

      // Find the first open pool for this product type
      const { rows: [pool_row] } = await pool.query(
        `SELECT id, name, annual_rate, term_months, product_type, min_investment
         FROM investment_pools
         WHERE product_type = $1
           AND status = 'open'
         ORDER BY created_at ASC
         LIMIT 1`,
        [productType]
      );
      if (!pool_row) {
        console.log(`[recurringCron] Skipping ${investor.id} — no open pool for product type '${productType}'`);
        pushService.sendPushToInvestor(investor.id, {
          title: 'Recurring Investment Skipped',
          body:  `No open pool is available for your chosen product this month. We'll try again next month.`,
          url:   '/portal/',
        }).catch(() => {});
        emailService.sendAlert(investor, {
          subject: 'Recurring Investment Skipped — No Open Pool',
          message: `Your recurring investment of R${amount.toLocaleString('en-ZA')} was skipped this month because no open pool is currently available for your chosen product type. We will attempt again next month.`,
        }).catch(() => {});
        skipped++;
        continue;
      }

      const minInvest = parseFloat(pool_row.min_investment) || 0;
      if (amount < minInvest) {
        console.log(`[recurringCron] Skipping ${investor.id} — amount R${amount} below pool minimum R${minInvest}`);
        pushService.sendPushToInvestor(investor.id, {
          title: 'Recurring Investment Skipped',
          body:  `Your recurring amount of R${amount.toLocaleString('en-ZA')} is below the minimum of R${minInvest.toLocaleString('en-ZA')} for this product. Please update your settings.`,
          url:   '/portal/',
        }).catch(() => {});
        emailService.sendAlert(investor, {
          subject: 'Recurring Investment Skipped — Below Minimum',
          message: `Your recurring investment of R${amount.toLocaleString('en-ZA')} could not be processed because it is below the pool minimum of R${minInvest.toLocaleString('en-ZA')}. Please log in and update your recurring investment amount.`,
        }).catch(() => {});
        skipped++;
        continue;
      }

      if (balance < totalDeduct) {
        console.log(`[recurringCron] Skipping ${investor.id} — insufficient funds (have: ${balance}, need: ${totalDeduct} incl. fee)`);
        pushService.sendPushToInvestor(investor.id, {
          title: 'Recurring Investment Failed',
          body:  `Insufficient wallet balance. You need R${totalDeduct.toLocaleString('en-ZA')} (R${amount.toLocaleString('en-ZA')} + R${platformFee.toLocaleString('en-ZA')} fee) but have R${balance.toLocaleString('en-ZA')}. Please top up your wallet.`,
          url:   '/portal/',
        }).catch(() => {});
        emailService.sendAlert(investor, {
          subject: 'Recurring Investment Failed — Insufficient Funds',
          message: `Your recurring investment of R${amount.toLocaleString('en-ZA')} could not be processed. Your wallet balance (R${balance.toLocaleString('en-ZA')}) is below the required R${totalDeduct.toLocaleString('en-ZA')} (investment + 1% platform fee). Please top up your wallet to ensure next month's investment goes through.`,
        }).catch(() => {});
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

      // Deduct investment amount + 1% platform fee from wallet atomically
      const { rowCount } = await pool.query(
        'UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2 AND wallet_balance >= $1',
        [totalDeduct, investor.id]
      );
      if (!rowCount) {
        console.log(`[recurringCron] Skipping ${investor.id} — balance check failed at deduction`);
        skipped++;
        continue;
      }

      await pool.query(
        `INSERT INTO investments
           (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
            annual_rate, term_months, expected_return, actual_return, product_type, is_reinvestment, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,0,$11,false,NOW(),NOW())`,
        [
          investmentId, investor.id, pool_row.id, pool_row.name,
          amount,
          startDate.toISOString().slice(0, 10),
          endDate.toISOString().slice(0, 10),
          annualRate, termMonths, expectedReturn, pool_row.product_type,
        ]
      );

      // Investment transaction
      await pool.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, transaction_date, investment_id, pool_id, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,'investment',$2,'completed',$3,$4,NOW(),$5,$6,NOW(),NOW())`,
        [investor.id, amount, txRef, `Recurring investment — ${pool_row.name}`, investmentId, pool_row.id]
      );

      // Platform fee transaction
      await pool.query(
        `INSERT INTO transactions
           (id, investor_id, type, amount, status, reference, description, transaction_date, investment_id, pool_id, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,'fee',$2,'completed',$3,$4,NOW(),$5,$6,NOW(),NOW())`,
        [investor.id, platformFee, txRef + '-FEE', `Platform fee — ${pool_row.name}`, investmentId, pool_row.id]
      );

      await pool.query(
        'UPDATE investors SET total_invested = COALESCE(total_invested,0) + $1, updated_at = NOW() WHERE id = $2',
        [amount, investor.id]
      );

      setImmediate(() => emailService.sendInvestmentCreated(investor, {
        poolName: pool_row.name, amount, annualRate, termMonths, expectedReturn,
        endDate:  endDate.toISOString(),
      }).catch(err => console.error('[email] sendInvestmentCreated (recurring) failed:', err.message)));

      pushService.sendPushToInvestor(investor.id, {
        title: 'Recurring Investment Placed',
        body:  `R${amount.toLocaleString('en-ZA')} invested into ${pool_row.name}. Matures in ${termMonths} months.`,
        url:   '/portal/',
      }).catch(() => {});

      console.log(`[recurringCron] R${amount} (+R${platformFee} fee) into pool ${pool_row.id} (${productType}) for investor ${investor.id}`);
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
  const today    = new Date();
  const todayDay = today.getDate(); // 1-31
  // Deterministic date-based reference prefix prevents double-charging on cron restarts
  const todayStr = today.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  console.log(`[autoTopUp] Running for day ${todayDay} (${todayStr})…`);

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
  let processed = 0, skipped = 0, failed = 0;

  for (const inv of investors) {
    const amount   = parseFloat(inv.auto_topup_amount);
    const amtKobo  = Math.round(amount * 100);
    // Deterministic reference: same investor+date always produces the same ref.
    // Paystack rejects a duplicate reference → idempotent if the cron fires twice.
    const reference = `ATU-${todayStr}-${inv.id.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`;

    try {
      // Skip if we already successfully credited this investor today (local idempotency)
      const { rows: alreadyDone } = await pool.query(
        `SELECT id FROM transactions
         WHERE investor_id = $1 AND reference = $2 AND status = 'completed'`,
        [inv.id, reference]
      );
      if (alreadyDone.length > 0) {
        console.log(`[autoTopUp] Skipping ${inv.id} — already credited today (${reference})`);
        skipped++;
        continue;
      }

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
        const { rows: [invRow] } = await pool.query('SELECT * FROM investors WHERE id=$1', [inv.id]);
        if (invRow) {
          emailService.sendDepositConfirmed(invRow, amount, reference, 'Auto Top-Up (Paystack)').catch(() => {});
        }
        pushService.sendPushToInvestor(inv.id, {
          title: 'Wallet Topped Up',
          body:  `R${amount.toLocaleString('en-ZA')} has been added to your wallet.`,
          url:   '/portal/',
        }).catch(() => {});
        console.log(`[autoTopUp] R${amount} credited to ${inv.id}, ref: ${reference}`);
        processed++;
      } else {
        const errMsg = (psData.message || '').toLowerCase();
        console.error(`[autoTopUp] Charge failed for ${inv.id}:`, psData.message || JSON.stringify(psData));

        // Only permanently disable for definitive card failures, not transient errors.
        // Paystack 5xx, network timeouts, or generic errors should NOT disable the feature.
        const isCardError = errMsg.includes('invalid') || errMsg.includes('expired') ||
          errMsg.includes('do not honor') || errMsg.includes('declined') ||
          errMsg.includes('stolen') || errMsg.includes('lost') ||
          errMsg.includes('invalid authorization') || errMsg.includes('blocked');

        if (isCardError) {
          await pool.query('UPDATE investors SET auto_topup_enabled=false WHERE id=$1', [inv.id]);
          console.log(`[autoTopUp] Auto top-up disabled for ${inv.id} (card error: ${psData.message})`);
        }

        // Notify investor of the failure
        pushService.sendPushToInvestor(inv.id, {
          title: 'Auto Top-Up Failed',
          body:  isCardError
            ? 'Your card could not be charged. Auto top-up has been paused — please update your card.'
            : 'Your scheduled wallet top-up could not be completed. We will retry tomorrow.',
          url: '/portal/',
        }).catch(() => {});
        failed++;
      }
    } catch (err) {
      console.error(`[autoTopUp] Error for investor ${inv.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[autoTopUp] Done — ${processed} credited, ${skipped} skipped, ${failed} failed`);
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
