/* ═══════════════════════════════════════════════════════════
   Broadcast Messaging API — /api/admin/broadcast
   Requires role: admin | director
   ═══════════════════════════════════════════════════════════ */
'use strict';

const router      = require('express').Router();
const pool        = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const smsService  = require('../services/sms');
const pushService = require('../services/pushService');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM          = process.env.FROM_EMAIL || 'SV Capital <noreply@svcapital.co.za>';
const BASE_URL      = process.env.BASE_URL   || 'https://platform.svcapital.co.za';
const BATCH_SIZE    = 50;

/* ── Auth guard: admin + director only ─────────────────────── */
router.use(requireAuth, requireRole('admin', 'director'));

/* ── Shared email wrapper — matches transactional email template ─── */
function _wrapBroadcast(message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222}
.shell{max-width:580px;margin:32px auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 6px 32px rgba(0,0,0,.10)}
.hdr{background:linear-gradient(135deg,#303030 0%,#303030 100%);padding:30px 40px;text-align:center}
.logo img{height:48px;width:auto;object-fit:contain;display:block;margin:0 auto}
.bdy{padding:38px 40px;font-size:0.95rem;color:#444;line-height:1.7;white-space:pre-wrap}
.ftr{background:#f7f9fc;border-top:1px solid #eee;padding:18px 40px;text-align:center;font-size:0.76rem;color:#aaa}
.ftr a{color:#ff9b0c;text-decoration:none}
@media(max-width:600px){.bdy,.hdr,.ftr{padding:24px 20px}}
</style></head><body>
<div class="shell">
  <div class="hdr"><div class="logo"><img src="${BASE_URL}/assets/sv-capital-logo-horizontal-white-text.png" alt="SV Capital" /></div></div>
  <div class="bdy">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  <div class="ftr">SV Capital (Pty) Ltd &nbsp;·&nbsp; <a href="${BASE_URL}">platform.svcapital.co.za</a><br>
  This is a broadcast message from the SV Capital team.</div>
</div></body></html>`;
}

/* ── Helper: send one email via Resend ──────────────────────── */
async function _sendEmail(to, subject, message) {
  if (!RESEND_API_KEY || !to) return { ok: false, reason: 'no_key_or_email' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html: _wrapBroadcast(message) }),
    });
    return r.ok ? { ok: true } : { ok: false, reason: await r.text() };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/* ── Helper: query investors by segment ─────────────────────── */
async function _getInvestors(segment) {
  let rows;
  if (segment === 'all') {
    const res = await pool.query(`SELECT id, first_name, last_name, email, phone FROM investors WHERE email IS NOT NULL AND email <> '' ORDER BY first_name`);
    rows = res.rows;
  } else if (segment === 'active') {
    const res = await pool.query(`
      SELECT DISTINCT i.id, i.first_name, i.last_name, i.email, i.phone
      FROM investors i
      INNER JOIN investments inv ON inv.investor_id = i.id AND inv.status = 'active'
      WHERE i.email IS NOT NULL AND i.email <> ''
      ORDER BY i.first_name
    `);
    rows = res.rows;
  } else if (segment === 'pending_fica') {
    const res = await pool.query(`
      SELECT id, first_name, last_name, email, phone
      FROM investors
      WHERE (fica_status = 'pending' OR kyc_status = 'pending')
        AND email IS NOT NULL AND email <> ''
      ORDER BY first_name
    `);
    rows = res.rows;
  } else {
    // Treat as pool_id
    const res = await pool.query(`
      SELECT DISTINCT i.id, i.first_name, i.last_name, i.email, i.phone
      FROM investors i
      INNER JOIN investments inv ON inv.investor_id = i.id AND inv.pool_id = $1
      WHERE i.email IS NOT NULL AND i.email <> ''
      ORDER BY i.first_name
    `, [segment]);
    rows = res.rows;
  }
  return rows;
}

/* ══════════════════════════════════════════════════════════════
   GET /broadcast/preview?segment=X
   Returns { count } of matching investors
══════════════════════════════════════════════════════════════ */
router.get('/broadcast/preview', async (req, res) => {
  const { segment = 'all' } = req.query;
  try {
    const investors = await _getInvestors(segment);
    res.json({ count: investors.length });
  } catch (err) {
    console.error('[broadcast] preview error:', err.message);
    res.status(500).json({ error: 'Failed to count recipients', detail: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   POST /broadcast
   Body: { subject, message, channel, segment }
   Returns { sent, failed, total }
══════════════════════════════════════════════════════════════ */
router.post('/broadcast', async (req, res) => {
  const { subject, message, channel = 'email', segment = 'all' } = req.body || {};

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const validChannels = ['email', 'sms', 'both', 'push', 'all'];
  if (!validChannels.includes(channel)) {
    return res.status(400).json({ error: 'channel must be email, sms, both, push, or all' });
  }
  if ((channel === 'email' || channel === 'both' || channel === 'all') && !subject) {
    return res.status(400).json({ error: 'subject is required for email broadcasts' });
  }

  try {
    const investors = await _getInvestors(segment);

    let sent = 0;
    let failed = 0;
    const total = investors.length;

    // ── Push channel (handle first, may return early) ────────────────────────
    if (channel === 'push' || channel === 'all') {
      const investorIds = investors.map(i => i.id);
      const pushResult = await pushService.sendPushToAll(investorIds, {
        title: subject || 'SV Capital',
        body:  message,
        url:   '/portal/',
        icon:  '/assets/logo.png',
        badge: '/assets/logo.png',
        tag:   'sv-broadcast',
      });

      await pushService.logNotification({
        type:           'broadcast',
        title:          subject || 'Broadcast',
        body:           message,
        url:            '/portal/',
        recipientCount: pushResult.sent,
        sentBy:         req.user?.email || 'admin',
      });

      if (channel === 'push') {
        console.log(`[broadcast] push segment=${segment} total=${total} sent=${pushResult.sent}`);
        return res.json({ sent: pushResult.sent, failed: total - pushResult.sent, total });
      }
      // For 'all' channel, accumulate push sends and fall through to email/sms
      sent += pushResult.sent;
    }

    // ── Email / SMS batches ──────────────────────────────────────────────────
    for (let i = 0; i < investors.length; i += BATCH_SIZE) {
      const batch = investors.slice(i, i + BATCH_SIZE);
      const tasks = batch.map(async (inv) => {
        const emailTo = inv.email;
        const phone   = inv.phone;
        let ok = true;

        if (channel === 'email' || channel === 'both' || channel === 'all') {
          if (emailTo) {
            const result = await _sendEmail(emailTo, subject, message);
            if (!result.ok) {
              console.error(`[broadcast] email failed for ${emailTo}:`, result.reason);
              ok = false;
            }
          } else {
            ok = false;
          }
        }

        if (channel === 'sms' || channel === 'both' || channel === 'all') {
          if (phone) {
            try {
              await smsService.ENABLED
                ? smsService.sendDepositConfirmed // just test it's available
                : Promise.resolve();
              // Use the internal _send by reconstructing — smsService doesn't export _send,
              // so we replicate the africas talking call pattern via the public API:
              // The smsService module doesn't export a generic send. We do it via the internal
              // AT endpoint the same way smsService._send does.
              const qsModule = require('querystring');
              const https    = require('https');
              const AT_KEY   = process.env.AFRICASTALKING_API_KEY;
              const AT_USER  = process.env.AFRICASTALKING_USERNAME;
              const AT_SEND  = process.env.AFRICASTALKING_SENDER || '';

              if (AT_KEY && AT_USER) {
                const phone27 = String(phone).trim().replace(/\s/g, '').replace(/^0/, '+27');
                if (phone27.startsWith('+')) {
                  await new Promise((resolve) => {
                    const body = qsModule.stringify({
                      username: AT_USER,
                      to:       phone27,
                      message,
                      ...(AT_SEND ? { from: AT_SEND } : {}),
                    });
                    const reqHttp = https.request({
                      hostname: 'api.africastalking.com',
                      path:     '/version1/messaging',
                      method:   'POST',
                      headers: {
                        apiKey:           AT_KEY,
                        'Content-Type':   'application/x-www-form-urlencoded',
                        Accept:           'application/json',
                        'Content-Length': Buffer.byteLength(body),
                      },
                    }, (r) => {
                      let data = '';
                      r.on('data', c => (data += c));
                      r.on('end', () => resolve(data));
                    });
                    reqHttp.on('error', () => resolve(null));
                    reqHttp.write(body);
                    reqHttp.end();
                  });
                }
              }
            } catch (smsErr) {
              console.error(`[broadcast] SMS failed for ${phone}:`, smsErr.message);
              ok = false;
            }
          } else if (channel === 'sms') {
            // SMS only mode — no phone number
            ok = false;
          }
        }

        return ok;
      });

      const results = await Promise.allSettled(tasks);
      results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value) sent++;
        else failed++;
      });
    }

    console.log(`[broadcast] segment=${segment} channel=${channel} total=${total} sent=${sent} failed=${failed}`);
    res.json({ sent, failed, total });
  } catch (err) {
    console.error('[broadcast] error:', err.message);
    res.status(500).json({ error: 'Broadcast failed', detail: err.message });
  }
});

/* ── Manual pool cycler trigger ─────────────────────────────── */
router.post('/run-pool-cycler', async (req, res) => {
  try {
    const { cycleExpiredPools } = require('../jobs/poolCyclerCron');
    const count = await cycleExpiredPools();
    res.json({ ok: true, cycled: count });
  } catch (err) {
    console.error('[admin] manual pool cycler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
