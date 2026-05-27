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
  currentView: 'dashboard',
  charts: {}
};

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
    transactions: 'Transactions', support: 'Support Tickets', analytics: 'Analytics', settings: 'Settings'
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
    settings: loadSettings,
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
        <span style="font-size:0.82rem;font-weight:700;color:var(--white)">${p.pool_name}</span>
        <span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span>
      </div>
      <div class="pool-card__progress-label">
        <span>${Utils.rand(p.raised_amount)} raised</span>
        <span>${pct}% of ${Utils.rand(p.target_amount)}</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${p.investor_count} investors · Closes ${Utils.date(p.close_date)}</div>
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
        ${inv.notes ? `<div class="panel mt-12" style="background:var(--dark-3)"><div class="panel__header"><span class="panel__title">Admin Notes</span></div><div class="panel__body" style="font-size:0.82rem;color:var(--text-muted)">${inv.notes}</div></div>` : ''}
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
          <td class="td-green">${Utils.pct(i.expected_return_rate)}</td>
          <td>${Utils.statusBadge(i.status)}</td>
          <td class="td-muted">${Utils.date(i.maturity_date)}</td>
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
          <td class="td-muted">${Utils.date(t.transaction_date)}</td>
        </tr>
      `).join('')}</tbody>
    </table>

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
}

async function depositToInvestor(investorId, investorName, currentBalance) {
  const amtStr = prompt(`Add funds to ${investorName}'s wallet.\nCurrent balance: ${Utils.rand(currentBalance)}\n\nEnter amount (R):`);
  if (!amtStr) return;
  const amount = parseFloat(amtStr);
  if (!amount || amount <= 0) { Toast.error('Invalid amount'); return; }
  try {
    await API.investors.update(investorId, { wallet_balance: currentBalance + amount });
    await API.transactions.create({
      id: Utils.genId('TXN'),
      investor_id: investorId,
      investor_name: investorName,
      type: 'deposit',
      amount,
      status: 'completed',
      reference: `ADMIN-DEP-${Date.now()}`,
      description: `Admin deposit — wallet top-up`,
      transaction_date: new Date().toISOString()
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

  body.innerHTML = items.map(k => `
    <tr>
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
  `).join('');
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
    const statusColors = { open: 'green', filling: 'blue', active: 'gold', matured: 'purple', paid_out: 'gray', closed: 'gray' };
    return `
      <div class="pool-card">
        <div class="pool-card__header">
          <div>
            <div class="pool-card__name">${p.pool_name}</div>
            <div class="pool-card__partner">${p.partner_name}</div>
          </div>
          <div class="flex-center gap-8">
            <span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span>
            ${Utils.statusBadge(p.status)}
          </div>
        </div>

        <div class="pool-card__stats">
          <div class="pool-stat"><span class="pool-stat__label">Rate</span><span class="pool-stat__value pool-stat__value--gold">${Utils.pct(p.benchmark_rate)}</span></div>
          <div class="pool-stat"><span class="pool-stat__label">Investors</span><span class="pool-stat__value">${p.investor_count}</span></div>
          <div class="pool-stat"><span class="pool-stat__label">Term</span><span class="pool-stat__value">${p.term_months}mo</span></div>
        </div>

        <div class="pool-card__progress-label">
          <span>${Utils.rand(p.raised_amount)} raised</span>
          <span>${pct}% funded</span>
        </div>
        <div class="progress-bar"><div class="progress-fill${p.product_type.includes('solar') ? ' progress-fill--green' : p.product_type === 'short_term' ? ' progress-fill--blue' : ''}" style="width:${pct}%"></div></div>

        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:8px;display:flex;justify-content:space-between">
          <span>Opens: ${Utils.date(p.open_date)}</span>
          <span>Matures: ${Utils.date(p.maturity_date)}</span>
        </div>

        <div class="pool-card__actions">
          <button class="btn btn--secondary btn--sm flex-1" onclick='editPool(${JSON.stringify(p.id)})'><i class="fa-solid fa-pen"></i> Edit</button>
          ${p.status === 'open' ? `<button class="btn btn--primary btn--sm" onclick='closePool(${JSON.stringify(p.id)})'><i class="fa-solid fa-lock"></i> Close</button>` : ''}
          ${p.status === 'matured' ? `<button class="btn btn--success btn--sm" onclick='markPaidOut(${JSON.stringify(p.id)})'><i class="fa-solid fa-check"></i> Mark Paid Out</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function openAddPoolModal() { Modal.open('addPoolModal'); }

async function saveNewPool() {
  const name = document.getElementById('newPoolName').value.trim();
  const type = document.getElementById('newPoolType').value;
  const target = parseFloat(document.getElementById('newPoolTarget').value);
  if (!name || !target) { Toast.error('Pool name and target amount required'); return; }
  try {
    await API.pools.create({
      id: `POOL-${type.toUpperCase().slice(0,3)}-${Date.now()}`,
      pool_name: name, product_type: type,
      target_amount: target, raised_amount: 0,
      min_investment: parseFloat(document.getElementById('newPoolMin').value) || 500,
      term_months: parseInt(document.getElementById('newPoolTerm').value) || 12,
      benchmark_rate: parseFloat(document.getElementById('newPoolRate').value) || 0.13,
      partner_name: document.getElementById('newPoolPartner').value.trim(),
      open_date: document.getElementById('newPoolOpenDate').value ? new Date(document.getElementById('newPoolOpenDate').value).toISOString() : new Date().toISOString(),
      close_date: document.getElementById('newPoolCloseDate').value ? new Date(document.getElementById('newPoolCloseDate').value).toISOString() : '',
      status: 'open', investor_count: 0, actual_rate: 0,
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
  document.getElementById('editPoolName').value        = pool.pool_name || '';
  document.getElementById('editPoolStatus').value      = pool.status || 'open';
  document.getElementById('editPoolType').value        = pool.product_type || 'cattle';
  document.getElementById('editPoolTerm').value        = pool.term_months || 12;
  document.getElementById('editPoolTarget').value      = pool.target_amount || 0;
  document.getElementById('editPoolRaised').value      = pool.raised_amount || 0;
  document.getElementById('editPoolMin').value         = pool.min_investment || 500;
  document.getElementById('editPoolRate').value        = pool.benchmark_rate || 0;
  document.getElementById('editPoolActualRate').value  = pool.actual_rate || 0;
  document.getElementById('editPoolPartner').value     = pool.partner_name || '';
  document.getElementById('editPoolInvCount').value    = pool.investor_count || 0;
  // Convert ISO dates to YYYY-MM-DD for date inputs
  const toDateVal = iso => { try { return iso ? new Date(iso).toISOString().split('T')[0] : ''; } catch { return ''; } };
  document.getElementById('editPoolOpenDate').value    = toDateVal(pool.open_date);
  document.getElementById('editPoolCloseDate').value   = toDateVal(pool.maturity_date || pool.close_date);

  Modal.open('editPoolModal');
}

async function saveEditPool() {
  const id = document.getElementById('editPoolId').value;
  if (!id) return;

  const toISO = val => { try { return val ? new Date(val).toISOString() : ''; } catch { return ''; } };

  const updates = {
    pool_name:      document.getElementById('editPoolName').value.trim(),
    status:         document.getElementById('editPoolStatus').value,
    product_type:   document.getElementById('editPoolType').value,
    term_months:    parseInt(document.getElementById('editPoolTerm').value) || 12,
    target_amount:  parseFloat(document.getElementById('editPoolTarget').value) || 0,
    raised_amount:  parseFloat(document.getElementById('editPoolRaised').value) || 0,
    min_investment: parseFloat(document.getElementById('editPoolMin').value) || 500,
    benchmark_rate: parseFloat(document.getElementById('editPoolRate').value) || 0,
    actual_rate:    parseFloat(document.getElementById('editPoolActualRate').value) || 0,
    partner_name:   document.getElementById('editPoolPartner').value.trim(),
    investor_count: parseInt(document.getElementById('editPoolInvCount').value) || 0,
    open_date:      toISO(document.getElementById('editPoolOpenDate').value),
    maturity_date:  toISO(document.getElementById('editPoolCloseDate').value),
    close_date:     toISO(document.getElementById('editPoolCloseDate').value),
  };

  if (!updates.pool_name) { Toast.error('Pool name is required'); return; }

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
      <td class="td-green">${Utils.rand(i.expected_return_amount)}</td>
      <td>${Utils.statusBadge(i.status)}</td>
      <td class="td-muted">${Utils.date(i.maturity_date)}</td>
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
      <div class="info-row"><span class="info-row__label">Expected Return</span><span class="info-row__value td-green">${Utils.rand(inv.expected_return_amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Return Rate</span><span class="info-row__value">${Utils.pct(inv.expected_return_rate)} p.a.</span></div>
      <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value">${Utils.statusBadge(inv.status)}</span></div>
      <div class="info-row"><span class="info-row__label">Investment Date</span><span class="info-row__value td-muted">${Utils.date(inv.investment_date)}</span></div>
      <div class="info-row"><span class="info-row__label">Maturity Date</span><span class="info-row__value td-muted">${Utils.date(inv.maturity_date)}</span></div>
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
  const actualRate = prompt(`Enter actual return rate achieved (e.g. 0.1561 for 15.61%):`, inv.expected_return_rate);
  if (!actualRate) return;
  const rate = parseFloat(actualRate);
  const actualReturn = Math.round(inv.amount * rate * ((new Date(inv.maturity_date) - new Date(inv.investment_date)) / (365 * 86400000)));

  try {
    await API.investments.update(id, {
      status: 'paid_out',
      actual_return_amount: actualReturn,
      payout_date: new Date().toISOString()
    });
    await API.transactions.create({
      id: Utils.genId('TXN'),
      investor_id: inv.investor_id || '',
      investor_name: inv.investor_name,
      type: 'payout',
      amount: inv.amount + actualReturn,
      status: 'completed',
      reference: `PAYOUT-${Date.now()}`,
      description: `Maturity payout for ${inv.pool_name}`,
      pool_name: inv.pool_name,
      transaction_date: new Date().toISOString()
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
    const res = await API.transactions.list({ limit: 200 });
    STATE.transactions = res.data || [];
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

function renderTxnTable() {
  const body = document.getElementById('txnBody');
  const start = (txnPage - 1) * TXN_PG_SIZE;
  const page = filteredTxns.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)).slice(start, start + TXN_PG_SIZE);

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

    // Show EFT proof attachment if present
    const proofLink = (t.proof_attached && t.proof_filename)
      ? `<a href="#" onclick="viewEftProof('${t.id}')" style="display:inline-flex;align-items:center;gap:4px;font-size:0.7rem;color:#FF8215;font-weight:600;margin-top:2px"><i class="fa-solid fa-paperclip"></i> ${t.proof_filename}</a>`
      : '';

    return `<tr>
      <td><div class="td-strong">${t.investor_name}</div></td>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${t.type?.replace(/_/g, ' ') || '—'}</span></td>
      <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
      <td>${statusCell}</td>
      <td class="td-muted" style="font-size:0.75rem">${t.reference || '—'}</td>
      <td class="td-muted" style="font-size:0.75rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.description || '—'}${proofLink}</td>
      <td class="td-muted">${Utils.date(t.transaction_date)}</td>
      <td>
        ${isPendingDeposit ? `<button class="btn btn--success btn--sm" onclick="changeTxnStatus('${t.id}', 'completed', '${t.investor_id}', ${t.amount})" title="Approve deposit"><i class="fa-solid fa-check"></i></button>` : ''}
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
      const mq = !q || `${t.investor_name} ${t.reference}`.toLowerCase().includes(q);
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

function openAddTxnModal() { Modal.open('addTxnModal'); }

async function saveNewTxn() {
  const name = document.getElementById('txnInvestorName').value.trim();
  const amount = parseFloat(document.getElementById('txnAmount').value);
  const type = document.getElementById('txnType').value;
  if (!name || !amount) { Toast.error('Investor name and amount required'); return; }

  try {
    await API.transactions.create({
      id: Utils.genId('TXN'),
      investor_name: name, investor_id: '',
      type, amount: type === 'investment' || type === 'withdrawal' ? -Math.abs(amount) : Math.abs(amount),
      status: document.getElementById('txnStatus').value,
      reference: document.getElementById('txnRef').value.trim(),
      description: document.getElementById('txnDesc').value.trim(),
      transaction_date: new Date().toISOString()
    });
    Toast.success('Transaction recorded');
    Modal.close('addTxnModal');
    await loadTransactions();
  } catch (e) { Toast.error('Failed to record transaction'); }
}

/* ═══════════════════════════════════════════════
   SUPPORT TICKETS
   ═══════════════════════════════════════════════ */
async function loadSupport() {
  try {
    const res = await API.tickets.list({ limit: 100 });
    STATE.tickets = res.data || [];
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

  body.innerHTML = items.map(t => `<tr>
    <td><div class="td-strong">${t.investor_name}</div><div class="td-muted">${t.investor_email}</div></td>
    <td class="td-strong" style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.subject}</td>
    <td><span class="badge badge--gray">${t.category?.replace(/_/g, ' ') || '—'}</span></td>
    <td>${Utils.priorityBadge(t.priority)}</td>
    <td>${Utils.statusBadge(t.status)}</td>
    <td class="td-muted">${t.assigned_to || '—'}</td>
    <td class="td-muted">${Utils.date(t.created_date)}</td>
    <td>
      <button class="btn btn--secondary btn--sm" onclick='viewTicket(${JSON.stringify(t.id)})'><i class="fa-solid fa-eye"></i> View</button>
    </td>
  </tr>`).join('');
}

function setupTicketFilters() {
  document.getElementById('ticketStatusFilter').addEventListener('change', renderTicketsTable);
  document.getElementById('ticketPriorityFilter').addEventListener('change', renderTicketsTable);
}

async function viewTicket(id) {
  const tkt = STATE.tickets.find(t => t.id === id);
  if (!tkt) return;

  document.getElementById('ticketModalTitle').textContent = `Ticket #${tkt.id} — ${tkt.subject}`;
  document.getElementById('ticketModalBody').innerHTML = `
    <div class="grid-2 mb-16" style="gap:12px">
      <div class="info-row"><span class="info-row__label">Investor</span><span class="info-row__value">${tkt.investor_name}</span></div>
      <div class="info-row"><span class="info-row__label">Category</span><span class="info-row__value">${tkt.category?.replace(/_/g, ' ')}</span></div>
      <div class="info-row"><span class="info-row__label">Priority</span><span class="info-row__value">${Utils.priorityBadge(tkt.priority)}</span></div>
      <div class="info-row"><span class="info-row__label">Status</span><span class="info-row__value">${Utils.statusBadge(tkt.status)}</span></div>
    </div>
    <div class="panel mb-12" style="background:var(--dark-3)">
      <div class="panel__header"><span class="panel__title">Investor Message</span></div>
      <div class="panel__body" style="font-size:0.85rem;color:var(--text-muted)">${tkt.message || '—'}</div>
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
      await API.tickets.update(id, {
        admin_response: document.getElementById('ticketResponse').value,
        status: document.getElementById('ticketStatusUpdate').value,
        assigned_to: document.getElementById('ticketAssigned').value,
        resolved_date: ['resolved', 'closed'].includes(document.getElementById('ticketStatusUpdate').value) ? new Date().toISOString() : ''
      });
      Toast.success('Ticket updated');
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
