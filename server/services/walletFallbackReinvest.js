'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Putting a wallet-fallback maturity back into a pool.

   This is NOT what the maturity engine does. The engine never touches the
   wallet: matured funds go straight into the new investment. Here the money
   has already been credited to the wallet, so it has to be debited back out
   — which is only possible while the investor still has it.

   One module, so the admin console button and the CLI script cannot move the
   same money on different rules. Everything money-bearing lives here: the
   plan, the per-investor transaction, the locks, and the idempotence.

   ── The properties that matter ───────────────────────────────────────
   · PLAN and APPLY are separate calls. Nothing writes without apply().
   · One transaction per investor. A failure takes one row down, not 57.
   · The balance is re-read FOR UPDATE inside that transaction, so a client
     who spends between the plan and the write is caught rather than driven
     negative.
   · The target pool is locked FOR UPDATE and its capacity re-checked.
   · Idempotent on transactions.reference 'REINV-FIX-<investment id>', which
     carries a UNIQUE index — running twice does not reinvest twice.
   · Fee-free, as the rollover would have been. The 1% is charged on a
     client's own investment, not on a correction of ours.
   ═══════════════════════════════════════════════════════════════════ */

const { SAME_PRODUCT } = require('./walletFallbackAudit');

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* Everything both calls need to agree about: who is in, who is out, and why.
   apply() re-derives this rather than trusting a plan handed back to it — a
   plan is a snapshot, and the only state that may decide a write is the state
   inside the transaction that performs it. */
async function selectRows(db, { sourcePoolId, targetPoolId, includeSwitches = false,
                                only = [], exclude = [] }) {
  const onlySet    = new Set((only || []).filter(Boolean));
  const excludeSet = new Set((exclude || []).filter(Boolean));

  const { rows: [target] } = await db.query(
    `SELECT id, name, product_type, status, term_months, annual_rate,
            current_invested, max_investment, end_date
       FROM investment_pools WHERE id = $1`, [targetPoolId]);
  if (!target) throw new Error(`Target pool ${targetPoolId} not found.`);

  const { rows } = await db.query(`
    SELECT t.amount, t.sub_account_id,
           i.id AS investment_id, i.investor_id, i.product_type, i.pool_name AS src_name,
           COALESCE(NULLIF(TRIM(i.maturity_instruction), ''), '') AS instruction,
           inv.first_name, inv.last_name,
           inv.wallet_balance, sa.wallet_balance AS sub_balance,
           EXISTS (SELECT 1 FROM transactions d
                    WHERE d.reference = 'REINV-FIX-' || i.id) AS already_done
      FROM transactions t
      JOIN investments       i   ON i.id  = t.investment_id
      LEFT JOIN investors    inv ON inv.id = i.investor_id
      LEFT JOIN sub_accounts sa  ON sa.id  = t.sub_account_id
     WHERE t.reference LIKE 'MAT-FALLBACK-%'
       AND i.pool_id = $1
     ORDER BY t.amount DESC`, [sourcePoolId]);

  /* An --only naming nothing is a typo, not an empty result: it would
     otherwise correct nobody and report success. */
  for (const id of onlySet) {
    if (!rows.some(r => r.investment_id === id)) {
      throw new Error(`${id} has no wallet-fallback credit in ${sourcePoolId}.`);
    }
  }

  const chosen = [], skipped = [];
  for (const r of rows) {
    const amount  = r2(r.amount);
    const balance = r2(r.sub_account_id ? r.sub_balance : r.wallet_balance);
    const row = {
      investment_id: r.investment_id, investor_id: r.investor_id,
      sub_account_id: r.sub_account_id || null,
      who: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.investor_id,
      instruction: r.instruction, src_name: r.src_name,
      amount, balance, balance_after: r2(balance - amount),
    };
    if (r.already_done)                       { skipped.push({ ...row, why: 'already corrected' }); continue; }
    if (onlySet.size && !onlySet.has(r.investment_id))
                                              { skipped.push({ ...row, why: 'not in the selection' }); continue; }
    if (excludeSet.has(r.investment_id))      { skipped.push({ ...row, why: 'excluded by hand' }); continue; }
    if (!SAME_PRODUCT.has(r.instruction) && !includeSwitches)
                                              { skipped.push({ ...row, why: 'asked for a different product' }); continue; }
    if (balance + 0.005 < amount)             { skipped.push({ ...row, why: 'wallet no longer holds it' }); continue; }
    chosen.push(row);
  }

  const total = r2(chosen.reduce((a, c) => a + c.amount, 0));
  const overCapacity = target.max_investment != null &&
    Number(target.current_invested || 0) + total > Number(target.max_investment);

  /* status 'open' is not the same as still raising: a pool keeps that status
     until the cycler deploys it, so between its close date and that moment it
     reads open while being shut. Named, never silently allowed. */
  const closedToNew = target.status === 'open' && !!(target.end_date &&
    new Date(target.end_date).toISOString().slice(0, 10) <
    new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10));

  return { target, chosen, skipped, total, overCapacity, closedToNew };
}

async function planReinvest(db, opts) {
  const { target, chosen, skipped, total, overCapacity, closedToNew } = await selectRows(db, opts);
  return {
    target: {
      id: target.id, name: target.name, product_type: target.product_type,
      status: target.status, end_date: target.end_date,
      term_months: target.term_months, annual_rate: target.annual_rate,
      current_invested: target.current_invested, max_investment: target.max_investment,
    },
    warnings: [
      ...(target.status !== 'open'
        ? [`This pool is "${target.status}", not open — money added here joins a round that is already running.`] : []),
      ...(closedToNew
        ? [`This pool stopped raising on ${new Date(target.end_date).toISOString().slice(0, 10)}. Its status is still "open" only because the cycler has not deployed it yet.`] : []),
      ...(overCapacity
        ? [`This would take the pool past its maximum of ${target.max_investment}.`] : []),
    ],
    blocked: overCapacity,
    count: chosen.length, total, chosen, skipped,
  };
}

/* Writes. One transaction per investor; a row that fails is reported and the
   rest continue, because 56 good corrections should not be lost to one. */
async function applyReinvest(pool, opts) {
  const plan = await planReinvest(pool, opts);
  if (plan.blocked) throw new Error(plan.warnings.find(w => /maximum/.test(w)) || 'Refused.');

  const applied = [], failed = [];
  for (const c of plan.chosen) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [bal] } = c.sub_account_id
        ? await client.query('SELECT wallet_balance b FROM sub_accounts WHERE id=$1 FOR UPDATE', [c.sub_account_id])
        : await client.query('SELECT wallet_balance b FROM investors    WHERE id=$1 FOR UPDATE', [c.investor_id]);
      if (!bal || Number(bal.b) + 0.005 < c.amount) {
        await client.query('ROLLBACK');
        failed.push({ ...c, error: `balance moved to ${bal ? bal.b : 'unknown'}` });
        continue;
      }

      const { rows: [lock] } = await client.query(
        'SELECT current_invested, max_investment, term_months, annual_rate, name, product_type FROM investment_pools WHERE id=$1 FOR UPDATE',
        [plan.target.id]);
      if (lock.max_investment != null &&
          Number(lock.current_invested || 0) + c.amount > Number(lock.max_investment)) {
        await client.query('ROLLBACK');
        failed.push({ ...c, error: 'target pool at capacity' });
        continue;
      }

      const term  = lock.term_months || 6;
      const start = new Date();
      const end   = new Date(start); end.setMonth(end.getMonth() + term);
      const newId = 'INV-RIFIX-' + Date.now() + '-' +
                    String(c.investor_id).replace(/[^A-Z0-9]/gi, '').slice(-6);
      const expct = r2(c.amount * (parseFloat(lock.annual_rate) || 0) * (term / 12));

      if (c.sub_account_id) {
        await client.query('UPDATE sub_accounts SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
                           [c.amount, c.sub_account_id]);
      } else {
        await client.query('UPDATE investors SET wallet_balance = wallet_balance - $1, updated_at = NOW() WHERE id = $2',
                           [c.amount, c.investor_id]);
      }

      await client.query(
        `INSERT INTO investments
           (id, investor_id, sub_account_id, pool_id, pool_name, amount, status, start_date, end_date,
            annual_rate, term_months, expected_return, actual_return, product_type,
            maturity_instruction, is_reinvestment, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,0,$12,'reinvest',true,NOW(),NOW())`,
        [newId, c.investor_id, c.sub_account_id || null, plan.target.id, lock.name, c.amount,
         start.toISOString().slice(0, 10), end.toISOString().slice(0, 10),
         lock.annual_rate, term, expct, lock.product_type]);

      /* Typed 'reinvestment', not 'investment', so it reads as what it is on
         the client's statement — _stmtLabel renders it "Reinvestment". Both
         sit in the statement's DEBIT list, so the running balance is
         unaffected by the choice and the wallet debit above is reflected
         either way.

         UNIQUE on reference — this is what makes a second run a no-op. */
      await client.query(
        `INSERT INTO transactions
           (id, investor_id, sub_account_id, type, amount, status, reference, description,
            investment_id, pool_id, transaction_date, created_at, updated_at)
         VALUES (gen_random_uuid(),$1,$2,'reinvestment',$3,'completed',$4,$5,$6,$7,NOW(),NOW(),NOW())`,
        [c.investor_id, c.sub_account_id || null, c.amount, 'REINV-FIX-' + c.investment_id,
         `Reinvested into ${lock.name} — corrects the maturity of ${c.src_name || opts.sourcePoolId}, ` +
         `which was paid to the wallet because no pool matched its product type`,
         newId, plan.target.id]);

      await client.query(
        `UPDATE investment_pools
            SET current_invested = COALESCE(current_invested,0) + $1,
                raised_amount    = COALESCE(raised_amount,0) + $1,
                investor_count   = COALESCE(investor_count,0) + 1,
                updated_at = NOW()
          WHERE id = $2`, [c.amount, plan.target.id]);

      await client.query('COMMIT');
      applied.push({ ...c, new_investment_id: newId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      failed.push({ ...c, error: err.message });
    } finally {
      client.release();
    }
  }

  return {
    target: plan.target,
    applied, failed, skipped: plan.skipped,
    appliedCount: applied.length,
    appliedTotal: r2(applied.reduce((a, x) => a + x.amount, 0)),
    failedCount: failed.length,
  };
}

module.exports = { planReinvest, applyReinvest };
