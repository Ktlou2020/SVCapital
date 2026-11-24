'use strict';
const pool = require('../db/pool');
const emailService = require('./email');

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 60000, 300000]; // immediate, 1 min, 5 min

async function enqueue(toEmail, template, payload) {
  try {
    await pool.query(
      `INSERT INTO email_queue (to_email, template, payload) VALUES ($1, $2, $3)`,
      [toEmail, template, JSON.stringify(payload)]
    );
  } catch (e) {
    console.error('[emailQueue] enqueue error:', e.message);
    // Fire-and-forget fallback so caller isn't blocked
  }
}

async function processQueue() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM email_queue
       WHERE status IN ('pending','failed')
         AND attempts < $1
         AND scheduled_at <= NOW()
       ORDER BY created_at ASC
       LIMIT 10 FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS]
    );
    await client.query('COMMIT');
    for (const item of rows) {
      try {
        await pool.query(`UPDATE email_queue SET status='processing', attempts=attempts+1 WHERE id=$1`, [item.id]);
        const fn = emailService[item.template];
        if (typeof fn !== 'function') throw new Error(`Unknown email template: ${item.template}`);
        await fn(...(item.payload.args || []));
        await pool.query(`UPDATE email_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [item.id]);
      } catch (err) {
        const nextAttempt = item.attempts + 1;
        const delay = RETRY_DELAYS_MS[nextAttempt] || 600000;
        const newStatus = nextAttempt >= MAX_ATTEMPTS ? 'dead' : 'failed';
        await pool.query(
          `UPDATE email_queue SET status=$1, last_error=$2, scheduled_at=NOW()+$3::interval WHERE id=$4`,
          [newStatus, err.message.slice(0,500), `${delay} milliseconds`, item.id]
        ).catch(() => {});
        console.error(`[emailQueue] ${newStatus} item ${item.id}: ${err.message}`);
      }
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[emailQueue] processQueue error:', e.message);
  } finally {
    client.release();
  }
}

/* ─── THE OUTBOX: WRITE IT DOWN, THEN TRY IT ───────────────────────
 *
 * enqueue() above hands a message to the cron, which drains every two
 * minutes. That is right for a monthly statement and wrong for "your
 * signature is needed to release R20 000" — nobody should wait two minutes
 * to be told their group's money is held up.
 *
 * The alternative the group notices used was to call the email service
 * directly and catch the failure into a console line. So a statement that
 * failed got three attempts and a row somebody could find, and a request
 * for a signature got one attempt and silence. That asymmetry was exactly
 * backwards: the one that matters had the weaker delivery.
 *
 * This is the outbox pattern and it gives both. The row is written FIRST,
 * so the message exists before anything can go wrong with sending it; the
 * send is then attempted immediately, so there is no added delay; and if
 * that attempt fails — or the process dies between the two — the row is
 * still there and the cron picks it up with the same retries and the same
 * dead-letter state as everything else.
 *
 * It resolves to how it went, and NEVER REJECTS. A notification that
 * throws into a caller which is a floating promise would be the original
 * problem with more steps.
 */
async function enqueueAndSend(toEmail, template, args) {
  if (!toEmail) return { ok: false, reason: 'no address' };
  let id = null;
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO email_queue (to_email, template, payload, status, attempts)
       VALUES ($1, $2, $3, 'processing', 1) RETURNING id`,
      [toEmail, template, JSON.stringify({ args })]);
    id = row && row.id;
  } catch (e) {
    /* The outbox itself is down. Fall through and try to send anyway: a
       message that arrives without a record is better than neither. */
    console.error('[emailQueue] could not write the outbox row:', e.message);
  }

  try {
    const fn = emailService[template];
    if (typeof fn !== 'function') throw new Error(`Unknown email template: ${template}`);
    await fn(...(args || []));
    if (id) await pool.query(`UPDATE email_queue SET status='sent', sent_at=NOW() WHERE id=$1`, [id])
      .catch(() => {});
    return { ok: true, queued: !!id, id };
  } catch (err) {
    if (id) {
      /* Back to 'failed' with attempts already at 1, so the cron's own
         backoff and MAX_ATTEMPTS carry it from here rather than starting
         the count again. */
      await pool.query(
        `UPDATE email_queue SET status='failed', last_error=$2, scheduled_at=NOW()+'60 seconds' WHERE id=$1`,
        [id, String(err.message || err).slice(0, 500)]).catch(() => {});
      console.warn(`[emailQueue] first attempt failed, queued for retry (${id}): ${err.message}`);
      return { ok: false, queued: true, id, error: err.message };
    }
    console.error('[emailQueue] send failed with no outbox row:', err.message);
    return { ok: false, queued: false, error: err.message };
  }
}

module.exports = { enqueue, enqueueAndSend, processQueue };
