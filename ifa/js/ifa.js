/* ═══════════════════════════════════════════════
   SV CAPITAL — IFA Partner Portal JS
   ═══════════════════════════════════════════════ */
'use strict';

/* ─── Session — uses shared Auth object from ../js/api.js ─── */
let IFA_SESSION = null;

function getSession() {
  // First try the new JWT-based auth
  const user = Auth.getUser();
  if (user && (user.role === 'ifa') && user.ifaId) {
    return { ifaId: user.ifaId, name: `${user.firstName || ''} ${user.lastName || ''}`.trim(), company: '' };
  }
  // Fall back to legacy IFA session storage
  try {
    const raw = localStorage.getItem('svc_ifa_session') || sessionStorage.getItem('svc_ifa_session');
    return raw ? JSON.parse(raw) : null;
  } catch(_) { return null; }
}

function requireAuth() {
  // Check JWT-based login first
  if (Auth.isLoggedIn()) {
    const user = Auth.getUser();
    if (user && (user.role === 'ifa' || user.role === 'admin' || user.role === 'director')) {
      IFA_SESSION = {
        ifaId:   user.ifaId || user.investorId || 'IFA-001',
        name:    `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        company: '',
        email:   user.email,
      };
      return true;
    }
  }
  IFA_SESSION = getSession();
  if (!IFA_SESSION) {
    window.location.href = 'login.html';
    return false;
  }
  return true;
}

function signOut() {
  Auth.logout('/login.html');
  localStorage.removeItem('svc_ifa_session');
  sessionStorage.removeItem('svc_ifa_session');
}

/* ─── State ─── */
let STATE = {
  ifa: null,
  clients: [],
  investments: [],
  transactions: [],
  tickets: [],
  pools: [],
  currentView: 'dashboard',
  charts: {}
};

/* ─── Toast, Modal, Utils all come from ../js/api.js — no re-declaration needed ─── */

/* ─── Navigation ─── */
function navigate(view, btnEl) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  const titles = {
    dashboard:    'Dashboard',
    clients:      'My Clients',
    investments:  'Client Investments',
    transactions: 'Transactions',
    support:      'Support Tickets',
    profile:      'My Profile'
  };

  const el = document.getElementById('topbarTitle');
  if (el) el.textContent = titles[view] || view;
  STATE.currentView = view;

  const loaders = {
    dashboard:    loadDashboard,
    clients:      loadClients,
    investments:  loadInvestments,
    transactions: loadTransactions,
    support:      loadSupport,
    profile:      loadProfile
  };
  if (loaders[view]) loaders[view]();
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;

  // Populate identity in sidebar
  document.getElementById('identityName').textContent = IFA_SESSION.name;
  document.getElementById('identityCompany').textContent = IFA_SESSION.company || 'IFA Partner';
  document.getElementById('identityAvatar').textContent = Utils.initials(IFA_SESSION.name);
  document.getElementById('topbarIFAName').textContent = IFA_SESSION.name;

  await loadDashboard();
});

/* ═══════════════════════════════════════════════
   DATA LOADERS — shared fetch helpers
═══════════════════════════════════════════════ */
async function fetchIFA() {
  return await API.ifas.get(IFA_SESSION.ifaId);
}

async function fetchClients(clientIds) {
  if (!clientIds.length) return [];
  const data = await API.investors.list({ limit: 200 });
  return (data.data || []).filter(inv => clientIds.includes(inv.id));
}

async function fetchInvestments(clientIds) {
  if (!clientIds.length) return [];
  const data = await API.investments.list({ limit: 500 });
  return (data.data || []).filter(inv => clientIds.includes(inv.investor_id));
}

async function fetchTransactions(clientIds) {
  if (!clientIds.length) return [];
  const data = await API.transactions.list({ limit: 500 });
  return (data.data || []).filter(t => clientIds.includes(t.investor_id));
}

async function fetchTickets(clientIds) {
  if (!clientIds.length) return [];
  const data = await API.tickets.list({ limit: 200 });
  return (data.data || []).filter(t => clientIds.includes(t.investor_id));
}

async function fetchPools() {
  const data = await API.pools.list({ limit: 100 });
  return data.data || [];
}

/* ═══════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    setDashboardLoading(true);

    STATE.ifa = await fetchIFA();
    const clientIds = STATE.ifa.assigned_clients || [];

    const [clients, investments, transactions, tickets, pools] = await Promise.all([
      fetchClients(clientIds),
      fetchInvestments(clientIds),
      fetchTransactions(clientIds),
      fetchTickets(clientIds),
      fetchPools()
    ]);

    STATE.clients      = clients;
    STATE.investments  = investments;
    STATE.transactions = transactions;
    STATE.tickets      = tickets;
    STATE.pools        = pools;

    renderDashboardStats();
    renderRecentClientsWidget();
    renderActiveInvestmentsWidget();
    renderPendingActionsWidget();
    renderPortfolioChart();

    setDashboardLoading(false);
  } catch(e) {
    console.error('Dashboard load error:', e);
    Toast.error('Failed to load dashboard data');
    setDashboardLoading(false);
  }
}

function setDashboardLoading(on) {
  ['ds-clients','ds-aum','ds-returns','ds-commission'].forEach(id => {
    const el = document.getElementById(id);
    if (el && on) el.textContent = '...';
  });
}

function renderDashboardStats() {
  const clients    = STATE.clients;
  const invests    = STATE.investments;
  const totalAUM   = clients.reduce((s, c) => s + (c.total_invested || 0), 0);
  const totalRet   = clients.reduce((s, c) => s + (c.total_returns  || 0), 0);
  const commRate   = STATE.ifa.commission_rate || 0;
  const commission = totalAUM * (commRate / 100);

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('ds-clients',    clients.length);
  set('ds-aum',        Utils.rand(totalAUM));
  set('ds-returns',    Utils.rand(totalRet));
  set('ds-commission', Utils.rand(commission));

  // Active investments badge
  const activeInvests = invests.filter(i => i.status === 'active').length;
  const badge = document.getElementById('ds-active-badge');
  if (badge) badge.textContent = `${activeInvests} active`;
}

function renderRecentClientsWidget() {
  const el = document.getElementById('recentClientsWidget');
  if (!el) return;
  const recent = STATE.clients.slice(0, 5);
  if (!recent.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-users"></i><p>No clients linked yet</p></div>`;
    return;
  }
  el.innerHTML = recent.map(c => `
    <div class="flex-center gap-10" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div class="avatar avatar--md ${c.total_invested > 100000 ? 'avatar--gold' : 'avatar--teal'}">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.84rem;font-weight:600;color:var(--text-h)">${c.first_name} ${c.last_name}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">${c.email}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:0.82rem;font-weight:700;color:var(--gold)">${Utils.rand(c.total_invested)}</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">invested</div>
      </div>
      <button class="btn btn--sm btn--secondary" onclick="viewClientDetail('${c.id}')"><i class="fa-solid fa-eye"></i></button>
    </div>
  `).join('').replace(/border-bottom[^"]+/, s => recent.indexOf(recent[recent.length-1]) === recent.length-1 ? '' : s);
}

function renderActiveInvestmentsWidget() {
  const el = document.getElementById('activeInvestmentsWidget');
  if (!el) return;
  const active = STATE.investments.filter(i => i.status === 'active').slice(0, 5);
  if (!active.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-chart-line"></i><p>No active investments</p></div>`;
    return;
  }
  el.innerHTML = `<div style="overflow-x:auto">
    <table class="data-table">
      <thead><tr><th>Client</th><th>Pool</th><th>Amount</th><th>Return</th><th>Maturity</th></tr></thead>
      <tbody>
        ${active.map(inv => {
          const client = STATE.clients.find(c => c.id === inv.investor_id);
          return `<tr>
            <td class="td-strong">${client ? client.first_name + ' ' + client.last_name : inv.investor_name || '—'}</td>
            <td class="td-muted" style="font-size:0.78rem">${inv.pool_name || '—'}</td>
            <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
            <td class="td-green">${Utils.pct(inv.expected_return_rate)}</td>
            <td class="td-muted">${Utils.date(inv.maturity_date)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

function renderPendingActionsWidget() {
  const el = document.getElementById('pendingActionsWidget');
  if (!el) return;

  const pendingFica  = STATE.clients.filter(c => c.status === 'pending_fica' || c.fica_status === 'pending').length;
  const openTickets  = STATE.tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length;
  const maturingSoon = STATE.investments.filter(i => {
    if (!i.maturity_date) return false;
    const daysLeft = (new Date(i.maturity_date) - Date.now()) / (1000 * 60 * 60 * 24);
    return daysLeft > 0 && daysLeft <= 30;
  }).length;

  const actions = [
    { icon: 'fa-id-card', color: '#f97316', label: 'Clients pending FICA',   count: pendingFica,  view: 'clients' },
    { icon: 'fa-headset', color: '#3b82f6', label: 'Open support tickets',   count: openTickets,  view: 'support' },
    { icon: 'fa-hourglass-end', color: '#a855f7', label: 'Investments maturing in 30 days', count: maturingSoon, view: 'investments' }
  ].filter(a => a.count > 0);

  if (!actions.length) {
    el.innerHTML = `<div class="empty-state" style="padding:24px"><i class="fa-solid fa-circle-check" style="color:var(--green);opacity:0.5"></i><p>No pending actions — all clear!</p></div>`;
    return;
  }

  el.innerHTML = actions.map(a => `
    <div class="flex-between gap-10" style="padding:11px 0;border-bottom:1px solid var(--border);cursor:pointer"
         onclick="navigate('${a.view}', document.querySelector('[data-view=${a.view}]'))">
      <div class="flex-center gap-10">
        <div style="width:34px;height:34px;border-radius:9px;background:${a.color}18;display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid ${a.icon}" style="color:${a.color};font-size:0.82rem"></i>
        </div>
        <span style="font-size:0.82rem;color:var(--text-body)">${a.label}</span>
      </div>
      <span style="font-size:0.9rem;font-weight:800;color:${a.color}">${a.count}</span>
    </div>
  `).join('');
}

function renderPortfolioChart() {
  const ctx = document.getElementById('portfolioChart');
  if (!ctx) return;

  // Group AUM by client
  const labels = STATE.clients.slice(0, 8).map(c => c.first_name + ' ' + c.last_name.slice(0,1) + '.');
  const data   = STATE.clients.slice(0, 8).map(c => c.total_invested || 0);
  const colors = ['#2F8C9B','#D4AF37','#22c55e','#f97316','#a855f7','#3b82f6','#ef4444','#06b6d4'];

  if (STATE.charts.portfolio) STATE.charts.portfolio.destroy();
  if (!labels.length) return;

  STATE.charts.portfolio = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderColor: '#fff', borderWidth: 3, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { position: 'right', labels: { color: '#6b7280', font: { size: 11 }, boxWidth: 10, padding: 10 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${Utils.rand(ctx.parsed)}`
          }
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   CLIENTS VIEW
═══════════════════════════════════════════════ */
async function loadClients() {
  try {
    if (!STATE.clients.length) await loadDashboard();
    renderClientStats();
    renderClientsTable();
    setupClientSearch();
  } catch(e) {
    Toast.error('Failed to load clients');
  }
}

function renderClientStats() {
  const c = STATE.clients;
  const active  = c.filter(x => x.status === 'active').length;
  const pending = c.filter(x => x.status === 'pending_fica' || x.fica_status === 'pending').length;
  const totalW  = c.reduce((s, x) => s + (x.wallet_balance || 0), 0);
  const totalI  = c.reduce((s, x) => s + (x.total_invested || 0), 0);

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('cl-total',   c.length);
  set('cl-active',  active);
  set('cl-pending', pending);
  set('cl-aum',     Utils.rand(totalI));
}

function renderClientsTable(searchQ = '', filterStatus = '') {
  const tbody = document.getElementById('clientsBody');
  if (!tbody) return;

  let data = STATE.clients.slice();
  if (filterStatus) data = data.filter(c => c.status === filterStatus || c.fica_status === filterStatus);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    data = data.filter(c =>
      (c.first_name || '').toLowerCase().includes(q) ||
      (c.last_name  || '').toLowerCase().includes(q) ||
      (c.email      || '').toLowerCase().includes(q)
    );
  }

  const footer = document.getElementById('clientsFooter');
  if (footer) footer.textContent = `Showing ${data.length} of ${STATE.clients.length} clients`;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fa-solid fa-users"></i><p>No clients found</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(c => {
    const clientInvests = STATE.investments.filter(i => i.investor_id === c.id);
    const activeCount   = clientInvests.filter(i => i.status === 'active').length;
    return `<tr>
      <td>
        <div class="flex-center gap-10">
          <div class="avatar avatar--sm avatar--teal">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
          <div>
            <div class="td-strong">${c.first_name} ${c.last_name}</div>
            <div style="font-size:0.7rem;color:var(--text-muted)">${c.email}</div>
          </div>
        </div>
      </td>
      <td class="td-muted">${c.phone || '—'}</td>
      <td>${Utils.statusBadge(c.fica_status || c.status)}</td>
      <td class="td-gold fw-700">${Utils.rand(c.wallet_balance)}</td>
      <td class="td-teal fw-700">${Utils.rand(c.total_invested)}</td>
      <td>
        <span class="badge badge--teal">${activeCount} active</span>
      </td>
      <td>
        <div class="flex-center gap-6">
          <button class="btn btn--sm btn--secondary" onclick="viewClientDetail('${c.id}')">
            <i class="fa-solid fa-eye"></i> View
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function setupClientSearch() {
  const searchEl = document.getElementById('clientSearch');
  const filterEl = document.getElementById('clientStatusFilter');
  const refresh  = () => renderClientsTable(searchEl?.value.trim() || '', filterEl?.value || '');

  if (searchEl && !searchEl._wired) {
    searchEl.addEventListener('input', () => setTimeout(refresh, 180));
    searchEl._wired = true;
  }
  if (filterEl && !filterEl._wired) {
    filterEl.addEventListener('change', refresh);
    filterEl._wired = true;
  }
}

function viewClientDetail(clientId) {
  const c = STATE.clients.find(x => x.id === clientId);
  if (!c) return;

  const clientInvests = STATE.investments.filter(i => i.investor_id === clientId);
  const clientTxns    = STATE.transactions.filter(t => t.investor_id === clientId).slice(0, 8);

  document.getElementById('clientDetailTitle').textContent = `${c.first_name} ${c.last_name}`;
  document.getElementById('clientDetailBody').innerHTML = `
    <div class="grid-2 mb-16">
      <div>
        <div class="flex-center gap-12 mb-16">
          <div class="avatar avatar--lg avatar--teal">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
          <div>
            <div style="font-size:1.05rem;font-weight:800;color:var(--text-h)">${c.first_name} ${c.last_name}</div>
            <div style="color:var(--text-muted);font-size:0.8rem">${c.email}</div>
            <div class="mt-12">${Utils.statusBadge(c.status)}</div>
          </div>
        </div>
        <div class="info-list">
          <div class="info-row"><span class="info-row__label">Phone</span><span class="info-row__value">${c.phone || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">ID Number</span><span class="info-row__value">${c.id_number || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Location</span><span class="info-row__value">${[c.city, c.province].filter(Boolean).join(', ') || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">Risk Profile</span><span class="info-row__value">${c.risk_profile || '—'}</span></div>
          <div class="info-row"><span class="info-row__label">FICA Status</span><span class="info-row__value">${Utils.statusBadge(c.fica_status || 'pending')}</span></div>
          <div class="info-row"><span class="info-row__label">Joined</span><span class="info-row__value">${Utils.date(c.date_joined)}</span></div>
        </div>
      </div>
      <div>
        <div style="background:#f8fafc;border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px">
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">Financial Summary</div>
          <div class="info-list">
            <div class="info-row"><span class="info-row__label">Wallet Balance</span><span class="info-row__value td-teal">${Utils.rand(c.wallet_balance)}</span></div>
            <div class="info-row"><span class="info-row__label">Total Invested</span><span class="info-row__value td-gold">${Utils.rand(c.total_invested)}</span></div>
            <div class="info-row"><span class="info-row__label">Total Returns</span><span class="info-row__value td-green">${Utils.rand(c.total_returns)}</span></div>
            <div class="info-row"><span class="info-row__label">Effective Return</span><span class="info-row__value td-green">${c.total_invested ? Utils.pct(c.total_returns / c.total_invested) : '—'}</span></div>
            <div class="info-row"><span class="info-row__label">Active Investments</span><span class="info-row__value">${clientInvests.filter(i => i.status === 'active').length}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div style="font-size:0.84rem;font-weight:700;color:var(--text-h);margin-bottom:10px">
      Investments (${clientInvests.length})
    </div>
    ${clientInvests.length
      ? `<table class="data-table mb-16">
          <thead><tr><th>Pool</th><th>Amount</th><th>Return Rate</th><th>Status</th><th>Maturity</th></tr></thead>
          <tbody>${clientInvests.map(i => `<tr>
            <td class="td-strong">${i.pool_name || '—'}</td>
            <td class="td-gold fw-700">${Utils.rand(i.amount)}</td>
            <td class="td-green">${Utils.pct(i.expected_return_rate)}</td>
            <td>${Utils.statusBadge(i.status)}</td>
            <td class="td-muted">${Utils.date(i.maturity_date)}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-chart-line"></i><p>No investments yet</p></div>`
    }

    <div style="font-size:0.84rem;font-weight:700;color:var(--text-h);margin:16px 0 10px">
      Recent Transactions (${clientTxns.length})
    </div>
    ${clientTxns.length
      ? `<table class="data-table">
          <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${clientTxns.map(t => `<tr>
            <td>${Utils.statusBadge(t.type)}</td>
            <td class="${t.amount > 0 ? 'td-green' : 'td-teal'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
            <td>${Utils.statusBadge(t.status)}</td>
            <td class="td-muted">${Utils.date(t.transaction_date)}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-arrows-rotate"></i><p>No transactions yet</p></div>`
    }
  `;

  Modal.open('clientDetailModal');
}

/* ═══════════════════════════════════════════════
   INVESTMENTS VIEW
═══════════════════════════════════════════════ */
async function loadInvestments() {
  try {
    if (!STATE.investments.length) await loadDashboard();
    renderInvestmentStats();
    renderInvestmentsTable();
    setupInvestmentSearch();
  } catch(e) {
    Toast.error('Failed to load investments');
  }
}

function renderInvestmentStats() {
  const inv = STATE.investments;
  const active  = inv.filter(i => i.status === 'active');
  const totalAmt = active.reduce((s, i) => s + (i.amount || 0), 0);
  const totalRet = active.reduce((s, i) => s + ((i.amount || 0) * (i.expected_return_rate || 0)), 0);

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('inv-total',   inv.length);
  set('inv-active',  active.length);
  set('inv-amount',  Utils.rand(totalAmt));
  set('inv-returns', Utils.rand(totalRet));
}

function renderInvestmentsTable(searchQ = '', filterStatus = '') {
  const tbody = document.getElementById('investmentsBody');
  if (!tbody) return;

  let data = STATE.investments.slice();
  if (filterStatus) data = data.filter(i => i.status === filterStatus);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    data = data.filter(i =>
      (i.pool_name || '').toLowerCase().includes(q) ||
      (i.investor_name || '').toLowerCase().includes(q)
    );
  }

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fa-solid fa-chart-line"></i><p>No investments found</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(inv => {
    const client = STATE.clients.find(c => c.id === inv.investor_id);
    return `<tr>
      <td>
        <div class="flex-center gap-8">
          <div class="avatar avatar--sm">${Utils.initials(client ? client.first_name + ' ' + client.last_name : inv.investor_name || '?')}</div>
          <span class="td-strong">${client ? client.first_name + ' ' + client.last_name : inv.investor_name || '—'}</span>
        </div>
      </td>
      <td class="td-strong">${inv.pool_name || '—'}</td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td class="td-green">${Utils.pct(inv.expected_return_rate)}</td>
      <td class="td-green">${Utils.rand((inv.amount || 0) * (inv.expected_return_rate || 0))}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
      <td class="td-muted">${Utils.date(inv.maturity_date)}</td>
    </tr>`;
  }).join('');
}

function setupInvestmentSearch() {
  const searchEl = document.getElementById('investmentSearch');
  const filterEl = document.getElementById('investmentStatusFilter');
  const refresh  = () => renderInvestmentsTable(searchEl?.value.trim() || '', filterEl?.value || '');

  if (searchEl && !searchEl._wired) {
    searchEl.addEventListener('input', () => setTimeout(refresh, 180));
    searchEl._wired = true;
  }
  if (filterEl && !filterEl._wired) {
    filterEl.addEventListener('change', refresh);
    filterEl._wired = true;
  }
}

/* ═══════════════════════════════════════════════
   TRANSACTIONS VIEW
═══════════════════════════════════════════════ */
async function loadTransactions() {
  try {
    if (!STATE.transactions.length) await loadDashboard();
    renderTransactionsTable();
    setupTxnSearch();
  } catch(e) {
    Toast.error('Failed to load transactions');
  }
}

function renderTransactionsTable(searchQ = '', filterType = '') {
  const tbody = document.getElementById('txnBody');
  if (!tbody) return;

  let data = STATE.transactions.slice().sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));
  if (filterType) data = data.filter(t => t.type === filterType);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    data = data.filter(t =>
      (t.investor_name || '').toLowerCase().includes(q) ||
      (t.reference || '').toLowerCase().includes(q) ||
      (t.description || '').toLowerCase().includes(q)
    );
  }

  // Stats
  const totalDeposits = STATE.transactions.filter(t => t.type === 'deposit' && t.status === 'completed').reduce((s,t) => s + (t.amount || 0), 0);
  const totalReturns  = STATE.transactions.filter(t => t.type === 'return' && t.status === 'completed').reduce((s,t) => s + (t.amount || 0), 0);
  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('txn-count',    STATE.transactions.length);
  set('txn-deposits', Utils.rand(totalDeposits));
  set('txn-returns',  Utils.rand(totalReturns));

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-arrows-rotate"></i><p>No transactions found</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(t => {
    const client = STATE.clients.find(c => c.id === t.investor_id);
    return `<tr>
      <td>
        <div class="flex-center gap-8">
          <div class="avatar avatar--sm">${Utils.initials(client ? client.first_name + ' ' + client.last_name : t.investor_name || '?')}</div>
          <span class="td-strong">${client ? client.first_name + ' ' + client.last_name : t.investor_name || '—'}</span>
        </div>
      </td>
      <td>${Utils.statusBadge(t.type)}</td>
      <td class="${t.amount > 0 ? 'td-green' : 'td-teal'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted" style="font-size:0.78rem">${t.reference || '—'}</td>
      <td class="td-muted">${Utils.date(t.transaction_date)}</td>
    </tr>`;
  }).join('');
}

function setupTxnSearch() {
  const searchEl = document.getElementById('txnSearch');
  const filterEl = document.getElementById('txnTypeFilter');
  const refresh  = () => renderTransactionsTable(searchEl?.value.trim() || '', filterEl?.value || '');

  if (searchEl && !searchEl._wired) {
    searchEl.addEventListener('input', () => setTimeout(refresh, 180));
    searchEl._wired = true;
  }
  if (filterEl && !filterEl._wired) {
    filterEl.addEventListener('change', refresh);
    filterEl._wired = true;
  }
}

/* ═══════════════════════════════════════════════
   SUPPORT VIEW
═══════════════════════════════════════════════ */
async function loadSupport() {
  try {
    if (!STATE.tickets.length) await loadDashboard();
    renderSupportStats();
    renderTicketsTable();
  } catch(e) {
    Toast.error('Failed to load support tickets');
  }
}

function renderSupportStats() {
  const t = STATE.tickets;
  const open   = t.filter(x => x.status === 'open' || x.status === 'in_progress').length;
  const closed = t.filter(x => x.status === 'closed' || x.status === 'resolved').length;
  const urgent = t.filter(x => x.priority === 'urgent' || x.priority === 'high').length;

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('tkt-total', t.length);
  set('tkt-open',  open);
  set('tkt-closed', closed);
  set('tkt-urgent', urgent);
}

function renderTicketsTable(filterStatus = '') {
  const tbody = document.getElementById('ticketsBody');
  if (!tbody) return;

  let data = STATE.tickets.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (filterStatus) data = data.filter(t => t.status === filterStatus);

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-headset"></i><p>No support tickets</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(t => {
    const client = STATE.clients.find(c => c.id === t.investor_id);
    const prioColor = t.priority === 'urgent' ? '#ef4444' : t.priority === 'high' ? '#f97316' : '#6b7280';
    return `<tr>
      <td class="td-muted" style="font-size:0.75rem;font-family:monospace">${t.id || '—'}</td>
      <td>
        <div class="flex-center gap-8">
          <div class="avatar avatar--sm">${Utils.initials(client ? client.first_name + ' ' + client.last_name : t.investor_name || '?')}</div>
          <span class="td-strong">${client ? client.first_name + ' ' + client.last_name : t.investor_name || '—'}</span>
        </div>
      </td>
      <td class="td-strong">${t.subject || '—'}</td>
      <td><span class="badge" style="color:${prioColor};background:${prioColor}18">${t.priority || 'normal'}</span></td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted">${Utils.date(t.created_at || t.date_opened)}</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   PROFILE VIEW
═══════════════════════════════════════════════ */
function loadProfile() {
  const ifa = STATE.ifa;
  if (!ifa) return;

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('profile-name',        ifa.first_name + ' ' + ifa.last_name);
  set('profile-email',       ifa.email);
  set('profile-phone',       ifa.phone || '—');
  set('profile-license',     ifa.license_number || '—');
  set('profile-company',     ifa.company_name || '—');
  set('profile-commission',  (ifa.commission_rate || 0).toFixed(2) + '%');
  set('profile-status',      ifa.status || '—');
  set('profile-joined',      Utils.date(ifa.date_joined));
  set('profile-clients',     (ifa.assigned_clients || []).length);
  set('profile-aum',         Utils.rand(ifa.aum_managed || 0));

  const avatar = document.getElementById('profile-avatar');
  if (avatar) avatar.textContent = Utils.initials(ifa.first_name + ' ' + ifa.last_name);
}
