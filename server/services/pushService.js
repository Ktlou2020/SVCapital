/* ═══════════════════════════════════════════════════════════
   Push Notification Service — Web Push (VAPID)
   ═══════════════════════════════════════════════════════════ */
'use strict';

const webPush = require('web-push');
const pool    = require('../db/pool');

/* ─── In-memory VAPID key cache ─── */
let _vapidPublicKey  = null;
let _vapidPrivateKey = null;
let _vapidInitDone   = false;

/**
 * Initialise VAPID keys:
 * 1. Check env vars first
 * 2. Fall back to platform_settings table
 * 3. Auto-generate and persist if none found
 */
async function _ensureVapid() {
  if (_vapidInitDone) return;

  let pub  = process.env.VAPID_PUBLIC_KEY  || null;
  let priv = process.env.VAPID_PRIVATE_KEY || null;

  if (!pub || !priv) {
    // Try DB
    try {
      const { rows } = await pool.query(
        `SELECT key, value FROM platform_settings WHERE key IN ('vapid_public_key','vapid_private_key')`
      );
      rows.forEach(r => {
        if (r.key === 'vapid_public_key')  pub  = r.value;
        if (r.key === 'vapid_private_key') priv = r.value;
      });
    } catch (e) {
      console.warn('[pushService] Could not read VAPID keys from DB:', e.message);
    }
  }

  if (!pub || !priv) {
    // Auto-generate
    console.log('[pushService] Generating new VAPID key pair…');
    const keys = webPush.generateVAPIDKeys();
    pub  = keys.publicKey;
    priv = keys.privateKey;

    // Persist to platform_settings
    try {
      await pool.query(
        `INSERT INTO platform_settings (key, value, description)
         VALUES ('vapid_public_key', $1, 'Web Push VAPID public key'),
                ('vapid_private_key', $2, 'Web Push VAPID private key')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [pub, priv]
      );
      console.log('[pushService] VAPID keys persisted to platform_settings.');
    } catch (e) {
      console.error('[pushService] Failed to save VAPID keys to DB:', e.message);
    }
  }

  _vapidPublicKey  = pub;
  _vapidPrivateKey = priv;
  _vapidInitDone   = true;

  webPush.setVapidDetails(
    'mailto:admin@svcapital.co.za',
    _vapidPublicKey,
    _vapidPrivateKey
  );
}

/* ─── Public API ─── */

/**
 * Returns the VAPID public key (base64url string).
 */
async function getVapidPublicKey() {
  await _ensureVapid();
  return _vapidPublicKey;
}

/**
 * Send a push notification to all subscriptions of a single investor.
 * Automatically removes expired (410/404) subscriptions from the DB.
 *
 * @param {string} investorId
 * @param {{ title, body, url, icon, badge, tag }} payload
 */
async function sendPushToInvestor(investorId, { title, body, url, icon, badge, tag } = {}) {
  await _ensureVapid();

  let subscriptions;
  try {
    const { rows } = await pool.query(
      `SELECT id, subscription FROM push_subscriptions WHERE investor_id = $1`,
      [investorId]
    );
    subscriptions = rows;
  } catch (e) {
    console.error(`[pushService] DB fetch error for investor ${investorId}:`, e.message);
    return 0;
  }

  if (!subscriptions.length) return 0;

  const pushPayload = JSON.stringify({
    title: title || 'SV Capital',
    body:  body  || '',
    url:   url   || '/portal/',
    icon:  icon  || '/assets/logo.png',
    badge: badge || '/assets/logo.png',
    tag:   tag   || 'sv-capital',
  });

  let sent = 0;
  const toDelete = [];

  await Promise.allSettled(
    subscriptions.map(async (row) => {
      try {
        await webPush.sendNotification(row.subscription, pushPayload);
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired / unregistered
          toDelete.push(row.id);
        } else {
          console.warn(`[pushService] Push failed for sub ${row.id}:`, err.message);
        }
      }
    })
  );

  // Clean up stale subscriptions
  for (const id of toDelete) {
    await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]).catch(() => {});
  }
  if (toDelete.length) {
    console.log(`[pushService] Removed ${toDelete.length} expired subscriptions.`);
  }

  return sent;
}

/**
 * Batch-send push notifications to a list of investor IDs.
 *
 * @param {string[]} investorIds
 * @param {{ title, body, url, icon, badge, tag }} payload
 * @returns {{ sent: number, skipped: number }}
 */
async function sendPushToAll(investorIds, payload) {
  await _ensureVapid();

  let totalSent = 0;
  // Process in batches to avoid hammering the push service
  const BATCH = 25;
  for (let i = 0; i < investorIds.length; i += BATCH) {
    const chunk = investorIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map(id => sendPushToInvestor(id, payload))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') totalSent += r.value || 0;
    });
  }
  return { sent: totalSent, skipped: investorIds.length - totalSent };
}

/**
 * Insert a row into push_notifications_log.
 *
 * @param {{ type, title, body, url, recipientCount, sentBy }} opts
 */
async function logNotification({ type, title, body, url, recipientCount, sentBy }) {
  try {
    await pool.query(
      `INSERT INTO push_notifications_log
         (notification_type, title, body, url, recipient_count, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [type || 'broadcast', title, body || null, url || null, recipientCount || 0, sentBy || 'system']
    );
  } catch (e) {
    console.error('[pushService] logNotification error:', e.message);
  }
}

module.exports = {
  getVapidPublicKey,
  sendPushToInvestor,
  sendPushToAll,
  logNotification,
};
