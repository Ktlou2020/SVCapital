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

module.exports = { enqueue, processQueue };
