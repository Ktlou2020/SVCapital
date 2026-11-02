'use strict';
/* ═══════════════════════════════════════════════════════════
   Contributions — open the period, then chase it.

   Two jobs, both daily, both deliberately dull.

   OPENING runs every day rather than on the due day, because a stokvel whose
   period opened only on the 1st would give a member who joined on the 3rd no
   obligation at all that month. Running daily means the unique index does
   the work: about thirty calls per period, one of which inserts.

   CHASING is where restraint matters more than cleverness. A platform that
   reminds somebody daily that they are behind on R500 is a platform they
   mute, and then the one reminder that mattered is muted too. So: one
   reminder per obligation, ever, recorded on the row. The treasurer chases
   the rest, which is a conversation rather than a notification.
   ═══════════════════════════════════════════════════════════ */

const cron = require('node-cron');
const pool = require('../db/pool');
const contributions = require('../services/stokvelContributions');

async function openPeriods() {
  const { rows: groups } = await pool.query(
    `SELECT DISTINCT s.sub_account_id
       FROM stokvel_contribution_schedules s
       JOIN sub_accounts a ON a.id = s.sub_account_id
      WHERE s.active = true AND a.status = 'active'`);
  let created = 0;
  for (const g of groups) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await contributions.openPeriod(client, g.sub_account_id);
      await client.query('COMMIT');
      created += r.created || 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      /* One stokvel's bad schedule must not stop the others. */
      console.error(`[stokvel] opening ${g.sub_account_id} failed:`, err.message);
    } finally {
      client.release();
    }
  }
  if (created) console.log(`[stokvel] opened ${created} contribution(s)`);
  return { created };
}

async function chaseArrears() {
  const emailService = require('../services/email');
  const pushService  = require('../services/pushService');

  /* Overdue, unsettled, and never reminded. The reminded_at guard is what
     keeps this to one message rather than one a day until they pay. */
  const { rows } = await pool.query(
    `SELECT c.id, c.investor_id, c.period_label, c.due_date, c.kind, c.note,
            (c.amount_due - c.amount_paid) AS owed,
            a.name AS stokvel_name,
            i.email, i.first_name
       FROM stokvel_contributions c
       JOIN sub_accounts a ON a.id = c.sub_account_id
       JOIN investors    i ON i.id = c.investor_id
      WHERE c.status = 'due'
        AND c.due_date < CURRENT_DATE
        AND c.reminded_at IS NULL
        AND (c.amount_due - c.amount_paid) > 0
      LIMIT 500`);

  let sent = 0;
  for (const r of rows) {
    try {
      /* A FINE IS NOT A PERIOD. Fines are carried on this table with a
         period_label of their own (FINE-<id>) so the unique index never
         collides — which meant the chase said "your FINE-SCF8A2C1
         contribution of R50,00 is outstanding", an identifier read out to
         a member as though it were a month. What they need is the word
         fine and what it was for. */
      const isFine = r.kind === 'fine';
      const what = isFine
        ? ('fine' + (r.note ? ' — ' + String(r.note).slice(0, 80) : ''))
        : (r.period_label + ' contribution');

      await emailService.sendStokvelArrears(
        { email: r.email, first_name: r.first_name },
        /* No label for a fine. FINE-<id> is an identifier, and handing a
           renderer a value that would be wrong to render is how it ends up
           rendered — which is what happened. */
        { stokvelName: r.stokvel_name, periodLabel: isFine ? null : r.period_label,
          owed: r.owed, dueDate: r.due_date, kind: r.kind, note: r.note }
      ).catch(() => {});
      pushService.sendPushToInvestor(r.investor_id, {
        title: r.stokvel_name,
        body: `Your ${what} of R${Number(r.owed).toFixed(2)} is outstanding.`,
      }).catch(() => {});
      /* Marked whether or not the message got through. A failed send that is
         retried daily is the spam this guard exists to prevent, and the
         arrears list in the app is the reliable channel. */
      await pool.query(
        'UPDATE stokvel_contributions SET reminded_at = NOW() WHERE id = $1', [r.id]);
      sent++;
    } catch (err) {
      console.error(`[stokvel] reminder for ${r.id} failed:`, err.message);
    }
  }
  if (sent) console.log(`[stokvel] reminded ${sent} member(s) of arrears`);
  return { sent };
}

/* The safety net under the share ledger.
   
   Nine code paths credit a stokvel wallet and only one of them — the
   contribution — names a member, so the rest are placed by reconcile.
   Rather than hook each writer, which is the mistake this codebase already
   paid for when maturity turned out to be the only money path that did not
   split to sub-accounts, this sweeps every stokvel daily. A credit path
   nobody hooked is allocated correctly by the next morning, and anything it
   cannot reconcile is named rather than left to be discovered. */
async function reconcileShares() {
  const shares = require('../services/stokvelShares');
  const { rows: groups } = await pool.query(
    `SELECT id FROM sub_accounts WHERE account_type = 'stokvel' AND status = 'active'`);
  let moved = 0, failed = 0;
  for (const g of groups) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await shares.reconcile(client, g.id, { reason: 'Daily share-out' });
      await client.query('COMMIT');
      if (out.allocated || out.debtsPaid) moved++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      failed++;
      /* One stokvel's bad state must not stop the others. */
      console.error(`[stokvel] reconciling ${g.id} failed:`, err.message);
    } finally {
      client.release();
    }
  }
  if (moved || failed) console.log(`[stokvel] shares: ${moved} reconciled, ${failed} failed`);
  return { moved, failed };
}

function startStokvelContributionCron() {
  // 00:20 SAST — open the period before anybody looks at it.
  cron.schedule('20 0 * * *', async () => {
    try { await openPeriods(); }
    catch (err) { console.error('[stokvel] open cron error:', err.message); }
  }, { timezone: 'Africa/Johannesburg' });

  // 09:00 SAST — chase, once, at an hour a person would send a message.
  cron.schedule('0 9 * * *', async () => {
    try { await chaseArrears(); }
    catch (err) { console.error('[stokvel] chase cron error:', err.message); }
  }, { timezone: 'Africa/Johannesburg' });

  // 01:10 SAST — after the night's maturity and interest work has landed.
  cron.schedule('10 1 * * *', async () => {
    try { await reconcileShares(); }
    catch (err) { console.error('[stokvel] reconcile cron error:', err.message); }
  }, { timezone: 'Africa/Johannesburg' });

  console.log('[stokvel] scheduled: 00:20 open contributions, 01:10 reconcile shares, 09:00 chase arrears (SAST)');
}

module.exports = { startStokvelContributionCron, openPeriods, chaseArrears, reconcileShares };
