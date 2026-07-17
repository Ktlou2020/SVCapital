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
  // Check JWT or staffSession via the unified Auth helper
  if (Auth.isLoggedIn()) {
    const user = Auth.getUser();
    // Allow staff roles that have IFA/admin/director access
    if (user && (user.role === 'ifa' || user.role === 'admin' || user.role === 'director' || user.role === 'staff')) {
      IFA_SESSION = {
        ifaId:   user.ifaId || user.investorId || user.id || 'IFA-SSO',
        name:    `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        company: '',
        email:   user.email,
      };
      return true;
    }
  }
  IFA_SESSION = getSession();
  if (!IFA_SESSION) {
    // Redirect to the unified staff login, not the legacy IFA-specific one
    window.location.href = '/team/login.html';
    return false;
  }
  return true;
}

function signOut() {
  Auth.logout('/team/login.html');
  localStorage.removeItem('svc_ifa_session');
  sessionStorage.removeItem('svc_ifa_session');
}

/* ─── Helpers ─── */
function _ifaGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function _animateCounter(el, target, prefix = '', suffix = '', duration = 800) {
  if (!el) return;
  const startTime = performance.now();
  const step = (now) => {
    const elapsed = Math.min((now - startTime) / duration, 1);
    const eased   = 1 - Math.pow(1 - elapsed, 3);
    const current = Math.round(target * eased);
    el.textContent = prefix + current.toLocaleString('en-ZA') + suffix;
    if (elapsed < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function _populateWelcomeBanner(ifa) {
  if (!ifa) return;
  const name = (ifa.first_name || '') + ' ' + (ifa.last_name || '');
  const greeting = _ifaGreeting();

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const show = (id) => { const el = document.getElementById(id); if (el) el.style.display = ''; };

  set('ifaWelcomeGreeting', greeting);
  set('ifaWelcomeName', name.trim() || 'IFA Partner');

  const avatarEl = document.getElementById('ifaWelcomeAvatar');
  if (avatarEl) avatarEl.textContent = Utils.initials(name);

  if (ifa.company_name) {
    set('ifaChipCompanyVal', ifa.company_name);
    show('ifaChipCompany');
  }
  if (ifa.commission_rate) {
    set('ifaChipCommissionVal', parseFloat(ifa.commission_rate).toFixed(1) + '%');
    show('ifaChipCommission');
  }
  if (ifa.license_number) {
    set('ifaChipLicenseVal', ifa.license_number);
    show('ifaChipLicense');
  }

  const statusChip = document.getElementById('ifaChipStatus');
  if (statusChip) {
    if (ifa.status === 'active') {
      statusChip.className = 'ifa-chip ifa-chip--green';
      statusChip.innerHTML = '<i class="fa-solid fa-circle-check"></i> Active Partner';
    } else if (ifa.status === 'suspended') {
      statusChip.className = 'ifa-chip ifa-chip--orange';
      statusChip.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Suspended';
    }
  }
}

function _populatePerfPanel(ifa, clients) {
  const totalAUM    = clients.reduce((s, c) => s + (c.total_invested || 0), 0);
  const totalRet    = clients.reduce((s, c) => s + (c.total_returns  || 0), 0);
  const commRate    = ifa.commission_rate || 0;
  const commission  = totalAUM * (commRate / 100);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('perf-aum',        Utils.rand(totalAUM));
  set('perf-returns',    Utils.rand(totalRet));
  set('perf-commission', Utils.rand(commission));
  set('perf-clients',    clients.length);
}

/* ─── State ─── */
let STATE = {
  ifa: null,
  clients: [],
  investments: [],
  transactions: [],
  tickets: [],
  ifaTickets: [],
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
    refer:        'Refer Client',
    investments:  'Client Investments',
    transactions: 'Transactions',
    support:      'Support Tickets',
    profile:      'My Profile',
    commission:   'Commission'
  };

  const el = document.getElementById('topbarTitle');
  if (el) el.textContent = titles[view] || view;
  STATE.currentView = view;

  const loaders = {
    dashboard:    loadDashboard,
    clients:      loadClients,
    refer:        loadRefer,
    investments:  loadInvestments,
    transactions: loadTransactions,
    support:      loadSupport,
    profile:      loadProfile,
    commission:   loadCommission
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

async function fetchMyClients() {
  // Fetch investors where ifa_id matches this IFA
  try {
    const data = await API.list('investors', { ifa_id: IFA_SESSION.ifaId, limit: 500 });
    if (data && data.data && data.data.length > 0) return data.data;
  } catch(_) {}
  // Fallback: try via assigned_clients from IFA record
  if (STATE.ifa && STATE.ifa.assigned_clients && STATE.ifa.assigned_clients.length) {
    const ids = STATE.ifa.assigned_clients;
    const data = await API.investors.list({ limit: 500 });
    return (data.data || []).filter(inv => ids.includes(inv.id));
  }
  return [];
}

async function fetchClients(clientIds) {
  if (!clientIds || !clientIds.length) return [];
  const data = await API.investors.list({ limit: 500 });
  return (data.data || []).filter(inv => clientIds.includes(inv.id));
}

async function fetchInvestments(clientIds) {
  if (!clientIds || !clientIds.length) return [];
  const data = await API.investments.list({ limit: 500 });
  return (data.data || []).filter(inv => clientIds.includes(inv.investor_id));
}

async function fetchTransactions(clientIds) {
  if (!clientIds || !clientIds.length) return [];
  const data = await API.transactions.list({ limit: 500 });
  return (data.data || []).filter(t => clientIds.includes(t.investor_id));
}

async function fetchTickets(clientIds) {
  if (!clientIds || !clientIds.length) return [];
  const data = await API.tickets.list({ limit: 200 });
  return (data.data || []).filter(t => clientIds.includes(t.investor_id));
}

async function fetchIFAOwnTickets() {
  // Tickets filed by this IFA (reference contains IFA id or email)
  try {
    const data = await API.tickets.list({ limit: 200 });
    const all = data.data || [];
    const ifaEmail = (STATE.ifa && STATE.ifa.email) || (IFA_SESSION && IFA_SESSION.email) || '';
    const ifaId    = IFA_SESSION.ifaId || '';
    return all.filter(t =>
      !t.investor_id &&
      (
        (t.reference && (t.reference.includes(ifaId) || t.reference.includes(ifaEmail))) ||
        (t.created_by && (t.created_by === ifaId || t.created_by === ifaEmail))
      )
    );
  } catch(_) { return []; }
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

    // Fetch IFA record first
    let ifaRecord = null;
    try { ifaRecord = await fetchIFA(); } catch(_) {}
    STATE.ifa = ifaRecord || {};

    // Fetch clients — prefer ifa_id query, fallback to assigned_clients
    let clients = [];
    try { clients = await fetchMyClients(); } catch(_) {}
    if (!clients.length && STATE.ifa.assigned_clients && STATE.ifa.assigned_clients.length) {
      try { clients = await fetchClients(STATE.ifa.assigned_clients); } catch(_) {}
    }

    const clientIds = clients.map(c => c.id);

    const [investments, transactions, tickets, pools] = await Promise.all([
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

    _populateWelcomeBanner(STATE.ifa);
    _populatePerfPanel(STATE.ifa, clients);
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
  // Sum active investments for AUM
  const activeInvests = invests.filter(i => i.status === 'active');
  const totalAUM   = activeInvests.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  // Also add total_invested from clients as fallback
  const clientAUM  = clients.reduce((s, c) => s + (parseFloat(c.total_invested) || 0), 0);
  const aum        = totalAUM || clientAUM;
  const totalRet   = clients.reduce((s, c) => s + (parseFloat(c.total_returns) || 0), 0);
  const commRate   = parseFloat(STATE.ifa.commission_rate || 0);
  const commission = aum * (commRate / 100);
  const avgPortfolio = clients.length ? (aum / clients.length) : 0;

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('ds-clients',    clients.length);
  set('ds-aum',        Utils.rand(aum));
  set('ds-returns',    Utils.rand(totalRet));
  set('ds-commission', Utils.rand(commission));

  // Active investments badge
  const badge = document.getElementById('ds-active-badge');
  if (badge) badge.textContent = `${activeInvests.length} active`;

  // Update perf panel too
  set('perf-aum',        Utils.rand(aum));
  set('perf-returns',    Utils.rand(totalRet));
  set('perf-commission', Utils.rand(commission));
  set('perf-clients',    clients.length);

  // Store computed values for reuse
  STATE._aum        = aum;
  STATE._commission = commission;
  STATE._avgPortfolio = avgPortfolio;
}

function renderRecentClientsWidget() {
  const el = document.getElementById('recentClientsWidget');
  if (!el) return;
  const recent = STATE.clients.slice(0, 5);
  if (!recent.length) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-users"></i><p>No clients linked yet</p></div>`;
    return;
  }
  el.innerHTML = recent.map((c, idx) => `
    <div class="flex-center gap-10" style="padding:10px 0;${idx < recent.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
      <div class="avatar avatar--md ${(parseFloat(c.total_invested) || 0) > 100000 ? 'avatar--gold' : 'avatar--teal'}">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
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
  `).join('');
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
    { icon: 'fa-id-card',        color: '#f97316', label: 'Clients pending FICA',              count: pendingFica,  view: 'clients' },
    { icon: 'fa-headset',        color: '#656565', label: 'Open support tickets',              count: openTickets,  view: 'support' },
    { icon: 'fa-hourglass-end',  color: '#a855f7', label: 'Investments maturing in 30 days',  count: maturingSoon, view: 'investments' }
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

  // Group AUM by client — prefer investment amounts, fallback to total_invested
  const topClients = STATE.clients.slice(0, 8);
  const labels = topClients.map(c => c.first_name + ' ' + (c.last_name || '').slice(0,1) + '.');
  const data   = topClients.map(c => {
    const clientInvests = STATE.investments
      .filter(i => i.investor_id === c.id && i.status === 'active')
      .reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
    return clientInvests || parseFloat(c.total_invested) || 0;
  });
  const colors = ['#656565','#fec24f','#22c55e','#f97316','#a855f7','#656565','#ef4444','#656565'];

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
  const active  = c.filter(x => x.status === 'active' || x.fica_status === 'fica_approved').length;
  const pending = c.filter(x => x.status === 'pending_fica' || x.fica_status === 'pending').length;
  const totalI  = c.reduce((s, x) => s + (parseFloat(x.total_invested) || 0), 0);

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
    const totalInvested = clientInvests.filter(i => i.status === 'active').reduce((s,i) => s + (parseFloat(i.amount) || 0), 0) || parseFloat(c.total_invested) || 0;
    const totalReturns  = parseFloat(c.total_returns) || 0;
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
      <td>${Utils.statusBadge(c.status || 'pending')}</td>
      <td class="td-gold fw-700">${Utils.rand(totalInvested)}</td>
      <td class="td-green">${Utils.rand(totalReturns)}</td>
      <td>${Utils.statusBadge(c.fica_status || 'pending')}</td>
      <td class="td-muted">${Utils.date(c.date_joined)}</td>
      <td>
        <div class="flex-center gap-6">
          <button class="btn btn--sm btn--secondary" onclick="viewClientDetail('${c.id}')" title="View Portfolio">
            <i class="fa-solid fa-eye"></i> Portfolio
          </button>
          <a class="btn btn--sm btn--secondary" href="mailto:${c.email}" title="Contact Client">
            <i class="fa-solid fa-envelope"></i>
          </a>
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
  const clientTxns    = STATE.transactions.filter(t => t.investor_id === clientId)
    .sort((a,b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at))
    .slice(0, 5);
  const totalInvested = clientInvests.filter(i => i.status === 'active').reduce((s,i) => s + (parseFloat(i.amount) || 0), 0) || parseFloat(c.total_invested) || 0;
  const totalReturns  = parseFloat(c.total_returns) || 0;

  document.getElementById('clientDetailTitle').textContent = `${c.first_name} ${c.last_name}`;
  document.getElementById('clientDetailBody').innerHTML = `
    <div class="grid-2 mb-16">
      <div>
        <div class="flex-center gap-12 mb-16">
          <div class="avatar avatar--lg avatar--teal">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
          <div>
            <div style="font-size:1.05rem;font-weight:800;color:var(--text-h)">${c.first_name} ${c.last_name}</div>
            <div style="color:var(--text-muted);font-size:0.8rem">${c.email}</div>
            ${c.phone ? `<div style="color:var(--text-muted);font-size:0.8rem;margin-top:2px"><i class="fa-solid fa-phone" style="font-size:0.7rem"></i> ${c.phone}</div>` : ''}
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
            <div class="info-row"><span class="info-row__label">Total Invested</span><span class="info-row__value td-gold">${Utils.rand(totalInvested)}</span></div>
            <div class="info-row"><span class="info-row__label">Total Returns</span><span class="info-row__value td-green">${Utils.rand(totalReturns)}</span></div>
            <div class="info-row"><span class="info-row__label">Effective Return</span><span class="info-row__value td-green">${totalInvested ? Utils.pct(totalReturns / totalInvested) : '—'}</span></div>
            <div class="info-row"><span class="info-row__label">Active Investments</span><span class="info-row__value">${clientInvests.filter(i => i.status === 'active').length}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div style="font-size:0.84rem;font-weight:700;color:var(--text-h);margin-bottom:10px">
      Investment Portfolio (${clientInvests.length})
    </div>
    ${clientInvests.length
      ? `<table class="data-table mb-16">
          <thead><tr><th>Pool</th><th>Amount</th><th>Annual Rate</th><th>Status</th><th>Start Date</th><th>Maturity</th></tr></thead>
          <tbody>${clientInvests.map(i => `<tr>
            <td class="td-strong">${i.pool_name || '—'}</td>
            <td class="td-gold fw-700">${Utils.rand(i.amount)}</td>
            <td class="td-green">${Utils.pct(i.expected_return_rate)}</td>
            <td>${Utils.statusBadge(i.status)}</td>
            <td class="td-muted">${Utils.date(i.start_date)}</td>
            <td class="td-muted">${Utils.date(i.maturity_date)}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-chart-line"></i><p>No investments yet</p></div>`
    }

    <div style="font-size:0.84rem;font-weight:700;color:var(--text-h);margin:16px 0 10px">
      Recent Transactions (last 5)
    </div>
    ${clientTxns.length
      ? `<table class="data-table">
          <thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${clientTxns.map(t => `<tr>
            <td>${Utils.statusBadge(t.type)}</td>
            <td class="${parseFloat(t.amount) > 0 ? 'td-green' : 'td-teal'} fw-700">${parseFloat(t.amount) > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
            <td>${Utils.statusBadge(t.status)}</td>
            <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-arrows-rotate"></i><p>No transactions yet</p></div>`
    }
  `;

  Modal.open('clientDetailModal');
}

/* ═══════════════════════════════════════════════
   REFER CLIENT VIEW
═══════════════════════════════════════════════ */
async function loadRefer() {
  try {
    if (!STATE.clients.length) await loadDashboard();
    renderReferralLink();
    renderReferralOverview();
    renderReferTable();
    setupReferFilter();
  } catch(e) {
    Toast.error('Failed to load referral data');
  }
}

function _getReferralUrl() {
  const ifaId = IFA_SESSION.ifaId || (STATE.ifa && STATE.ifa.id) || '';
  const origin = window.location.origin;
  return `${origin}/signup?ifa=${encodeURIComponent(ifaId)}`;
}

function renderReferralLink() {
  const url = _getReferralUrl();
  const ifaId = IFA_SESSION.ifaId || (STATE.ifa && STATE.ifa.id) || '';

  const linkEl = document.getElementById('referralLinkText');
  if (linkEl) linkEl.textContent = url;

  const waMsg = encodeURIComponent(
    `Hi! I'd like to introduce you to SV Capital — a trusted investment platform.\n\n` +
    `Sign up using my referral link and I'll guide you through the process:\n${url}\n\n` +
    `Feel free to reach out if you have any questions.`
  );
  const waEl = document.getElementById('referralWhatsApp');
  if (waEl) waEl.href = `https://wa.me/?text=${waMsg}`;

  const emailSubject = encodeURIComponent('Investment Opportunity — SV Capital');
  const emailBody = encodeURIComponent(
    `Dear Investor,\n\nI would like to invite you to consider SV Capital as your investment partner.\n\n` +
    `Please sign up using my referral link:\n${url}\n\n` +
    `I look forward to helping you grow your wealth.\n\nKind regards`
  );
  const emailEl = document.getElementById('referralEmail');
  if (emailEl) emailEl.href = `mailto:?subject=${emailSubject}&body=${emailBody}`;
}

function renderReferralOverview() {
  const el = document.getElementById('referralOverviewBody');
  if (!el) return;

  const clients = STATE.clients;
  const total        = clients.length;
  const approved     = clients.filter(c => c.status === 'active' || c.fica_status === 'fica_approved').length;
  const pendingFica  = clients.filter(c => c.status === 'pending_fica' || c.fica_status === 'pending').length;
  const ficaSubmitted = clients.filter(c => c.status === 'fica_submitted' || c.fica_status === 'fica_submitted').length;
  const invested     = clients.filter(c => (parseFloat(c.total_invested) || 0) > 0).length;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div style="text-align:center;background:#f0fdf4;border:1px solid rgba(34,197,94,0.2);border-radius:var(--radius);padding:16px">
        <div style="font-size:1.6rem;font-weight:800;color:var(--green)">${approved}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">FICA Approved</div>
      </div>
      <div style="text-align:center;background:#fff7ed;border:1px solid rgba(249,115,22,0.2);border-radius:var(--radius);padding:16px">
        <div style="font-size:1.6rem;font-weight:800;color:var(--orange)">${pendingFica}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">Pending FICA</div>
      </div>
      <div style="text-align:center;background:#eff6ff;border:1px solid rgba(59,130,246,0.2);border-radius:var(--radius);padding:16px">
        <div style="font-size:1.6rem;font-weight:800;color:#656565">${ficaSubmitted}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">FICA Submitted</div>
      </div>
      <div style="text-align:center;background:#fefce8;border:1px solid rgba(254,194,79,0.2);border-radius:var(--radius);padding:16px">
        <div style="font-size:1.6rem;font-weight:800;color:var(--gold)">${invested}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px">Invested</div>
      </div>
    </div>
    <div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:var(--radius);font-size:0.78rem;color:var(--text-muted)">
      <strong style="color:var(--text-h)">${total} total referred clients</strong> —
      ${pendingFica} still need to complete FICA before they can invest.
    </div>
  `;
}

function renderReferTable(ficaFilter = '') {
  const tbody = document.getElementById('referTableBody');
  if (!tbody) return;

  let data = STATE.clients.slice();
  if (ficaFilter) {
    data = data.filter(c => {
      if (ficaFilter === 'active') return c.status === 'active' || c.fica_status === 'fica_approved';
      return c.status === ficaFilter || c.fica_status === ficaFilter;
    });
  }

  const footer = document.getElementById('referTableFooter');
  if (footer) footer.textContent = `Showing ${data.length} of ${STATE.clients.length} referred clients`;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fa-solid fa-user-plus"></i><p>No clients found</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(c => {
    const totalInvested = parseFloat(c.total_invested) || 0;
    return `<tr>
      <td>
        <div class="flex-center gap-8">
          <div class="avatar avatar--sm avatar--teal">${Utils.initials(c.first_name + ' ' + c.last_name)}</div>
          <span class="td-strong">${c.first_name} ${c.last_name}</span>
        </div>
      </td>
      <td class="td-muted">${c.email}</td>
      <td class="td-muted">${c.phone || '—'}</td>
      <td>${Utils.statusBadge(c.fica_status || c.status || 'pending')}</td>
      <td class="td-muted">${Utils.date(c.date_joined)}</td>
      <td class="td-gold fw-700">${Utils.rand(totalInvested)}</td>
      <td>
        <button class="btn btn--sm btn--secondary" onclick="viewClientDetail('${c.id}')">
          <i class="fa-solid fa-eye"></i> View
        </button>
      </td>
    </tr>`;
  }).join('');
}

function setupReferFilter() {
  const filterEl = document.getElementById('referFicaFilter');
  if (filterEl && !filterEl._wired) {
    filterEl.addEventListener('change', () => renderReferTable(filterEl.value));
    filterEl._wired = true;
  }
}

function copyReferralLink() {
  const url = _getReferralUrl();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => Toast.success('Referral link copied to clipboard!'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    Toast.success('Referral link copied!');
  }
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
  const inv    = STATE.investments;
  const active = inv.filter(i => i.status === 'active');
  const totalAmt = active.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  // Weighted average rate
  const wavg = active.length
    ? active.reduce((s, i) => s + (parseFloat(i.expected_return_rate) || 0) * (parseFloat(i.amount) || 0), 0) / (totalAmt || 1)
    : 0;
  const totalRet = active.reduce((s, i) => s + ((parseFloat(i.amount) || 0) * (parseFloat(i.expected_return_rate) || 0)), 0);

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
    data = data.filter(i => {
      const client = STATE.clients.find(c => c.id === i.investor_id);
      const clientName = client ? (client.first_name + ' ' + client.last_name).toLowerCase() : '';
      return (i.pool_name || '').toLowerCase().includes(q) ||
             clientName.includes(q) ||
             (i.investor_name || '').toLowerCase().includes(q);
    });
  }

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fa-solid fa-chart-line"></i><p>No investments found</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(inv => {
    const client = STATE.clients.find(c => c.id === inv.investor_id);
    const clientName = client ? client.first_name + ' ' + client.last_name : inv.investor_name || '—';
    const amount = parseFloat(inv.amount) || 0;
    const rate   = parseFloat(inv.expected_return_rate) || 0;
    return `<tr>
      <td>
        <div class="flex-center gap-8">
          <div class="avatar avatar--sm">${Utils.initials(clientName)}</div>
          <span class="td-strong">${clientName}</span>
        </div>
      </td>
      <td class="td-strong">${inv.pool_name || '—'}</td>
      <td class="td-gold fw-700">${Utils.rand(amount)}</td>
      <td class="td-muted">${Utils.date(inv.start_date)}</td>
      <td class="td-muted">${Utils.date(inv.maturity_date)}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
      <td class="td-green">${Utils.pct(rate)}</td>
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

  let data = STATE.transactions.slice().sort((a, b) =>
    new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at)
  );
  if (filterType) data = data.filter(t => t.type === filterType);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    data = data.filter(t => {
      const client = STATE.clients.find(c => c.id === t.investor_id);
      const clientName = client ? (client.first_name + ' ' + client.last_name).toLowerCase() : '';
      return clientName.includes(q) ||
             (t.investor_name || '').toLowerCase().includes(q) ||
             (t.reference || '').toLowerCase().includes(q) ||
             (t.description || '').toLowerCase().includes(q);
    });
  }

  // Stats
  const totalDeposits = STATE.transactions.filter(t => t.type === 'deposit' && t.status === 'completed').reduce((s,t) => s + (parseFloat(t.amount) || 0), 0);
  const totalReturns  = STATE.transactions.filter(t => t.type === 'return'  && t.status === 'completed').reduce((s,t) => s + (parseFloat(t.amount) || 0), 0);
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
    const clientName = client ? client.first_name + ' ' + client.last_name : t.investor_name || '—';
    const amount = parseFloat(t.amount) || 0;
    return `<tr>
      <td>
        <div class="flex-center gap-8">
          <div class="avatar avatar--sm">${Utils.initials(clientName)}</div>
          <span class="td-strong">${clientName}</span>
        </div>
      </td>
      <td>${Utils.statusBadge(t.type)}</td>
      <td class="${amount >= 0 ? 'td-green' : 'td-teal'} fw-700">${amount >= 0 ? '+' : ''}${Utils.rand(amount)}</td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted" style="font-size:0.78rem">${t.reference || '—'}</td>
      <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
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
    if (!STATE.clients.length) await loadDashboard();
    // Also load IFA own tickets
    if (!STATE.ifaTickets.length) {
      STATE.ifaTickets = await fetchIFAOwnTickets();
    }
    renderSupportStats();
    renderTicketsTable();
  } catch(e) {
    Toast.error('Failed to load support tickets');
  }
}

function renderSupportStats() {
  const combined = [...STATE.tickets, ...STATE.ifaTickets];
  const open   = combined.filter(x => x.status === 'open' || x.status === 'in_progress').length;
  const closed = combined.filter(x => x.status === 'closed' || x.status === 'resolved').length;
  const urgent = combined.filter(x => x.priority === 'urgent' || x.priority === 'high').length;

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('tkt-total', combined.length);
  set('tkt-open',  open);
  set('tkt-closed', closed);
  set('tkt-urgent', urgent);
}

function renderTicketsTable(filterStatus = '') {
  const tbody = document.getElementById('ticketsBody');
  if (!tbody) return;

  // Combine client tickets + IFA own tickets
  const combined = [
    ...STATE.tickets.map(t => ({ ...t, _source: 'client' })),
    ...STATE.ifaTickets.map(t => ({ ...t, _source: 'ifa' }))
  ].sort((a, b) => new Date(b.created_at || b.date_opened) - new Date(a.created_at || a.date_opened));

  let data = combined;
  if (filterStatus) data = data.filter(t => t.status === filterStatus);

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fa-solid fa-headset"></i><p>No support tickets</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(t => {
    const client = STATE.clients.find(c => c.id === t.investor_id);
    const sourceLabel = t._source === 'ifa'
      ? `<span style="font-size:0.72rem;font-weight:600;color:var(--teal)"><i class="fa-solid fa-id-badge"></i> My Account</span>`
      : (client
          ? `<div class="flex-center gap-6"><div class="avatar avatar--sm">${Utils.initials(client.first_name + ' ' + client.last_name)}</div><span class="td-strong">${client.first_name} ${client.last_name}</span></div>`
          : `<span class="td-muted">${t.investor_name || '—'}</span>`);
    const prioColor = t.priority === 'urgent' ? '#ef4444' : t.priority === 'high' ? '#f97316' : '#6b7280';
    return `<tr>
      <td class="td-muted" style="font-size:0.75rem;font-family:monospace">${String(t.id || '—').slice(0,8)}</td>
      <td>${sourceLabel}</td>
      <td class="td-strong">${t.subject || '—'}</td>
      <td><span class="badge badge--gray" style="font-size:0.7rem">${(t.category || 'general').replace('_',' ')}</span></td>
      <td><span class="badge" style="color:${prioColor};background:${prioColor}18">${t.priority || 'normal'}</span></td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted">${Utils.date(t.created_at || t.date_opened)}</td>
    </tr>`;
  }).join('');
}

function openNewTicketModal() {
  // Reset form
  const fields = ['ticketSubject','ticketMessage'];
  fields.forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  const cat = document.getElementById('ticketCategory');
  const pri = document.getElementById('ticketPriority');
  if (cat) cat.value = 'general';
  if (pri) pri.value = 'medium';
  Modal.open('newTicketModal');
}

async function submitNewTicket() {
  const subject  = (document.getElementById('ticketSubject')?.value || '').trim();
  const message  = (document.getElementById('ticketMessage')?.value || '').trim();
  const category = document.getElementById('ticketCategory')?.value || 'general';
  const priority = document.getElementById('ticketPriority')?.value || 'medium';

  if (!subject) { Toast.warning('Please enter a subject'); return; }
  if (!message) { Toast.warning('Please enter a message'); return; }

  const btn = document.getElementById('submitTicketBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...'; }

  try {
    const ifaId    = IFA_SESSION.ifaId || (STATE.ifa && STATE.ifa.id) || '';
    const ifaEmail = (STATE.ifa && STATE.ifa.email) || (IFA_SESSION && IFA_SESSION.email) || '';

    const payload = {
      investor_id: null,
      subject,
      message,
      category,
      priority,
      status:     'open',
      reference:  `IFA-${ifaId}`,
      created_by: ifaEmail || ifaId,
    };

    const result = await API.tickets.create(payload);
    STATE.ifaTickets.unshift({ ...payload, id: result.id || result.data?.id || Utils.genId('TKT'), created_at: new Date().toISOString(), _source: 'ifa' });

    renderSupportStats();
    renderTicketsTable(document.getElementById('ticketStatusFilter')?.value || '');
    Modal.close('newTicketModal');
    Toast.success('Support ticket submitted successfully!');
  } catch(e) {
    console.error('Ticket submit error:', e);
    Toast.error('Failed to submit ticket. Please try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Ticket'; }
  }
}

/* ═══════════════════════════════════════════════
   COMMISSION VIEW
═══════════════════════════════════════════════ */
async function loadCommission() {
  if (!STATE.clients.length) await loadDashboard();

  const ifa     = STATE.ifa || {};
  const clients = STATE.clients;
  const rate    = parseFloat(ifa.commission_rate || 0.5);

  // Check for actual commission transactions
  const commTxns = STATE.transactions.filter(t =>
    t.type === 'commission' ||
    (t.reference && t.reference.toLowerCase().includes((IFA_SESSION.ifaId || '').toLowerCase()))
  );

  const totalAUM        = clients.reduce((s, c) => s + (parseFloat(c.total_invested) || 0), 0);
  const totalCommission = commTxns.length
    ? commTxns.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0)
    : totalAUM * (rate / 100);
  const billingClients  = clients.filter(c => (parseFloat(c.total_invested) || 0) > 0).length;

  // This month's commission
  const now = new Date();
  const thisMonthTxns = commTxns.filter(t => {
    const d = new Date(t.transaction_date || t.created_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const thisMonthComm = thisMonthTxns.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('comm-rate',    rate.toFixed(2) + '%');
  set('comm-aum',     Utils.rand(totalAUM));
  set('comm-owed',    Utils.rand(totalCommission));
  set('comm-clients', billingClients);

  const sub = document.getElementById('commissionSubTitle');
  if (sub) {
    if (commTxns.length) {
      sub.textContent = `Commission is calculated at ${rate.toFixed(2)}% of initial investment amount. Showing ${commTxns.length} actual commission transaction(s).`;
    } else {
      sub.textContent = `Projected commissions — actual payouts are processed monthly by SV Capital. Rate: ${rate.toFixed(2)}% of AUM.`;
    }
  }

  const body = document.getElementById('commissionBody');
  if (!body) return;
  if (!clients.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:20px">No clients linked to your account</td></tr>';
    const f = document.getElementById('commissionFooter');
    if (f) f.textContent = '—';
    return;
  }

  if (commTxns.length) {
    // Show actual commission transaction ledger
    const sorted = [...commTxns].sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at));
    body.innerHTML = sorted.map(t => {
      const client = STATE.clients.find(c => c.id === t.investor_id);
      const clientName = client ? `${client.first_name} ${client.last_name}` : t.investor_name || '—';
      const commAmt = parseFloat(t.amount) || 0;
      // Back-calculate investment amount from commission if possible
      const investAmt = rate > 0 ? commAmt / (rate / 100) : 0;
      return `<tr>
        <td><div style="font-weight:600">${clientName}</div></td>
        <td>${Utils.statusBadge(client ? (client.fica_status || client.status) : 'pending')}</td>
        <td class="fw-700 td-gold">${Utils.rand(investAmt || 0)}</td>
        <td class="fw-700 td-green">${Utils.rand(commAmt)}</td>
        <td>${Utils.rand(parseFloat(client?.total_returns) || 0)}</td>
        <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
      </tr>`;
    }).join('');
  } else {
    // Projected commissions — per-client breakdown
    const sorted = [...clients].sort((a, b) => (parseFloat(b.total_invested) || 0) - (parseFloat(a.total_invested) || 0));
    body.innerHTML = sorted.map(c => {
      const clientAUM  = parseFloat(c.total_invested) || 0;
      const clientComm = clientAUM * (rate / 100);
      return `<tr>
        <td><div style="font-weight:600">${c.first_name} ${c.last_name}</div><div style="font-size:0.72rem;color:var(--text-muted)">${c.email}</div></td>
        <td>${Utils.statusBadge(c.fica_status || c.status)}</td>
        <td class="fw-700 td-gold">${Utils.rand(clientAUM)}</td>
        <td class="fw-700 td-green">${Utils.rand(clientComm)}</td>
        <td>${Utils.rand(parseFloat(c.total_returns) || 0)}</td>
        <td class="td-muted">${Utils.date(c.date_joined)}</td>
      </tr>`;
    }).join('');
  }

  const footer = document.getElementById('commissionFooter');
  if (footer) {
    const monthNote = thisMonthComm > 0 ? ` · This month: ${Utils.rand(thisMonthComm)}` : '';
    footer.textContent = `${clients.length} clients · Total AUM ${Utils.rand(totalAUM)} · Est. commission ${Utils.rand(totalCommission)}${monthNote}`;
  }
}

function exportCommissionCSV() {
  const ifa     = STATE.ifa || {};
  const clients = STATE.clients;
  const rate    = parseFloat(ifa.commission_rate || 0.5);
  const headers = ['Client','Email','FICA Status','AUM','Commission Rate','Commission Amount','Total Returns','Joined'];
  const rows    = [headers, ...clients.map(c => [
    `${c.first_name} ${c.last_name}`,
    c.email,
    c.fica_status || c.status,
    parseFloat(c.total_invested) || 0,
    rate.toFixed(2) + '%',
    (((parseFloat(c.total_invested) || 0) * rate) / 100).toFixed(2),
    parseFloat(c.total_returns) || 0,
    c.date_joined ? new Date(c.date_joined).toLocaleDateString('en-ZA') : '',
  ])];
  const csv  = rows.map(r => r.map(cell => {
    const s = String(cell ?? '').replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `commission-statement-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  Toast.success('Commission statement downloaded');
}

/* ═══════════════════════════════════════════════
   PROFILE VIEW
═══════════════════════════════════════════════ */
function loadProfile() {
  const ifa = STATE.ifa;
  if (!ifa) return;

  const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
  set('profile-name',        (ifa.first_name || '') + ' ' + (ifa.last_name || ''));
  set('profile-email',       ifa.email || IFA_SESSION.email || '—');
  set('profile-phone',       ifa.phone || '—');
  set('profile-license',     ifa.license_number || '—');
  set('profile-company',     ifa.company_name || '—');
  set('profile-commission',  (parseFloat(ifa.commission_rate) || 0).toFixed(2) + '%');
  set('profile-joined',      Utils.date(ifa.date_joined));
  set('profile-clients',     (ifa.assigned_clients || STATE.clients || []).length);

  const totalAUM = STATE.clients.reduce((s, c) => s + (parseFloat(c.total_invested) || 0), 0);
  set('profile-aum', Utils.rand(totalAUM));

  const avatar = document.getElementById('profile-avatar');
  if (avatar) avatar.textContent = Utils.initials((ifa.first_name || '') + ' ' + (ifa.last_name || ''));

  const statusBadgeEl = document.getElementById('profile-status-badge');
  if (statusBadgeEl) statusBadgeEl.innerHTML = Utils.statusBadge(ifa.status || 'active');
}
