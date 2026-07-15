/* ═══════════════════════════════════════════════════════════
   Push Notification Service — Web Push (VAPID)
   ═══════════════════════════════════════════════════════════ */
'use strict';

const crypto  = require('crypto');
const webPush = require('web-push');
const pool    = require('../db/pool');

/* ════════════════════════════════════════════════════════════
   FCM HTTP v1 — native Android / iOS push via service account
   Set FCM_SERVICE_ACCOUNT_JSON env var to the contents of the
   Firebase service account JSON file to enable native push.
════════════════════════════════════════════════════════════ */

let _fcmAccessToken  = null;
let _fcmTokenExpiry  = 0;
let _fcmProjectId    = null;

async function _ensureFcmToken() {
  const saJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!saJson) return null;

  // Return cached token if still valid (refresh 1 min before expiry)
  if (_fcmAccessToken && Date.now() < _fcmTokenExpiry - 60000) return _fcmAccessToken;

  try {
    const sa = JSON.parse(saJson);
    _fcmProjectId = sa.project_id;

    const now     = Math.floor(Date.now() / 1000);
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss:   sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud:   'https://oauth2.googleapis.com/token',
      iat:   now,
      exp:   now + 3600,
    })).toString('base64url');

    const sigInput = `${header}.${payload}`;
    const signer   = crypto.createSign('RSA-SHA256');
    signer.update(sigInput);
    const sig = signer.sign(sa.private_key).toString('base64url');

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth2:grant-type:jwt-bearer',
        assertion:  `${sigInput}.${sig}`,
      }).toString(),
    });

    const data = await tokenRes.json();
    if (!data.access_token) throw new Error(JSON.stringify(data));

    _fcmAccessToken = data.access_token;
    _fcmTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return _fcmAccessToken;
  } catch (e) {
    console.error('[pushService] FCM token error:', e.message);
    return null;
  }
}

async function _sendOneFcmToken(deviceToken, { title, body, url, tag } = {}) {
  const accessToken = await _ensureFcmToken();
  if (!accessToken) return false;

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${_fcmProjectId}/messages:send`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token:        deviceToken,
            notification: { title: title || 'SV Capital', body: body || '' },
            data:         { url: url || '/portal/', tag: tag || 'sv-capital' },
            android: { notification: { channelId: 'svcapital_investments', sound: 'default' } },
            apns:    { payload: { aps: { badge: 1, sound: 'default' } } },
          },
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const code = (err.error?.details || []).find(d => d.errorCode)?.errorCode || '';
      if (res.status === 404 || code === 'UNREGISTERED') return 'stale';
      console.warn('[pushService] FCM send failed:', err.error?.message || res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[pushService] FCM fetch error:', e.message);
    return false;
  }
}

async function _sendFcmToInvestor(investorId, payload) {
  if (!process.env.FCM_SERVICE_ACCOUNT_JSON) return 0;
  let tokens;
  try {
    const { rows } = await pool.query(
      `SELECT id, token FROM push_tokens WHERE investor_id = $1`, [investorId]
    );
    tokens = rows;
  } catch (e) {
    console.warn('[pushService] FCM DB fetch error:', e.message);
    return 0;
  }
  if (!tokens.length) return 0;

  let sent = 0;
  const toDelete = [];
  await Promise.allSettled(tokens.map(async row => {
    const r = await _sendOneFcmToken(row.token, payload);
    if (r === true)    sent++;
    if (r === 'stale') toDelete.push(row.id);
  }));
  for (const id of toDelete) {
    await pool.query('DELETE FROM push_tokens WHERE id = $1', [id]).catch(() => {});
  }
  if (toDelete.length) console.log(`[pushService] Removed ${toDelete.length} stale FCM tokens.`);
  return sent;
}

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

  // Also deliver via FCM to native (Android/iOS) device tokens
  const fcmSent = await _sendFcmToInvestor(investorId, { title, body, url, tag });
  sent += fcmSent;

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
