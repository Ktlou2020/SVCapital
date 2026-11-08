'use strict';
const https       = require('https');
const querystring = require('querystring');

const AT_KEY    = process.env.AFRICASTALKING_API_KEY;
const AT_USER   = process.env.AFRICASTALKING_USERNAME;
const AT_SENDER = process.env.AFRICASTALKING_SENDER || '';
const ENABLED   = !!(AT_KEY && AT_USER);

function _formatPhone(raw) {
  return String(raw || '').trim().replace(/\s/g, '').replace(/^0/, '+27');
}

function _fmt(amount) {
  return 'R' + Number(amount || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _send(to, message) {
  if (!ENABLED || !to) return Promise.resolve();
  const phone = _formatPhone(to);
  if (!phone.startsWith('+')) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      username: AT_USER,
      to:       phone,
      message,
      ...(AT_SENDER ? { from: AT_SENDER } : {}),
    });

    const req = https.request({
      hostname: 'api.africastalking.com',
      path:     '/version1/messaging',
      method:   'POST',
      headers: {
        'apiKey':         AT_KEY,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const status = parsed.SMSMessageData?.Recipients?.[0]?.status;
          if (status === 'Success') resolve(parsed);
          else reject(new Error(data));
        } catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendDepositConfirmed(phone, firstName, amount) {
  const msg = `Hi ${firstName}, your SV Capital deposit of ${_fmt(amount)} has been confirmed and added to your wallet. Log in to invest: svcapital.co.za`;
  return _send(phone, msg).catch(e => console.error('[SMS] deposit confirmed:', e.message));
}

async function sendWithdrawalProcessed(phone, firstName, amount) {
  const msg = `Hi ${firstName}, your SV Capital withdrawal of ${_fmt(amount)} has been processed and is on its way to your bank account.`;
  return _send(phone, msg).catch(e => console.error('[SMS] withdrawal processed:', e.message));
}

async function sendWithdrawalRejected(phone, firstName, amount) {
  const msg = `Hi ${firstName}, your SV Capital withdrawal of ${_fmt(amount)} could not be processed. The amount has been refunded to your wallet. Please contact us for details.`;
  return _send(phone, msg).catch(e => console.error('[SMS] withdrawal rejected:', e.message));
}

async function sendMaturityAlert(phone, firstName, amount, poolName) {
  const msg = `Hi ${firstName}, your SV Capital investment in ${poolName} has matured. ${_fmt(amount)} is ready for reinvestment or withdrawal. Log in: svcapital.co.za`;
  return _send(phone, msg).catch(e => console.error('[SMS] maturity alert:', e.message));
}

/* An invitation to join a stokvel. The one message here sent to somebody who
   may not be a user at all — a treasurer typing in a cousin's cell number
   has handed us the only way to reach them — so it has to be complete in
   160 characters: who, what, and how to find it. No link: the invitation is
   addressed, and signing in as the holder of this number is what claims it.
   See services/stokvelInvites.js. */
async function sendStokvelInvite(phone, { inviterName, stokvelName, terms }) {
  /* The rules are in the SMS and not only in the email, because for a great
     many stokvel members the SMS is the only one of the two they will read. */
  const msg = `${inviterName} invited you to join ${stokvelName} on SV Capital. `
            + (terms ? `${terms} ` : '')
            + `Sign in or sign up with this number and the invite is on your Sub-accounts screen: svcapital.co.za`;
  return _send(phone, msg);
}

module.exports = { sendDepositConfirmed, sendWithdrawalProcessed, sendWithdrawalRejected, sendMaturityAlert, sendStokvelInvite, ENABLED };
