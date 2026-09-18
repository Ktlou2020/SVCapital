/* ═══════════════════════════════════════════════════════════
   Cattle payout cron — every working day, 08:00 SAST.

   The certificate says proceeds are paid within seven working days of the
   sale. That is a promise about a date, and this is what keeps it.

   It pays, rather than reminding somebody to pay. A promise in a document
   that depends on a person remembering is a promise that is kept on the days
   that person is at their desk.

   Three things make it safe to run every morning:

     · It pays only what is DUE — sold, unpaid, and the due date reached. A
       sale recorded late cannot pay late and a sale recorded twice cannot pay
       twice, because the date is stored on the row and not inferred from when
       anybody got round to it.

     · Each animal is claimed by the same statement that pays it, so two
       instances of the server racing the same morning cannot pay one animal
       into a wallet twice. The UPDATE ... WHERE paid_at IS NULL RETURNING is
       the lock.

     · Each animal is its own transaction. One client's bad row — a deleted
       investor, a constraint — does not hold up everybody else's money.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const cron = require('node-cron');
const pool = require('../db/pool');

const rnd = n => Math.random().toString(36).slice(2, 2 + n).toUpperCase();

async function runCattlePayouts({ now } = {}) {
  const today = (now || new Date()).toISOString().slice(0, 10);
  let paid = 0, failed = 0, total = 0;

  let due;
  try {
    ({ rows: due } = await pool.query(
      `SELECT id, investor_id, tag_number, proceeds, certificate_no, sold_at, payout_due_at
         FROM cattle_ownerships
        WHERE status = 'sold' AND paid_at IS NULL AND payout_due_at <= $1
        ORDER BY payout_due_at`, [today]));
  } catch (e) {
    console.error('[cattlePayout] could not read what is due:', e.message);
    return { paid: 0, failed: 0, error: e.message };
  }

  if (!due.length) {
    console.log('[cattlePayout] nothing due today.');
    return { paid: 0, failed: 0, total: 0 };
  }

  for (const row of due) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      /* Claimed and paid by one statement: a second runner finds paid_at set
         and gets no row back, rather than crediting the wallet again. */
      const { rows: [claimed] } = await client.query(
        `UPDATE cattle_ownerships
            SET status = 'settled', paid_at = NOW(),
                payout_reference = $1, updated_at = NOW()
          WHERE id = $2 AND status = 'sold' AND paid_at IS NULL
        RETURNING id, investor_id, proceeds, tag_number, certificate_no`,
        [`PAY-${row.certificate_no}`, row.id]);
      if (!claimed) { await client.query('ROLLBACK'); continue; }

      const amount = Number(claimed.proceeds) || 0;
      await client.query(
        'UPDATE investors SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2',
        [amount, claimed.investor_id]);
      await client.query(
        `INSERT INTO transactions (id, investor_id, type, amount, status, reference, description)
         VALUES ($1,$2,'payout',$3,'completed',$4,$5)`,
        [`TXN-${rnd(12)}`, claimed.investor_id, amount, `PAY-${claimed.certificate_no}`,
         `Sale proceeds — beef animal ${claimed.tag_number}`]);
      await client.query('COMMIT');
      paid++; total += amount;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      failed++;
      console.error(`[cattlePayout] ${row.id} (${row.tag_number}) failed:`, e.message);
    } finally {
      client.release();
    }
  }

  console.log(`[cattlePayout] ${paid} paid, R${total.toFixed(2)}${failed ? `, ${failed} failed` : ''}.`);
  return { paid, failed, total };
}

function startCattlePayoutCron() {
  /* 08:00 SAST = 06:00 UTC, Monday to Friday. Daily rather than weekly
     because the promise is seven working days and not "the following
     Friday"; weekends are skipped because a due date never lands on one. */
  cron.schedule('0 6 * * 1-5', () => {
    runCattlePayouts().catch(e => console.error('[cattlePayout] cron error:', e.message));
  }, { timezone: 'UTC' });
  console.log('[cattlePayout] scheduled: weekdays 08:00 SAST');
}

module.exports = { startCattlePayoutCron, runCattlePayouts };
