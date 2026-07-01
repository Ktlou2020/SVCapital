/* ═══════════════════════════════════════════════════════════
   Maturity Engine (consolidated — replaces the old payoutCron)
   Timing (South African time, Africa/Johannesburg):
     • 23:00 on an investment's maturity day → runMaturityProcessing:
         - mark the investment 'matured'
         - mark the pool 'matured' (its end_date has passed)
         - execute the maturity instruction immediately (reinvested/switched
           capital is fee-free and rolls into the pool of the relevant product
           that is OPEN and closing at month-end; wallet fallback if none):
             · payout_all     → whole amount to wallet
             · payout_return  → returns to wallet, capital reinvested (same product)
             · payout_custom  → custom amount to wallet, remainder reinvested (same product)
             · reinvest       → whole amount reinvested (same product)
             · switch_product → whole amount switched into another product
             · custom_switch  → custom amount to wallet, remainder switched into another product
       The pool cycler then opens the NEXT month's fundraising pool at 00:01.
   Also: runMaturityAlerts sends 30-day / 7-day advance warnings.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');
const smsService   = require('../services/sms');

// Reinvestments are NOT charged a platform fee — the full matured amount rolls over.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ────────────────────────────────────────────────────────────
   23:00 — mark matured, mature the pools, execute payouts.
   Reinvest instructions roll into the open pool closing at month-end.
   ──────────────────────────────────────────────────────────── */
async function runMaturityProcessing() {
  console.log('[maturity] running maturity processing (23:00)…');

  // 1. Mature the POOLS whose end_date (maturity date) has passed.
  const { rowCount: poolsMatured } = await pool.query(`
    UPDATE investment_pools
       SET status = 'matured', updated_at = NOW()
     WHERE end_date IS NOT NULL
       AND end_date <= NOW()
       AND status IN ('open','filling','active','waitlist')
  `);
  if (poolsMatured) console.log(`[maturity] ${poolsMatured} pool(s) set to matured`);

  // 2. Find investments maturing now that still need processing.
  const { rows: investments } = await pool.query(`
    SELECT i.*, inv.email, inv.first_name, inv.last_name, inv.phone
    FROM investments i
    JOIN investors inv ON inv.id = i.investor_id
    WHERE i.status = 'active'
      AND i.end_date IS NOT NULL
      AND i.end_date <= NOW()
      AND i.maturity_processed_at IS NULL
  `);

  let processed = 0, reinvestPending = 0;
  for (const inv of investments) {
    try {
      const principal    = parseFloat(inv.amount) || 0;
      const actualReturn = parseFloat(inv.actual_return) || parseFloat(inv.expected_return) || 0;
      const gross        = round2(principal + actualReturn);
      const instruction  = inv.maturity_instruction || 'reinvest';
      const poolName     = inv.pool_name || inv.pool_id || 'your investment';
      const custom       = Math.max(0, Math.min(gross, round2(parseFloat(inv.custom_payout_amount) || 0)));
      const switchType   = inv.switch_product_type || inv.product_type;

      // Mark matured first.
      await pool.query(`UPDATE investments SET status = 'matured', updated_at = NOW() WHERE id = $1`, [inv.id]);

      // Execute the maturity instruction. Reinvested/switched capital is
      // fee-free and rolls into the pool of the relevant product that is open
      // and closing at month-end.
      switch (instruction) {
        case 'payout_all':
          await creditWallet(inv, gross, actualReturn, `Maturity payout — ${poolName}`);
          break;

        case 'payout_return':
          // Returns paid out; capital reinvested into the same product.
          await creditWallet(inv, actualReturn, actualReturn, `Maturity return payout — ${poolName}`);
          await reinvestAmount(inv, principal, inv.product_type, poolName);
          reinvestPending++;
          break;

        case 'payout_custom': {
          // Pay out a custom amount; reinvest the remainder into the same product.
          await creditWallet(inv, custom, Math.min(actualReturn, custom), `Maturity custom payout — ${poolName}`);
          await reinvestAmount(inv, round2(gross - custom), inv.product_type, poolName);
          reinvestPending++;
          break;
        }

        case 'custom_switch': {
          // Pay out a custom amount; switch the remainder into another product.
          await creditWallet(inv, custom, Math.min(actualReturn, custom), `Maturity custom payout — ${poolName}`);
          await reinvestAmount(inv, round2(gross - custom), switchType, poolName);
          reinvestPending++;
          break;
        }

        case 'switch_product':
          // Switch the full matured amount into another product.
          await reinvestAmount(inv, gross, switchType, poolName);
          reinvestPending++;
          break;

        case 'reinvest':
        default:
          await reinvestAmount(inv, gross, inv.product_type, poolName);
          reinvestPending++;
          break;
      }

      // All money movement done — close out the maturity.
      await pool.query(`UPDATE investments SET maturity_processed_at = NOW(), updated_at = NOW() WHERE id = $1`, [inv.id]);

      // Notify the investor.
      await emailService.sendInvestmentMatured(
        { email: inv.email, first_name: inv.first_name },
        { poolName, amount: principal, actualReturn }
      ).catch(err => console.error('[maturity] email failed:', err.message));
      await smsService.sendMaturityAlert(
        inv.phone, inv.first_name, principal, poolName
      ).catch(err => console.error('[maturity] SMS failed:', err.message));

      processed++;
    } catch (err) {
      console.error(`[maturity] failed to process investment ${inv.id}:`, err.message);
    }
  }

  console.log(`[maturity] done — ${processed} matured (${reinvestPending} reinvested/rolled)`);
  return processed;
}

/* ────────────────────────────────────────────────────────────
   creditWallet — pay `amount` to the investor's wallet as a payout.
   `returnPortion` is the part counted toward total_returns.
   ──────────────────────────────────────────────────────────── */
async function creditWallet(inv, amount, returnPortion, description) {
  const amt = round2(amount);
  if (amt <= 0) return;
  await pool.query(
    'UPDATE investors SET wallet_balance = wallet_balance + $1, total_returns = COALESCE(total_returns,0) + $2, updated_at = NOW() WHERE id = $3',
    [amt, round2(returnPortion || 0), inv.investor_id]
  );
  await pool.query(
    `INSERT INTO transactions
       (id, investor_id, type, amount, status, reference, description, investment_id, transaction_date, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,'payout',$2,'completed',$3,$4,$5,NOW(),NOW(),NOW())`,
    [inv.investor_id, amt, 'MAT-' + inv.id, description, inv.id]
  );
}

/* ────────────────────────────────────────────────────────────
   reinvestAmount — roll `amount` (fee-free) into the pool of
   `productType` that is currently OPEN and closing at month-end (the
   active fundraising pool). If no such pool exists, the amount is paid
   to the investor's wallet instead. Does NOT mark maturity_processed_at
   (the caller does that once all money movement is complete).
   ──────────────────────────────────────────────────────────── */
async function reinvestAmount(inv, amount, productType, sourcePoolName) {
  const amt = round2(amount);
  if (amt <= 0) return;
  try {
    const { rows: targets } = await pool.query(
      `SELECT * FROM investment_pools
        WHERE status = 'open'
          AND product_type = $1
          AND (max_investment IS NULL OR COALESCE(current_invested,0) < max_investment)
        ORDER BY end_date ASC NULLS LAST, created_at ASC
        LIMIT 1`,
      [productType || 'general']
    );
    const target = targets[0];

    if (!target) {
      // No open closing pool for this product — pay the amount to the wallet.
      await creditWallet(inv, amt, 0, `Maturity payout — ${sourcePoolName} (no open ${productType || ''} pool to reinvest into)`);
      console.log(`[maturity] no open ${productType} pool — paid R${amt} to wallet for ${inv.investor_id}`);
      return;
    }

    const termMonths   = target.term_months || 6;
    const startDate    = new Date();
    const endDate      = new Date(startDate); endDate.setMonth(endDate.getMonth() + termMonths);
    const newExpReturn = round2(amt * (parseFloat(target.annual_rate) || 0) * (termMonths / 12));
    const newInvId     = 'INV-RI-' + Date.now() + '-' + String(inv.investor_id).replace(/[^A-Z0-9]/gi, '').slice(-6);
    const switched     = target.product_type !== inv.product_type;

    await pool.query(
      `INSERT INTO investments
         (id, investor_id, pool_id, pool_name, amount, status, start_date, end_date,
          annual_rate, term_months, expected_return, actual_return, product_type,
          maturity_instruction, is_reinvestment, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,0,$11,'reinvest',true,NOW(),NOW())`,
      [newInvId, inv.investor_id, target.id, target.name, amt,
       startDate.toISOString().slice(0,10), endDate.toISOString().slice(0,10),
       target.annual_rate, termMonths, newExpReturn, target.product_type]
    );

    const verb = switched ? 'switch' : 'reinvestment';
    await pool.query(
      `INSERT INTO transactions
         (id, investor_id, type, amount, status, reference, description, investment_id, pool_id, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,'investment',$2,'completed',$3,$4,$5,$6,NOW(),NOW(),NOW())`,
      [inv.investor_id, amt, 'REINV-' + inv.id, `Maturity ${verb} — ${sourcePoolName} → ${target.name}`, newInvId, target.id]
    );

    await pool.query(
      'UPDATE investment_pools SET current_invested = COALESCE(current_invested,0) + $1, raised_amount = COALESCE(raised_amount,0) + $1, updated_at = NOW() WHERE id = $2',
      [amt, target.id]
    );

    console.log(`[maturity] ${verb} ${inv.id} → ${newInvId} (R${amt}, fee-free) into closing pool ${target.id}`);
  } catch (err) {
    console.error(`[maturity] reinvestAmount failed for ${inv.id}:`, err.message);
  }
}

/* ────────────────────────────────────────────────────────────
   Advance maturity alerts (30-day / 7-day). Unchanged behaviour.
   ──────────────────────────────────────────────────────────── */
async function runMaturityAlerts() {
  console.log('[maturity] running maturity alert scan…');
  try {
    const now = new Date();
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
      if (!(daysLeft <= 31 && daysLeft >= 29) && !(daysLeft <= 8 && daysLeft >= 6)) continue;

      await emailService.sendMaturityAlert(
        { email: inv.email, first_name: inv.first_name },
        { poolName: inv.pool_name || inv.pool_id || 'your investment',
          amount: inv.amount, expectedReturn: inv.expected_return || 0,
          endDate: inv.end_date, daysLeft }
      );
      await pool.query('UPDATE investments SET maturity_alert_sent_at = NOW() WHERE id = $1', [inv.id]);
      sent++;
    }
    console.log(`[maturity] done — ${sent} alert(s) sent`);
  } catch (err) {
    console.error('[maturity] alert error:', err.message);
  }
}

function startMaturityCron() {
  // 23:00 SAST — mature investments/pools + execute payout instructions.
  cron.schedule('0 23 * * *', async () => {
    await runMaturityProcessing();
    await runMaturityAlerts();
  }, { timezone: 'Africa/Johannesburg' });
  console.log('[maturity] scheduled: daily at 23:00 SAST — maturity processing + alerts');
}

module.exports = { startMaturityCron, runMaturityProcessing, runMaturityAlerts };
