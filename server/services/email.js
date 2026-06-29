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
.hdr{background:linear-gradient(135deg,#303030 0%,#303030 100%);padding:30px 40px;text-align:center}
.logo{display:flex;align-items:center;justify-content:center;gap:12px}
.logo img{height:48px;width:48px;object-fit:contain;display:block;flex-shrink:0}
.logo-text{font-size:1.55rem;font-weight:800;letter-spacing:-0.5px;color:#ff9b0c}
.logo-text em{color:#fff;font-style:normal}
.bdy{padding:38px 40px}
h2{font-size:1.2rem;font-weight:700;color:#303030;margin-bottom:14px}
p{font-size:0.93rem;color:#444;line-height:1.65;margin-bottom:14px}
.big{font-size:2.1rem;font-weight:800;color:#ff9b0c;display:block;margin:10px 0 18px}
.box{background:#f7f9fc;border-radius:12px;padding:18px 22px;margin:18px 0}
.row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #eee;font-size:0.87rem}
.row:last-child{border-bottom:none}
.lbl{color:#888}
.val{font-weight:600;color:#303030;text-align:right}
.btn{display:inline-block;background:#ff9b0c;color:#fff!important;text-decoration:none!important;padding:13px 30px;border-radius:10px;font-weight:700;font-size:0.94rem;margin:10px 0}
.green{color:#22c55e}
.gold{color:#ff9b0c}
.ftr{background:#f7f9fc;border-top:1px solid #eee;padding:18px 40px;text-align:center;font-size:0.76rem;color:#aaa}
.ftr a{color:#ff9b0c;text-decoration:none}
@media(max-width:600px){.bdy,.hdr,.ftr{padding:24px 20px}}
</style></head><body>
<div class="shell">
  <div class="hdr"><div class="logo"><img src="${BASE_URL}/assets/logo.png" alt="" /><span class="logo-text">SV <em>Capital</em></span></div></div>
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

/* ── 7a. Ticket assigned to admin user ──────────────────── */
function sendTicketAssigned(assignedUser, { ticketId, subject, investorName, category, priority }) {
  const { email, first_name } = assignedUser;
  const priorityColor = priority === 'urgent' ? '#ef4444' : priority === 'high' ? '#f97316' : '#6b7280';
  return _send({
    to: email,
    subject: `You've been assigned a support ticket: "${subject}"`,
    html: _wrap(`
      <h2>Support Ticket Assigned 🎫</h2>
      <p>Hi ${first_name}, a support ticket has been assigned to you.</p>
      <div class="box">
        <p style="margin:0 0 6px"><strong>Ticket:</strong> #${ticketId} — ${subject}</p>
        <p style="margin:0 0 6px"><strong>Investor:</strong> ${investorName}</p>
        ${category ? `<p style="margin:0 0 6px"><strong>Category:</strong> ${category.replace(/_/g, ' ')}</p>` : ''}
        <p style="margin:0"><strong>Priority:</strong> <span style="color:${priorityColor};font-weight:700">${priority}</span></p>
      </div>
      <p>Please log in to the admin dashboard to review and respond.</p>
      <a href="${BASE_URL}/admin/" class="btn">Open Admin Dashboard →</a>
    `),
    text: `Hi ${first_name}, ticket #${ticketId} "${subject}" from ${investorName} has been assigned to you. Log in at ${BASE_URL}/admin/`,
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

/* ── 8. Withdrawal requested (investor notification) ────────── */
function sendWithdrawalRequested(investor, { amount, reference }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Withdrawal request received — ${_fmt(amount)}`,
    html: _wrap(`
      <h2>Withdrawal Request Received 📤</h2>
      <p>Hi ${first_name}, we've received your withdrawal request and it is being processed by our team.</p>
      <span class="big">${_fmt(amount)}</span>
      <div class="box">
        <div class="row"><span class="lbl">Amount Requested</span><span class="val gold">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val" style="color:#f59e0b">Pending Review</span></div>
      </div>
      <p>Funds will be transferred to your verified bank account on record once our team has processed the request. This typically takes 1–2 business days.</p>
      <a href="${BASE_URL}/portal/" class="btn">View Wallet →</a>
    `),
    text: `Hi ${first_name}, your withdrawal request of ${_fmt(amount)} (ref: ${reference}) has been received and is pending processing.`,
  });
}

/* ── 9. Withdrawal processed (payment sent) ─────────────────── */
function sendWithdrawalProcessed(investor, { amount, reference, bankName }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Withdrawal processed — ${_fmt(amount)} sent to your bank`,
    html: _wrap(`
      <h2>Withdrawal Processed ✅</h2>
      <p>Hi ${first_name}, your withdrawal has been processed and the funds have been sent to your bank account.</p>
      <span class="big">${_fmt(amount)}</span>
      <div class="box">
        <div class="row"><span class="lbl">Amount Sent</span><span class="val green">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Bank</span><span class="val">${bankName || 'Registered bank account'}</span></div>
        <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val green">Completed</span></div>
      </div>
      <p>Funds typically appear in your bank account within 1 business day. Please contact support if you do not receive the funds within 2 business days.</p>
      <a href="${BASE_URL}/portal/" class="btn">View Portfolio →</a>
    `),
    text: `Hi ${first_name}, your withdrawal of ${_fmt(amount)} (ref: ${reference}) has been processed and sent to your bank.`,
  });
}

/* ── 10. Withdrawal rejected (funds returned to wallet) ─────── */
function sendWithdrawalRejected(investor, { amount, reference, reason }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Withdrawal request declined — ${_fmt(amount)} returned to wallet`,
    html: _wrap(`
      <h2>Withdrawal Request Declined ⚠️</h2>
      <p>Hi ${first_name}, unfortunately your withdrawal request could not be processed at this time.</p>
      <div class="box">
        <div class="row"><span class="lbl">Amount</span><span class="val gold">${_fmt(amount)}</span></div>
        <div class="row"><span class="lbl">Reference</span><span class="val">${reference}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val" style="color:#ef4444">Declined</span></div>
        ${reason ? `<div class="row"><span class="lbl">Reason</span><span class="val">${reason}</span></div>` : ''}
      </div>
      <p><strong>${_fmt(amount)} has been returned to your SV Capital wallet.</strong></p>
      <p>If you believe this is an error or need further assistance, please contact our support team by raising a ticket.</p>
      <a href="${BASE_URL}/portal/" class="btn">Contact Support →</a>
    `),
    text: `Hi ${first_name}, your withdrawal of ${_fmt(amount)} (ref: ${reference}) was declined and the funds have been returned to your wallet.${reason ? ' Reason: ' + reason : ''} Contact support if you need help.`,
  });
}

/* ── 11. Bank account approved ───────────────────────────────── */
function sendBankAccountApproved(investor, { bankName, accountNumber }) {
  const { email, first_name } = investor;
  const masked = accountNumber ? '••••••' + String(accountNumber).slice(-4) : '—';
  return _send({
    to: email,
    subject: 'Your bank account has been verified ✅',
    html: _wrap(`
      <h2>Bank Account Verified ✅</h2>
      <p>Hi ${first_name}, great news! Your linked bank account has been verified and approved by our team.</p>
      <div class="box">
        <div class="row"><span class="lbl">Bank</span><span class="val">${bankName}</span></div>
        <div class="row"><span class="lbl">Account Number</span><span class="val">${masked}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val green">Approved</span></div>
      </div>
      <p>You can now request wallet withdrawals to this bank account at any time from your portal.</p>
      <a href="${BASE_URL}/portal/" class="btn">Withdraw Funds →</a>
    `),
    text: `Hi ${first_name}, your bank account (${bankName} — ${masked}) has been verified. You can now withdraw funds from your SV Capital wallet.`,
  });
}

/* ── 12. Monthly portfolio statement ─────────────────────── */
function sendMonthlyStatement(investor, { investments, recentTransactions }) {
  const { email, first_name, last_name, wallet_balance, total_invested, total_returns } = investor;
  if (!email) return Promise.resolve();

  const now = new Date();
  const monthName = now.toLocaleString('en-ZA', { month: 'long', year: 'numeric' });
  const rand = (n) => 'R' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const pct = (r) => (Number(r || 0) * 100).toFixed(2) + '%';
  const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const statusColor = (s) => ({ active: '#10b981', matured: '#7c5cfc', pending: '#f59e0b', cancelled: '#ef4444' }[s] || '#6b7280');

  const activeInvestments = investments.filter(i => i.status === 'active');
  const effectiveReturn = Number(total_invested) > 0 ? ((Number(total_returns) / Number(total_invested)) * 100).toFixed(2) + '%' : '—';

  const investmentRows = activeInvestments.length
    ? activeInvestments.map(i => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#e5e7eb">${i.pool_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#FF9B0C;font-weight:600">${rand(i.amount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#10b981">${pct(i.annual_rate)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#9ca3af">${fmtDate(i.end_date)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a"><span style="background:${statusColor(i.status)}22;color:${statusColor(i.status)};padding:2px 8px;border-radius:20px;font-size:12px;font-weight:600">${i.status}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="5" style="padding:16px;text-align:center;color:#6b7280">No active investments</td></tr>';

  const txnRows = recentTransactions.length
    ? recentTransactions.slice(0, 5).map(t => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#e5e7eb;text-transform:capitalize">${t.type}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:${Number(t.amount) >= 0 ? '#10b981' : '#ef4444'};font-weight:600">${Number(t.amount) >= 0 ? '+' : ''}${rand(t.amount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#9ca3af">${fmtDate(t.created_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="padding:16px;text-align:center;color:#6b7280">No transactions in the past 30 days</td></tr>';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:40px 20px">
  <div style="text-align:center;margin-bottom:32px">
    <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:6px">
      <img src="${BASE_URL}/assets/logo.png" alt="" style="height:48px;width:48px;object-fit:contain;display:block">
      <span style="font-size:28px;font-weight:900;color:#FF9B0C;letter-spacing:-0.5px">SV <span style="color:#fff">Capital</span></span>
    </div>
    <div style="font-size:13px;color:#6b7280;margin-top:4px">Monthly Statement — ${monthName}</div>
  </div>

  <div style="background:#161616;border:1px solid #262626;border-radius:16px;padding:28px;margin-bottom:20px">
    <div style="font-size:16px;font-weight:700;color:#f9fafb;margin-bottom:4px">Hi ${first_name || 'Investor'},</div>
    <div style="font-size:13px;color:#9ca3af">Here is your portfolio summary for ${monthName}.</div>
  </div>

  <div style="display:grid;gap:12px;margin-bottom:20px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="32%" style="background:#161616;border:1px solid #262626;border-radius:12px;padding:20px;text-align:center">
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Total Invested</div>
        <div style="font-size:22px;font-weight:800;color:#FF9B0C">${rand(total_invested)}</div>
      </td>
      <td width="4%"></td>
      <td width="32%" style="background:#161616;border:1px solid #262626;border-radius:12px;padding:20px;text-align:center">
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Total Returns</div>
        <div style="font-size:22px;font-weight:800;color:#10b981">${rand(total_returns)}</div>
      </td>
      <td width="4%"></td>
      <td width="32%" style="background:#161616;border:1px solid #262626;border-radius:12px;padding:20px;text-align:center">
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Wallet Balance</div>
        <div style="font-size:22px;font-weight:800;color:#f9fafb">${rand(wallet_balance)}</div>
      </td>
    </tr></table>
  </div>

  <div style="background:#161616;border:1px solid #262626;border-radius:16px;margin-bottom:20px;overflow:hidden">
    <div style="padding:16px 20px;border-bottom:1px solid #262626">
      <span style="font-size:14px;font-weight:700;color:#f9fafb">Active Investments (${activeInvestments.length})</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <thead><tr style="background:#1a1a1a">
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Pool</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Amount</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Rate</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Matures</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Status</th>
      </tr></thead>
      <tbody>${investmentRows}</tbody>
    </table>
  </div>

  <div style="background:#161616;border:1px solid #262626;border-radius:16px;margin-bottom:24px;overflow:hidden">
    <div style="padding:16px 20px;border-bottom:1px solid #262626">
      <span style="font-size:14px;font-weight:700;color:#f9fafb">Recent Transactions (last 30 days)</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      <thead><tr style="background:#1a1a1a">
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Type</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Amount</th>
        <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase">Date</th>
      </tr></thead>
      <tbody>${txnRows}</tbody>
    </table>
  </div>

  <div style="text-align:center;margin-bottom:24px">
    <a href="${process.env.PORTAL_URL || 'https://svcapital.co.za/portal'}" style="display:inline-block;background:linear-gradient(135deg,#FF9B0C,#e07a00);color:#000;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none">View Full Portfolio →</a>
  </div>

  <div style="text-align:center;font-size:11px;color:#4b5563;line-height:1.6">
    <p>SV Capital (Pty) Ltd · Registered Investment Manager · FSP Number XXXXX</p>
    <p>This statement is for information purposes only and does not constitute financial advice.</p>
    <p>Effective overall return: <strong style="color:#10b981">${effectiveReturn}</strong></p>
  </div>
</div></body></html>`;

  return _send({ to: email, subject: `Your SV Capital Statement — ${monthName}`, html });
}

/* ── 13. Director monthly report ────────────────────────── */
function sendDirectorReport(director, data) {
  const { email, first_name } = director;
  const { monthLabel, aum, newInvestors, returnsTotal, depositsTotal, totalInvestors, pools } = data;
  const fmtR = v => `R${Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtN = v => Number(v || 0).toLocaleString('en-ZA');

  const poolRows = (pools && pools.length)
    ? pools.map(p => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:0.86rem">${p.pool_name || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:0.86rem;text-transform:capitalize">${p.product_type || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:0.86rem;color:#ff9b0c;font-weight:600">${fmtR(p.invested)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:0.86rem;text-align:right">${fmtN(p.investors)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="padding:12px;text-align:center;color:#aaa;font-size:0.85rem">No active pool data</td></tr>';

  return _send({
    to: email,
    subject: `SV Capital — Monthly Director Report: ${monthLabel}`,
    html: _wrap(`
      <h2>Monthly Director Report 📊</h2>
      <p>Hi ${first_name || 'Director'}, here is the SV Capital platform summary for <strong>${monthLabel}</strong>.</p>

      <div class="box">
        <div class="row"><span class="lbl">Total AUM (Active Investments)</span><span class="val gold">${fmtR(aum)}</span></div>
        <div class="row"><span class="lbl">Total Active Investors</span><span class="val">${fmtN(totalInvestors)}</span></div>
        <div class="row"><span class="lbl">New Investors This Month</span><span class="val green">${fmtN(newInvestors)}</span></div>
        <div class="row"><span class="lbl">Returns Distributed This Month</span><span class="val green">${fmtR(returnsTotal)}</span></div>
        <div class="row"><span class="lbl">Deposits Received This Month</span><span class="val">${fmtR(depositsTotal)}</span></div>
      </div>

      <h2 style="margin-top:24px">Pool Breakdown (Top 10 Active)</h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:10px;border-radius:10px;overflow:hidden;border:1px solid #eee">
        <thead>
          <tr style="background:#f7f9fc">
            <th style="padding:9px 12px;text-align:left;font-size:0.78rem;color:#888;font-weight:600;text-transform:uppercase">Pool</th>
            <th style="padding:9px 12px;text-align:left;font-size:0.78rem;color:#888;font-weight:600;text-transform:uppercase">Type</th>
            <th style="padding:9px 12px;text-align:left;font-size:0.78rem;color:#888;font-weight:600;text-transform:uppercase">Total Invested</th>
            <th style="padding:9px 12px;text-align:right;font-size:0.78rem;color:#888;font-weight:600;text-transform:uppercase"># Investors</th>
          </tr>
        </thead>
        <tbody>${poolRows}</tbody>
      </table>

      <p style="margin-top:22px">Log in to the admin panel to view full breakdowns, transaction details, and investor activity.</p>
      <a href="${BASE_URL}/admin/" class="btn">Go to Admin Panel →</a>
    `),
    text: `Director Report — ${monthLabel}\n\nAUM: ${fmtR(aum)}\nTotal Investors: ${fmtN(totalInvestors)}\nNew Investors: ${fmtN(newInvestors)}\nReturns Distributed: ${fmtR(returnsTotal)}\nDeposits: ${fmtR(depositsTotal)}\n\nLog in at ${BASE_URL}/admin/`,
  });
}

/* ── 14. Waitlist notification ───────────────────────────── */
function sendWaitlistNotification(investor, { poolName }) {
  const { email, first_name } = investor;
  return _send({
    to: email,
    subject: `Good news — ${poolName} is open again!`,
    html: _wrap(`
      <h2>Investment Pool Now Open 🎉</h2>
      <p>Hi ${first_name || 'there'}, great news!</p>
      <p>The investment pool you joined the waitlist for — <strong>${poolName}</strong> — is now open for new investments.</p>
      <div class="box">
        <div class="row"><span class="lbl">Pool</span><span class="val">${poolName}</span></div>
        <div class="row"><span class="lbl">Status</span><span class="val green">Open for Investment</span></div>
      </div>
      <p>Log in now to secure your spot before it fills up again. Pools can close quickly once reopened!</p>
      <a href="${BASE_URL}/portal/" class="btn">Invest Now →</a>
    `),
    text: `Hi ${first_name || 'there'}, ${poolName} is now open for new investments. Log in to secure your spot: ${BASE_URL}/portal/`,
  });
}

/* ── 15. KYC / FICA approved ─────────────────────────────── */
function sendKycApproved(investor) {
  const { email, first_name } = investor;
  if (!email) return Promise.resolve();
  const today = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });
  return _send({
    to: email,
    subject: 'Identity Verified — You\'re Ready to Invest ✅',
    html: _wrap(`
      <h2>FICA Verification Approved ✅</h2>
      <p>Hi ${first_name}, great news! Your identity documents have been reviewed and approved by our compliance team.</p>
      <div class="box">
        <div class="row"><span class="lbl">Status</span><span class="val green">Approved</span></div>
        <div class="row"><span class="lbl">Verified on</span><span class="val">${today}</span></div>
      </div>
      <p>Your account is now fully verified. You can invest in all available pools on the SV Capital platform.</p>
      <a href="${BASE_URL}/portal/" class="btn">Start Investing →</a>
    `),
    text: `Hi ${first_name}, your FICA/KYC documents have been approved. Your account is now fully verified — log in to start investing.`,
  });
}

/* ── 14. Login anomaly alert ─────────────────────────────── */
function sendLoginAlert(recipient, { ip, time }) {
  // recipient can be an investor row (email, first_name) or a user row (email, first_name)
  const email      = recipient.email;
  const firstName  = recipient.first_name || 'there';
  const fmtTime    = time ? new Date(time).toLocaleString('en-ZA', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }) : 'Unknown time';
  return _send({
    to: email,
    subject: 'New login to your SV Capital account',
    html: _wrap(`
      <h2>New Login Detected 🔔</h2>
      <p>Hi ${firstName}, we detected a login to your SV Capital account from a new location.</p>
      <div class="box">
        <div class="row"><span class="lbl">IP Address</span><span class="val">${ip || 'Unknown'}</span></div>
        <div class="row"><span class="lbl">Time</span><span class="val">${fmtTime}</span></div>
      </div>
      <p>If this was you, no action is needed.</p>
      <p><strong>If this wasn't you</strong>, please contact us immediately at
         <a href="mailto:support@svcapital.co.za">support@svcapital.co.za</a>
         or change your password right away.</p>
      <a href="${BASE_URL}/portal/" class="btn">Change My Password →</a>
    `),
    text: `Hi ${firstName}, a login was detected from a new location (IP: ${ip || 'Unknown'}) at ${fmtTime}. If this wasn't you, contact us at support@svcapital.co.za or change your password immediately.`,
  });
}

/* ── 15. KYC / FICA rejected ─────────────────────────────── */
function sendKycRejected(investor, { reason, notes } = {}) {
  const { email, first_name } = investor;
  if (!email) return Promise.resolve();
  const detail = notes || reason || 'The documents provided did not meet our verification requirements.';
  return _send({
    to: email,
    subject: 'Action Required: FICA Documents Need Attention',
    html: _wrap(`
      <h2>FICA Verification Unsuccessful</h2>
      <p>Hi ${first_name}, unfortunately we could not verify your identity documents at this time.</p>
      <div class="box">
        <div class="row"><span class="lbl">Status</span><span class="val" style="color:#ef4444">Requires Re-submission</span></div>
        <div class="row"><span class="lbl">Reason</span><span class="val">${detail}</span></div>
      </div>
      <p>Please log in to your portal, update your documents, and resubmit. Our team will re-review within 1–2 business days.</p>
      <a href="${BASE_URL}/portal/" class="btn">Update Documents →</a>
    `),
    text: `Hi ${first_name}, your FICA/KYC verification was unsuccessful. Reason: ${detail}. Please update and resubmit your documents via the portal.`,
  });
}

/* ── 16. FICA re-verification reminder ───────────────────── */
function sendFicaResubmitReminder(investor) {
  return _send({
    to: investor.email,
    subject: 'Action Required: Please resubmit your FICA documents',
    html: _wrap(`
      <h2>FICA Document Re-verification Required</h2>
      <p>Dear ${investor.first_name},</p>
      <p>Your FICA verification documents are approaching their 3-year validity period. To comply with South African regulatory requirements, we kindly request that you resubmit your identity documents.</p>
      <p>Please log in to your SV Capital investor portal and navigate to <strong>My Profile → KYC Documents</strong> to upload updated documents.</p>
      <a href="https://platform.svcapital.co.za/portal/" class="btn">Resubmit Documents</a>
      <p>If you have any questions, please contact our support team.</p>
    `),
  });
}

/* ── Gift: received by existing investor ──────────────────── */
function sendGiftReceived(to, { senderName, amount, message, recipientName }) {
  const amt = parseFloat(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 });
  return _send({
    to,
    subject: `🎁 ${senderName} sent you a R${Math.round(amount)} investment gift`,
    text: `${senderName} sent you a R${amt} investment gift! ${message ? `"${message}" ` : ''}The funds are now in your SV Capital wallet.`,
    html: _wrap(`
      <h2>You've received an investment gift! 🎁</h2>
      <p>Hi ${recipientName},</p>
      <p><strong>${senderName}</strong> just sent you an investment gift on SV Capital.</p>
      ${message ? `<div class="box" style="border-left:4px solid #ff9b0c;background:#fffbf0"><p style="font-style:italic;color:#555;margin:0">&ldquo;${message}&rdquo;</p></div>` : ''}
      <span class="big">R${amt}</span>
      <p>This amount has been added directly to your wallet and is ready to invest right now.</p>
      <a href="${BASE_URL}/portal/" class="btn">Go to My Wallet →</a>
      <p style="font-size:0.8rem;color:#aaa;margin-top:24px">Gift sender: ${senderName} &nbsp;·&nbsp; SV Capital — Venture Beyond the Ordinary</p>
    `),
  });
}

/* ── Gift: invite to non-investor ─────────────────────────── */
function sendGiftInvite(to, { senderName, amount, message, recipientName, signupUrl }) {
  const amt = parseFloat(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2 });
  return _send({
    to,
    subject: `🎁 You have a R${Math.round(amount)} investment gift waiting for you`,
    text: `${senderName} sent you a R${amt} investment gift on SV Capital! ${message ? `"${message}" ` : ''}Sign up to claim it: ${signupUrl}`,
    html: _wrap(`
      <h2>You have an investment gift waiting! 🎁</h2>
      <p>Hi${recipientName ? ` ${recipientName}` : ''},</p>
      <p><strong>${senderName}</strong> sent you an investment gift through SV Capital — South Africa's smart investment platform.</p>
      ${message ? `<div class="box" style="border-left:4px solid #ff9b0c;background:#fffbf0"><p style="font-style:italic;color:#555;margin:0">&ldquo;${message}&rdquo;</p></div>` : ''}
      <span class="big">R${amt}</span>
      <p>Create your free SV Capital account to claim this gift. It'll be waiting in your wallet — ready to start earning returns immediately.</p>
      <a href="${signupUrl}" class="btn" style="font-size:1rem">Claim Your Gift →</a>
      <div class="box">
        <div class="row"><span class="lbl">Gift Amount</span><span class="val gold">R${amt}</span></div>
        <div class="row"><span class="lbl">From</span><span class="val">${senderName}</span></div>
        <div class="row"><span class="lbl">Valid for</span><span class="val">30 days</span></div>
      </div>
      <p style="font-size:0.8rem;color:#aaa">SV Capital (Pty) Ltd is a licensed FSP (FSP #52449). This gift was sent by an existing SV Capital investor. To decline, simply ignore this email.</p>
    `),
  });
}

/* ── Leave request submitted → notify a director ──────────── */
function sendLeaveRequestSubmitted(director, { employeeName, leaveType, startDate, endDate, days, reason }) {
  const name = director.first_name || 'Director';
  const type = (leaveType || 'leave').replace(/_/g, ' ');
  return _send({
    to: director.email,
    subject: `Leave request from ${employeeName} — awaiting your review`,
    html: _wrap(`
      <h2>New Leave Request 🗓️</h2>
      <p>Hi ${name}, <strong>${employeeName}</strong> has submitted a leave request that needs your review.</p>
      <div class="box">
        <div class="row"><span class="lbl">Employee</span><span class="val">${employeeName}</span></div>
        <div class="row"><span class="lbl">Type</span><span class="val" style="text-transform:capitalize">${type}</span></div>
        <div class="row"><span class="lbl">From</span><span class="val">${_date(startDate)}</span></div>
        <div class="row"><span class="lbl">To</span><span class="val">${_date(endDate)}</span></div>
        <div class="row"><span class="lbl">Days</span><span class="val">${days || '—'}</span></div>
        ${reason ? `<div class="row"><span class="lbl">Reason</span><span class="val">${reason}</span></div>` : ''}
        <div class="row"><span class="lbl">Status</span><span class="val gold">Pending</span></div>
      </div>
      <p>Review and approve or decline this request in the Director Panel.</p>
      <a href="${BASE_URL}/team/director.html" class="btn">Review Leave Requests →</a>
    `),
    text: `${employeeName} submitted a ${type} leave request (${_date(startDate)} – ${_date(endDate)}, ${days} day(s)). Review it in the Director Panel: ${BASE_URL}/team/director.html`,
  });
}

/* ── Leave request outcome → notify the staff member ──────── */
function sendLeaveOutcome(employee, { status, leaveType, startDate, endDate, days, reviewedBy }) {
  const name = employee.first_name || 'there';
  const type = (leaveType || 'leave').replace(/_/g, ' ');
  const approved = status === 'approved';
  return _send({
    to: employee.email,
    subject: `Your leave request was ${approved ? 'approved' : 'declined'}`,
    html: _wrap(`
      <h2>Leave ${approved ? 'Approved ✅' : 'Declined'}</h2>
      <p>Hi ${name}, your ${type} leave request has been <strong>${approved ? 'approved' : 'declined'}</strong>${reviewedBy ? ` by ${reviewedBy}` : ''}.</p>
      <div class="box">
        <div class="row"><span class="lbl">Type</span><span class="val" style="text-transform:capitalize">${type}</span></div>
        <div class="row"><span class="lbl">From</span><span class="val">${_date(startDate)}</span></div>
        <div class="row"><span class="lbl">To</span><span class="val">${_date(endDate)}</span></div>
        <div class="row"><span class="lbl">Days</span><span class="val">${days || '—'}</span></div>
        <div class="row"><span class="lbl">Outcome</span><span class="val ${approved ? 'green' : ''}">${approved ? 'Approved' : 'Declined'}</span></div>
      </div>
      <a href="${BASE_URL}/team/employee.html" class="btn">Open My Dashboard →</a>
    `),
    text: `Your ${type} leave request (${_date(startDate)} – ${_date(endDate)}) was ${approved ? 'approved' : 'declined'}${reviewedBy ? ` by ${reviewedBy}` : ''}.`,
  });
}

module.exports = {
  sendWelcome,
  sendLeaveRequestSubmitted,
  sendLeaveOutcome,
  sendDepositConfirmed,
  sendInvestmentCreated,
  sendMaturityAlert,
  sendInvestmentMatured,
  sendTicketResponse,
  sendTicketAssigned,
  sendPasswordReset,
  sendWithdrawalRequested,
  sendWithdrawalProcessed,
  sendWithdrawalRejected,
  sendBankAccountApproved,
  sendMonthlyStatement,
  sendDirectorReport,
  sendWaitlistNotification,
  sendKycApproved,
  sendKycRejected,
  sendLoginAlert,
  sendFicaResubmitReminder,
  sendGiftReceived,
  sendGiftInvite,
};
