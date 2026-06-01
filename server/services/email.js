/* ═══════════════════════════════════════════════════════════
   SV Capital — Transactional Email Service (Resend)
   All sends are fire-and-forget. A missing RESEND_API_KEY
   silently skips delivery rather than crashing the request.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const BASE_URL = process.env.BASE_URL || 'https://platform.svcapital.co.za';
// FROM_EMAIL must come from a domain verified in your Resend dashboard.
// Until svcapital.co.za is verified, use the Resend test address:
//   onboarding@resend.dev
const FROM = process.env.FROM_EMAIL || 'SV Capital <noreply@svcapital.co.za>';

/* ── HTML wrapper ─────────────────────────────────────────── */
function _wrap(body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222}
.shell{max-width:580px;margin:32px auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 6px 32px rgba(0,0,0,.10)}
.hdr{background:linear-gradient(135deg,#1a2235 0%,#253352 100%);padding:30px 40px;text-align:center}
.logo{font-size:1.55rem;font-weight:800;letter-spacing:-0.5px;color:#ff9b0c}
.logo em{color:#fff;font-style:normal}
.bdy{padding:38px 40px}
h2{font-size:1.2rem;font-weight:700;color:#1a2235;margin-bottom:14px}
p{font-size:0.93rem;color:#444;line-height:1.65;margin-bottom:14px}
.big{font-size:2.1rem;font-weight:800;color:#ff9b0c;display:block;margin:10px 0 18px}
.box{background:#f7f9fc;border-radius:12px;padding:18px 22px;margin:18px 0}
.row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #eee;font-size:0.87rem}
.row:last-child{border-bottom:none}
.lbl{color:#888}
.val{font-weight:600;color:#1a2235;text-align:right}
.btn{display:inline-block;background:#ff9b0c;color:#fff!important;text-decoration:none!important;padding:13px 30px;border-radius:10px;font-weight:700;font-size:0.94rem;margin:10px 0}
.green{color:#22c55e}
.gold{color:#ff9b0c}
.ftr{background:#f7f9fc;border-top:1px solid #eee;padding:18px 40px;text-align:center;font-size:0.76rem;color:#aaa}
.ftr a{color:#ff9b0c;text-decoration:none}
@media(max-width:600px){.bdy,.hdr,.ftr{padding:24px 20px}}
</style></head><body>
<div class="shell">
  <div class="hdr"><div class="logo">SV <em>Capital</em></div></div>
  <div class="bdy">${body}</div>
  <div class="ftr">SV Capital (Pty) Ltd &nbsp;·&nbsp; <a href="${BASE_URL}">platform.svcapital.co.za</a><br>
  This is an automated message — please do not reply directly.</div>
</div></body></html>`;
}

/* ── Core send ────────────────────────────────────────────── */
async function _send({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping:', subject); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      }),
    });
    const data = await r.json();
    if (!r.ok) console.error('[email] Resend error:', JSON.stringify(data));
    else       console.log(`[email] ✓ "${subject}" → ${Array.isArray(to) ? to[0] : to}`);
  } catch (err) {
    console.error('[email] send failed:', err.message);
  }
}

const _fmt  = v => `R${parseFloat(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const _pct  = v => `${(parseFloat(v || 0) * 100).toFixed(2)}%`;
const _date = v => v ? new Date(v).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

/* ── 1. Welcome ───────────────────────────────────────────── */
function sendWelcome(investor) {
  const { email, first_name, id } = investor;
  return _send({
    to: email,
    subject: `Welcome to SV Capital, ${first_name}! 🎉`,
    html: _wrap(`
      <h2>Welcome, ${first_name}! 👋</h2>
      <p>Your SV Capital investor account is live. Here's what to do next:</p>
      <div class="box">
        <div class="row"><span class="lbl">Investor ID</span><span class="val">${id}</span></div>
        <div class="row"><span class="lbl">Email</span><span class="val">${email}</span></div>
        <div class="row"><span class="lbl">Account Status</span><span class="val green">Active</span></div>
      </div>
      <p><strong>1. Complete FICA verification</strong> — upload your ID and proof of address to unlock all products.<br>
         <strong>2. Top up your wallet</strong> — via Paystack, Ozow, or bank transfer.<br>
         <strong>3. Start investing</strong> — browse our open pools and put your money to work.</p>
      <a href="${BASE_URL}/portal/" class="btn">Go to My Portal →</a>
    `),
    text: `Welcome to SV Capital, ${first_name}! Your investor account (${id}) is ready. Visit ${BASE_URL}/portal/ to get started.`,
  });
}

/* ── 2. Deposit confirmed ─────────────────────────────────── */
function sendDepositConfirmed(investor, amount, reference, gateway = 'EFT') {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Deposit confirmed — ${_fmt(amount)} credited to your wallet`,
    html: _wrap(`
      <h2>Deposit Confirmed ✅</h2>
      <p>Hi ${first_name}, your deposit has been received and your wallet has been credited.</p>
      <span class="big">${_fmt(amount)}</span>
      <div class="box">
        <div class="row"><span class="lbl">Amount</span><span class="val green">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Payment Method</span><span class="val">${gateway}</span></div>
        <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val green">Credited</span></div>
      </div>
      <p>Your funds are ready to invest. Browse our open pools and start growing your wealth.</p>
      <a href="${BASE_URL}/portal/" class="btn">Invest Now →</a>
    `),
    text: `Hi ${first_name}, ${_fmt(amount)} has been credited to your SV Capital wallet (ref: ${reference}). Visit ${BASE_URL}/portal/ to invest.`,
  });
}

/* ── 3. Investment created ────────────────────────────────── */
function sendInvestmentCreated(investor, { poolName, amount, annualRate, termMonths, expectedReturn, endDate }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Investment confirmed — ${_fmt(amount)} in ${poolName}`,
    html: _wrap(`
      <h2>Investment Confirmed 🎯</h2>
      <p>Hi ${first_name}, your investment has been placed and is now active.</p>
      <span class="big">${_fmt(amount)}</span>
      <div class="box">
        <div class="row"><span class="lbl">Pool</span><span class="val">${poolName}</span></div>
        <div class="row"><span class="lbl">Amount Invested</span><span class="val gold">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Annual Rate</span><span class="val green">${_pct(annualRate)}</span></div>
        <div class="row"><span class="lbl">Term</span><span class="val">${termMonths} months</span></div>
        <div class="row"><span class="lbl">Expected Return</span><span class="val green">${_fmt(expectedReturn)}</span></div>
        <div class="row"><span class="lbl">Maturity Date</span><span class="val">${_date(endDate)}</span></div>
      </div>
      <p>Track the performance of your investment in your portal at any time.</p>
      <a href="${BASE_URL}/portal/" class="btn">View My Investments →</a>
    `),
    text: `Hi ${first_name}, your investment of ${_fmt(amount)} in ${poolName} at ${_pct(annualRate)} p.a. is confirmed. Maturity: ${_date(endDate)}.`,
  });
}

/* ── 4. Maturity alert (N days before end) ────────────────── */
function sendMaturityAlert(investor, { poolName, amount, expectedReturn, endDate, daysLeft }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Action required: ${poolName} matures in ${daysLeft} days`,
    html: _wrap(`
      <h2>Investment Maturing Soon ⏰</h2>
      <p>Hi ${first_name}, your investment in <strong>${poolName}</strong> matures in
         <strong class="gold">${daysLeft} days</strong> on <strong>${_date(endDate)}</strong>.</p>
      <div class="box">
        <div class="row"><span class="lbl">Pool</span><span class="val">${poolName}</span></div>
        <div class="row"><span class="lbl">Principal</span><span class="val">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Expected Return</span><span class="val green">${_fmt(expectedReturn)}</span></div>
        <div class="row"><span class="lbl">Maturity Date</span><span class="val gold">${_date(endDate)}</span></div>
      </div>
      <p>Please log in and submit your <strong>maturity instruction</strong> (reinvest or pay out) before the maturity date to avoid delays.</p>
      <a href="${BASE_URL}/portal/" class="btn">Submit Instruction →</a>
    `),
    text: `Hi ${first_name}, your ${poolName} investment matures in ${daysLeft} days (${_date(endDate)}). Log in to submit your maturity instruction: ${BASE_URL}/portal/`,
  });
}

/* ── 5. Investment matured / paid out ────────────────────── */
function sendInvestmentMatured(investor, { poolName, amount, actualReturn }) {
  const { email, first_name } = investor;
  const total = parseFloat(amount || 0) + parseFloat(actualReturn || 0);
  return _send({
    to: email,
    subject: `Your ${poolName} investment has matured 🎉`,
    html: _wrap(`
      <h2>Investment Matured 🎉</h2>
      <p>Hi ${first_name}, your investment in <strong>${poolName}</strong> has successfully matured and been processed.</p>
      <div class="box">
        <div class="row"><span class="lbl">Pool</span><span class="val">${poolName}</span></div>
        <div class="row"><span class="lbl">Principal</span><span class="val">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Return Earned</span><span class="val green">${_fmt(actualReturn)}</span></div>
        <div class="row"><span class="lbl">Total Processed</span><span class="val gold">${_fmt(total)}</span></div>
      </div>
      <p>Funds have been processed as per your maturity instruction. Log in to view the full details.</p>
      <a href="${BASE_URL}/portal/" class="btn">View My Portfolio →</a>
    `),
    text: `Hi ${first_name}, your ${poolName} investment has matured. Return: ${_fmt(actualReturn)}. Total: ${_fmt(total)}. Visit ${BASE_URL}/portal/ to view details.`,
  });
}

/* ── 6. Support ticket response ──────────────────────────── */
function sendTicketResponse(investor, { subject: ticketSubject, adminResponse }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Response to your query: "${ticketSubject}"`,
    html: _wrap(`
      <h2>Support Response 💬</h2>
      <p>Hi ${first_name}, the SV Capital support team has responded to your query.</p>
      <div class="box" style="border-left:4px solid #ff9b0c;padding-left:18px">
        <p style="margin:0;font-size:0.9rem;color:#333;line-height:1.7">${adminResponse.replace(/\n/g, '<br>')}</p>
      </div>
      <p>If you have further questions, please log in and raise a follow-up ticket.</p>
      <a href="${BASE_URL}/portal/" class="btn">View My Tickets →</a>
    `),
    text: `Hi ${first_name}, the team has responded to "${ticketSubject}":\n\n${adminResponse}\n\nLog in at ${BASE_URL}/portal/`,
  });
}

/* ── 7. Password reset ───────────────────────────────────── */
function sendPasswordReset(email, firstName, resetLink) {
  return _send({
    to: email,
    subject: 'Reset your SV Capital password',
    html: _wrap(`
      <h2>Password Reset Request 🔐</h2>
      <p>Hi ${firstName || 'there'}, we received a request to reset your SV Capital password.</p>
      <p>Click the button below — this link expires in <strong>30 minutes</strong>.</p>
      <a href="${resetLink}" class="btn">Reset My Password →</a>
      <p style="margin-top:24px;font-size:0.82rem;color:#999">
        If you did not request this reset, you can safely ignore this email. Your password will not change.
      </p>
    `),
    text: `Hi ${firstName || 'there'}, reset your SV Capital password here (expires in 30 min): ${resetLink}`,
  });
}

/* ── 8. Withdrawal requested ──────────────────────────────── */
function sendWithdrawalRequested(investor, { amount, bankName, accountNumber, reference }) {
  const { email, first_name } = investor;
  const last4 = String(accountNumber || '').slice(-4).padStart(4, '•');
  return _send({
    to: email,
    subject: `Withdrawal request received — ${_fmt(amount)}`,
    html: _wrap(`
      <h2>Withdrawal Request Received 📤</h2>
      <p>Hi ${first_name}, we've received your withdrawal request and it is being processed.</p>
      <span class="big">${_fmt(amount)}</span>
      <div class="box">
        <div class="row"><span class="lbl">Amount</span><span class="val">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Bank</span><span class="val">${bankName || '—'}</span></div>
        <div class="row"><span class="lbl">Account</span><span class="val">••••${last4}</span></div>
        <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val" style="color:#f59e0b">Pending Processing</span></div>
      </div>
      <p>Transfers are processed within 1–3 business days. You will receive a confirmation once the funds have been sent.</p>
      <a href="${BASE_URL}/portal/" class="btn">View My Wallet →</a>
    `),
    text: `Hi ${first_name}, your withdrawal of ${_fmt(amount)} to ••••${last4} (${bankName}) has been received (ref: ${reference}). Allow 1–3 business days.`,
  });
}

/* ── 9. Withdrawal processed ─────────────────────────────── */
function sendWithdrawalProcessed(investor, { amount, bankName, accountNumber, reference }) {
  const { email, first_name } = investor;
  const last4 = String(accountNumber || '').slice(-4).padStart(4, '•');
  return _send({
    to: email,
    subject: `Withdrawal processed — ${_fmt(amount)} sent to your bank`,
    html: _wrap(`
      <h2>Withdrawal Processed ✅</h2>
      <p>Hi ${first_name}, your withdrawal has been processed and the funds are on their way to your bank account.</p>
      <span class="big">${_fmt(amount)}</span>
      <div class="box">
        <div class="row"><span class="lbl">Amount</span><span class="val green">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Bank</span><span class="val">${bankName || '—'}</span></div>
        <div class="row"><span class="lbl">Account</span><span class="val">••••${last4}</span></div>
        <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val green">Processed</span></div>
      </div>
      <p>Please allow 1–3 business days for the funds to reflect in your account.</p>
      <a href="${BASE_URL}/portal/" class="btn">View My Wallet →</a>
    `),
    text: `Hi ${first_name}, your withdrawal of ${_fmt(amount)} to ••••${last4} (${bankName}) has been processed (ref: ${reference}).`,
  });
}

/* ── 10. Withdrawal rejected ─────────────────────────────── */
function sendWithdrawalRejected(investor, { amount, reason }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Withdrawal request declined — ${_fmt(amount)}`,
    html: _wrap(`
      <h2>Withdrawal Request Declined ❌</h2>
      <p>Hi ${first_name}, unfortunately your withdrawal request could not be processed.</p>
      <div class="box">
        <div class="row"><span class="lbl">Amount</span><span class="val">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Reason</span><span class="val" style="color:#ef4444">${reason || 'Contact support for details'}</span></div>
        <div class="row"><span class="lbl">Refunded</span><span class="val green">Yes — back in your wallet</span></div>
      </div>
      <p>The ${_fmt(amount)} has been refunded to your wallet. Please contact support if you have questions.</p>
      <a href="${BASE_URL}/portal/" class="btn">Contact Support →</a>
    `),
    text: `Hi ${first_name}, your withdrawal of ${_fmt(amount)} was declined: ${reason || 'contact support'}. Funds refunded to your wallet.`,
  });
}

/* ── 11. Bank account approved ───────────────────────────── */
function sendBankAccountApproved(investor, { bankName, accountNumber }) {
  const { email, first_name } = investor;
  const last4 = String(accountNumber || '').slice(-4).padStart(4, '•');
  return _send({
    to: email,
    subject: 'Your bank account has been verified ✅',
    html: _wrap(`
      <h2>Bank Account Verified ✅</h2>
      <p>Hi ${first_name}, your bank account has been verified and approved for withdrawals.</p>
      <div class="box">
        <div class="row"><span class="lbl">Bank</span><span class="val">${bankName || '—'}</span></div>
        <div class="row"><span class="lbl">Account</span><span class="val">••••${last4}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val green">Approved</span></div>
      </div>
      <p>You can now request withdrawals from your wallet to this account at any time.</p>
      <a href="${BASE_URL}/portal/" class="btn">Go to My Wallet →</a>
    `),
    text: `Hi ${first_name}, your bank account ••••${last4} (${bankName}) has been approved for withdrawals.`,
  });
}

module.exports = {
  sendWelcome,
  sendDepositConfirmed,
  sendInvestmentCreated,
  sendMaturityAlert,
  sendInvestmentMatured,
  sendTicketResponse,
  sendPasswordReset,
  sendWithdrawalRequested,
  sendWithdrawalProcessed,
  sendWithdrawalRejected,
  sendBankAccountApproved,
};
