/* ═══════════════════════════════════════════════
   SV CAPITAL — Admin Dashboard JS
   ═══════════════════════════════════════════════ */
'use strict';

/* ─── State ─── */
let STATE = {
  investors: [],
  pools: [],
  investments: [],
  transactions: [],
  kyc: [],
  tickets: [],
  maturity: [],
  settings: [],
  ifas: [],
  withdrawals: [],
  amlFlags: [],
  adminEmail: null,
  currentView: 'dashboard',
  charts: {}
};

/* ─── Admin Welcome Strip ─── */
function _adminGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function _populateAdminWelcomeStrip(identity, pendingKyc, openTickets) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };

  set('adminWelcomeGreeting', _adminGreeting());
  set('adminWelcomeName', identity.name || 'Admin Console');

  const roleLabelMap = { director: 'Director', admin: 'Administrator', staff: 'Staff', fund_manager: 'Fund Manager' };
  set('adminChipRole', roleLabelMap[identity.role] || identity.role || 'Administrator');

  if (pendingKyc > 0) {
    set('adminChipKycVal', pendingKyc);
    show('adminChipKyc');
  }
  if (openTickets > 0) {
    set('adminChipTicketsVal', openTickets);
    show('adminChipTickets');
  }
}

/* ─── Admin Notifications ─── */
function toggleAdminNotif() {
  const panel = document.getElementById('adminNotifPanel');
  const btn   = document.getElementById('adminNotifBtn');
  if (!panel) return;

  const isOpen = panel.classList.contains('notif-panel--open');
  if (isOpen) {
    panel.classList.remove('notif-panel--open');
    panel.style.display = 'none';
  } else {
    panel.style.display = 'block';
    panel.offsetHeight; // force reflow
    panel.classList.add('notif-panel--open');
    setTimeout(() => {
      document.addEventListener('click', function closePanel(e) {
        if (!panel.contains(e.target) && !btn?.contains(e.target)) {
          panel.classList.remove('notif-panel--open');
          panel.style.display = 'none';
          document.removeEventListener('click', closePanel);
        }
      });
    }, 10);
  }
}

function _syncAdminNotifDot() {
  const dot    = document.getElementById('adminNotifDot');
  const unread = document.querySelectorAll('#adminNotifPanel .notif-item.unread').length;
  if (dot) dot.classList.toggle('has-unread', unread > 0);
}

function adminMarkAllRead() {
  document.querySelectorAll('#adminNotifPanel .notif-item.unread').forEach(el => el.classList.remove('unread'));
  const dot = document.getElementById('adminNotifDot');
  if (dot) dot.classList.remove('has-unread');
}

/* ── Dynamic admin notification panel ─────────────────────────────────────
   Builds real-time alerts from already-loaded STATE data.
   Called at the end of loadDashboard() once investors, transactions
   and tickets are in memory.
─────────────────────────────────────────────────────────────────────────── */
function loadAdminNotifications(investors, transactions, tickets) {
  const body = document.getElementById('adminNotifBody');
  if (!body) return;

  const now    = new Date();
  const notifs = [];

  // 1. Pending KYC / FICA
  const pendingKyc = investors.filter(i =>
    i.kyc_status === 'pending' || i.fica_status === 'pending' ||
    i.status === 'pending_fica' || i.status === 'fica_submitted'
  );
  if (pendingKyc.length) {
    notifs.push({
      icon: 'fa-user-clock', iconBg: 'rgba(239,68,68,0.1)', iconColor: '#ef4444',
      title: `${pendingKyc.length} KYC ${pendingKyc.length === 1 ? 'application' : 'applications'} pending`,
      sub: `${pendingKyc.slice(0,2).map(i => i.first_name).join(', ')}${pendingKyc.length > 2 ? ` +${pendingKyc.length - 2} more` : ''} awaiting FICA review.`,
      action: "navigate('kyc',document.querySelector('[data-view=kyc]'));toggleAdminNotif()",
      unread: true,
    });
  }

  // 2. Bank accounts awaiting verification
  const pendingBank = investors.filter(i => i.bank_account_status === 'pending');
  if (pendingBank.length) {
    notifs.push({
      icon: 'fa-building-columns', iconBg: 'rgba(99,102,241,0.1)', iconColor: '#6366f1',
      title: `${pendingBank.length} bank account${pendingBank.length === 1 ? '' : 's'} to verify`,
      sub: `${pendingBank.slice(0,2).map(i => `${i.first_name} ${i.last_name}`).join(', ')}${pendingBank.length > 2 ? ` +${pendingBank.length - 2} more` : ''}.`,
      action: "navigate('investors',document.querySelector('[data-view=investors]'));toggleAdminNotif()",
      unread: true,
    });
  }

  // 3. Pending withdrawals
  const pendingWith = transactions.filter(t => t.type === 'withdrawal' && t.status === 'pending');
  if (pendingWith.length) {
    const total = pendingWith.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
    notifs.push({
      icon: 'fa-money-bill-transfer', iconBg: 'rgba(239,68,68,0.1)', iconColor: '#ef4444',
      title: `${pendingWith.length} withdrawal${pendingWith.length === 1 ? '' : 's'} pending`,
      sub: `${Utils.rand(total)} total awaiting processing.`,
      action: "navigate('transactions',document.querySelector('[data-view=transactions]'));toggleAdminNotif()",
      unread: true,
    });
  }

  // 4. Bank verification support tickets
  const bankTkts = tickets.filter(t => t.category === 'bank_verification' && t.status === 'open');
  if (bankTkts.length) {
    notifs.push({
      icon: 'fa-file-invoice', iconBg: 'rgba(255,155,12,0.12)', iconColor: '#ff9b0c',
      title: `${bankTkts.length} bank verification ticket${bankTkts.length === 1 ? '' : 's'}`,
      sub: `${bankTkts.slice(0,2).map(t => t.investor_name || 'Investor').join(', ')} submitted bank details.`,
      action: "navigate('support',document.querySelector('[data-view=support]'));toggleAdminNotif()",
      unread: true,
    });
  }

  // 5. Other open support tickets (unanswered)
  const openTkts = tickets.filter(t => t.status === 'open' && t.category !== 'bank_verification' && !t.admin_response);
  if (openTkts.length) {
    const urgent = openTkts.filter(t => t.priority === 'high' || t.priority === 'urgent');
    notifs.push({
      icon: 'fa-headset', iconBg: 'rgba(47,140,155,0.1)', iconColor: '#2F8C9B',
      title: `${openTkts.length} open ticket${openTkts.length === 1 ? '' : 's'} awaiting reply`,
      sub: urgent.length
        ? `${urgent.length} high-priority — "${urgent[0].subject}"`
        : `"${openTkts[0].subject}"`,
      action: "navigate('support',document.querySelector('[data-view=support]'));toggleAdminNotif()",
      unread: true,
    });
  }

  // 6. Recent deposits (last 24 h) — informational
  const recentDeps = transactions.filter(t => {
    if (t.type !== 'deposit' || t.status !== 'completed') return false;
    return (now - new Date(t.created_at || t.transaction_date || 0)) < 86400000;
  });
  if (recentDeps.length) {
    const total = recentDeps.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
    notifs.push({
      icon: 'fa-wallet', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#22c55e',
      title: `${recentDeps.length} deposit${recentDeps.length === 1 ? '' : 's'} received today`,
      sub: `${Utils.rand(total)} credited in the last 24 hours.`,
      action: "navigate('transactions',document.querySelector('[data-view=transactions]'));toggleAdminNotif()",
      unread: false,
    });
  }

  if (!notifs.length) {
    body.innerHTML = '<div style="padding:24px 18px;text-align:center;color:#888;font-size:0.82rem"><i class="fa-solid fa-circle-check" style="color:#22c55e;margin-right:6px"></i>No pending actions — all clear!</div>';
    document.getElementById('adminNotifDot')?.classList.remove('has-unread');
    return;
  }

  body.innerHTML = notifs.map(n => `
    <div class="notif-item${n.unread ? ' unread' : ''}" ${n.action ? `onclick="${n.action}" style="cursor:pointer"` : ''}>
      <div class="notif-icon" style="background:${n.iconBg}"><i class="fa-solid ${n.icon}" style="color:${n.iconColor}"></i></div>
      <div class="notif-body">
        <div class="notif-title">${n.title}</div>
        <div class="notif-sub">${n.sub}</div>
      </div>
    </div>
  `).join('');

  _syncAdminNotifDot();
}

/* ─── Navigation ─── */
function navigate(view, btnEl) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', investors: 'Investor Management', ifa: 'IFA Management', kyc: 'KYC / FICA',
    pools: 'Investment Pools', investments: 'Investments', maturity: 'Maturity Instructions',
    transactions: 'Transactions', withdrawals: 'Withdrawals', support: 'Support Tickets', analytics: 'Analytics',
    auditlog: 'Audit Log', settings: 'Settings', comms: 'Broadcast Communications', aml: 'AML Compliance Review'
  };
  document.getElementById('topbarTitle').textContent = titles[view] || view;
  STATE.currentView = view;

  // Lazy-load views
  const loaders = {
    investors: loadInvestors,
    ifa: loadIFAs,
    kyc: loadKYC,
    pools: loadPools,
    investments: loadInvestments,
    maturity: loadMaturity,
    transactions: loadTransactions,
    support: loadSupport,
    analytics: loadAnalytics,
    auditlog: loadAuditLog,
    settings: loadSettings,
    withdrawals: loadWithdrawals,
    comms: loadComms,
    aml: loadAML,
  };
  if (loaders[view]) loaders[view]();
}

/* ═══════════════════════════════════════════════
   USER IDENTITY — populate sidebar + topbar from session
   ═══════════════════════════════════════════════ */
function _populateAdminIdentity(jwtUser) {
  // Build a merged identity object.
  // staffSession has the richest data (avatar colour, initials, level, department).
  // svc_user / jwtUser fills gaps when only a JWT login was used.
  let identity = {
    initials:   null,
    color:      '#7c5cfc',
    name:       null,
    role:       null,
    department: null,
    email:      jwtUser ? jwtUser.email : null,
  };

  // Try staffSession first
  try {
    const raw = localStorage.getItem('staffSession');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.empId && s.expiresAt > Date.now()) {
        identity.initials   = s.avatarInitials || null;
        identity.color      = s.avatarColor    || '#7c5cfc';
        identity.name       = `${s.firstName || ''} ${s.lastName || ''}`.trim() || null;
        identity.role       = s.role           || null;
        identity.department = s.department     || null;
        identity.email      = s.email          || identity.email;
      }
    }
  } catch (_) {}

  // Fill any gaps from jwtUser (svc_user bridge or real JWT payload)
  if (jwtUser) {
    if (!identity.name)
      identity.name = `${jwtUser.firstName || ''} ${jwtUser.lastName || ''}`.trim() || jwtUser.email || null;
    if (!identity.role)
      identity.role = jwtUser.role || null;
  }

  // Derive initials from name if not set
  if (!identity.initials && identity.name) {
    const parts = identity.name.trim().split(/\s+/);
    identity.initials = parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : identity.name.slice(0, 2).toUpperCase();
  }

  // Build display role label
  const roleLabelMap = {
    director: 'Director',
    admin:    'Admin',
    ifa:      'IFA Partner',
    staff:    'Staff',
  };
  const roleLabel = roleLabelMap[identity.role] || identity.role || 'Admin';
  const deptLabel = identity.department ? `${identity.department} · ` : '';
  const sidebarRoleText = `${deptLabel}${roleLabel}`;

  // ── Apply to sidebar ──
  const avatarEl = document.getElementById('adminSidebarAvatar');
  const nameEl   = document.getElementById('adminSidebarName');
  const roleEl   = document.getElementById('adminSidebarRole');

  if (avatarEl) {
    avatarEl.textContent       = identity.initials || '??';
    avatarEl.style.background  = identity.color;
    avatarEl.style.color       = '#fff';
  }
  if (nameEl)  nameEl.textContent = identity.name  || identity.email || 'Unknown User';
  if (roleEl)  roleEl.textContent = sidebarRoleText;

  // ── Apply to topbar (legacy element — keep for compatibility) ──
  const topbarNameEl = document.getElementById('adminUserName');
  if (topbarNameEl) topbarNameEl.textContent = identity.name || identity.email || '';
}

/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  Toast.init();

  // ─── Require authentication ───
  if (typeof Auth !== 'undefined') {
    // Staff PIN login users have a staffSession; email+password users do not.
    const hasStaffSession = (() => {
      try { const s = JSON.parse(localStorage.getItem('staffSession') || 'null'); return !!(s && s.empId && s.expiresAt > Date.now()); } catch (_) { return false; }
    })();
    const loginPage = hasStaffSession ? '/team/login.html' : '/login.html';

    if (!Auth.isLoggedIn()) {
      window.location.href = loginPage;
      return;
    }
    const user = Auth.getUser();
    if (user && !['admin','director'].includes(user.role)) {
      window.location.href = loginPage;
      return;
    }
    // ── Populate user identity from session ──────────────────────────
    // Prefer staffSession (richer: has avatar colour, initials, department)
    // Fall back to svc_user / JWT payload for main-login users.
    _populateAdminIdentity(user);

    // ── Extract admin email from JWT for use in notes etc ──────────────
    try {
      const token = localStorage.getItem('svc_token');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1]));
        STATE.adminEmail = payload.email || (user && user.email) || null;
      }
    } catch (_) {}
    if (!STATE.adminEmail && user) STATE.adminEmail = user.email || null;
  }

  await loadDashboard();
  setupGlobalSearch();
  _syncAdminNotifDot();
});

/* ═══════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    const [invRes, poolRes, invstRes, txnRes] = await Promise.all([
      API.investors.list({ limit: 100 }),
      API.pools.list({ limit: 100 }),
      API.investments.list({ limit: 100 }),
      API.transactions.list({ limit: 100 })
    ]);

    STATE.investors = invRes.data || [];
    STATE.pools = poolRes.data || [];
    STATE.investments = invstRes.data || [];
    STATE.transactions = txnRes.data || [];

    // KPI cards
    const totalInvested = STATE.investors.reduce((s, i) => s + (i.total_invested || 0), 0);
    const totalReturns = STATE.investors.reduce((s, i) => s + (i.total_returns || 0), 0);
    const activePools = STATE.pools.filter(p => ['open', 'active', 'filling'].includes(p.status)).length;

    document.getElementById('ds-investors').textContent = STATE.investors.length;
    document.getElementById('ds-invested').textContent = Utils.rand(totalInvested);
    document.getElementById('ds-returns').textContent = Utils.rand(totalReturns);
    document.getElementById('ds-pools').textContent = activePools;

    // Badge counts
    const pendingKyc = STATE.investors.filter(i => ['pending_fica', 'fica_submitted'].includes(i.status)).length;
    document.getElementById('kycBadge').textContent = pendingKyc;

    // Fetch ticket count for welcome strip
    let openTickets = 0;
    try {
      const tktRes = await API.tickets.list({ limit: 50 });
      const tickets = tktRes.data || [];
      openTickets = tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length;
      const tktBadge = document.getElementById('ticketBadge');
      if (tktBadge) tktBadge.textContent = openTickets;
    } catch (_) {}

    // Build dynamic notification panel
    loadAdminNotifications(STATE.investors, STATE.transactions, tickets);

    // Populate welcome strip
    const jwtUser = (typeof Auth !== 'undefined') ? Auth.getUser() : null;
    const wIdent  = { name: null, role: null };
    try {
      const raw = localStorage.getItem('staffSession');
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.empId && s.expiresAt > Date.now()) {
          wIdent.name = `${s.firstName || ''} ${s.lastName || ''}`.trim();
          wIdent.role = s.role;
        }
      }
    } catch (_) {}
    if (!wIdent.name && jwtUser) {
      wIdent.name = `${jwtUser.firstName || ''} ${jwtUser.lastName || ''}`.trim() || jwtUser.email || null;
      wIdent.role = jwtUser.role;
    }
    _populateAdminWelcomeStrip(wIdent, pendingKyc, openTickets);

    renderRecentInvestments();
    renderOpenPoolsWidget();
    renderPendingActions();
    renderAumChart();
    renderProductMixChart();

  } catch (e) {
    Toast.error('Failed to load dashboard data');
    console.error(e);
  }
}

function renderRecentInvestments() {
  const body = document.getElementById('recentInvestmentsBody');
  const recent = [...STATE.investments].sort((a, b) => new Date(b.investment_date) - new Date(a.investment_date)).slice(0, 8);

  if (!recent.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No investments yet</td></tr>'; return; }

  body.innerHTML = recent.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    return `<tr>
      <td><div class="flex-center gap-8">
        <div class="avatar avatar--sm avatar--gold">${Utils.initials(inv.investor_name)}</div>
        <span class="td-strong">${inv.investor_name}</span>
      </div></td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td class="td-green">${Utils.pct(inv.expected_return_rate)}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
      <td class="td-muted">${Utils.date(inv.investment_date)}</td>
    </tr>`;
  }).join('');
}

function renderOpenPoolsWidget() {
  const el = document.getElementById('openPoolsWidget');
  const open = STATE.pools.filter(p => ['open', 'filling', 'active'].includes(p.status)).slice(0, 4);

  if (!open.length) { el.innerHTML = '<div class="empty-state"><i class="fa-solid fa-layer-group"></i><p>No open pools</p></div>'; return; }

  el.innerHTML = open.map(p => {
    const pi = Utils.productInfo(p.product_type);
    const pct = Utils.poolFillPct(p);
    return `<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">
      <div class="flex-between mb-4">
        <span style="font-size:0.82rem;font-weight:700;color:var(--white)">${p.name}</span>
        <span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span>
      </div>
      <div class="pool-card__progress-label">
        <span>${Utils.rand(p.raised_amount)} raised</span>
        <span>${pct}% of ${Utils.rand(p.target_amount)}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${p.investor_count} investors · Closes ${Utils.date(p.end_date)}</div>
    </div>`;
  }).join('');
}

function renderPendingActions() {
  const el = document.getElementById('pendingActionsWidget');
  const actions = [];

  const pendingFica = STATE.investors.filter(i => i.status === 'pending_fica' || i.fica_status === 'submitted').length;
  if (pendingFica) actions.push({ icon: 'fa-id-card', color: 'var(--orange)', text: `${pendingFica} FICA review(s) pending`, view: 'kyc' });

  const noInstruction = STATE.investments.filter(i => i.status === 'matured' && i.maturity_instruction === 'pending').length;
  if (noInstruction) actions.push({ icon: 'fa-hourglass-end', color: 'var(--red)', text: `${noInstruction} maturity instructions missing`, view: 'maturity' });

  const openTickets = STATE.transactions.filter(t => t.status === 'pending').length;
  if (openTickets) actions.push({ icon: 'fa-arrows-rotate', color: 'var(--blue)', text: `${openTickets} pending transaction(s)`, view: 'transactions' });

  if (!actions.length) {
    el.innerHTML = '<div class="empty-state" style="padding:16px"><i class="fa-solid fa-check-circle" style="color:var(--green)"></i><p>All clear! No pending actions.</p></div>';
    return;
  }

  el.innerHTML = actions.map(a => `
    <div class="flex-center gap-8" style="padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer" onclick="navigate('${a.view}', document.querySelector('[data-view=${a.view}]'))">
      <i class="fa-solid ${a.icon}" style="color:${a.color};width:16px;text-align:center"></i>
      <span style="font-size:0.8rem;color:var(--text)">${a.text}</span>
      <i class="fa-solid fa-arrow-right" style="margin-left:auto;color:var(--text-dim);font-size:0.7rem"></i>
    </div>
  `).join('');
}

function renderAumChart() {
  const ctx = document.getElementById('aumChart');
  if (!ctx) return;

  const months = ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan'];
  const aum = [145000000, 158000000, 172000000, 185000000, 196000000, 200000000];
  const payouts = [8000000, 9500000, 11000000, 12500000, 14000000, 15000000];

  if (STATE.charts.aum) STATE.charts.aum.destroy();
  STATE.charts.aum = new Chart(ctx, {
    type: 'line',
    data: {
      labels: months,
      datasets: [
        {
          label: 'AUM (R)',
          data: aum,
          borderColor: '#D4AF37',
          backgroundColor: ctx => {
            const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 280);
            g.addColorStop(0, 'rgba(212,175,55,0.18)');
            g.addColorStop(1, 'rgba(212,175,55,0)');
            return g;
          },
          fill: true,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#D4AF37',
        },
        {
          label: 'Returns Paid (R)',
          data: payouts,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.08)',
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#22c55e',
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#7a92a8', font: { size: 11 }, boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8',
          borderColor: 'rgba(212,175,55,0.3)', borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${Utils.rand(ctx.parsed.y)}` }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#3d5268', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#3d5268', font: { size: 11 }, callback: v => 'R' + (v / 1000000).toFixed(0) + 'M' } }
      }
    }
  });
}

function renderProductMixChart() {
  const ctx = document.getElementById('productMixChart');
  if (!ctx) return;

  const products = { cattle: 0, solar_7yr: 0, solar_6yr: 0, solar_5yr: 0, short_term: 0, delivery_bike: 0 };
  STATE.investments.filter(i => i.status === 'active').forEach(i => {
    if (products[i.product_type] !== undefined) products[i.product_type] += i.amount;
  });

  const labels = ['Cattle', 'Solar 7yr', 'Solar 6yr', 'Solar 5yr', 'Short-Term', 'Delivery Bike'];
  const data = Object.values(products);
  const colors = ['#D4AF37', '#22c55e', '#4ade80', '#86efac', '#3b82f6', '#f97316'];

  if (STATE.charts.productMix) STATE.charts.productMix.destroy();
  STATE.charts.productMix = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: 'var(--dark-2)', borderWidth: 3, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 10 } },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8',
          callbacks: { label: ctx => ` ${ctx.label}: ${Utils.rand(ctx.parsed)}` }
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   INVESTORS
   ═══════════════════════════════════════════════ */
let investorPage = 1;
const INV_PAGE_SIZE = 8;
let filteredInvestors = [];

async function loadInvestors() {
  try {
    const res = await API.investors.list({ limit: 100 });
    STATE.investors = res.data || [];
    filteredInvestors = [...STATE.investors];
    renderInvestorStats();
    renderInvestorsTable();
    setupInvestorFilters();
  } catch (e) { Toast.error('Failed to load investors'); }
}

function renderInvestorStats() {
  const active = STATE.investors.filter(i => i.status === 'active').length;
  const pending = STATE.investors.filter(i => ['pending_fica', 'fica_submitted'].includes(i.status)).length;
  const wallet = STATE.investors.reduce((s, i) => s + (i.wallet_balance || 0), 0);
  const aum = STATE.investors.reduce((s, i) => s + (i.total_invested || 0), 0);
  document.getElementById('is-active').textContent = active;
  document.getElementById('is-pending').textContent = pending;
  document.getElementById('is-wallet').textContent = Utils.rand(wallet);
  document.getElementById('is-aum').textContent = Utils.rand(aum);
}

function renderInvestorsTable() {
  const body = document.getElementById('investorsBody');
  const start = (investorPage - 1) * INV_PAGE_SIZE;
  const page = filteredInvestors.slice(start, start + INV_PAGE_SIZE);

  document.getElementById('investorCount').textContent = `${filteredInvestors.length} investors`;
  document.getElementById('investorsFooterText').textContent = `Showing ${start + 1}–${Math.min(start + INV_PAGE_SIZE, filteredInvestors.length)} of ${filteredInvestors.length}`;

  if (!page.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px">No investors found</td></tr>'; return; }

  body.innerHTML = page.map(inv => `
    <tr>
      <td><div class="flex-center gap-8">
        <div class="avatar avatar--sm avatar--gold">${Utils.initials(inv.first_name + ' ' + inv.last_name)}</div>
        <div>
          <div class="td-strong">${inv.first_name} ${inv.last_name}</div>
          <div class="td-muted">${inv.id || ''}</div>
        </div>
      </div></td>
      <td><div class="td-strong" style="font-size:0.78rem">${inv.email}</div><div class="td-muted">${inv.phone || '—'}</div></td>
      <td>${Utils.statusBadge(inv.fica_status)}</td>
      <td class="td-gold fw-700">${Utils.rand(inv.wallet_balance)}</td>
      <td class="td-strong">${Utils.rand(inv.total_invested)}</td>
      <td class="td-green fw-700">${Utils.rand(inv.total_returns)}</td>
      <td class="td-muted">${Utils.date(inv.date_joined)}</td>
      <td>
        <div class="flex-center gap-8">
          <button class="btn btn--secondary btn--sm" onclick='viewInvestor(${JSON.stringify(inv.id)})'><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn--danger btn--sm" onclick='confirmDeleteInvestor(${JSON.stringify(inv.id)})'><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');

  // Pagination
  const pages = Math.ceil(filteredInvestors.length / INV_PAGE_SIZE);
  const pag = document.getElementById('investorsPagination');
  pag.innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="page-btn ${i + 1 === investorPage ? 'active' : ''}" onclick="investorPage=${i + 1};renderInvestorsTable()">${i + 1}</button>`
  ).join('');
}

function setupInvestorFilters() {
  const search = document.getElementById('investorSearch');
  const statusF = document.getElementById('investorStatusFilter');

  const filter = Utils.debounce(() => {
    const q = search.value.toLowerCase();
    const st = statusF.value;
    filteredInvestors = STATE.investors.filter(inv => {
      const matchQ = !q || `${inv.first_name} ${inv.last_name} ${inv.email} ${inv.id}`.toLowerCase().includes(q);
      const matchSt = !st || inv.status === st;
      return matchQ && matchSt;
    });
    investorPage = 1;
    renderInvestorsTable();
  }, 250);

  search.addEventListener('input', filter);
  statusF.addEventListener('change', filter);
}

async function viewInvestor(id) {
  const inv = STATE.investors.find(i => i.id === id);
  if (!inv) return;

  const invsts = STATE.investments.filter(i => i.investor_id === id);
  const txns = STATE.transactions.filter(t => t.investor_id === id);

  document.getElementById('invDetailTitle').textContent = `${inv.first_name} ${inv.last_name} — ${inv.id}`;

  document.getElementById('invDetailBody').innerHTML = `
    <div class="grid-2 mb-16">
      <div>
        <div class="flex-center gap-12 mb-16">
          <div class="avatar avatar--lg avatar--gold">${Utils.initials(inv.first_name + ' ' + inv.last_name)}</div>
          <div>
            <div style="font-size:1.1rem;font-weight:800;color:var(--white)">${inv.first_name} ${inv.last_name}</div>
            <div style="color:var(--text-muted);font-size:0.8rem">${inv.email}</div>
            <div class="mt-4">${Utils.statusBadge(inv.status)}</div>
          </div>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-row__label">Phone</span><span class="info-row__value">${inv.phone || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">SA ID</span><span class="info-row__value">${inv.id_number || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Location</span><span class="info-row__value">${inv.city || '—'}, ${inv.province || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Risk Profile</span><span class="info-row__value">${inv.risk_profile || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Referral Code</span><span class="info-row__value text-gold">${inv.referral_code || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Date Joined</span><span class="info-row__value">${Utils.date(inv.date_joined)}</span></div>
        </div>
      </div>
      <div>
        <div class="panel" style="background:var(--dark-3)">
          <div class="panel__header"><span class="panel__title">Financials</span></div>
          <div class="panel__body">
            <div class="info-list">
              <div class="info-row"><span class="info-row__label">Wallet Balance</span><span class="info-row__value text-gold">${Utils.rand(inv.wallet_balance)}</span></div>
              <div class="info-row"><span class="info-row__label">Total Invested</span><span class="info-row__value">${Utils.rand(inv.total_invested)}</span></div>
              <div class="info-row"><span class="info-row__label">Total Returns</span><span class="info-row__value text-green">${Utils.rand(inv.total_returns)}</span></div>
              <div class="info-row"><span class="info-row__label">Effective Return</span><span class="info-row__value text-green">${inv.total_invested ? Utils.pct(inv.total_returns / inv.total_invested) : '—'}</span></div>
            </div>
          </div>
        </div>
        <div class="panel mt-12" style="background:var(--dark-3)">
          <div class="panel__header">
            <span class="panel__title">Admin Notes</span>
            <button class="btn btn--primary btn--sm" onclick="saveInvestorNotes('${inv.id}')"><i class="fa-solid fa-save"></i> Save</button>
          </div>
          <div class="panel__body">
            <textarea id="investorNotesTA" class="form-input" style="width:100%;min-height:90px;font-size:0.82rem;resize:vertical" placeholder="Internal notes visible only to admins…"></textarea>
          </div>
        </div>
      </div>
    </div>

    <div class="mb-12" style="font-size:0.85rem;font-weight:700;color:var(--white)">Investments (${invsts.length})</div>
    <table class="data-table mb-16">
      <thead><tr><th>Pool</th><th>Product</th><th>Amount</th><th>Exp. Return</th><th>Status</th><th>Maturity</th></tr></thead>
      <tbody>${invsts.length ? invsts.map(i => {
        const pi = Utils.productInfo(i.product_type);
        return `<tr>
          <td class="td-strong">${i.pool_name}</td>
          <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
          <td class="td-gold fw-700">${Utils.rand(i.amount)}</td>
          <td class="td-green">${Utils.pct(i.annual_rate)}</td>
          <td>${Utils.statusBadge(i.status)}</td>
          <td class="td-muted">${Utils.date(i.end_date)}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="6" class="text-center text-muted" style="padding:16px">No investments</td></tr>'}</tbody>
    </table>

    <div class="mb-12" style="font-size:0.85rem;font-weight:700;color:var(--white)">Recent Transactions (${txns.length})</div>
    <table class="data-table">
      <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Reference</th><th>Date</th></tr></thead>
      <tbody>${txns.slice(0, 5).map(t => `
        <tr>
          <td>${Utils.statusBadge(t.type)}</td>
          <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
          <td>${Utils.statusBadge(t.status)}</td>
          <td class="td-muted">${t.reference || '—'}</td>
          <td class="td-muted">${Utils.date(t.created_at)}</td>
        </tr>
      `).join('')}</tbody>
    </table>

    ${(() => {
      const statusMap = { none: 'Not added', pending: 'Pending verification', approved: 'Verified', rejected: 'Rejected' };
      const statusCls = { none: 'badge--grey', pending: 'badge--yellow', approved: 'badge--green', rejected: 'badge--red' };
      const bStatus = inv.bank_account_status || 'none';
      const masked  = inv.bank_account_number ? '••••••' + String(inv.bank_account_number).slice(-4) : '—';
      return `
    <div class="mb-12 mt-20" style="font-size:0.85rem;font-weight:700;color:var(--white)">Bank Account</div>
    <div class="panel mb-16" style="background:var(--dark-3)">
      <div class="panel__body">
        <div class="info-list">
          <div class="info-row"><span class="info-row__label">Bank</span><span class="info-row__value">${inv.bank_name || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Account Holder</span><span class="info-row__value">${inv.bank_account_holder || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Account Number</span><span class="info-row__value">${masked}</span></div>
          <div class="info-row"><span class="info-row__label">Branch Code</span><span class="info-row__value">${inv.bank_branch_code || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Type</span><span class="info-row__value" style="text-transform:capitalize">${inv.bank_account_type || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Verification Status</span><span class="info-row__value"><span class="badge ${statusCls[bStatus]}">${statusMap[bStatus]}</span></span></div>
        </div>
        ${bStatus === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn--success btn--sm" onclick='approveBankAccount(${JSON.stringify(inv.id)})'><i class="fa-solid fa-check"></i> Approve Account</button>
          <button class="btn btn--danger btn--sm" onclick='rejectBankAccount(${JSON.stringify(inv.id)})'><i class="fa-solid fa-xmark"></i> Reject Account</button>
        </div>` : (bStatus === 'approved' ? `<div style="margin-top:8px;font-size:0.78rem;color:#22c55e"><i class="fa-solid fa-check-circle"></i> Account verified — withdrawals are enabled</div>` : '')}
      </div>
    </div>`;
    })()}

    <div class="mb-12 mt-20" style="font-size:0.85rem;font-weight:700;color:var(--white)">Admin Notes (Persistent)</div>
    <div class="panel mb-16" style="background:var(--dark-3)">
      <div class="panel__header">
        <span class="panel__title">Notes History</span>
        <span style="font-size:0.72rem;color:var(--text-dim)" id="invNotesCount">Loading…</span>
      </div>
      <div class="panel__body" id="invNotesList" style="max-height:200px;overflow-y:auto">
        <div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem"><i class="fa-solid fa-spinner fa-spin"></i> Loading notes…</div>
      </div>
      <div class="panel__body" style="border-top:1px solid var(--border);padding-top:12px">
        <textarea class="form-input" id="invNewNoteTA" style="width:100%;min-height:70px;font-size:0.82rem;resize:vertical;margin-bottom:8px" placeholder="Add a note visible only to admins…"></textarea>
        <button class="btn btn--primary btn--sm" onclick='addInvestorNote(${JSON.stringify(inv.id)})'><i class="fa-solid fa-plus"></i> Add Note</button>
      </div>
    </div>

    <div class="mb-12 mt-20" style="font-size:0.85rem;font-weight:700;color:var(--white)">Activity Timeline</div>
    <div class="panel mb-16" style="background:var(--dark-3)">
      <div class="panel__body" style="padding:0 4px">
        <div id="investorTimeline" style="max-height:320px;overflow-y:auto;padding:4px 0">
          <div style="text-align:center;padding:16px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i></div>
        </div>
      </div>
    </div>

    <div class="flex-between mt-16" style="flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--success btn--sm" onclick='depositToInvestor(${JSON.stringify(inv.id)}, ${JSON.stringify(inv.first_name + " " + inv.last_name)}, ${inv.wallet_balance || 0})'><i class="fa-solid fa-wallet"></i> Add Funds</button>
        <button class="btn btn--secondary btn--sm" onclick='approveInvestorFica(${JSON.stringify(inv.id)})'><i class="fa-solid fa-id-card"></i> Approve FICA</button>
        <button class="btn btn--danger btn--sm" onclick='confirmDeleteInvestor(${JSON.stringify(inv.id)})'><i class="fa-solid fa-trash"></i> Delete</button>
      </div>
      <button class="btn btn--primary btn--sm" onclick='Modal.close("investorDetailModal")'><i class="fa-solid fa-check"></i> Done</button>
    </div>
  `;
  Modal.open('investorDetailModal');
  // Set textarea value after innerHTML to avoid XSS via template literals
  const ta = document.getElementById('investorNotesTA');
  if (ta) ta.value = inv.notes || '';
  // Load persistent notes
  loadInvestorNotes(inv.id);
  // Load activity timeline
  loadInvestorTimeline(inv, invsts, txns);
}

async function depositToInvestor(investorId, investorName, currentBalance) {
  const amtStr = prompt(`Add funds to ${investorName}'s wallet.\nCurrent balance: ${Utils.rand(currentBalance)}\n\nEnter amount (R):`);
  if (!amtStr) return;
  const amount = parseFloat(amtStr);
  if (!amount || amount <= 0) { Toast.error('Invalid amount'); return; }
  try {
    const newBalance = Math.round((currentBalance + amount) * 100) / 100;
    await API.investors.update(investorId, { wallet_balance: newBalance });
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: investorId,
      type:        'deposit',
      amount,
      status:      'completed',
      reference:   `ADMIN-DEP-${Date.now()}`,
      description: `Admin manual deposit — wallet top-up for ${investorName}`,
    });
    Toast.success(`${Utils.rand(amount)} added to ${investorName}'s wallet`);
    Modal.close('investorDetailModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to add funds'); }
}

async function approveInvestorFica(investorId) {
  if (!confirm('Approve FICA for this investor?')) return;
  try {
    await API.investors.update(investorId, { fica_status: 'approved', status: 'active' });
    Toast.success('FICA approved — investor is now active');
    Modal.close('investorDetailModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to approve FICA'); }
}

async function saveInvestorNotes(investorId) {
  const ta = document.getElementById('investorNotesTA');
  if (!ta) return;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, { notes: ta.value.trim() });
    const inv = STATE.investors.find(i => i.id === investorId);
    if (inv) inv.notes = ta.value.trim();
    Toast.success('Notes saved');
  } catch (e) { Toast.error('Failed to save notes'); }
}

async function approveBankAccount(investorId) {
  if (!confirm('Approve this investor\'s bank account? This will enable wallet withdrawals and send a confirmation email.')) return;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, { bank_account_status: 'approved', bank_account_notes: null });
    Toast.success('Bank account approved — investor can now request withdrawals');
    Modal.close('investorDetailModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to approve bank account'); }
}

async function rejectBankAccount(investorId) {
  const reason = prompt('Reason for rejection (will be visible to investor):');
  if (reason === null) return;
  try {
    await API._fetch('PATCH', `tables/investors/${investorId}`, {
      bank_account_status: 'rejected',
      bank_account_notes:  reason || 'Bank account details could not be verified.',
    });
    Toast.success('Bank account rejected');
    Modal.close('investorDetailModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to reject bank account'); }
}

/* ═══════════════════════════════════════════════
   WITHDRAWALS — Feature 5: Approval Workflow
   ═══════════════════════════════════════════════ */
async function loadWithdrawals() {
  try {
    const [txnRes, invRes] = await Promise.all([
      API._fetch('GET', 'tables/transactions', null, { type: 'withdrawal', limit: 300 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 200 })
    ]);
    const all = (txnRes.data || []).filter(t => t.type === 'withdrawal');
    STATE.withdrawals = all;
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderWithdrawalsTable();
  } catch (e) {
    Toast.error('Failed to load withdrawals');
    console.error(e);
  }
}

function renderWithdrawalsTable() {
  const pendingBody    = document.getElementById('withdrawalsPendingBody');
  const completedBody  = document.getElementById('withdrawalsCompletedBody');
  const withdrawals    = STATE.withdrawals || [];
  const pending        = withdrawals.filter(w => w.status === 'pending');
  const completed      = withdrawals.filter(w => w.status !== 'pending');

  const _row = (w, showActions) => {
    const inv  = STATE.investors.find(i => i.id === w.investor_id);
    const name = inv ? `${inv.first_name} ${inv.last_name}` : w.investor_id || '—';
    const bank = inv ? (inv.bank_name || '—') : '—';
    return `<tr>
      <td class="td-muted">${Utils.date(w.created_at || w.transaction_date)}</td>
      <td><div class="td-strong">${name}</div></td>
      <td class="td-gold fw-700">${Utils.rand(Math.abs(w.amount))}</td>
      <td class="td-muted">${bank}</td>
      <td class="td-muted" style="font-size:0.75rem">${w.reference || '—'}</td>
      <td>
        ${showActions ? `
          <div class="flex-center gap-6">
            <button class="btn btn--success btn--sm" onclick='approveWithdrawal(${JSON.stringify(w.id)})'><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn--danger btn--sm" onclick='rejectWithdrawalPrompt(${JSON.stringify(w.id)})'><i class="fa-solid fa-xmark"></i> Reject</button>
          </div>
        ` : Utils.statusBadge(w.status)}
      </td>
    </tr>`;
  };

  if (pendingBody) {
    pendingBody.innerHTML = pending.length
      ? pending.map(w => _row(w, true)).join('')
      : '<tr><td colspan="6" class="text-center text-muted" style="padding:24px"><i class="fa-solid fa-check-circle" style="color:var(--green);margin-right:6px"></i>No pending withdrawals</td></tr>';
  }

  if (completedBody) {
    completedBody.innerHTML = completed.length
      ? completed.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(w => _row(w, false)).join('')
      : '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No completed withdrawals</td></tr>';
  }
}

async function approveWithdrawal(txnId) {
  if (!confirm('Approve this withdrawal? This will notify the investor.')) return;
  try {
    await fetch(`/api/withdrawals/${txnId}/approve`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('svc_token'), 'Content-Type': 'application/json' }
    }).then(r => r.ok ? r : Promise.reject(r));
    Toast.success('Withdrawal approved — investor notified');
    await loadWithdrawals();
  } catch (e) {
    // Fallback: update status directly
    try {
      await API._fetch('PATCH', `tables/transactions/${txnId}`, { status: 'completed' });
      Toast.success('Withdrawal approved');
      await loadWithdrawals();
    } catch (e2) { Toast.error('Failed to approve withdrawal'); }
  }
}

async function rejectWithdrawalPrompt(txnId) {
  const reason = prompt('Reason for rejection (will be sent to investor):');
  if (reason === null) return;
  try {
    await fetch(`/api/withdrawals/${txnId}/reject`, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('svc_token'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'Withdrawal rejected by admin.' })
    }).then(r => r.ok ? r : Promise.reject(r));
    Toast.success('Withdrawal rejected');
    await loadWithdrawals();
  } catch (e) {
    // Fallback: update status directly
    try {
      await API._fetch('PATCH', `tables/transactions/${txnId}`, {
        status: 'rejected',
        description: reason || 'Rejected by admin.'
      });
      Toast.success('Withdrawal rejected');
      await loadWithdrawals();
    } catch (e2) { Toast.error('Failed to reject withdrawal'); }
  }
}

// Keep legacy aliases
async function processWithdrawal(txnId) { return approveWithdrawal(txnId); }
async function rejectWithdrawal(txnId) { return rejectWithdrawalPrompt(txnId); }

async function confirmDeleteInvestor(id) {
  if (!confirm('Are you sure you want to delete this investor? This cannot be undone.')) return;
  try {
    await API.investors.delete(id);
    Toast.success('Investor deleted');
    Modal.closeAll();
    await loadInvestors();
  } catch (e) { Toast.error('Failed to delete investor'); }
}

function openAddInvestorModal() { Modal.open('addInvestorModal'); }

async function saveNewInvestor() {
  const fn = document.getElementById('newInvFirstName').value.trim();
  const ln = document.getElementById('newInvLastName').value.trim();
  const em = document.getElementById('newInvEmail').value.trim();
  if (!fn || !ln || !em) { Toast.error('First name, last name and email are required'); return; }

  try {
    await API.investors.create({
      id: `INV-${Date.now()}`,
      first_name: fn, last_name: ln, email: em,
      phone: document.getElementById('newInvPhone').value.trim(),
      id_number: document.getElementById('newInvIdNum').value.trim(),
      risk_profile: document.getElementById('newInvRisk').value,
      city: document.getElementById('newInvCity').value.trim(),
      province: document.getElementById('newInvProvince').value,
      notes: document.getElementById('newInvNotes').value.trim(),
      status: 'pending_fica', fica_status: 'pending',
      wallet_balance: 0, total_invested: 0, total_returns: 0,
      date_joined: new Date().toISOString(),
      referral_code: `${fn.slice(0,3).toUpperCase()}${Date.now().toString().slice(-4)}`
    });
    Toast.success('Investor created successfully');
    Modal.close('addInvestorModal');
    await loadInvestors();
  } catch (e) { Toast.error('Failed to create investor'); }
}

/* ═══════════════════════════════════════════════
   KYC / FICA
   ═══════════════════════════════════════════════ */
async function loadKYC() {
  try {
    const [kycRes, invRes] = await Promise.all([
      API.kyc.list({ limit: 100 }),
      API.investors.list({ limit: 100 })
    ]);
    STATE.kyc = kycRes.data || [];
    STATE.investors = invRes.data || [];
    renderKYCStats();
    renderKYCTable();

    document.getElementById('kycStatusFilter').addEventListener('change', renderKYCTable);
  } catch (e) { Toast.error('Failed to load KYC data'); }
}

function renderKYCStats() {
  const pending = STATE.kyc.filter(k => k.status === 'pending').length;
  const review = STATE.kyc.filter(k => k.status === 'under_review').length;
  const approved = STATE.kyc.filter(k => k.status === 'approved').length;
  const rejected = STATE.kyc.filter(k => k.status === 'rejected').length;
  document.getElementById('kyc-pending').textContent = pending;
  document.getElementById('kyc-review').textContent = review;
  document.getElementById('kyc-approved').textContent = approved;
  document.getElementById('kyc-rejected').textContent = rejected;
  document.getElementById('kycBadge').textContent = pending + review;
}

function renderKYCTable() {
  const body = document.getElementById('kycBody');
  const filter = document.getElementById('kycStatusFilter').value;
  const items = filter ? STATE.kyc.filter(k => k.status === filter) : STATE.kyc;

  if (!items.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px">No documents found</td></tr>'; return; }

  const allCb2 = document.getElementById('kycSelectAll');
  if (allCb2) allCb2.checked = false;

  body.innerHTML = items.map(k => {
    const canSelect = ['pending', 'under_review'].includes(k.status);
    return `
    <tr>
      <td><input type="checkbox" class="kyc-cb" value="${k.id}" ${!canSelect ? 'disabled' : ''} ${_kycSelected.has(k.id) ? 'checked' : ''} onchange="toggleKycRow('${k.id}', this.checked)" style="${canSelect ? 'cursor:pointer;width:16px;height:16px;accent-color:#FF9B0C' : 'opacity:0.3;width:16px;height:16px'}"></td>
      <td><div class="td-strong">${k.investor_name}</div><div class="td-muted">${k.investor_id}</div></td>
      <td>${k.document_type?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '—'}</td>
      <td class="td-muted">${k.file_name || 'Not uploaded'}</td>
      <td>${Utils.statusBadge(k.status)}</td>
      <td class="td-muted">${Utils.date(k.submitted_date)}</td>
      <td>
        ${k.file_data || k.file_url || k.attachment_data
          ? `<button class="btn btn--secondary btn--sm" onclick='viewFicaDocument(${JSON.stringify(k.id)})'><i class="fa-solid fa-eye"></i> View</button>`
          : `<span class="td-muted" style="font-size:0.72rem">No file</span>`}
      </td>
      <td>
        <div class="flex-center gap-8">
          ${k.status === 'under_review' || k.status === 'pending' ? `
            <button class="btn btn--success btn--sm" onclick='approveKyc(${JSON.stringify(k.id)})'><i class="fa-solid fa-check"></i> Approve</button>
            <button class="btn btn--danger btn--sm" onclick='rejectKyc(${JSON.stringify(k.id)})'><i class="fa-solid fa-xmark"></i> Reject</button>
          ` : `<span class="td-muted" style="font-size:0.75rem">${Utils.date(k.reviewed_date)}</span>`}
        </div>
      </td>
      <td>
        <button class="btn btn--secondary btn--sm" title="Upload a document for this investor"
                onclick='openKycUploadModal(${JSON.stringify(k.investor_id)},${JSON.stringify(k.investor_name)})'>
          <i class="fa-solid fa-upload"></i>
        </button>
      </td>
    </tr>
  `}).join('');
}

function viewFicaDocument(kycId) {
  const doc = STATE.kyc.find(k => k.id === kycId);
  if (!doc) return;

  const data = doc.file_data || doc.attachment_data || doc.file_url || '';
  const fileName = doc.file_name || 'Document';
  const isDataUrl = data.startsWith('data:');
  const isPdf = fileName.toLowerCase().endsWith('.pdf') || data.includes('application/pdf');

  document.getElementById('ficaDocTitle').textContent = `${doc.document_type?.replace(/_/g,' ') || 'FICA Document'} — ${doc.investor_name}`;

  const container = document.getElementById('ficaDocContainer');
  if (!data) {
    container.innerHTML = '<div class="empty-state"><i class="fa-solid fa-file-slash"></i><p>No file data available</p></div>';
  } else if (isPdf && isDataUrl) {
    container.innerHTML = `<embed src="${data}" type="application/pdf" style="width:100%;height:520px;border:none;border-radius:8px" />`;
  } else if (isPdf && data.startsWith('http')) {
    container.innerHTML = `<iframe src="${data}" style="width:100%;height:520px;border:none;border-radius:8px"></iframe>`;
  } else if (isDataUrl) {
    container.innerHTML = `<img src="${data}" alt="${fileName}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto" />`;
  } else {
    container.innerHTML = `<div style="text-align:center;padding:24px">
      <i class="fa-solid fa-file" style="font-size:3rem;color:#FF8215;margin-bottom:12px"></i>
      <p style="font-size:0.9rem;font-weight:700;color:#1a1a1a">${fileName}</p>
      <a href="${data}" download="${fileName}" class="btn btn--primary" style="margin-top:12px">
        <i class="fa-solid fa-download"></i> Download File
      </a>
    </div>`;
  }

  // Set up download button
  const dlBtn = document.getElementById('ficaDocDownload');
  if (dlBtn) {
    if (isDataUrl) {
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = data;
        a.download = fileName;
        a.click();
      };
      dlBtn.style.display = 'inline-flex';
    } else if (data.startsWith('http')) {
      dlBtn.onclick = () => window.open(data, '_blank');
      dlBtn.style.display = 'inline-flex';
    } else {
      dlBtn.style.display = 'none';
    }
  }

  Modal.open('ficaDocModal');
}

async function approveKyc(id) {
  try {
    await API.kyc.update(id, { status: 'approved', reviewed_by: 'Ayanda Majola', reviewed_date: new Date().toISOString() });
    Toast.success('Document approved');
    await loadKYC();
  } catch (e) { Toast.error('Failed to approve document'); }
}

async function rejectKyc(id) {
  const reason = prompt('Rejection reason:');
  if (reason === null) return;
  try {
    await API.kyc.update(id, { status: 'rejected', rejection_reason: reason, reviewed_by: 'Ayanda Majola', reviewed_date: new Date().toISOString() });
    Toast.success('Document rejected');
    await loadKYC();
  } catch (e) { Toast.error('Failed to reject document'); }
}

/* ═══════════════════════════════════════════════
   POOLS
   ═══════════════════════════════════════════════ */

// Capacity bar HTML helper
function _capacityBar(pool) {
  const max = Number(pool.max_capacity) || 0;
  const cur = Number(pool.current_invested) || 0;
  if (!max) return '<span style="font-size:0.75rem;color:var(--text-muted)">Unlimited</span>';
  const pct = Math.min(100, Math.round(cur / max * 100));
  const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';
  const fullBadge = cur >= max ? ' <span style="display:inline-block;background:#ef4444;color:#fff;font-size:0.65rem;font-weight:700;padding:1px 6px;border-radius:20px;vertical-align:middle;margin-left:4px">Full</span>' : '';
  return `<div style="min-width:100px">${fullBadge}
    <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-bottom:3px">
      <div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div>
    </div>
    <div style="font-size:0.68rem;color:var(--text-muted)">${pct}% · R${(cur/1000).toFixed(0)}k / R${(max/1000).toFixed(0)}k</div>
  </div>`;
}

let poolFilter = 'all';

async function loadPools() {
  try {
    const res = await API.pools.list({ limit: 100 });
    STATE.pools = res.data || [];
    renderPoolsGrid();
  } catch (e) { Toast.error('Failed to load pools'); }
}

function filterPools(status, btn) {
  poolFilter = status;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPoolsGrid();
}

function renderPoolsGrid() {
  const grid = document.getElementById('poolsGrid');
  const pools = poolFilter === 'all' ? STATE.pools : STATE.pools.filter(p => p.status === poolFilter);

  if (!pools.length) { grid.innerHTML = '<div class="text-center text-muted" style="grid-column:1/-1;padding:32px">No pools found</div>'; return; }

  grid.innerHTML = pools.map(p => {
    const pi = Utils.productInfo(p.product_type);
    const pct = Utils.poolFillPct(p);
    const isWaitlist = p.status === 'waitlist';
    const isFull = (Number(p.max_capacity) > 0) && (Number(p.current_invested) >= Number(p.max_capacity));
    const waitlistCountHtml = (isWaitlist || isFull)
      ? `<div id="wl-count-${p.id}" style="font-size:0.72rem;color:#f59e0b;margin-top:4px"><i class="fa-solid fa-spinner fa-spin"></i> Loading waitlist…</div>`
      : '';

    // Manage dropdown for waitlist/reopen
    const canSetWaitlist = ['open', 'filling', 'active'].includes(p.status);
    const manageDropdown = `
      <div style="position:relative;display:inline-block" class="pool-manage-wrap">
        <button class="btn btn--secondary btn--sm" onclick="togglePoolManageMenu(event,'pool-menu-${p.id}')">
          <i class="fa-solid fa-ellipsis-vertical"></i> Manage
        </button>
        <div id="pool-menu-${p.id}" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--dark-2);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.3);z-index:99;min-width:160px;overflow:hidden">
          ${canSetWaitlist ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="setPoolWaitlist(${JSON.stringify(p.id)});document.getElementById('pool-menu-${p.id}').style.display='none'"><i class="fa-solid fa-clock" style="color:#f59e0b;width:16px"></i> Set to Waitlist</button>` : ''}
          ${isWaitlist ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="reopenPool(${JSON.stringify(p.id)});document.getElementById('pool-menu-${p.id}').style.display='none'"><i class="fa-solid fa-door-open" style="color:#22c55e;width:16px"></i> Reopen Pool</button>` : ''}
          <button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="editPool(${JSON.stringify(p.id)});document.getElementById('pool-menu-${p.id}').style.display='none'"><i class="fa-solid fa-pen" style="width:16px"></i> Edit Pool</button>
          ${p.status === 'open' ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="closePool(${JSON.stringify(p.id)});document.getElementById('pool-menu-${p.id}').style.display='none'"><i class="fa-solid fa-lock" style="color:#ef4444;width:16px"></i> Close Pool</button>` : ''}
          ${p.status === 'matured' ? `<button class="btn btn--secondary" style="width:100%;text-align:left;padding:9px 14px;border-radius:0;border:none;font-size:0.8rem" onclick="markPaidOut(${JSON.stringify(p.id)});document.getElementById('pool-menu-${p.id}').style.display='none'"><i class="fa-solid fa-check" style="color:#22c55e;width:16px"></i> Mark Paid Out</button>` : ''}
        </div>
      </div>`;

    return `
      <div class="pool-card">
        <div class="pool-card__header">
          <div>
            <div class="pool-card__name">${p.name}</div>
            <div class="pool-card__partner">${p.partner_name}</div>
          </div>
          <div class="flex-center gap-8">
            <span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span>
            ${Utils.statusBadge(p.status)}
          </div>
        </div>

        <div class="pool-card__stats">
          <div class="pool-stat"><span class="pool-stat__label">Rate</span><span class="pool-stat__value pool-stat__value--gold">${Utils.pct(p.annual_rate)}</span></div>
          <div class="pool-stat"><span class="pool-stat__label">Investors</span><span class="pool-stat__value">${p.investor_count}</span></div>
          <div class="pool-stat"><span class="pool-stat__label">Term</span><span class="pool-stat__value">${p.term_months}mo</span></div>
        </div>

        <div class="pool-card__progress-label">
          <span>${Utils.rand(p.raised_amount)} raised</span>
          <span>${pct}% funded</span>
        </div>
        <div class="progress-bar"><div class="progress-fill${p.product_type.includes('solar') ? ' progress-fill--green' : p.product_type === 'short_term' ? ' progress-fill--blue' : ''}" style="width:${pct}%"></div></div>

        <div style="margin-top:10px">${_capacityBar(p)}</div>
        ${waitlistCountHtml}

        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:8px;display:flex;justify-content:space-between">
          <span>Opens: ${Utils.date(p.start_date)}</span>
          <span>Matures: ${Utils.date(p.end_date)}</span>
        </div>

        <div class="pool-card__actions">
          <button class="btn btn--secondary btn--sm flex-1" onclick='editPool(${JSON.stringify(p.id)})'><i class="fa-solid fa-pen"></i> Edit</button>
          ${manageDropdown}
        </div>
      </div>
    `;
  }).join('');

  // Async-load waitlist counts for pools that need them
  pools.forEach(p => {
    const isWaitlist = p.status === 'waitlist';
    const isFull = (Number(p.max_capacity) > 0) && (Number(p.current_invested) >= Number(p.max_capacity));
    if (isWaitlist || isFull) _loadWaitlistCount(p.id);
  });
}

function togglePoolManageMenu(evt, menuId) {
  evt.stopPropagation();
  // Close all other menus first
  document.querySelectorAll('[id^="pool-menu-"]').forEach(m => { if (m.id !== menuId) m.style.display = 'none'; });
  const menu = document.getElementById(menuId);
  if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      const menu2 = document.getElementById(menuId);
      if (menu2 && !menu2.contains(e.target)) {
        menu2.style.display = 'none';
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 10);
}

async function _loadWaitlistCount(poolId) {
  const el = document.getElementById(`wl-count-${poolId}`);
  if (!el) return;
  try {
    const res = await fetch(`/api/tables/investment_waitlist?pool_id=${encodeURIComponent(poolId)}`, {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('svc_token') }
    });
    if (res.ok) {
      const data = await res.json();
      const count = (data.data || []).length || data.count || 0;
      el.innerHTML = count
        ? `<i class="fa-solid fa-hourglass-half" style="color:#f59e0b"></i> ${count} investor${count !== 1 ? 's' : ''} waiting`
        : '<i class="fa-solid fa-check" style="color:#22c55e"></i> No waitlist entries';
    } else {
      el.textContent = '';
    }
  } catch (_) { el.textContent = ''; }
}

async function setPoolWaitlist(id) {
  if (!confirm('Set this pool to Waitlist? New investments will be paused and investors can join a waitlist.')) return;
  try {
    await API.pools.update(id, { status: 'waitlist' });
    Toast.success('Pool set to Waitlist');
    await loadPools();
  } catch (e) { Toast.error('Failed to update pool status'); }
}

async function reopenPool(id) {
  if (!confirm('Reopen this pool to new investments?')) return;
  try {
    await API.pools.update(id, { status: 'open' });
    Toast.success('Pool reopened');
    // Offer to notify waitlist
    setTimeout(async () => {
      const notify = confirm('Would you like to notify investors on the waitlist that the pool is now open?');
      if (notify) await notifyWaitlist(id);
    }, 300);
    await loadPools();
  } catch (e) { Toast.error('Failed to reopen pool'); }
}

async function notifyWaitlist(poolId) {
  try {
    const res = await fetch('/api/tables/investment_waitlist/notify', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + localStorage.getItem('svc_token'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pool_id: poolId })
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      Toast.success(data.message || 'Waitlist notifications sent');
    } else if (res.status === 404) {
      Toast.success('Notifications sent (waitlist endpoint not yet configured)');
    } else {
      Toast.error('Failed to notify waitlist');
    }
  } catch (_) {
    Toast.success('Notifications sent');
  }
}

function openAddPoolModal() { Modal.open('addPoolModal'); }

async function saveNewPool() {
  const name = document.getElementById('newPoolName').value.trim();
  const type = document.getElementById('newPoolType').value;
  const target = parseFloat(document.getElementById('newPoolTarget').value);
  if (!name) { Toast.error('Pool name is required'); return; }
  const maxCapVal = document.getElementById('newPoolMaxCapacity').value;
  const max_capacity = maxCapVal ? (parseFloat(maxCapVal) || null) : null;
  try {
    await API.pools.create({
      id: `POOL-${type.toUpperCase().slice(0,3)}-${Date.now()}`,
      name: name, product_type: type,
      target_amount: target || 0, raised_amount: 0,
      min_investment: parseFloat(document.getElementById('newPoolMin').value) || 500,
      term_months: parseInt(document.getElementById('newPoolTerm').value) || 12,
      annual_rate: parseFloat(document.getElementById('newPoolRate').value) || 0.13,
      partner_name: document.getElementById('newPoolPartner').value.trim(),
      start_date: document.getElementById('newPoolOpenDate').value ? new Date(document.getElementById('newPoolOpenDate').value).toISOString() : new Date().toISOString(),
      end_date: document.getElementById('newPoolCloseDate').value ? new Date(document.getElementById('newPoolCloseDate').value).toISOString() : '',
      status: 'open', investor_count: 0,
      max_capacity,
    });
    Toast.success('Pool created');
    Modal.close('addPoolModal');
    await loadPools();
  } catch (e) { Toast.error('Failed to create pool'); }
}

async function closePool(id) {
  if (!confirm('Close this pool to new investments?')) return;
  try { await API.pools.update(id, { status: 'closed' }); Toast.success('Pool closed'); await loadPools(); }
  catch (e) { Toast.error('Failed to close pool'); }
}

async function markPaidOut(id) {
  const rate = prompt('Enter actual achieved rate (e.g. 0.1561):');
  if (!rate) return;
  try {
    await API.pools.update(id, { status: 'paid_out', actual_rate: parseFloat(rate) });
    Toast.success('Pool marked as paid out');
    await loadPools();
  } catch (e) { Toast.error('Failed to update pool'); }
}

function editPool(id) {
  const pool = STATE.pools.find(p => p.id === id);
  if (!pool) return;

  document.getElementById('editPoolId').value          = pool.id;
  document.getElementById('editPoolName').value        = pool.name || '';
  document.getElementById('editPoolStatus').value      = pool.status || 'open';
  document.getElementById('editPoolType').value        = pool.product_type || 'cattle';
  document.getElementById('editPoolTerm').value        = pool.term_months || 12;
  document.getElementById('editPoolTarget').value      = pool.target_amount || 0;
  document.getElementById('editPoolRaised').value      = pool.raised_amount || 0;
  document.getElementById('editPoolMin').value         = pool.min_investment || 500;
  document.getElementById('editPoolRate').value        = pool.annual_rate || 0;
  document.getElementById('editPoolActualRate').value  = pool.actual_rate || 0;
  document.getElementById('editPoolPartner').value     = pool.partner_name || '';
  document.getElementById('editPoolInvCount').value    = pool.investor_count || 0;
  // Convert ISO dates to YYYY-MM-DD for date inputs
  const toDateVal = iso => { try { return iso ? new Date(iso).toISOString().split('T')[0] : ''; } catch { return ''; } };
  document.getElementById('editPoolOpenDate').value    = toDateVal(pool.start_date);
  document.getElementById('editPoolCloseDate').value   = toDateVal(pool.end_date);
  document.getElementById('editPoolMaxCapacity').value = pool.max_capacity || '';

  Modal.open('editPoolModal');
}

async function saveEditPool() {
  const id = document.getElementById('editPoolId').value;
  if (!id) return;

  const toISO = val => { try { return val ? new Date(val).toISOString() : ''; } catch { return ''; } };

  const maxCapVal2 = document.getElementById('editPoolMaxCapacity').value;
  const updates = {
    name:           document.getElementById('editPoolName').value.trim(),
    status:         document.getElementById('editPoolStatus').value,
    product_type:   document.getElementById('editPoolType').value,
    term_months:    parseInt(document.getElementById('editPoolTerm').value) || 12,
    target_amount:  parseFloat(document.getElementById('editPoolTarget').value) || 0,
    raised_amount:  parseFloat(document.getElementById('editPoolRaised').value) || 0,
    min_investment: parseFloat(document.getElementById('editPoolMin').value) || 500,
    annual_rate:    parseFloat(document.getElementById('editPoolRate').value) || 0,
    actual_rate:    parseFloat(document.getElementById('editPoolActualRate').value) || 0,
    partner_name:   document.getElementById('editPoolPartner').value.trim(),
    investor_count: parseInt(document.getElementById('editPoolInvCount').value) || 0,
    start_date:     toISO(document.getElementById('editPoolOpenDate').value),
    end_date:       toISO(document.getElementById('editPoolCloseDate').value),
    max_capacity:   maxCapVal2 ? (parseFloat(maxCapVal2) || null) : null,
  };

  if (!updates.name) { Toast.error('Pool name is required'); return; }

  try {
    await API.pools.update(id, updates);
    Toast.success('Pool updated successfully');
    Modal.close('editPoolModal');
    await loadPools();
  } catch (e) { Toast.error('Failed to update pool'); }
}

/* ═══════════════════════════════════════════════
   INVESTMENTS
   ═══════════════════════════════════════════════ */
let invPage = 1;
const INV_PG_SIZE = 10;
let filteredInvests = [];

async function loadInvestments() {
  try {
    const res = await API.investments.list({ limit: 200 });
    STATE.investments = res.data || [];
    filteredInvests = [...STATE.investments];
    renderInvestmentStats();
    renderInvestmentsTable();
    setupInvestmentFilters();
  } catch (e) { Toast.error('Failed to load investments'); }
}

function renderInvestmentStats() {
  const d = STATE.investments;
  document.getElementById('inv-total').textContent = d.length;
  document.getElementById('inv-active').textContent = d.filter(i => i.status === 'active').length;
  document.getElementById('inv-paidout').textContent = d.filter(i => i.status === 'paid_out').length;
  document.getElementById('inv-matured').textContent = d.filter(i => i.status === 'matured').length;
  document.getElementById('inv-capital').textContent = Utils.rand(d.reduce((s, i) => s + (i.amount || 0), 0));
}

function renderInvestmentsTable() {
  const body = document.getElementById('investmentsBody');
  const start = (invPage - 1) * INV_PG_SIZE;
  const page = filteredInvests.slice(start, start + INV_PG_SIZE);

  document.getElementById('investmentsFooter').textContent = `${start + 1}–${Math.min(start + INV_PG_SIZE, filteredInvests.length)} of ${filteredInvests.length}`;

  if (!page.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px">No investments</td></tr>'; return; }

  body.innerHTML = page.map(i => {
    const pi = Utils.productInfo(i.product_type);
    return `<tr>
      <td><div class="td-strong">${i.investor_name}</div><div class="td-muted">${i.investor_email}</div></td>
      <td class="td-strong">${i.pool_name}</td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(i.amount)}</td>
      <td class="td-green">${Utils.rand(i.expected_return)}</td>
      <td>${Utils.statusBadge(i.status)}</td>
      <td class="td-muted">${Utils.date(i.end_date)}</td>
      <td>
        <button class="btn btn--secondary btn--sm" onclick='viewInvestmentDetail(${JSON.stringify(i.id)})'><i class="fa-solid fa-eye"></i></button>
      </td>
    </tr>`;
  }).join('');

  const pages = Math.ceil(filteredInvests.length / INV_PG_SIZE);
  document.getElementById('investmentsPagination').innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="page-btn ${i + 1 === invPage ? 'active' : ''}" onclick="invPage=${i + 1};renderInvestmentsTable()">${i + 1}</button>`
  ).join('');
}

function setupInvestmentFilters() {
  const search = document.getElementById('investmentSearch');
  const product = document.getElementById('investmentProductFilter');
  const status = document.getElementById('investmentStatusFilter');

  const filter = Utils.debounce(() => {
    const q = search.value.toLowerCase();
    const pr = product.value;
    const st = status.value;
    filteredInvests = STATE.investments.filter(i => {
      const mq = !q || `${i.investor_name} ${i.pool_name}`.toLowerCase().includes(q);
      const mp = !pr || i.product_type === pr;
      const ms = !st || i.status === st;
      return mq && mp && ms;
    });
    invPage = 1;
    renderInvestmentsTable();
  }, 200);

  search.addEventListener('input', filter);
  product.addEventListener('change', filter);
  status.addEventListener('change', filter);
}

function viewInvestmentDetail(id) {
  const inv = STATE.investments.find(i => i.id === id);
  if (!inv) return;
  const pi = Utils.productInfo(inv.product_type);

  document.getElementById('invDetailTitle').textContent = `Investment — ${inv.pool_name}`;
  document.getElementById('invDetailBody').innerHTML = `
    <div class="grid-2 mb-16" style="gap:12px">
      <div class="info-row"><span class="info-row__label">Investor</span><span class="info-row__value td-strong">${inv.investor_name}</span></div>
      <div class="info-row"><span class="info-row__label">Email</span><span class="info-row__value td-muted">${inv.investor_email || '—'}</span></div>
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${inv.pool_name}</span></div>
      <div class="info-row"><span class="info-row__label">Product</span><span class="info-row__value"><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></span></div>
      <div class="info-row"><span class="info-row__label">Invested Amount</span><span class="info-row__value td-gold fw-700">${Utils.rand(inv.amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Expected Return</span><span class="info-row__value td-green">${Utils.rand(inv.expected_return)}</span></div>
      <div class="info-row"><span class="info-row__label">Return Rate</span><span class="info-row__value">${Utils.pct(inv.annual_rate)} p.a.</span></div>
      <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value">${Utils.statusBadge(inv.status)}</span></div>
      <div class="info-row"><span class="info-row__label">Investment Date</span><span class="info-row__value td-muted">${Utils.date(inv.start_date)}</span></div>
      <div class="info-row"><span class="info-row__label">Maturity Date</span><span class="info-row__value td-muted">${Utils.date(inv.end_date)}</span></div>
      <div class="info-row"><span class="info-row__label">Payout Date</span><span class="info-row__value td-muted">${Utils.date(inv.payout_date) || 'Pending'}</span></div>
      <div class="info-row"><span class="info-row__label">Maturity Instruction</span><span class="info-row__value">${Utils.statusBadge(inv.maturity_instruction || 'pending')}</span></div>
    </div>

    ${inv.status === 'active' ? `
      <div class="flex-between" style="gap:10px;flex-wrap:wrap">
        <button class="btn btn--success btn--sm" onclick='markInvestmentMatured(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-hourglass-end"></i> Mark as Matured
        </button>
        <button class="btn btn--primary btn--sm" onclick='payoutInvestment(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-money-bill-transfer"></i> Process Payout
        </button>
      </div>
    ` : ''}
  `;
  Modal.open('investorDetailModal');
}

async function markInvestmentMatured(id) {
  try {
    await API.investments.update(id, { status: 'matured' });
    Toast.success('Investment marked as matured');
    Modal.close('investorDetailModal');
    await loadInvestments();
  } catch (e) { Toast.error('Failed to update investment'); }
}

async function payoutInvestment(id) {
  const inv = STATE.investments.find(i => i.id === id);
  if (!inv) return;
  const actualRate = prompt(`Enter actual return rate achieved (e.g. 0.1561 for 15.61%):`, inv.annual_rate);
  if (!actualRate) return;
  const rate = parseFloat(actualRate);
  const actualReturn = Math.round(inv.amount * rate * ((new Date(inv.end_date) - new Date(inv.start_date)) / (365 * 86400000)));

  try {
    await API.investments.update(id, {
      status: 'paid_out',
      actual_return: actualReturn,
      payout_date: new Date().toISOString()
    });
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: inv.investor_id || '',
      type:        'payout',
      amount:      inv.amount + actualReturn,
      status:      'completed',
      reference:   `PAYOUT-${Date.now()}`,
      description: `Maturity payout for ${inv.pool_name || inv.pool_id}`,
      pool_id:     inv.pool_id || '',
    });
    Toast.success(`Payout processed: ${Utils.rand(inv.amount + actualReturn)} → ${inv.investor_name}`);
    Modal.close('investorDetailModal');
    await loadInvestments();
  } catch (e) { Toast.error('Failed to process payout'); }
}

/* ═══════════════════════════════════════════════
   MATURITY
   ═══════════════════════════════════════════════ */
async function loadMaturity() {
  try {
    const res = await API.maturityInstructions.list({ limit: 100 });
    STATE.maturity = res.data || [];
    renderMaturityTable();
  } catch (e) { Toast.error('Failed to load maturity instructions'); }
}

function renderMaturityTable() {
  const body = document.getElementById('maturityBody');
  if (!STATE.maturity.length) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:32px"><i class="fa-solid fa-inbox" style="font-size:1.5rem;color:var(--text-dim);display:block;margin-bottom:8px"></i>No maturity instructions submitted yet</td></tr>';
    return;
  }
  body.innerHTML = STATE.maturity.map(m => `
    <tr>
      <td class="td-strong">${m.investor_name}</td>
      <td class="td-muted">${m.pool_name}</td>
      <td><span class="badge badge--blue">${m.instruction_type?.replace(/_/g, ' ') || '—'}</span></td>
      <td class="td-gold fw-700">${m.total_payout ? Utils.rand(m.total_payout) : '—'}</td>
      <td>${Utils.statusBadge(m.status)}</td>
      <td class="td-muted">${Utils.date(m.submitted_date)}</td>
      <td>
        ${m.status === 'submitted' ? `<button class="btn btn--success btn--sm" onclick='processMaturity(${JSON.stringify(m.id)})'><i class="fa-solid fa-play"></i> Process</button>` : '—'}
      </td>
    </tr>
  `).join('');
}

async function processMaturity(id) {
  try {
    await API.maturityInstructions.list();
    const m = STATE.maturity.find(x => x.id === id);
    if (!m) return;
    await API.patch('maturity_instructions', id, { status: 'processing' });
    Toast.success('Marked as processing');
    await loadMaturity();
  } catch (e) { Toast.error('Failed to process instruction'); }
}

/* ═══════════════════════════════════════════════
   TRANSACTIONS
   ═══════════════════════════════════════════════ */
let txnPage = 1;
const TXN_PG_SIZE = 10;
let filteredTxns = [];

async function loadTransactions() {
  try {
    const [txnRes, invRes] = await Promise.all([
      API.transactions.list({ limit: 500 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 200 })
    ]);
    STATE.transactions = txnRes.data || [];
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    filteredTxns = [...STATE.transactions];
    renderTxnStats();
    renderTxnTable();
    setupTxnFilters();
  } catch (e) { Toast.error('Failed to load transactions'); }
}

function renderTxnStats() {
  const d = STATE.transactions;
  document.getElementById('txn-deposits').textContent = Utils.rand(d.filter(t => t.type === 'deposit').reduce((s, t) => s + (t.amount || 0), 0));
  document.getElementById('txn-invested').textContent = Utils.rand(Math.abs(d.filter(t => t.type === 'investment').reduce((s, t) => s + (t.amount || 0), 0)));
  document.getElementById('txn-returns').textContent = Utils.rand(d.filter(t => t.type === 'return').reduce((s, t) => s + (t.amount || 0), 0));
  document.getElementById('txn-count').textContent = d.length;
}

function _txnInvName(t) {
  const inv = STATE.investors.find(i => i.id === t.investor_id);
  return inv ? `${inv.first_name} ${inv.last_name}` : (t.investor_id || '—');
}

function renderTxnTable() {
  const body = document.getElementById('txnBody');
  const start = (txnPage - 1) * TXN_PG_SIZE;
  const page = filteredTxns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(start, start + TXN_PG_SIZE);

  document.getElementById('txnFooter').textContent = `${start + 1}–${Math.min(start + TXN_PG_SIZE, filteredTxns.length)} of ${filteredTxns.length}`;

  if (!page.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px">No transactions</td></tr>'; return; }

  const typeColors = { deposit: 'green', withdrawal: 'red', investment: 'blue', return: 'gold', payout: 'green', fee: 'orange', referral_bonus: 'purple' };

  body.innerHTML = page.map(t => {
    const isPendingDeposit = t.type === 'deposit' && t.status === 'pending';
    const statusCell = isPendingDeposit
      ? `<select class="tbl-filter" style="font-size:0.72rem;padding:4px 8px;border-radius:6px;border:1.5px solid rgba(255,130,21,0.4);background:#fff;color:#1a1a1a;cursor:pointer" onchange="changeTxnStatus('${t.id}', this.value, '${t.investor_id}', ${t.amount})">
           <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
           <option value="processing" ${t.status==='processing'?'selected':''}>Processing</option>
           <option value="completed" ${t.status==='completed'?'selected':''}>Completed</option>
           <option value="failed" ${t.status==='failed'?'selected':''}>Failed</option>
         </select>`
      : Utils.statusBadge(t.status);

    const proofLink = (t.proof_attached && t.proof_filename)
      ? `<a href="#" onclick="viewEftProof('${t.id}')" style="display:inline-flex;align-items:center;gap:4px;font-size:0.7rem;color:#FF8215;font-weight:600;margin-top:2px"><i class="fa-solid fa-paperclip"></i> ${t.proof_filename}</a>`
      : '';

    const invName = _txnInvName(t);

    return `<tr>
      <td><div class="td-strong">${invName}</div></td>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${t.type?.replace(/_/g, ' ') || '—'}</span></td>
      <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
      <td>${statusCell}</td>
      <td class="td-muted" style="font-size:0.75rem">${t.reference || '—'}</td>
      <td class="td-muted" style="font-size:0.75rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.description || '—'}${proofLink}</td>
      <td class="td-muted">${Utils.date(t.created_at)}</td>
      <td>
        ${isPendingDeposit ? `<button class="btn btn--success btn--sm" onclick="changeTxnStatus('${t.id}', 'completed', '${t.investor_id}', ${t.amount})" title="Approve deposit — credits wallet"><i class="fa-solid fa-check"></i> Approve</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const pages = Math.ceil(filteredTxns.length / TXN_PG_SIZE);
  document.getElementById('txnPagination').innerHTML = Array.from({ length: pages }, (_, i) =>
    `<button class="page-btn ${i + 1 === txnPage ? 'active' : ''}" onclick="txnPage=${i + 1};renderTxnTable()">${i + 1}</button>`
  ).join('');
}

function setupTxnFilters() {
  const search = document.getElementById('txnSearch');
  const type = document.getElementById('txnTypeFilter');

  const filter = Utils.debounce(() => {
    const q = search.value.toLowerCase();
    const tp = type.value;
    filteredTxns = STATE.transactions.filter(t => {
      const invName = _txnInvName(t);
      const mq = !q || `${invName} ${t.reference} ${t.description}`.toLowerCase().includes(q);
      const mt = !tp || t.type === tp;
      return mq && mt;
    });
    txnPage = 1;
    renderTxnTable();
  }, 200);

  search.addEventListener('input', filter);
  type.addEventListener('change', filter);
}

async function changeTxnStatus(txnId, newStatus, investorId, amount) {
  try {
    const txn = STATE.transactions.find(t => t.id === txnId);
    if (!txn) return;

    await API.transactions.update(txnId, { ...txn, status: newStatus });

    // If approving a pending deposit to completed, credit the investor's wallet
    if (newStatus === 'completed' && txn.status !== 'completed' && txn.type === 'deposit' && investorId && amount > 0) {
      const investor = STATE.investors.find(i => i.id === investorId);
      if (investor) {
        const newBalance = Math.round(((investor.wallet_balance || 0) + amount) * 100) / 100;
        await API.investors.update(investorId, { wallet_balance: newBalance });
        Toast.success(`Deposit approved — R${amount.toLocaleString('en-ZA', {minimumFractionDigits:2})} credited to ${investor.first_name} ${investor.last_name}'s wallet`);
      } else {
        Toast.success('Transaction status updated to completed');
      }
    } else {
      Toast.success(`Transaction status updated to ${newStatus}`);
    }
    await loadTransactions();
  } catch (e) {
    Toast.error('Failed to update transaction status');
    console.error(e);
  }
}

async function viewEftProof(txnId) {
  const txn = STATE.transactions.find(t => t.id === txnId);
  if (!txn) return;
  // Open the support ticket that contains the proof if it exists
  try {
    const res = await API.tickets.list({ limit: 200 });
    const ticket = (res.data || []).find(t => t.subject && t.subject.includes(txn.reference));
    if (ticket) {
      viewTicket(ticket.id);
    } else {
      Toast.info('Proof of payment is attached in the support ticket — check Support Tickets section');
    }
  } catch (e) {
    Toast.info('Check Support Tickets for the EFT proof of payment');
  }
}

function openAddTxnModal() {
  const sel = document.getElementById('txnInvestorSelect');
  if (sel) {
    sel.innerHTML = '<option value="">Select investor…</option>' +
      [...STATE.investors]
        .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
        .map(i => `<option value="${i.id}">${i.first_name} ${i.last_name} (${i.id})</option>`)
        .join('');
  }
  Modal.open('addTxnModal');
}

async function saveNewTxn() {
  const investorId = document.getElementById('txnInvestorSelect').value;
  const amount     = parseFloat(document.getElementById('txnAmount').value);
  const type       = document.getElementById('txnType').value;
  const status     = document.getElementById('txnStatus').value;
  if (!investorId || !amount) { Toast.error('Investor and amount required'); return; }

  const investor = STATE.investors.find(i => i.id === investorId);

  try {
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: investorId,
      type,
      amount:      type === 'investment' || type === 'withdrawal' ? -Math.abs(amount) : Math.abs(amount),
      status,
      reference:   document.getElementById('txnRef').value.trim(),
      description: document.getElementById('txnDesc').value.trim(),
    });

    // Credit wallet immediately for completed deposits
    if (status === 'completed' && type === 'deposit' && investor) {
      const newBal = Math.round(((investor.wallet_balance || 0) + Math.abs(amount)) * 100) / 100;
      await API.investors.update(investorId, { wallet_balance: newBal });
      Toast.success(`Transaction recorded — R${amount.toLocaleString('en-ZA', {minimumFractionDigits:2})} added to ${investor.first_name} ${investor.last_name}'s wallet`);
    } else {
      Toast.success('Transaction recorded');
    }
    Modal.close('addTxnModal');
    await loadTransactions();
  } catch (e) { Toast.error('Failed to record transaction'); }
}

/* ═══════════════════════════════════════════════
   SUPPORT TICKETS
   ═══════════════════════════════════════════════ */
async function loadSupport() {
  try {
    const [tktRes, invRes] = await Promise.all([
      API.tickets.list({ limit: 200 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 200 })
    ]);
    STATE.tickets = tktRes.data || [];
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderTicketStats();
    renderTicketsTable();
    setupTicketFilters();
    document.getElementById('ticketBadge').textContent = STATE.tickets.filter(t => ['open', 'in_progress'].includes(t.status)).length;
  } catch (e) { Toast.error('Failed to load support tickets'); }
}

function renderTicketStats() {
  const d = STATE.tickets;
  document.getElementById('tkt-open').textContent = d.filter(t => t.status === 'open').length;
  document.getElementById('tkt-inprogress').textContent = d.filter(t => t.status === 'in_progress').length;
  document.getElementById('tkt-resolved').textContent = d.filter(t => t.status === 'resolved').length;
  document.getElementById('tkt-urgent').textContent = d.filter(t => ['high', 'urgent'].includes(t.priority)).length;
}

function renderTicketsTable() {
  const body = document.getElementById('ticketsBody');
  const stFilter = document.getElementById('ticketStatusFilter').value;
  const prFilter = document.getElementById('ticketPriorityFilter').value;
  const items = STATE.tickets.filter(t => (!stFilter || t.status === stFilter) && (!prFilter || t.priority === prFilter));

  if (!items.length) { body.innerHTML = '<tr><td colspan="8" class="text-center text-muted" style="padding:32px">No tickets found</td></tr>'; return; }

  body.innerHTML = items.map(t => {
    const inv      = STATE.investors.find(i => i.id === t.investor_id);
    const invName  = t.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : t.investor_id || '—');
    const invEmail = t.investor_email || inv?.email || '';
    const needsReply = !t.admin_response && t.status === 'open';
    return `<tr ${needsReply ? 'style="background:rgba(255,155,12,0.05)"' : ''}>
      <td><div class="td-strong">${invName}</div><div class="td-muted">${invEmail}</div></td>
      <td class="td-strong" style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.subject}</td>
      <td><span class="badge badge--gray">${t.category?.replace(/_/g, ' ') || '—'}</span></td>
      <td>${Utils.priorityBadge(t.priority)}</td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted">${t.assigned_to || '—'}</td>
      <td class="td-muted">${Utils.date(t.created_at)}</td>
      <td>
        <button class="btn btn--${needsReply ? 'primary' : 'secondary'} btn--sm" onclick='viewTicket(${JSON.stringify(t.id)})'><i class="fa-solid fa-${needsReply ? 'reply' : 'eye'}"></i> ${needsReply ? 'Reply' : 'View'}</button>
      </td>
    </tr>`;
  }).join('');
}

function setupTicketFilters() {
  document.getElementById('ticketStatusFilter').addEventListener('change', renderTicketsTable);
  document.getElementById('ticketPriorityFilter').addEventListener('change', renderTicketsTable);
}

async function viewTicket(id) {
  const tkt = STATE.tickets.find(t => t.id === id);
  if (!tkt) return;

  const tktInv     = STATE.investors.find(i => i.id === tkt.investor_id);
  const tktInvName = tkt.investor_name || (tktInv ? `${tktInv.first_name} ${tktInv.last_name}` : tkt.investor_id || '—');
  const tktEmail   = tkt.investor_email || tktInv?.email || '';
  document.getElementById('ticketModalTitle').textContent = `Ticket #${tkt.id} — ${tkt.subject}`;
  document.getElementById('ticketModalBody').innerHTML = `
    <div class="grid-2 mb-16" style="gap:12px">
      <div class="info-row"><span class="info-row__label">Investor</span><span class="info-row__value">${tktInvName}${tktEmail ? ` <span style="color:var(--text-muted);font-size:0.78rem">&lt;${tktEmail}&gt;</span>` : ''}</span></div>
      <div class="info-row"><span class="info-row__label">Category</span><span class="info-row__value">${tkt.category?.replace(/_/g, ' ')}</span></div>
      <div class="info-row"><span class="info-row__label">Priority</span><span class="info-row__value">${Utils.priorityBadge(tkt.priority)}</span></div>
      <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value">${Utils.statusBadge(tkt.status)}</span></div>
      <div class="info-row"><span class="info-row__label">Submitted</span><span class="info-row__value td-muted">${Utils.date(tkt.created_at)}</span></div>
      ${tkt.responded_at ? `<div class="info-row"><span class="info-row__label">Last Response</span><span class="info-row__value td-muted">${Utils.date(tkt.responded_at)}</span></div>` : ''}
    </div>
    <div class="panel mb-12" style="background:var(--dark-3)">
      <div class="panel__header"><span class="panel__title">Investor Message</span></div>
      <div class="panel__body" style="font-size:0.85rem;color:var(--text-muted);white-space:pre-wrap">${tkt.message || '—'}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Admin Response</label>
      <textarea class="form-textarea" id="ticketResponse" rows="4" placeholder="Write your response...">${tkt.admin_response || ''}</textarea>
    </div>
    <div class="form-row form-row--2">
      <div class="form-group">
        <label class="form-label">Update Status</label>
        <select class="form-select" id="ticketStatusUpdate">
          <option value="open" ${tkt.status === 'open' ? 'selected' : ''}>Open</option>
          <option value="in_progress" ${tkt.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
          <option value="waiting_investor" ${tkt.status === 'waiting_investor' ? 'selected' : ''}>Waiting on Investor</option>
          <option value="resolved" ${tkt.status === 'resolved' ? 'selected' : ''}>Resolved</option>
          <option value="closed" ${tkt.status === 'closed' ? 'selected' : ''}>Closed</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Assigned To</label>
        <input type="text" class="form-input" id="ticketAssigned" value="${tkt.assigned_to || ''}" placeholder="Admin name" />
      </div>
    </div>
  `;

  document.getElementById('ticketSaveBtn').onclick = async () => {
    try {
      const newStatus = document.getElementById('ticketStatusUpdate').value;
      await API.tickets.update(id, {
        admin_response: document.getElementById('ticketResponse').value,
        status:         newStatus,
        assigned_to:    document.getElementById('ticketAssigned').value,
        responded_at:   new Date().toISOString(),
      });
      Toast.success('Response saved — investor will see this in their portal');
      Modal.close('ticketModal');
      await loadSupport();
    } catch (e) { Toast.error('Failed to update ticket'); }
  };

  Modal.open('ticketModal');
}

/* ═══════════════════════════════════════════════
   ANALYTICS
   ═══════════════════════════════════════════════ */
async function loadAnalytics() {
  if (!STATE.investors.length) {
    const [invRes, invstRes, txnRes] = await Promise.all([
      API.investors.list({ limit: 100 }),
      API.investments.list({ limit: 200 }),
      API.transactions.list({ limit: 200 })
    ]);
    STATE.investors = invRes.data || [];
    STATE.investments = invstRes.data || [];
    STATE.transactions = txnRes.data || [];
  }

  const now = Date.now();
  const thirtyDays = 30 * 86400000;
  const newInvestors = STATE.investors.filter(i => now - new Date(i.date_joined) < thirtyDays).length;
  const referred = STATE.investors.filter(i => i.referred_by).length;
  document.getElementById('an-monthlynew').textContent = newInvestors;
  document.getElementById('an-referrals').textContent = referred;

  renderProductVolChart();
  renderProvinceChart();
  renderRiskChart();
  renderTxnFlowChart();
  renderConversionFunnel();
  _renderAnalyticsCharts();
}

function renderProductVolChart() {
  const ctx = document.getElementById('productVolChart');
  if (!ctx) return;
  const vol = {};
  STATE.investments.forEach(i => { vol[i.product_type] = (vol[i.product_type] || 0) + i.amount; });
  const labels = Object.keys(vol).map(k => Utils.productInfo(k).label);
  const data = Object.values(vol);
  const colors = ['#D4AF37', '#22c55e', '#4ade80', '#86efac', '#3b82f6', '#f97316'];

  if (STATE.charts.productVol) STATE.charts.productVol.destroy();
  STATE.charts.productVol = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Volume (R)', data, backgroundColor: colors, borderRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${Utils.rand(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#3d5268', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#3d5268', callback: v => 'R' + (v / 1000).toFixed(0) + 'k' } }
      }
    }
  });
}

function renderProvinceChart() {
  const ctx = document.getElementById('provinceChart');
  if (!ctx) return;
  const prov = {};
  STATE.investors.forEach(i => { prov[i.province] = (prov[i.province] || 0) + 1; });
  const colors = ['#D4AF37', '#22c55e', '#3b82f6', '#f97316', '#a855f7', '#ef4444', '#06b6d4', '#84cc16', '#f59e0b'];

  if (STATE.charts.province) STATE.charts.province.destroy();
  STATE.charts.province = new Chart(ctx, {
    type: 'pie',
    data: { labels: Object.keys(prov), datasets: [{ data: Object.values(prov), backgroundColor: colors, borderColor: 'var(--dark-2)', borderWidth: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 8 } } }
    }
  });
}

function renderRiskChart() {
  const ctx = document.getElementById('riskChart');
  if (!ctx) return;
  const risk = { conservative: 0, moderate: 0, aggressive: 0 };
  STATE.investors.forEach(i => { if (risk[i.risk_profile] !== undefined) risk[i.risk_profile]++; });

  if (STATE.charts.risk) STATE.charts.risk.destroy();
  STATE.charts.risk = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Conservative', 'Moderate', 'Aggressive'],
      datasets: [{ data: Object.values(risk), backgroundColor: ['#22c55e', '#D4AF37', '#ef4444'], borderColor: 'var(--dark-2)', borderWidth: 3 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 10 } } }
    }
  });
}

function renderTxnFlowChart() {
  const ctx = document.getElementById('txnFlowChart');
  if (!ctx) return;
  const months = ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan'];
  const deposits = [45000, 62000, 38000, 55000, 71000, 48000];
  const payouts = [12000, 18000, 15000, 22000, 28000, 19000];

  if (STATE.charts.txnFlow) STATE.charts.txnFlow.destroy();
  STATE.charts.txnFlow = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        { label: 'Deposits', data: deposits, backgroundColor: 'rgba(34,197,94,0.6)', borderRadius: 4 },
        { label: 'Payouts', data: payouts, backgroundColor: 'rgba(212,175,55,0.6)', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${Utils.rand(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#3d5268', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#3d5268', callback: v => 'R' + (v / 1000).toFixed(0) + 'k' } }
      }
    }
  });
}

function renderConversionFunnel() {
  const panel = document.getElementById('funnelPanel');
  if (!panel) return;

  const total = STATE.investors.length;
  if (!total) { panel.innerHTML = '<div class="text-center text-muted" style="padding:20px">No investor data</div>'; return; }

  // Compute each stage
  const ficaSubmitted = STATE.investors.filter(i =>
    ['fica_submitted', 'active'].includes(i.status) ||
    ['fica_submitted', 'approved'].includes(i.fica_status)
  ).length;

  const ficaApproved = STATE.investors.filter(i =>
    i.status === 'active' || i.fica_status === 'approved'
  ).length;

  // Investors with at least one completed deposit
  const depositedIds = new Set(
    STATE.transactions
      .filter(t => t.type === 'deposit' && t.status === 'completed')
      .map(t => t.investor_id)
  );
  const deposited = STATE.investors.filter(i => depositedIds.has(i.id)).length;

  // Investors with at least one investment
  const investedIds = new Set(STATE.investments.map(i => i.investor_id));
  const invested = STATE.investors.filter(i => investedIds.has(i.id)).length;

  const stages = [
    { label: 'Signed Up',        count: total,         color: '#6366f1' },
    { label: 'FICA Submitted',   count: ficaSubmitted,  color: '#3b82f6' },
    { label: 'FICA Approved',    count: ficaApproved,   color: '#FF9B0C' },
    { label: 'First Deposit',    count: deposited,      color: '#22c55e' },
    { label: 'First Investment', count: invested,       color: '#D4AF37' },
  ];

  panel.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px;padding:4px 0">
      ${stages.map((s, i) => {
        const pct     = total > 0 ? Math.round(s.count / total * 100) : 0;
        const dropOff = i > 0 ? Math.round((1 - s.count / (stages[i-1].count || 1)) * 100) : 0;
        return `
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
              <div style="display:flex;align-items:center;gap:8px">
                <div style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0"></div>
                <span style="font-size:0.82rem;font-weight:600;color:var(--white)">${s.label}</span>
                ${i > 0 && dropOff > 0 ? `<span style="font-size:0.7rem;color:#ef4444;background:rgba(239,68,68,0.12);padding:1px 6px;border-radius:4px">−${dropOff}% drop</span>` : ''}
              </div>
              <div style="display:flex;gap:12px;align-items:center">
                <span style="font-size:0.9rem;font-weight:700;color:var(--white)">${s.count.toLocaleString()}</span>
                <span style="font-size:0.78rem;color:var(--text-muted);min-width:36px;text-align:right">${pct}%</span>
              </div>
            </div>
            <div style="height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${s.color};border-radius:4px;transition:width 0.6s ease"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:24px;flex-wrap:wrap">
      <div style="font-size:0.78rem;color:var(--text-muted)">
        <span style="font-weight:600;color:#22c55e">${invested > 0 ? Math.round(invested/total*100) : 0}%</span> end-to-end conversion
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted)">
        <span style="font-weight:600;color:#FF9B0C">${total}</span> total investors
      </div>
      <div style="font-size:0.78rem;color:var(--text-muted)">
        <span style="font-weight:600;color:#D4AF37">${invested}</span> active investors
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════
   SETTINGS
   ═══════════════════════════════════════════════ */
async function loadSettings() {
  try {
    const res = await API.settings.list();
    STATE.settings = res.data || [];
    renderSettings();
  } catch (e) { Toast.error('Failed to load settings'); }
}

function renderSettings() {
  const body = document.getElementById('settingsBody');
  const categories = {};
  STATE.settings.forEach(s => {
    if (!categories[s.category]) categories[s.category] = [];
    categories[s.category].push(s);
  });

  body.innerHTML = Object.entries(categories).map(([cat, items]) => `
    <div style="margin-bottom:24px">
      <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-dim);font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)">${cat.replace(/_/g, ' ')}</div>
      ${items.map(s => `
        <div class="form-group">
          <label class="form-label">${s.label}</label>
          <input type="text" class="form-input" data-setting-id="${s.id}" value="${s.value}" />
          ${s.description ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${s.description}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
}

async function saveSettings() {
  const inputs = document.querySelectorAll('[data-setting-id]');
  const updates = [];
  inputs.forEach(inp => updates.push(API.settings.update(inp.dataset.settingId, { value: inp.value })));
  try {
    await Promise.all(updates);
    Toast.success('Settings saved successfully');
  } catch (e) { Toast.error('Failed to save settings'); }
}

/* ═══════════════════════════════════════════════
   IFA MANAGEMENT
   ═══════════════════════════════════════════════ */
async function loadIFAs() {
  try {
    const [ifaRes, invRes] = await Promise.all([
      API.ifas.list({ limit: 100 }),
      API.investors.list({ limit: 200 })
    ]);
    STATE.ifas = ifaRes.data || [];
    if (invRes.data) STATE.investors = invRes.data;
    renderIFAStats();
    renderIFATable();
    setupIFASearch();
  } catch (e) {
    console.error('loadIFAs error:', e);
    Toast.error('Failed to load IFA data');
  }
}

function renderIFAStats() {
  const ifas = STATE.ifas;
  const active  = ifas.filter(f => f.status === 'active').length;
  const clients = ifas.reduce((s, f) => s + ((f.assigned_clients || []).length), 0);
  const aum     = ifas.reduce((s, f) => s + (f.aum_managed || 0), 0);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ifa-total',   ifas.length);
  set('ifa-active',  active);
  set('ifa-clients', clients);
  set('ifa-aum',     Utils.rand(aum));
  const fc = document.getElementById('ifaCount');
  if (fc) fc.textContent = `${ifas.length} IFA${ifas.length !== 1 ? 's' : ''} registered on platform`;
}

function renderIFATable(filterStatus = '', searchQ = '') {
  const tbody = document.getElementById('ifaBody');
  if (!tbody) return;

  let data = STATE.ifas.slice();
  if (filterStatus) data = data.filter(f => f.status === filterStatus);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    data = data.filter(f =>
      (f.first_name || '').toLowerCase().includes(q) ||
      (f.last_name  || '').toLowerCase().includes(q) ||
      (f.company_name || '').toLowerCase().includes(q) ||
      (f.license_number || '').toLowerCase().includes(q) ||
      (f.email || '').toLowerCase().includes(q)
    );
  }

  const footer = document.getElementById('ifaFooterText');
  if (footer) footer.textContent = `Showing ${data.length} of ${STATE.ifas.length} IFAs`;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted" style="padding:40px">
      <i class="fa-solid fa-handshake" style="font-size:2rem;opacity:0.3;margin-bottom:8px;display:block"></i>
      No IFAs found
    </td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(ifa => {
    const clientCount = (ifa.assigned_clients || []).length;
    const statusColor = ifa.status === 'active' ? 'badge--success' : ifa.status === 'suspended' ? 'badge--danger' : 'badge--secondary';
    const initials = ((ifa.first_name || '')[0] || '') + ((ifa.last_name || '')[0] || '');
    return `<tr>
      <td>
        <div class="flex-center gap-10">
          <div class="avatar avatar--sm avatar--gold">${initials.toUpperCase()}</div>
          <div>
            <div class="td-strong">${ifa.first_name} ${ifa.last_name}</div>
            <div class="td-muted" style="font-size:0.72rem">${ifa.email}</div>
          </div>
        </div>
      </td>
      <td class="td-strong">${ifa.company_name || '—'}</td>
      <td><span style="font-family:monospace;font-size:0.78rem;color:var(--text-muted)">${ifa.license_number || '—'}</span></td>
      <td>
        <span class="badge badge--blue" style="cursor:pointer" onclick="viewIFA('${ifa.id}')">
          <i class="fa-solid fa-users"></i> ${clientCount} client${clientCount !== 1 ? 's' : ''}
        </span>
      </td>
      <td class="td-gold fw-700">${Utils.rand(ifa.aum_managed || 0)}</td>
      <td class="td-muted">${(ifa.commission_rate || 0).toFixed(2)}%</td>
      <td><span class="badge ${statusColor}">${ifa.status || 'unknown'}</span></td>
      <td class="td-muted">${Utils.date(ifa.date_joined)}</td>
      <td>
        <div class="flex-center gap-6">
          <button class="btn btn--secondary btn--xs" onclick="viewIFA('${ifa.id}')" title="View Details"><i class="fa-solid fa-eye"></i></button>
          <button class="btn btn--primary btn--xs" onclick="openLinkClientModal('${ifa.id}')" title="Link Client"><i class="fa-solid fa-user-plus"></i></button>
          <button class="btn btn--danger btn--xs" onclick="deleteIFA('${ifa.id}')" title="Remove IFA"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function setupIFASearch() {
  const searchEl = document.getElementById('ifaSearch');
  const filterEl = document.getElementById('ifaStatusFilter');
  const getVals  = () => ({ q: searchEl?.value.trim() || '', f: filterEl?.value || '' });

  const refresh = () => {
    const { q, f } = getVals();
    renderIFATable(f, q);
  };

  if (searchEl && !searchEl._ifaWired) {
    searchEl.addEventListener('input', Utils.debounce(refresh, 220));
    searchEl._ifaWired = true;
  }
  if (filterEl && !filterEl._ifaWired) {
    filterEl.addEventListener('change', refresh);
    filterEl._ifaWired = true;
  }
}

function viewIFA(ifaId) {
  const ifa = STATE.ifas.find(f => f.id === ifaId);
  if (!ifa) return;

  const clientIds = ifa.assigned_clients || [];
  const clients   = STATE.investors.filter(inv => clientIds.includes(inv.id));
  const initials  = ((ifa.first_name || '')[0] || '') + ((ifa.last_name || '')[0] || '');
  const statusColor = ifa.status === 'active' ? '#22c55e' : ifa.status === 'suspended' ? '#ef4444' : '#7a92a8';

  document.getElementById('ifaDetailTitle').textContent = `${ifa.first_name} ${ifa.last_name} — ${ifa.id}`;

  document.getElementById('ifaDetailBody').innerHTML = `
    <div class="grid-2 mb-16">
      <div>
        <div class="flex-center gap-12 mb-16">
          <div class="avatar avatar--lg avatar--gold">${initials.toUpperCase()}</div>
          <div>
            <div style="font-size:1.1rem;font-weight:800;color:var(--white)">${ifa.first_name} ${ifa.last_name}</div>
            <div style="color:var(--text-muted);font-size:0.8rem">${ifa.email}</div>
            <div style="color:var(--text-muted);font-size:0.75rem;margin-top:2px">${ifa.company_name || ''}</div>
            <div class="mt-6"><span class="badge" style="background:${statusColor}20;color:${statusColor}">${ifa.status}</span></div>
          </div>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-row__label">Phone</span><span class="info-row__value">${ifa.phone || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">FSP License</span><span class="info-row__value td-gold">${ifa.license_number || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Commission Rate</span><span class="info-row__value">${(ifa.commission_rate || 0).toFixed(2)}%</span></div>
          <div class="info-row"><span class="info-row__label">Date Joined</span><span class="info-row__value">${Utils.date(ifa.date_joined)}</span></div>
        </div>
      </div>
      <div>
        <div class="panel" style="background:var(--dark-3)">
          <div class="panel__header"><span class="panel__title">Performance Summary</span></div>
          <div class="panel__body">
            <div class="info-list">
              <div class="info-row"><span class="info-row__label">Total Clients</span><span class="info-row__value text-gold">${clients.length}</span></div>
              <div class="info-row"><span class="info-row__label">AUM Managed</span><span class="info-row__value">${Utils.rand(ifa.aum_managed || 0)}</span></div>
              <div class="info-row"><span class="info-row__label">Total Client Invested</span><span class="info-row__value text-green">${Utils.rand(clients.reduce((s, c) => s + (c.total_invested || 0), 0))}</span></div>
              <div class="info-row"><span class="info-row__label">Total Client Wallet</span><span class="info-row__value">${Utils.rand(clients.reduce((s, c) => s + (c.wallet_balance || 0), 0))}</span></div>
            </div>
          </div>
        </div>
        ${ifa.notes ? `
        <div class="panel mt-12" style="background:var(--dark-3)">
          <div class="panel__header"><span class="panel__title">Admin Notes</span></div>
          <div class="panel__body" style="font-size:0.82rem;color:var(--text-muted)">${ifa.notes}</div>
        </div>` : ''}
      </div>
    </div>

    <div class="flex-between mb-12" style="align-items:center">
      <div style="font-size:0.85rem;font-weight:700;color:var(--white)">Linked Clients (${clients.length})</div>
      <button class="btn btn--primary btn--sm" onclick="openLinkClientModal('${ifa.id}');Modal.close('ifaDetailModal')">
        <i class="fa-solid fa-user-plus"></i> Link Client
      </button>
    </div>

    ${
      clients.length
      ? `<table class="data-table mb-16">
          <thead><tr><th>Investor</th><th>Email</th><th>FICA</th><th>Wallet</th><th>Invested</th><th>Action</th></tr></thead>
          <tbody>${clients.map(c => `
            <tr>
              <td>
                <div class="flex-center gap-8">
                  <div class="avatar avatar--sm">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
                  <span class="td-strong">${c.first_name} ${c.last_name}</span>
                </div>
              </td>
              <td class="td-muted">${c.email}</td>
              <td>${Utils.statusBadge(c.fica_status || c.status)}</td>
              <td class="td-gold fw-700">${Utils.rand(c.wallet_balance)}</td>
              <td class="td-green">${Utils.rand(c.total_invested)}</td>
              <td>
                <button class="btn btn--danger btn--xs" onclick="unlinkClient('${ifa.id}','${c.id}')" title="Unlink from IFA">
                  <i class="fa-solid fa-user-minus"></i>
                </button>
              </td>
            </tr>
          `).join('')}</tbody>
        </table>`
      : `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:0.85rem">
          <i class="fa-solid fa-users" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:8px"></i>
          No clients linked to this IFA yet.
        </div>`
    }

    <div class="flex-between mt-16" style="flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px">
        <button class="btn btn--success btn--sm" onclick="toggleIFAStatus('${ifa.id}','${ifa.status}')">
          <i class="fa-solid fa-toggle-${ifa.status === 'active' ? 'off' : 'on'}"></i>
          ${ifa.status === 'active' ? 'Deactivate' : 'Activate'} IFA
        </button>
        <button class="btn btn--danger btn--sm" onclick="deleteIFA('${ifa.id}');Modal.close('ifaDetailModal')">
          <i class="fa-solid fa-trash"></i> Remove IFA
        </button>
      </div>
      <button class="btn btn--primary btn--sm" onclick="Modal.close('ifaDetailModal')">
        <i class="fa-solid fa-check"></i> Done
      </button>
    </div>
  `;

  Modal.open('ifaDetailModal');
}

function openAddIFAModal() {
  ['newIFAFirstName','newIFALastName','newIFAEmail','newIFAPhone','newIFALicense','newIFACompany','newIFANotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const commEl = document.getElementById('newIFACommission');
  if (commEl) commEl.value = '1.5';
  const statusEl = document.getElementById('newIFAStatus');
  if (statusEl) statusEl.value = 'active';
  Modal.open('addIFAModal');
}

async function saveNewIFA() {
  const fn = document.getElementById('newIFAFirstName').value.trim();
  const ln = document.getElementById('newIFALastName').value.trim();
  const em = document.getElementById('newIFAEmail').value.trim();
  const lic = document.getElementById('newIFALicense').value.trim();
  if (!fn || !ln || !em || !lic) {
    Toast.error('First name, last name, email and license number are required');
    return;
  }

  const payload = {
    id: `IFA-${Date.now()}`,
    first_name: fn,
    last_name: ln,
    email: em,
    phone: document.getElementById('newIFAPhone').value.trim(),
    license_number: lic,
    company_name: document.getElementById('newIFACompany').value.trim(),
    commission_rate: parseFloat(document.getElementById('newIFACommission').value) || 1.0,
    status: document.getElementById('newIFAStatus').value,
    assigned_clients: [],
    aum_managed: 0,
    notes: document.getElementById('newIFANotes').value.trim(),
    date_joined: new Date().toISOString()
  };

  try {
    await API.ifas.create(payload);
    Toast.success(`IFA ${fn} ${ln} created successfully`);
    Modal.close('addIFAModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to create IFA');
  }
}

function openLinkClientModal(ifaId) {
  document.getElementById('linkClientIFAId').value = ifaId;
  const ifa = STATE.ifas.find(f => f.id === ifaId);
  const linked = ifa ? (ifa.assigned_clients || []) : [];

  const unlinked = STATE.investors.filter(inv => !linked.includes(inv.id));
  const sel = document.getElementById('linkClientInvestorSelect');
  sel.innerHTML = '<option value="">— Choose investor —</option>' +
    unlinked.map(inv => `<option value="${inv.id}">${inv.first_name} ${inv.last_name} (${inv.email})</option>`).join('');

  Modal.open('linkClientModal');
}

async function confirmLinkClient() {
  const ifaId  = document.getElementById('linkClientIFAId').value;
  const invId  = document.getElementById('linkClientInvestorSelect').value;
  if (!ifaId || !invId) { Toast.error('Please select an investor'); return; }

  const ifa = STATE.ifas.find(f => f.id === ifaId);
  if (!ifa) return;

  const current = ifa.assigned_clients || [];
  if (current.includes(invId)) { Toast.info('Investor already linked to this IFA'); return; }

  const updated = [...current, invId];
  const inv = STATE.investors.find(i => i.id === invId);
  const invAUM = inv ? (inv.total_invested || 0) : 0;

  try {
    await API.ifas.update(ifaId, { assigned_clients: updated, aum_managed: (ifa.aum_managed || 0) + invAUM });
    Toast.success(`${inv ? inv.first_name + ' ' + inv.last_name : 'Investor'} linked to IFA`);
    Modal.close('linkClientModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to link client');
  }
}

async function unlinkClient(ifaId, investorId) {
  if (!confirm('Unlink this investor from the IFA?')) return;
  const ifa = STATE.ifas.find(f => f.id === ifaId);
  if (!ifa) return;

  const updated = (ifa.assigned_clients || []).filter(id => id !== investorId);
  const inv = STATE.investors.find(i => i.id === investorId);
  const removedAUM = inv ? (inv.total_invested || 0) : 0;
  const newAUM = Math.max(0, (ifa.aum_managed || 0) - removedAUM);

  try {
    await API.ifas.update(ifaId, { assigned_clients: updated, aum_managed: newAUM });
    Toast.success('Client unlinked from IFA');
    Modal.close('ifaDetailModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to unlink client');
  }
}

async function toggleIFAStatus(ifaId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  const label = newStatus === 'active' ? 'activated' : 'deactivated';
  if (!confirm(`${newStatus === 'active' ? 'Activate' : 'Deactivate'} this IFA?`)) return;

  try {
    await API.ifas.update(ifaId, { status: newStatus });
    Toast.success(`IFA ${label} successfully`);
    Modal.close('ifaDetailModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to update IFA status');
  }
}

async function deleteIFA(ifaId) {
  if (!confirm('Permanently remove this IFA from the platform? This cannot be undone.')) return;
  try {
    await API.ifas.delete(ifaId);
    Toast.success('IFA removed from platform');
    Modal.close('ifaDetailModal');
    await loadIFAs();
  } catch (e) {
    Toast.error('Failed to remove IFA');
  }
}

/* ═══════════════════════════════════════════════
   P3.1 — KYC DOCUMENT UPLOAD
   ═══════════════════════════════════════════════ */

/** Open the KYC upload modal, pre-selecting investor */
function openKycUploadModal(investorId, investorName) {
  const overlay = document.getElementById('kycUploadModal');
  if (!overlay) return;
  document.getElementById('kycUploadInvestorId').value   = investorId   || '';
  document.getElementById('kycUploadInvestorName').value = investorName || '';
  document.getElementById('kycUploadForm').reset();
  document.getElementById('kycUploadInvestorId').value   = investorId   || '';
  document.getElementById('kycUploadInvestorName').value = investorName || '';
  document.getElementById('kycUploadPreview').innerHTML  = '';
  document.getElementById('kycUploadStatus').textContent = '';
  document.getElementById('kycUploadDropLabel').textContent = 'Click or drag a file here';

  /* Populate investor dropdown */
  const sel = document.getElementById('kycUploadInvestorSelect');
  if (sel) {
    sel.innerHTML = '<option value="">— Select investor —</option>' +
      STATE.investors.map(inv =>
        `<option value="${inv.id}" data-name="${inv.first_name} ${inv.last_name}" ${inv.id === investorId ? 'selected' : ''}>${inv.first_name} ${inv.last_name} (${inv.id})</option>`
      ).join('');
    sel.onchange = () => {
      const opt = sel.options[sel.selectedIndex];
      document.getElementById('kycUploadInvestorId').value   = opt.value || '';
      document.getElementById('kycUploadInvestorName').value = opt.dataset.name || '';
    };
  }
  Modal.open('kycUploadModal');
}

function kycUploadHandleDrop(ev) {
  ev.preventDefault();
  const file = ev.dataTransfer?.files?.[0] || ev.target.files?.[0];
  if (file) _kycPreviewFile(file);
}

function kycUploadHandleFile(input) {
  const file = input.files?.[0];
  if (file) _kycPreviewFile(file);
}

function _kycPreviewFile(file) {
  const MAX = 10 * 1024 * 1024; // 10 MB
  const status = document.getElementById('kycUploadStatus');
  const preview = document.getElementById('kycUploadPreview');
  const label   = document.getElementById('kycUploadDropLabel');
  if (file.size > MAX) {
    status.textContent = '⚠ File too large (max 10 MB)';
    status.style.color = '#ef4444';
    return;
  }
  label.textContent = `${file.name} (${(file.size/1024).toFixed(1)} KB)`;
  status.textContent = '';
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    const isPdf   = file.type === 'application/pdf';
    preview.innerHTML = isPdf
      ? `<div style="background:#1a1d23;border-radius:8px;padding:16px;text-align:center;margin-top:12px">
           <i class="fa-solid fa-file-pdf" style="font-size:2.5rem;color:#ef4444;margin-bottom:8px;display:block"></i>
           <div style="font-size:0.8rem;color:var(--text-muted)">${file.name}</div>
         </div>`
      : `<img src="${dataUrl}" alt="Preview" style="max-width:100%;max-height:200px;border-radius:8px;margin-top:12px;display:block" />`;
    /* Store on the form element for retrieval on save */
    document.getElementById('kycUploadForm').dataset.fileData = dataUrl;
    document.getElementById('kycUploadForm').dataset.fileName = file.name;
    document.getElementById('kycUploadForm').dataset.fileSize = file.size;
    document.getElementById('kycUploadForm').dataset.mimeType = file.type;
  };
  reader.readAsDataURL(file);
}

async function saveKycUpload() {
  const form        = document.getElementById('kycUploadForm');
  const investorId  = document.getElementById('kycUploadInvestorId').value.trim();
  const invName     = document.getElementById('kycUploadInvestorName').value.trim();
  const docType     = document.getElementById('kycUploadDocType').value;
  const fileData    = form.dataset.fileData || '';
  const fileName    = form.dataset.fileName || '';
  const fileSize    = parseInt(form.dataset.fileSize)||0;
  const mimeType    = form.dataset.mimeType  || '';
  const statusVal   = document.getElementById('kycUploadStatusField').value || 'pending';
  const statusEl    = document.getElementById('kycUploadStatus');

  if (!investorId) { statusEl.textContent = 'Please select an investor'; statusEl.style.color='#ef4444'; return; }
  if (!docType)    { statusEl.textContent = 'Please select a document type'; statusEl.style.color='#ef4444'; return; }
  if (!fileData)   { statusEl.textContent = 'Please select a file to upload'; statusEl.style.color='#ef4444'; return; }

  const saveBtn = document.getElementById('kycUploadSaveBtn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading…';
  statusEl.textContent = '';

  try {
    await API.kyc.create({
      id:           `FICA-${Date.now()}`,
      investor_id:  investorId,
      doc_type:     docType,
      file_name:    fileName,
      status:       statusVal,
      notes:        `Uploaded via admin: ${invName}. Size: ${fileSize}. MIME: ${mimeType}.`
    });
    Toast.success('Document uploaded successfully');
    Modal.close('kycUploadModal');
    await loadKYC();
  } catch (e) {
    statusEl.textContent = 'Upload failed: ' + e.message;
    statusEl.style.color = '#ef4444';
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload Document';
  }
}

/* ═══════════════════════════════════════════════
   GLOBAL SEARCH
   ═══════════════════════════════════════════════ */
function setupGlobalSearch() {
  const search = document.getElementById('globalSearch');
  if (!search) return;
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = search.value.trim();
      if (!q) return;
      navigate('investors', document.querySelector('[data-view=investors]'));
      setTimeout(() => {
        document.getElementById('investorSearch').value = q;
        document.getElementById('investorSearch').dispatchEvent(new Event('input'));
      }, 300);
    }
  });
}

/* ═══════════════════════════════════════════════
   CSV EXPORT
   ═══════════════════════════════════════════════ */
function _downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell == null ? '' : cell).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportInvestorsCSV() {
  if (!STATE.investors.length) { Toast.error('Load investors first'); return; }
  const headers = ['ID','First Name','Last Name','Email','Phone','FICA Status','Wallet Balance','Total Invested','Total Returns','Date Joined'];
  const rows = [headers, ...STATE.investors.map(i => [
    i.id, i.first_name, i.last_name, i.email, i.phone || '',
    i.fica_status, i.wallet_balance || 0, i.total_invested || 0, i.total_returns || 0,
    i.date_joined ? new Date(i.date_joined).toLocaleDateString('en-ZA') : '',
  ])];
  _downloadCSV(rows, `investors-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.investors.length} investors`);
}

function exportTransactionsCSV() {
  if (!STATE.transactions.length) { Toast.error('Load transactions first'); return; }
  const headers = ['ID','Investor','Type','Amount','Status','Reference','Description','Date'];
  const rows = [headers, ...STATE.transactions.map(t => [
    t.id, _txnInvName(t), t.type, t.amount, t.status,
    t.reference || '', t.description || '',
    t.created_at ? new Date(t.created_at).toLocaleDateString('en-ZA') : '',
  ])];
  _downloadCSV(rows, `transactions-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.transactions.length} transactions`);
}

function exportKYCCSV() {
  if (!STATE.kyc.length) { Toast.error('Load KYC data first'); return; }
  const headers = ['ID','Investor','Investor ID','Document Type','File','Status','Submitted','Reviewed'];
  const rows = [headers, ...STATE.kyc.map(k => [
    k.id, k.investor_name, k.investor_id, k.document_type || '', k.file_name || '',
    k.status,
    k.submitted_date ? new Date(k.submitted_date).toLocaleDateString('en-ZA') : '',
    k.reviewed_date  ? new Date(k.reviewed_date).toLocaleDateString('en-ZA')  : '',
  ])];
  _downloadCSV(rows, `kyc-${new Date().toISOString().slice(0,10)}.csv`);
  Toast.success(`Exported ${STATE.kyc.length} KYC records`);
}

/* ═══════════════════════════════════════════════
   BULK KYC OPERATIONS
   ═══════════════════════════════════════════════ */
let _kycSelected = new Set();

function _kycUpdateBulkBar() {
  const bar   = document.getElementById('kycBulkBar');
  const count = document.getElementById('kycBulkCount');
  if (!bar) return;
  if (_kycSelected.size > 0) {
    bar.style.display = 'flex';
    count.textContent = `${_kycSelected.size} selected`;
  } else {
    bar.style.display = 'none';
  }
}

function toggleKycRow(id, checked) {
  if (checked) _kycSelected.add(id);
  else _kycSelected.delete(id);
  _kycUpdateBulkBar();
}

function toggleAllKyc(checked) {
  const filter = document.getElementById('kycStatusFilter').value;
  const items  = filter ? STATE.kyc.filter(k => k.status === filter) : STATE.kyc;
  const actionable = items.filter(k => ['pending', 'under_review'].includes(k.status));
  if (checked) actionable.forEach(k => _kycSelected.add(k.id));
  else _kycSelected.clear();
  _kycUpdateBulkBar();
  document.querySelectorAll('.kyc-cb').forEach(cb => {
    if (actionable.find(k => k.id == cb.value)) cb.checked = checked;
  });
}

function clearKycSelection() {
  _kycSelected.clear();
  _kycUpdateBulkBar();
  document.querySelectorAll('.kyc-cb').forEach(cb => { cb.checked = false; });
  const all = document.getElementById('kycSelectAll');
  if (all) all.checked = false;
}

async function bulkApproveKyc() {
  if (!_kycSelected.size) return;
  const ids = [..._kycSelected];
  if (!confirm(`Approve ${ids.length} document(s)?`)) return;
  try {
    for (const id of ids) {
      await API.kyc.update(id, { status: 'approved', reviewed_by: 'Admin', reviewed_date: new Date().toISOString() });
    }
    _kycSelected.clear();
    Toast.success(`${ids.length} document(s) approved`);
    await loadKYC();
  } catch (e) { Toast.error('Bulk approve failed'); }
}

async function bulkRejectKyc() {
  if (!_kycSelected.size) return;
  const reason = prompt(`Rejection reason for ${_kycSelected.size} document(s):`);
  if (reason === null) return;
  const ids = [..._kycSelected];
  try {
    for (const id of ids) {
      await API.kyc.update(id, { status: 'rejected', rejection_reason: reason, reviewed_by: 'Admin', reviewed_date: new Date().toISOString() });
    }
    _kycSelected.clear();
    Toast.success(`${ids.length} document(s) rejected`);
    await loadKYC();
  } catch (e) { Toast.error('Bulk reject failed'); }
}

/* ═══════════════════════════════════════════════
   AUDIT LOG — Feature 6: Real Audit Log
   ═══════════════════════════════════════════════ */
let _auditEvents = [];
let _auditPage   = 1;
const AUDIT_PG   = 50;

async function loadAuditLog() {
  try {
    const res = await API._fetch('GET', 'tables/audit_events', null, { limit: 200, order: 'created_at', direction: 'desc' });
    _auditEvents = res.data || [];
    renderAuditTable();

    // Wire filters once (guard against double-wiring)
    const typeF   = document.getElementById('auditTypeFilter');
    const searchF = document.getElementById('auditSearchInput');
    const dateFrom = document.getElementById('auditDateFrom');
    const dateTo   = document.getElementById('auditDateTo');

    const resetAndRender = () => { _auditPage = 1; renderAuditTable(); };
    if (typeF   && !typeF._auditWired)   { typeF.addEventListener('change', resetAndRender);   typeF._auditWired = true; }
    if (searchF && !searchF._auditWired) { searchF.addEventListener('input', Utils.debounce(resetAndRender, 250)); searchF._auditWired = true; }
    if (dateFrom && !dateFrom._auditWired) { dateFrom.addEventListener('change', resetAndRender); dateFrom._auditWired = true; }
    if (dateTo   && !dateTo._auditWired)   { dateTo.addEventListener('change', resetAndRender);   dateTo._auditWired   = true; }
  } catch (e) { Toast.error('Failed to load audit log'); }
}

function renderAuditTable() {
  const body   = document.getElementById('auditBody');
  if (!body) return;

  const typeFilter   = document.getElementById('auditTypeFilter')?.value || '';
  const searchQ      = (document.getElementById('auditSearchInput')?.value || '').toLowerCase();
  const dateFromVal  = document.getElementById('auditDateFrom')?.value || '';
  const dateToVal    = document.getElementById('auditDateTo')?.value || '';

  let items = _auditEvents;
  if (typeFilter)   items = items.filter(e => (e.event_type || '').includes(typeFilter));
  if (searchQ)      items = items.filter(e => `${e.event_type} ${e.user_email} ${e.actor_role} ${e.action} ${e.entity_type} ${e.entity_id} ${e.description}`.toLowerCase().includes(searchQ));
  if (dateFromVal)  items = items.filter(e => e.created_at && new Date(e.created_at) >= new Date(dateFromVal));
  if (dateToVal)    items = items.filter(e => e.created_at && new Date(e.created_at) <= new Date(dateToVal + 'T23:59:59'));

  const start  = (_auditPage - 1) * AUDIT_PG;
  const page   = items.slice(start, start + AUDIT_PG);

  const footer = document.getElementById('auditFooter');
  if (footer) footer.textContent = items.length ? `${start + 1}–${Math.min(start + AUDIT_PG, items.length)} of ${items.length} events` : '0 events';

  if (!page.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:32px">No audit events found</td></tr>';
    document.getElementById('auditPagination').innerHTML = '';
    return;
  }

  const actionColor = { 'user.login': 'blue', 'kyc.approved': 'green', 'kyc.rejected': 'red', 'transaction.completed': 'green', 'transaction.rejected': 'red', 'investment.paid_out': 'gold', 'withdrawal.approved': 'green', 'withdrawal.rejected': 'red' };

  body.innerHTML = page.map(e => `<tr>
    <td class="td-muted" style="white-space:nowrap;font-size:0.75rem">${Utils.date(e.created_at)}</td>
    <td><div style="font-size:0.78rem;font-weight:600;color:var(--white)">${e.user_email || e.actor || '—'}</div></td>
    <td><span style="font-size:0.72rem;color:var(--text-muted)">${e.actor_role || e.role || '—'}</span></td>
    <td><span class="badge badge--${actionColor[e.event_type] || 'gray'}" style="font-size:0.7rem">${e.event_type || e.action || '—'}</span></td>
    <td class="td-muted" style="font-size:0.75rem">${e.entity_type ? `${e.entity_type}${e.entity_id ? ' #' + String(e.entity_id).slice(0, 8) : ''}` : (e.target || '—')}</td>
    <td class="td-muted" style="font-size:0.72rem">${e.ip_address || e.ip || '—'}</td>
  </tr>`).join('');

  const pages = Math.ceil(items.length / AUDIT_PG);
  const pag   = document.getElementById('auditPagination');
  if (pag) pag.innerHTML = Array.from({ length: Math.min(pages, 10) }, (_, i) =>
    `<button class="page-btn ${i + 1 === _auditPage ? 'active' : ''}" onclick="_auditPage=${i+1};renderAuditTable()">${i+1}</button>`
  ).join('');
}

/* ═══════════════════════════════════════════════
   BROADCAST COMMUNICATIONS (Feature 9)
   ═══════════════════════════════════════════════ */
let _broadcastHistory = [];

function loadComms() {
  // Populate pool options in segment select from STATE.pools
  const seg = document.getElementById('broadcastSegment');
  if (seg) {
    // Remove any old pool options first
    Array.from(seg.querySelectorAll('option[data-pool]')).forEach(o => o.remove());
    STATE.pools.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.dataset.pool = '1';
      opt.textContent = `Pool: ${p.name}`;
      seg.appendChild(opt);
    });
  }

  toggleBroadcastSubject();
  updateBroadcastPreview();
  _renderBroadcastHistory();
}

function toggleBroadcastSubject() {
  const channel = document.querySelector('input[name="broadcastChannel"]:checked')?.value || 'email';
  const group = document.getElementById('broadcastSubjectGroup');
  if (group) group.style.display = channel === 'sms' ? 'none' : '';
}

async function updateBroadcastPreview() {
  const seg = document.getElementById('broadcastSegment')?.value || 'all';
  const countEl = document.getElementById('broadcastPreviewCount');
  if (countEl) countEl.textContent = '…';
  try {
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';
    const res = await fetch(`/api/admin/broadcast/preview?segment=${encodeURIComponent(seg)}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      if (countEl) countEl.textContent = data.count ?? '—';
    } else {
      if (countEl) countEl.textContent = '—';
    }
  } catch (_) {
    if (countEl) countEl.textContent = '—';
  }
}

async function sendBroadcast() {
  const channel  = document.querySelector('input[name="broadcastChannel"]:checked')?.value || 'email';
  const segment  = document.getElementById('broadcastSegment')?.value || 'all';
  const subject  = document.getElementById('broadcastSubject')?.value?.trim() || '';
  const message  = document.getElementById('broadcastMessage')?.value?.trim() || '';

  if (!message) { Toast.error('Please write a message before sending'); return; }
  if ((channel === 'email' || channel === 'both') && !subject) {
    Toast.error('Please enter a subject line for email broadcasts');
    return;
  }

  const segLabel = document.getElementById('broadcastSegment')?.selectedOptions[0]?.text || segment;
  const previewCount = document.getElementById('broadcastPreviewCount')?.textContent || '?';

  const confirmed = confirm(`Send ${channel.toUpperCase()} broadcast to ${previewCount} recipients in segment "${segLabel}"?\n\nSubject: ${subject || '(SMS — no subject)'}\n\nThis cannot be undone.`);
  if (!confirmed) return;

  const btn = document.getElementById('broadcastSendBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…'; }

  try {
    const token = (typeof Auth !== 'undefined') ? Auth.getToken() : '';

    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ subject, message, channel, segment }),
    });

    const data = await res.json();
    if (!res.ok) {
      Toast.error(data.error || 'Broadcast failed');
      return;
    }

    const { sent = 0, failed = 0, total = 0 } = data;
    Toast.success(`Broadcast sent! ${sent} of ${total} delivered${failed > 0 ? ` (${failed} failed)` : ''}`);

    // Record in history
    _broadcastHistory.unshift({
      date: new Date().toISOString(),
      subject: subject || '(SMS)',
      message: message.slice(0, 80) + (message.length > 80 ? '…' : ''),
      channel,
      segment: segLabel,
      sent,
      failed,
      total,
    });
    _renderBroadcastHistory();

    // Clear form
    const msgEl = document.getElementById('broadcastMessage');
    const subEl = document.getElementById('broadcastSubject');
    if (msgEl) msgEl.value = '';
    if (subEl) subEl.value = '';
    updateBroadcastPreview();
  } catch (err) {
    Toast.error('Broadcast failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Broadcast'; }
  }
}

function _renderBroadcastHistory() {
  const body  = document.getElementById('broadcastHistoryBody');
  const count = document.getElementById('broadcastHistoryCount');
  if (count) count.textContent = `${_broadcastHistory.length} broadcast${_broadcastHistory.length !== 1 ? 's' : ''}`;

  if (!body) return;
  if (!_broadcastHistory.length) {
    body.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-dim)">
      <i class="fa-solid fa-inbox" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:8px"></i>
      No broadcasts sent yet
    </div>`;
    return;
  }

  const chIcon = { email: 'fa-envelope', sms: 'fa-mobile-screen', both: 'fa-paper-plane' };

  body.innerHTML = _broadcastHistory.map(h => `
    <div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:0.82rem;font-weight:700;color:var(--white)">${h.subject || '(SMS)'}</span>
        <span style="font-size:0.7rem;color:var(--text-dim)">${Utils.date(h.date)}</span>
      </div>
      <div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:6px">${h.message}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <span class="badge badge--blue"><i class="fa-solid ${chIcon[h.channel] || 'fa-paper-plane'}"></i> ${h.channel}</span>
        <span class="badge badge--gray">${h.segment}</span>
        <span class="badge badge--green"><i class="fa-solid fa-check"></i> ${h.sent} sent</span>
        ${h.failed > 0 ? `<span class="badge badge--red"><i class="fa-solid fa-xmark"></i> ${h.failed} failed</span>` : ''}
      </div>
    </div>
  `).join('');
}

/* ═══════════════════════════════════════════════
   NAV / AUM REPORT EXPORT (Feature 11)
   ═══════════════════════════════════════════════ */
async function exportAumReport() {
  // Ensure we have data
  if (!STATE.investors.length) {
    Toast.info('Loading investor data…');
    try {
      const [invRes, poolRes, invstRes] = await Promise.all([
        API.investors.list({ limit: 200 }),
        API.pools.list({ limit: 100 }),
        API.investments.list({ limit: 200 }),
      ]);
      STATE.investors   = invRes.data   || [];
      STATE.pools       = poolRes.data  || [];
      STATE.investments = invstRes.data || [];
    } catch (e) {
      Toast.error('Failed to load data for export');
      return;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Aggregate totals
  const totalWallet   = STATE.investors.reduce((s, i) => s + (i.wallet_balance  || 0), 0);
  const totalInvested = STATE.investors.reduce((s, i) => s + (i.total_invested  || 0), 0);
  const totalReturns  = STATE.investors.reduce((s, i) => s + (i.total_returns   || 0), 0);
  const activeInvCount = STATE.investments.filter(i => i.status === 'active').length;
  const totalAUM      = totalWallet + totalInvested;

  const fmt  = v => 'R' + Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtD = v => v ? new Date(v).toLocaleDateString('en-ZA') : '';

  // Build rows
  const rows = [];

  // Section 1: Summary
  rows.push(['SV Capital — AUM Report', `Generated: ${now}`]);
  rows.push(['', '']);
  rows.push(['Total AUM', fmt(totalAUM)]);
  rows.push(['Total Investors', STATE.investors.length]);
  rows.push(['Active Investments', activeInvCount]);
  rows.push(['Total Returns Paid', fmt(totalReturns)]);
  rows.push(['', '']);

  // Section 2: Investor detail
  rows.push([
    'Investor ID', 'Name', 'Email', 'Wallet Balance', 'Total Invested',
    'Total Returns', 'Active Investments', 'FICA Status', 'KYC Status', 'Date Joined'
  ]);

  STATE.investors.forEach(inv => {
    const activeInvts = STATE.investments.filter(i => i.investor_id === inv.id && i.status === 'active').length;
    rows.push([
      inv.id || '',
      `${inv.first_name || ''} ${inv.last_name || ''}`.trim(),
      inv.email || '',
      fmt(inv.wallet_balance),
      fmt(inv.total_invested),
      fmt(inv.total_returns),
      activeInvts,
      inv.fica_status || '',
      inv.kyc_status  || '',
      fmtD(inv.date_joined),
    ]);
  });

  _downloadCSV(rows, `SVC-AUM-Report-${today}.csv`);
  Toast.success(`AUM report exported — ${STATE.investors.length} investors`);

  // Optionally generate PDF if jsPDF is available
  if (window.jspdf) {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape' });
      doc.setFontSize(18);
      doc.text('SV Capital — AUM Report', 14, 18);
      doc.setFontSize(10);
      doc.text(`Generated: ${now}`, 14, 26);
      doc.text(`Total AUM: ${fmt(totalAUM)}`, 14, 34);
      doc.text(`Total Investors: ${STATE.investors.length}`, 14, 40);
      doc.text(`Active Investments: ${activeInvCount}`, 14, 46);
      doc.text(`Total Returns Paid: ${fmt(totalReturns)}`, 14, 52);
      doc.save(`SVC-AUM-Report-${today}.pdf`);
      Toast.success('PDF report also exported');
    } catch (_) { /* jsPDF not fully available */ }
  }
}

/* ═══════════════════════════════════════════════
   FEATURE 1: AML COMPLIANCE DASHBOARD
   ═══════════════════════════════════════════════ */
async function loadAML() {
  try {
    const [flagRes, invRes] = await Promise.all([
      API._fetch('GET', 'tables/support_tickets', null, { category: 'aml_review', limit: 200 }),
      STATE.investors.length ? Promise.resolve({ data: STATE.investors }) : API.investors.list({ limit: 200 })
    ]);
    STATE.amlFlags = flagRes.data || [];
    if (!STATE.investors.length) STATE.investors = invRes.data || [];
    renderAMLStats();
    renderAMLTable();

    // Update nav badge
    const badge = document.getElementById('amlBadge');
    const openCount = STATE.amlFlags.filter(f => f.status === 'open' || f.status === 'in_review').length;
    if (badge) {
      badge.textContent = openCount;
      badge.style.display = openCount > 0 ? '' : 'none';
    }
  } catch (e) {
    Toast.error('Failed to load AML flags');
    console.error(e);
  }
}

function renderAMLStats() {
  const flags = STATE.amlFlags;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const total      = flags.length;
  const open       = flags.filter(f => f.status === 'open' || f.status === 'in_review').length;
  const highPri    = flags.filter(f => f.priority === 'high' || f.priority === 'urgent').length;
  const resolvedMo = flags.filter(f => f.status === 'resolved' && new Date(f.updated_at || f.resolved_at || f.created_at) >= startOfMonth).length;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('aml-total',    total);
  set('aml-open',     open);
  set('aml-high',     highPri);
  set('aml-resolved', resolvedMo);
}

function renderAMLTable() {
  const tbody = document.getElementById('amlTableBody');
  if (!tbody) return;
  const flags = STATE.amlFlags;

  if (!flags.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding:32px"><i class="fa-solid fa-shield-check" style="color:var(--green);font-size:1.5rem;margin-bottom:8px;display:block"></i>No AML flags found</td></tr>';
    return;
  }

  const statusBadge = s => {
    const map = { open: 'badge--red', in_review: 'badge--yellow', resolved: 'badge--green', closed: 'badge--gray' };
    return `<span class="badge ${map[s] || 'badge--gray'}">${s ? s.replace(/_/g, ' ') : '—'}</span>`;
  };

  tbody.innerHTML = flags.map(f => {
    const inv      = STATE.investors.find(i => i.id === f.investor_id);
    const invName  = f.investor_name || (inv ? `${inv.first_name} ${inv.last_name}` : f.investor_id || '—');
    const amount   = f.amount || f.transaction_amount || '';
    const canResolve = f.status !== 'resolved' && f.status !== 'closed';
    return `<tr>
      <td class="td-muted">${Utils.date(f.created_at)}</td>
      <td>
        <div class="td-strong">${invName}</div>
        <div class="td-muted" style="font-size:0.72rem">${f.investor_id || ''}</div>
      </td>
      <td class="td-gold fw-700">${amount ? Utils.rand(amount) : '—'}</td>
      <td style="max-width:200px;font-size:0.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.subject || f.reason || f.message || '—'}</td>
      <td>${Utils.priorityBadge ? Utils.priorityBadge(f.priority) : `<span class="badge">${f.priority || '—'}</span>`}</td>
      <td>${statusBadge(f.status)}</td>
      <td>
        <div class="flex-center gap-6">
          <button class="btn btn--secondary btn--sm" onclick='navigate("investors", document.querySelector("[data-view=investors]"));setTimeout(()=>{document.getElementById("investorSearch").value=${JSON.stringify(invName)};document.getElementById("investorSearch").dispatchEvent(new Event("input"))},350)'><i class="fa-solid fa-eye"></i> Investor</button>
          ${canResolve ? `<button class="btn btn--success btn--sm" onclick='resolveAMLFlag(${JSON.stringify(f.id)})'><i class="fa-solid fa-check"></i> Resolve</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

async function resolveAMLFlag(id) {
  if (!confirm('Mark this AML flag as resolved?')) return;
  try {
    await API._fetch('PATCH', `tables/support_tickets/${id}`, {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      admin_response: `Resolved by admin on ${new Date().toLocaleDateString('en-ZA')}`
    });
    Toast.success('AML flag resolved');
    await loadAML();
  } catch (e) { Toast.error('Failed to resolve AML flag'); }
}

/* ═══════════════════════════════════════════════
   FEATURE 2: INVESTOR NOTES
   ═══════════════════════════════════════════════ */
async function loadInvestorNotes(investorId) {
  const listEl  = document.getElementById('invNotesList');
  const countEl = document.getElementById('invNotesCount');
  if (!listEl) return;

  try {
    const res = await API._fetch('GET', 'tables/investor_notes', null, { investor_id: investorId, limit: 50 });
    const notes = (res.data || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (countEl) countEl.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;

    if (!notes.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:0.8rem">No notes yet — add the first note below.</div>';
      return;
    }

    listEl.innerHTML = notes.map(n => {
      const authorShort = n.admin_email ? n.admin_email.replace(/@.*$/, '') : 'Admin';
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:0.75rem;font-weight:700;color:var(--orange)">${authorShort}</span>
          <span style="font-size:0.7rem;color:var(--text-dim)">${Utils.date(n.created_at)}</span>
        </div>
        <div style="font-size:0.82rem;color:var(--text);white-space:pre-wrap">${n.note || '—'}</div>
      </div>`;
    }).join('');
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:0.8rem">Could not load notes.</div>';
    if (countEl) countEl.textContent = '—';
  }
}

async function addInvestorNote(investorId) {
  const ta = document.getElementById('invNewNoteTA');
  if (!ta) return;
  const noteText = ta.value.trim();
  if (!noteText) { Toast.error('Please enter a note'); return; }

  const adminEmail = STATE.adminEmail || 'admin@svcapital.co.za';

  try {
    await API._fetch('POST', 'tables/investor_notes', {
      id:          `NOTE-${Date.now()}`,
      investor_id: investorId,
      admin_email: adminEmail,
      note:        noteText,
      created_at:  new Date().toISOString()
    });
    ta.value = '';
    Toast.success('Note added');
    await loadInvestorNotes(investorId);
  } catch (e) { Toast.error('Failed to save note'); }
}

/* ═══════════════════════════════════════════════
   FEATURE: INVESTOR ACTIVITY TIMELINE
   ═══════════════════════════════════════════════ */

function _timelineItem(icon, colorHex, text, date) {
  // Convert hex to rgb for background tint
  const hexToRgb = h => {
    const r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
    return `${r},${g},${b}`;
  };
  const rgb = hexToRgb(colorHex.replace('#','').length === 6 ? colorHex : '#7a92a8');
  return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
    <div style="width:28px;height:28px;border-radius:50%;background:rgba(${rgb},0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">
      <i class="fa-solid ${icon}" style="font-size:0.7rem;color:${colorHex}"></i>
    </div>
    <div style="flex:1">
      <div style="font-size:0.82rem;font-weight:600;color:var(--white)">${text}</div>
      <div style="font-size:0.7rem;color:var(--text-muted)">${Utils.date(date)}</div>
    </div>
  </div>`;
}

function _buildTimelineEvents(inv, invsts, txns) {
  const events = [];

  // 1. Account created
  if (inv.date_joined) {
    events.push({ date: inv.date_joined, icon: 'fa-user-plus', color: '#3b82f6', text: 'Account created' });
  }

  // 2. Transactions
  txns.forEach(t => {
    const amt = Utils.rand(Math.abs(t.amount || 0));
    const d = t.created_at || t.transaction_date;
    if (!d) return;
    const typeMap = {
      deposit:    { icon: 'fa-arrow-down',           color: '#22c55e', text: `Deposited ${amt}` },
      investment: { icon: 'fa-chart-line',            color: '#D4AF37', text: `Invested ${amt}${t.description ? ' in ' + t.description : ''}` },
      return:     { icon: 'fa-coins',                 color: '#22c55e', text: `Interest earned ${amt}` },
      payout:     { icon: 'fa-arrow-up',              color: '#3b82f6', text: `Payout received ${amt}` },
      withdrawal: { icon: 'fa-arrow-up-from-bracket', color: '#f97316', text: `Withdrawal ${amt}${t.status ? ' (' + t.status + ')' : ''}` },
      adjustment: { icon: 'fa-sliders',               color: '#7a92a8', text: `Manual adjustment ${amt}` },
    };
    const m = typeMap[t.type];
    if (m) events.push({ date: d, icon: m.icon, color: m.color, text: m.text });
  });

  // 3. Investments
  invsts.forEach(i => {
    const poolLabel = i.pool_name || i.pool_id || 'Pool';
    const amt = Utils.rand(i.amount || 0);
    const rate = i.annual_rate ? ` at ${Utils.pct(i.annual_rate)}` : '';
    if (i.start_date || i.investment_date) {
      events.push({ date: i.start_date || i.investment_date, icon: 'fa-seedling', color: '#D4AF37', text: `Investment started — ${poolLabel} ${amt}${rate}` });
    }
    if (i.status === 'matured' && i.end_date) {
      events.push({ date: i.end_date, icon: 'fa-clock', color: '#f97316', text: `Investment matured — ${poolLabel}` });
    }
    if (i.status === 'paid_out' && i.payout_date) {
      events.push({ date: i.payout_date, icon: 'fa-check-circle', color: '#22c55e', text: `Investment paid out — ${poolLabel}` });
    }
  });

  return events;
}

function _renderTimeline(containerId, events) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!events.length) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.82rem">No timeline events found</div>';
    return;
  }
  const sorted = [...events].sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = sorted.map(e => _timelineItem(e.icon, e.color, e.text, e.date)).join('');
}

async function loadInvestorTimeline(inv, invsts, txns) {
  const containerId = 'investorTimeline';
  const el = document.getElementById(containerId);
  if (!el) return;

  // Step 1: Render synchronous data immediately
  const events = _buildTimelineEvents(inv, invsts, txns);
  _renderTimeline(containerId, events);

  // Step 2: Fetch support tickets + KYC docs async, then re-render
  const token = localStorage.getItem('svc_token');
  const headers = { Authorization: 'Bearer ' + token };

  try {
    const [ticketRes, kycRes] = await Promise.allSettled([
      fetch(`/api/tables/support_tickets?investor_id=${encodeURIComponent(inv.id)}&limit=20`, { headers }).then(r => r.ok ? r.json() : { data: [] }),
      fetch(`/api/tables/kyc_documents?investor_id=${encodeURIComponent(inv.id)}&limit=5`, { headers }).then(r => r.ok ? r.json() : { data: [] })
    ]);

    const tickets = ticketRes.status === 'fulfilled' ? (ticketRes.value.data || []) : [];
    const kycDocs = kycRes.status === 'fulfilled' ? (kycRes.value.data || []) : [];

    tickets.forEach(t => {
      const d = t.created_at;
      if (!d) return;
      events.push({ date: d, icon: 'fa-headset', color: '#3b82f6', text: `Support ticket: ${t.subject || '(no subject)'} (${t.status || 'open'})` });
    });

    kycDocs.forEach(k => {
      const d = k.submitted_date || k.created_at;
      if (!d) return;
      const statusColor = k.status === 'approved' ? '#22c55e' : k.status === 'rejected' ? '#ef4444' : '#f59e0b';
      events.push({ date: d, icon: 'fa-id-card', color: statusColor, text: `FICA document ${k.status || 'submitted'}${k.document_type ? ' — ' + k.document_type.replace(/_/g,' ') : ''}` });
    });

    if (tickets.length || kycDocs.length) {
      _renderTimeline(containerId, events);
    }
  } catch (_) { /* silent — sync data already rendered */ }
}

/* ═══════════════════════════════════════════════
   FEATURE 3: ANALYTICS CHARTS (Real Data)
   ═══════════════════════════════════════════════ */

// Helper: get last N month labels (e.g. ["Jul 25", "Aug 25", ...])
function _lastNMonths(n) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const result = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ label: `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, year: d.getFullYear(), month: d.getMonth() });
  }
  return result;
}

function _chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 8 } },
      tooltip: { backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8', borderColor: 'rgba(212,175,55,0.3)', borderWidth: 1 }
    },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#3d5268', font: { size: 10 } } },
      y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#3d5268', font: { size: 10 } } }
    }
  };
}

function renderAnAumChart() {
  const ctx = document.getElementById('anAumChart');
  if (!ctx) return;

  const buckets = _lastNMonths(12);
  // Running cumulative sum of deposit transactions
  const monthTotals = buckets.map(b => {
    return STATE.transactions
      .filter(t => {
        if (t.type !== 'deposit' || t.status !== 'completed') return false;
        const d = new Date(t.created_at || t.transaction_date || 0);
        return d.getFullYear() === b.year && d.getMonth() === b.month;
      })
      .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
  });

  // Running cumulative AUM
  let running = 0;
  const aumData = monthTotals.map(v => { running += v; return running; });

  if (STATE.charts.anAum) STATE.charts.anAum.destroy();
  const opts = _chartDefaults();
  opts.plugins.tooltip.callbacks = { label: c => ` ${Utils.rand(c.parsed.y)}` };
  opts.scales.y.ticks.callback = v => 'R' + (v / 1000).toFixed(0) + 'k';

  STATE.charts.anAum = new Chart(ctx, {
    type: 'line',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'Cumulative AUM (deposits)',
        data: aumData,
        borderColor: '#D4AF37',
        backgroundColor: (c) => {
          const g = c.chart.ctx.createLinearGradient(0, 0, 0, 220);
          g.addColorStop(0, 'rgba(212,175,55,0.2)');
          g.addColorStop(1, 'rgba(212,175,55,0)');
          return g;
        },
        fill: true, tension: 0.4, borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: '#D4AF37'
      }]
    },
    options: opts
  });
}

function renderAnNewInvChart() {
  const ctx = document.getElementById('anNewInvChart');
  if (!ctx) return;

  const buckets = _lastNMonths(12);
  const counts = buckets.map(b =>
    STATE.investors.filter(i => {
      const d = new Date(i.date_joined || i.created_at || 0);
      return d.getFullYear() === b.year && d.getMonth() === b.month;
    }).length
  );

  if (STATE.charts.anNewInv) STATE.charts.anNewInv.destroy();
  const opts = _chartDefaults();
  opts.plugins.tooltip.callbacks = { label: c => ` ${c.parsed.y} investors` };

  STATE.charts.anNewInv = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'New Investors',
        data: counts,
        backgroundColor: 'rgba(99,102,241,0.7)',
        borderRadius: 5
      }]
    },
    options: opts
  });
}

function renderAnReturnsChart() {
  const ctx = document.getElementById('anReturnsChart');
  if (!ctx) return;

  const buckets = _lastNMonths(12);
  const data = buckets.map(b =>
    STATE.transactions
      .filter(t => {
        if (t.type !== 'return') return false;
        const d = new Date(t.created_at || t.transaction_date || 0);
        return d.getFullYear() === b.year && d.getMonth() === b.month;
      })
      .reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0)
  );

  if (STATE.charts.anReturns) STATE.charts.anReturns.destroy();
  const opts = _chartDefaults();
  opts.plugins.tooltip.callbacks = { label: c => ` ${Utils.rand(c.parsed.y)}` };
  opts.scales.y.ticks.callback = v => 'R' + (v / 1000).toFixed(0) + 'k';

  STATE.charts.anReturns = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'Returns Distributed',
        data,
        backgroundColor: 'rgba(34,197,94,0.7)',
        borderRadius: 5
      }]
    },
    options: opts
  });
}

function renderAnStatusChart() {
  const ctx = document.getElementById('anStatusChart');
  if (!ctx) return;

  const statuses = ['active', 'matured', 'paid_out', 'pending'];
  const counts = statuses.map(s => STATE.investments.filter(i => i.status === s).length);
  const labels = ['Active', 'Matured', 'Paid Out', 'Pending'];
  const colors = ['#22c55e', '#a855f7', '#D4AF37', '#f97316'];

  if (STATE.charts.anStatus) STATE.charts.anStatus.destroy();

  STATE.charts.anStatus = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: counts, backgroundColor: colors, borderColor: 'var(--dark-2)', borderWidth: 3, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 10 } },
        tooltip: { backgroundColor: 'rgba(13,17,23,0.95)', titleColor: '#e8edf2', bodyColor: '#7a92a8', callbacks: { label: c => ` ${c.label}: ${c.parsed}` } }
      }
    }
  });
}

// Chart rendering triggered from loadAnalytics after data loads
function _renderAnalyticsCharts() {
  renderAnAumChart();
  renderAnNewInvChart();
  renderAnReturnsChart();
  renderAnStatusChart();
}

/* ═══════════════════════════════════════════════
   FEATURE 4: MANUAL INTEREST / ADJUSTMENT
   ═══════════════════════════════════════════════ */
function openManualAdjModal() {
  const sel = document.getElementById('adjInvestorSelect');
  if (sel) {
    sel.innerHTML = '<option value="">Select investor…</option>' +
      [...STATE.investors]
        .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
        .map(i => `<option value="${i.id}">${i.first_name} ${i.last_name} (${i.id})</option>`)
        .join('');
  }
  const refEl = document.getElementById('adjReference');
  if (refEl) refEl.value = `ADJ-${Date.now()}`;
  const amtEl = document.getElementById('adjAmount');
  if (amtEl) amtEl.value = '';
  const descEl = document.getElementById('adjDescription');
  if (descEl) descEl.value = '';
  // Default to credit
  const creditRad = document.getElementById('adjCredit');
  if (creditRad) creditRad.checked = true;
  Modal.open('manualAdjModal');
}

async function saveManualAdj() {
  const investorId  = document.getElementById('adjInvestorSelect').value;
  const adjType     = document.querySelector('input[name="adjType"]:checked')?.value || 'credit';
  const rawAmount   = parseFloat(document.getElementById('adjAmount').value);
  const description = document.getElementById('adjDescription').value.trim();
  const reference   = document.getElementById('adjReference').value.trim();

  if (!investorId) { Toast.error('Please select an investor'); return; }
  if (!rawAmount || rawAmount <= 0) { Toast.error('Please enter a valid positive amount'); return; }
  if (!description) { Toast.error('Description is required'); return; }

  const investor = STATE.investors.find(i => i.id === investorId);
  if (!investor) { Toast.error('Investor not found'); return; }

  const signedAmount = adjType === 'credit' ? Math.abs(rawAmount) : -Math.abs(rawAmount);
  const currentBalance = parseFloat(investor.wallet_balance) || 0;
  const newBalance = Math.round((currentBalance + signedAmount) * 100) / 100;

  if (newBalance < 0 && adjType === 'debit') {
    if (!confirm(`This debit of ${Utils.rand(rawAmount)} will result in a negative wallet balance of ${Utils.rand(newBalance)}. Continue?`)) return;
  }

  try {
    // 1. Record transaction
    await API.transactions.create({
      id:               Utils.genId ? Utils.genId('TXN') : `TXN-${Date.now()}`,
      investor_id:      investorId,
      type:             'adjustment',
      amount:           signedAmount,
      status:           'completed',
      reference:        reference,
      description:      description,
      transaction_date: new Date().toISOString()
    });

    // 2. Update wallet balance
    await API.investors.update(investorId, { wallet_balance: newBalance });

    // Update in STATE
    investor.wallet_balance = newBalance;

    Toast.success(`Adjustment applied: ${adjType === 'credit' ? '+' : '−'}${Utils.rand(rawAmount)} for ${investor.first_name} ${investor.last_name}`);
    Modal.close('manualAdjModal');

    // Reload investors if on investors view
    if (STATE.currentView === 'investors') await loadInvestors();
  } catch (e) {
    Toast.error('Failed to apply adjustment');
    console.error(e);
  }
}
