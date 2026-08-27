/* ═══════════════════════════════════════════════════════════
   Maturity Engine (consolidated — replaces the old payoutCron)
   Timing (South African time, Africa/Johannesburg):
     • 23:00 on an investment's maturity day → cycleExpiredPools() first
       (ensures the next month's pool is open before reinvestment looks for it),
       then runMaturityProcessing:
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
             · switch_amount  → named amount switched into another product, remainder
                                reinvested (same product) — the only instruction that
                                splits a maturity across two products, both fee-free
       The pool cycler then opens the NEXT month's fundraising pool at 00:01.
   Also: runMaturityAlerts sends 30-day / 7-day advance warnings.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron         = require('node-cron');
const pool         = require('../db/pool');
const emailService = require('../services/email');
const smsService   = require('../services/sms');
const pushService  = require('../services/pushService');
const { cycleExpiredPools } = require('./poolCyclerCron');

// Reinvestments are NOT charged a platform fee — the full matured amount rolls over.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ────────────────────────────────────────────────────────────
   postedReturnFor — the return an investment has actually earned,
   or null when nothing has been posted yet.

   This used to be:

     parseFloat(inv.actual_return) || parseFloat(inv.expected_return) || 0

   which paid expected_return — the projection computed from the contracted
   rate when the investment was created. Returns are not posted on the
   investment; they are posted on the POOL, as investment_pools.actual_rate,
   which is what the admin close-out writes. investments.actual_return is only
   written by interestCron, and interestCron is disabled ("Interest is credited
   at maturity only"). So the posted rate never reached the money path: a pool
   that earned 7% and a pool that earned 4% both paid out the projected figure.

   actual_rate is the return FOR THE POOL'S PERIOD, already — not per annum.
   It is not prorated over term_months. This is the same rule Utils.postedReturn
   applies in the portal, so what an investor is shown and what they are paid
   now come from one definition.

   Returns null — not 0 — when nothing is posted, so the caller can refuse
   rather than pay a number nobody stands behind. A pool that genuinely
   returned zero cannot currently be told apart from one whose rate has not
   been entered (the column defaults to 0), so that case needs an explicit
   decision rather than a guess.
   ──────────────────────────────────────────────────────────── */
function postedReturnFor(inv) {
  const recorded = parseFloat(inv.actual_return) || 0;
  if (recorded > 0) return round2(recorded);

  const rate = parseFloat(inv.pool_actual_rate) || 0;
  if (rate > 0) return round2((parseFloat(inv.amount) || 0) * rate);

  return null;
}

/* ────────────────────────────────────────────────────────────
   23:00 — mark matured, mature the pools, execute payouts.
   Reinvest instructions roll into the open pool closing at month-end.
   ──────────────────────────────────────────────────────────── */
async function runMaturityProcessing() {
  console.log('[maturity] running maturity processing (23:00)…');

  // FIX 10: Removed bulk pool status UPDATE from here. Pool status is now
  // updated inside each investment's own transaction, only after that
  // investment is fully processed and only when no further unprocessed
  // investments remain in the pool.

  // Find investments maturing now that still need processing.
  const { rows: investments } = await pool.query(`
    SELECT i.*, inv.email, inv.first_name, inv.last_name, inv.phone,
           p.actual_rate AS pool_actual_rate
    FROM investments i
    JOIN investors inv ON inv.id = i.investor_id
    LEFT JOIN investment_pools p ON p.id = i.pool_id
    WHERE i.status = 'active'
      AND i.end_date IS NOT NULL
      AND i.end_date <= NOW()
      AND i.maturity_processed_at IS NULL
  `);

  let processed = 0, reinvestPending = 0;
  const awaitingRate = [];
  for (const inv of investments) {
    /* Nothing posted, nothing paid. Leaving maturity_processed_at NULL means
       this investment is picked up again on the next nightly run, so posting
       the rate is all that is needed to release it. A late correct payment is
       recoverable; a wrong credit already spent is not. */
    const postedReturn = postedReturnFor(inv);
    if (postedReturn === null) {
      awaitingRate.push(inv);
      continue;
    }

    // FIX 6: Each investment gets its own client + transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // FIX 6: Lock this specific investment row within the transaction.
      // SKIP LOCKED means a concurrent cron instance skips rows we have locked.
      const { rows: locked } = await client.query(
        `SELECT id FROM investments
          WHERE id = $1
            AND maturity_processed_at IS NULL
          FOR UPDATE SKIP LOCKED`,
        [inv.id]
      );
      if (!locked.length) {
        // Another instance has claimed this row — skip it.
        await client.query('ROLLBACK');
        continue; // finally releases the client
      }

      const principal    = parseFloat(inv.amount) || 0;
      const actualReturn = postedReturn;   // posted, never projected — see postedReturnFor
      const gross        = round2(principal + actualReturn);
      const rawInstruction = inv.maturity_instruction || 'reinvest';
      // Delivery bike investments without an explicit non-reinvest instruction pay out to wallet
      const instruction  = (rawInstruction === 'reinvest' && (inv.product_type || '').includes('delivery_bike'))
        ? 'payout_all' : rawInstruction;
      const poolName     = inv.pool_name || inv.pool_id || 'your investment';
      const custom       = Math.max(0, Math.min(gross, round2(parseFloat(inv.custom_payout_amount) || 0)));
      const switchType   = inv.switch_product_type || inv.product_type;

      // Mark investment matured inside the transaction.
      await client.query(
        `UPDATE investments SET status = 'matured', updated_at = NOW() WHERE id = $1`,
        [inv.id]
      );

      // Execute the maturity instruction. All money movement uses the same client
      // so it participates in this transaction.
      switch (instruction) {
        case 'payout_all':
          await creditWallet(client, inv, gross, actualReturn, `Maturity payout — ${poolName}`);
          break;

        case 'payout_return':
          // Returns paid out; capital reinvested into the same product.
          await creditWallet(client, inv, actualReturn, actualReturn, `Maturity return payout — ${poolName}`);
          await reinvestAmount(client, inv, principal, inv.product_type, poolName);
          reinvestPending++;
          break;

        case 'payout_custom': {
          // Pay out a custom amount; reinvest the remainder into the same product.
          await creditWallet(client, inv, custom, Math.min(actualReturn, custom), `Maturity custom payout — ${poolName}`);
          await reinvestAmount(client, inv, round2(gross - custom), inv.product_type, poolName);
          reinvestPending++;
          break;
        }

        case 'custom_switch': {
          // Pay out a custom amount; switch the remainder into another product.
          await creditWallet(client, inv, custom, Math.min(actualReturn, custom), `Maturity custom payout — ${poolName}`);
          await reinvestAmount(client, inv, round2(gross - custom), switchType, poolName);
          reinvestPending++;
          break;
        }

        case 'switch_amount': {
          /* Split the maturity across two products: the named amount switches,
             the balance stays where it is. The only instruction that puts a
             named amount into a PRODUCT rather than the wallet.

             Both legs go through reinvestAmount, so both are fee-free. Doing
             this by paying the balance out and re-investing it from the wallet
             would cost the client the 1% platform fee on that balance, which
             is the whole reason this instruction exists.

             `custom` is already clamped to [0, gross], and reinvestAmount
             returns early on a non-positive amount — so custom == gross
             degenerates to switch_product and custom == 0 to reinvest, both
             without writing an empty investment. */
          await reinvestAmount(client, inv, custom, switchType, poolName, '-S');
          await reinvestAmount(client, inv, round2(gross - custom), inv.product_type, poolName, '-R');
          reinvestPending++;
          break;
        }

        case 'switch_product':
          // Switch the full matured amount into another product.
          await reinvestAmount(client, inv, gross, switchType, poolName);
          reinvestPending++;
          break;

        case 'reinvest':
        default:
          await reinvestAmount(client, inv, gross, inv.product_type, poolName);
          reinvestPending++;
          break;
      }

      // FIX 6: Set maturity_processed_at in the SAME transaction as the wallet/reinvest
      // operations — if anything fails, ROLLBACK ensures it is NOT set.
      await client.query(
        `UPDATE investments SET maturity_processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [inv.id]
      );

      // FIX 10: Mark the pool 'matured' inside this transaction, but only once all
      // investments in the pool have been processed (maturity_processed_at IS NOT NULL).
      // Because we set maturity_processed_at just above, the current investment is
      // already excluded by the NOT EXISTS check.
      if (inv.pool_id) {
        const poolUpdateResult = await client.query(
          `UPDATE investment_pools
              SET status = 'matured', updated_at = NOW()
            WHERE id = $1
              AND end_date IS NOT NULL
              AND end_date <= NOW()
              AND status IN ('open','filling','active','waitlist')
              AND NOT EXISTS (
                SELECT 1 FROM investments
                 WHERE pool_id = $1
                   AND maturity_processed_at IS NULL
              )`,
          [inv.pool_id]
        );
        // Last investment processed — compute and persist the maturity instruction summary.
        if (poolUpdateResult.rowCount > 0) {
          try {
            const summary = await computePoolMaturitySummary(client, inv.pool_id);
            await client.query(
              `UPDATE investment_pools SET maturity_summary = $1 WHERE id = $2`,
              [JSON.stringify(summary), inv.pool_id]
            );
            console.log(`[maturity] summary stored for pool ${inv.pool_id}:`, JSON.stringify(summary));
          } catch (sumErr) {
            console.error(`[maturity] summary compute failed for pool ${inv.pool_id}:`, sumErr.message);
          }
        }
      }

      await client.query('COMMIT');

      // Notifications are best-effort and sent after the transaction commits.
      await emailService.sendInvestmentMatured(
        { email: inv.email, first_name: inv.first_name },
        { poolName, amount: principal, actualReturn }
      ).catch(err => console.error('[maturity] email failed:', err.message));
      await smsService.sendMaturityAlert(
        inv.phone, inv.first_name, principal, poolName
      ).catch(err => console.error('[maturity] SMS failed:', err.message));
      pushService.sendPushToInvestor(inv.investor_id, {
        title: 'Investment Matured 🎉',
        body: `Your ${poolName} investment has matured. R${principal.toFixed(2)} + returns have been processed.`,
        url: '/portal/',
        icon: '/assets/logo.png',
        badge: '/assets/logo.png',
        tag: 'sv-maturity',
      }).catch(err => console.error('[maturity] push failed:', err.message));

      processed++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[maturity] failed to process investment ${inv.id}:`, err.message);
    } finally {
      client.release();
    }
  }

  if (awaitingRate.length) {
    /* Loud, and grouped by pool — the fix is one close-out per pool, not one
       action per investor. warn rather than log so it stands out in Railway. */
    const byPool = {};
    for (const inv of awaitingRate) {
      const k = inv.pool_id || '(no pool)';
      byPool[k] = byPool[k] || { n: 0, capital: 0, name: inv.pool_name || '' };
      byPool[k].n++;
      byPool[k].capital += parseFloat(inv.amount) || 0;
    }
    console.warn(
      `[maturity] HELD BACK — ${awaitingRate.length} matured investment(s) have no posted ` +
      `return and were NOT paid. Post the actual rate on the pool; they settle on the next run.`);
    for (const [poolId, v] of Object.entries(byPool)) {
      console.warn(`[maturity]   ${poolId} ${v.name} — ${v.n} investment(s), ` +
                   `R${v.capital.toFixed(2)} of capital waiting`);
    }
  }

  console.log(`[maturity] done — ${processed} matured (${reinvestPending} reinvested/rolled)` +
              (awaitingRate.length ? `, ${awaitingRate.length} held back awaiting a posted rate` : ''));
  return processed;
}

/* ────────────────────────────────────────────────────────────
   computePoolMaturitySummary — after all investments in a pool
   have been processed, aggregate the maturity instructions into
   a breakdown object: { [instruction]: { count, total } }.
   Uses the same `client` so it runs inside the final investment's
   transaction before COMMIT.
   ──────────────────────────────────────────────────────────── */
async function computePoolMaturitySummary(client, poolId) {
  const { rows } = await client.query(`
    SELECT
      COALESCE(NULLIF(maturity_instruction,''), 'auto_reinvest') AS instruction,
      COUNT(*)::int                                               AS count,
      SUM(amount + COALESCE(actual_return, expected_return, 0))  AS total
    FROM investments
    WHERE pool_id = $1
      AND maturity_processed_at IS NOT NULL
    GROUP BY 1
  `, [poolId]);

  const summary = {};
  for (const r of rows) {
    summary[r.instruction] = { count: r.count, total: round2(parseFloat(r.total) || 0) };
  }
  return summary;
}

/* ────────────────────────────────────────────────────────────
   creditWallet — pay `amount` to the investor's wallet as a payout.
   `returnPortion` is the part counted toward total_returns.
   `reference` overrides the default 'MAT-<inv.id>' — supply a distinct
   suffix (e.g. 'MAT-FALLBACK-<id>') when calling from reinvestAmount
   so that a fallback credit and a primary credit on the same investment
   don't collide on the unique reference index (FIX 8).
   All writes go through `client` so they participate in the caller's
   transaction (FIX 6).
   ──────────────────────────────────────────────────────────── */
async function creditWallet(client, inv, amount, returnPortion, description, reference) {
  const amt = round2(amount);
  if (amt <= 0) return;
  const ref = reference || ('MAT-' + inv.id);
  const ret = round2(returnPortion || 0);

  /* Back to the account the money came from.

     A sub-account has its own wallet, and investing from one debits it —
     tables.js locks the sub_accounts row and takes capital plus fee from it.
     This credited `investors` unconditionally, so capital and return both
     landed in the PARENT's wallet: the sub-account was left permanently short
     by everything it had invested, with total_returns still at zero however
     much it had earned.

     Every other money path on the platform already splits this way — deposits,
     manual credits, EFT approvals, interest distribution, withdrawals and the
     invest deduction all write sub_accounts.wallet_balance when there is one.
     Maturity was the only one that did not. */
  if (inv.sub_account_id) {
    await client.query(
      'UPDATE sub_accounts SET wallet_balance = wallet_balance + $1, total_returns = COALESCE(total_returns,0) + $2, updated_at = NOW() WHERE id = $3',
      [amt, ret, inv.sub_account_id]
    );
  } else {
    await client.query(
      'UPDATE investors SET wallet_balance = wallet_balance + $1, total_returns = COALESCE(total_returns,0) + $2, updated_at = NOW() WHERE id = $3',
      [amt, ret, inv.investor_id]
    );
  }

  /* The row carries the sub-account too, or the sub-account's own statement
     never shows the money arriving — the flow would be invisible from the
     account it belongs to. */
  await client.query(
    `INSERT INTO transactions
       (id, investor_id, sub_account_id, type, amount, status, reference, description, investment_id, transaction_date, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,$2,'payout',$3,'completed',$4,$5,$6,NOW(),NOW(),NOW())`,
    [inv.investor_id, inv.sub_account_id || null, amt, ref, description, inv.id]
  );
}

/* ────────────────────────────────────────────────────────────
   reinvestAmount — roll `amount` (fee-free) into the pool of
   `productType` that is currently OPEN and closing at month-end (the
   active fundraising pool). If no such pool exists, the amount is paid
   to the investor's wallet instead. Does NOT mark maturity_processed_at
   (the caller does that once all money movement is complete).
   All writes go through `client` so they participate in the caller's
   transaction (FIX 6, FIX 7, FIX 8, FIX 9).
   ──────────────────────────────────────────────────────────── */
/* `leg` distinguishes two rollovers made from the SAME investment in one
   transaction — switch_amount splits a maturity across two products.

   It is not cosmetic. transactions.reference carries a UNIQUE index, and the
   REINV- insert below has no ON CONFLICT clause, so a second call for the same
   investment would throw, roll the whole maturity back, and leave
   maturity_processed_at unset — the investment retried every night, its pool
   never marked matured. The new investment id derives from Date.now(), which
   two calls in the same millisecond share, so that needs separating too.

   Leave it empty for the single-rollover instructions: their references keep
   the exact form they have always had, so nothing already written moves. */
async function reinvestAmount(client, inv, amount, productType, sourcePoolName, leg = '') {
  const amt = round2(amount);
  if (amt <= 0) return;
  try {
    /* The end_date floor is what stops a stale pool capturing every rollover.
       Without it the filter was status='open' alone, and the ordering is
       end_date ASC — so the pool that closed longest ago sorted FIRST and won.
       Matured funds landed in a pool that had closed in September 2024.

       A pool cannot be relied on to leave 'open' by itself: the cycler only
       considers pools that closed within the last 60 days, so anything staler
       stays open forever and keeps winning.

       CURRENT_DATE, not a strict future date: the intended target is the pool
       closing at this month-end, and on the maturity night that pool's
       end_date IS today. 23:00 SAST is 21:00 UTC the same day, so the server's
       CURRENT_DATE has not rolled over and today's pool still qualifies.

       If nothing qualifies, `target` is null and the amount is paid to the
       wallet with a description saying why — visible and spendable, rather
       than buried in a pool that is finished. */
    const { rows: targets } = await client.query(
      `SELECT * FROM investment_pools
        WHERE status = 'open'
          AND product_type = $1
          AND (end_date IS NULL OR end_date >= CURRENT_DATE)
          AND (max_investment IS NULL OR COALESCE(current_invested,0) < max_investment)
        ORDER BY end_date ASC NULLS LAST, created_at ASC
        LIMIT 1`,
      [productType || 'general']
    );
    const target = targets[0];

    if (!target) {
      // No open pool for this product — pay the amount to the wallet.
      // FIX 8: Use a distinct reference suffix for this fallback credit.
      await creditWallet(
        client, inv, amt, 0,
        `Maturity payout — ${sourcePoolName} (no open ${productType || ''} pool to reinvest into)`,
        'MAT-FALLBACK-' + inv.id + leg
      );
      console.log(`[maturity] no open ${productType} pool — paid R${amt} to wallet for ${inv.investor_id}`);
      return;
    }

    // FIX 9: Lock the target pool row FOR UPDATE before re-checking capacity,
    // preventing concurrent over-allocation.
    const { rows: poolRows } = await client.query(
      'SELECT id, current_invested, max_investment FROM investment_pools WHERE id = $1 FOR UPDATE',
      [target.id]
    );
    const lockedPool = poolRows[0];
    if (!lockedPool) {
      // Pool disappeared between the SELECT above and the lock attempt.
      await creditWallet(
        client, inv, amt, 0,
        `Maturity payout — ${sourcePoolName} (target pool not found)`,
        'MAT-FALLBACK-' + inv.id + leg
      );
      return;
    }

    // Re-check capacity AFTER acquiring the lock.
    const currentInvested = Number(lockedPool.current_invested) || 0;
    const maxInvestment   = lockedPool.max_investment != null ? Number(lockedPool.max_investment) : null;
    if (maxInvestment !== null && currentInvested + amt > maxInvestment) {
      // Pool has filled up since we fetched it — fall back to wallet.
      await creditWallet(
        client, inv, amt, 0,
        `Maturity payout — ${sourcePoolName} (pool at capacity)`,
        'MAT-FALLBACK-' + inv.id + leg
      );
      console.log(`[maturity] pool ${target.id} at capacity — paid R${amt} to wallet for ${inv.investor_id}`);
      return;
    }

    const termMonths   = target.term_months || 6;
    const startDate    = new Date();
    const endDate      = new Date(startDate); endDate.setMonth(endDate.getMonth() + termMonths);
    const newExpReturn = round2(amt * (parseFloat(target.annual_rate) || 0) * (termMonths / 12));
    const newInvId     = 'INV-RI-' + Date.now() + leg + '-' + String(inv.investor_id).replace(/[^A-Z0-9]/gi, '').slice(-6);
    const switched     = target.product_type !== inv.product_type;

    await client.query(
      /* sub_account_id carries forward. Without it a rollover silently moved a
         sub-account's capital to the parent as a parent-level holding, and
         nothing in the new row said where it had come from — the link was
         simply gone, with no way to reconstruct it afterwards. */
      `INSERT INTO investments
         (id, investor_id, sub_account_id, pool_id, pool_name, amount, status, start_date, end_date,
          annual_rate, term_months, expected_return, actual_return, product_type,
          maturity_instruction, is_reinvestment, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,0,$12,'reinvest',true,NOW(),NOW())`,
      [newInvId, inv.investor_id, inv.sub_account_id || null, target.id, target.name, amt,
       startDate.toISOString().slice(0,10), endDate.toISOString().slice(0,10),
       target.annual_rate, termMonths, newExpReturn, target.product_type]
    );

    // Bookkeeping credit: shows the matured funds arriving back before being reinvested.
    // No wallet update — money goes straight into the new investment, net wallet change = R0.
    await client.query(
      `INSERT INTO transactions
         (id, investor_id, sub_account_id, type, amount, status, reference, description, investment_id, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,$2,'matured_funds',$3,'completed',$4,$5,$6,NOW(),NOW(),NOW())
       ON CONFLICT (reference) DO NOTHING`,
      [inv.investor_id, inv.sub_account_id || null, amt, 'MATF-' + inv.id + leg,
       `Matured Funds — ${sourcePoolName}`, inv.id]
    );

    const verb = switched ? 'switch' : 'reinvestment';
    await client.query(
      `INSERT INTO transactions
         (id, investor_id, sub_account_id, type, amount, status, reference, description, investment_id, pool_id, transaction_date, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,$2,'reinvestment',$3,'completed',$4,$5,$6,$7,NOW(),NOW(),NOW())`,
      [inv.investor_id, inv.sub_account_id || null, amt, 'REINV-' + inv.id + leg,
       `Maturity ${verb} — ${sourcePoolName} → ${target.name}`, newInvId, target.id]
    );

    await client.query(
      'UPDATE investment_pools SET current_invested = COALESCE(current_invested,0) + $1, raised_amount = COALESCE(raised_amount,0) + $1, updated_at = NOW() WHERE id = $2',
      [amt, target.id]
    );

    console.log(`[maturity] ${verb} ${inv.id} → ${newInvId} (R${amt}, fee-free) into closing pool ${target.id}`);
  } catch (err) {
    // FIX 7: Log but re-throw so the caller's transaction rolls back and
    // maturity_processed_at is NOT set — the investment will be retried next run.
    console.error(`[maturity] reinvestAmount failed for ${inv.id}:`, err.message);
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────
   Advance maturity alerts (30-day / 7-day / 3-day).
   ──────────────────────────────────────────────────────────── */
async function runMaturityAlerts() {
  console.log('[maturity] running maturity alert scan…');
  try {
    const now = new Date();

    // ── 30-day and 7-day alerts ─────────────────────────────
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
        { email: inv.email, first_name: inv.first_name, id: inv.investor_id },
        { poolName: inv.pool_name || inv.pool_id || 'your investment',
          amount: inv.amount, expectedReturn: inv.expected_return || 0,
          endDate: inv.end_date, daysLeft }
      );
      await pool.query('UPDATE investments SET maturity_alert_sent_at = NOW() WHERE id = $1', [inv.id]);
      sent++;
    }

    // ── 3-day alerts (separate tracking column) ─────────────
    const { rows: threeDayInvs } = await pool.query(`
      SELECT i.*, inv.email, inv.first_name
      FROM investments i
      JOIN investors inv ON inv.id = i.investor_id
      WHERE i.status = 'active'
        AND i.end_date IS NOT NULL
        AND i.end_date > NOW()
        AND i.end_date <= NOW() + INTERVAL '4 days'
        AND i.maturity_3day_alert_sent_at IS NULL
    `);

    for (const inv of threeDayInvs) {
      const daysLeft = Math.ceil((new Date(inv.end_date) - now) / 86400000);
      if (daysLeft < 2 || daysLeft > 4) continue;

      await emailService.sendMaturity3DayAlert(
        { email: inv.email, first_name: inv.first_name, id: inv.investor_id },
        { poolName: inv.pool_name || inv.pool_id || 'your investment',
          amount: inv.amount, expectedReturn: inv.expected_return || 0,
          endDate: inv.end_date }
      );
      await pool.query(
        'UPDATE investments SET maturity_3day_alert_sent_at = NOW() WHERE id = $1',
        [inv.id]
      );
      sent++;
    }

    console.log(`[maturity] done — ${sent} alert(s) sent`);
  } catch (err) {
    console.error('[maturity] alert error:', err.message);
  }
}

/* ────────────────────────────────────────────────────────────
   Monthly maturity reminder — runs on the 1st of each month.
   Sends each investor a summary of investments maturing in the
   next 30 days so they can prepare their maturity instructions.
   ──────────────────────────────────────────────────────────── */
async function runMonthlyMaturityReminder() {
  console.log('[maturity] running monthly maturity reminder…');
  try {
    const { rows } = await pool.query(`
      SELECT i.*, inv.email, inv.first_name, inv.id AS investor_id_col
      FROM investments i
      JOIN investors inv ON inv.id = i.investor_id
      WHERE i.status = 'active'
        AND i.end_date IS NOT NULL
        AND i.end_date > NOW()
        AND i.end_date <= NOW() + INTERVAL '31 days'
      ORDER BY i.investor_id, i.end_date
    `);

    // Group by investor
    const byInvestor = {};
    for (const row of rows) {
      const key = row.investor_id;
      if (!byInvestor[key]) {
        byInvestor[key] = {
          investor: { email: row.email, first_name: row.first_name, id: key },
          investments: [],
        };
      }
      byInvestor[key].investments.push(row);
    }

    let sent = 0;
    for (const { investor, investments } of Object.values(byInvestor)) {
      await emailService.sendMonthlyMaturitySummary(investor, investments);
      sent++;
    }
    console.log(`[maturity] monthly reminder done — ${sent} investor(s) notified`);
  } catch (err) {
    console.error('[maturity] monthly reminder error:', err.message);
  }
}

function startMaturityCron() {
  // 23:00 SAST daily — cycle pools first so the new month's pool exists before
  // reinvestment instructions run, then process maturity + advance alerts.
  cron.schedule('0 23 * * *', async () => {
    try {
      await cycleExpiredPools();
      await runMaturityProcessing();
      await runMaturityAlerts();
    } catch (err) {
      console.error('[maturity] cron error:', err.message);
    }
  }, { timezone: 'Africa/Johannesburg' });
  console.log('[maturity] scheduled: daily at 23:00 SAST — pool cycle + maturity processing + alerts');

  // 08:00 SAST on the 1st of each month — monthly maturity summary to investors.
  cron.schedule('0 8 1 * *', async () => {
    try {
      await runMonthlyMaturityReminder();
    } catch (err) {
      console.error('[maturity] monthly reminder cron error:', err.message);
    }
  }, { timezone: 'Africa/Johannesburg' });
  console.log('[maturity] scheduled: 1st of month at 08:00 SAST — monthly maturity reminder');
}

module.exports = {
  startMaturityCron,
  runMaturityProcessing,
  runMaturityAlerts,
  runMonthlyMaturityReminder,
};
