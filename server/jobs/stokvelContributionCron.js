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
    `SELECT c.id, c.investor_id, c.period_label, c.due_date,
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
      await emailService.sendStokvelArrears(
        { email: r.email, first_name: r.first_name },
        { stokvelName: r.stokvel_name, periodLabel: r.period_label,
          owed: r.owed, dueDate: r.due_date }
      ).catch(() => {});
      pushService.sendPushToInvestor(r.investor_id, {
        title: r.stokvel_name,
        body: `Your ${r.period_label} contribution of R${Number(r.owed).toFixed(2)} is outstanding.`,
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

  console.log('[stokvel] scheduled: 00:20 open contributions, 09:00 chase arrears (SAST)');
}

module.exports = { startStokvelContributionCron, openPeriods, chaseArrears };
