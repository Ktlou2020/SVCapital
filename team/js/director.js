/* ═══════════════════════════════════════════════════════════════════════
   SV Capital — Director Super Admin Panel
   team/js/director.js
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─── API helpers ─────────────────────────────────────────────────── */
const BASE   = '/api/';

/** Return { Authorization: 'Bearer <token>' } if a token is stored, else {} */
function _authHeader() {
  const t = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token');
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}

const get    = async p => {
  try {
    const r = await fetch(BASE+p, { credentials:'include', headers: _authHeader() });
    if (!r.ok) {
      console.error(`[Director] API ${r.status} on GET ${p}`);
      return {data:[],total:0,_error:r.status};
    }
    return r.json();
  } catch(e) {
    console.error(`[Director] Network error on GET ${p}:`, e.message);
    return {data:[],total:0,_error:'network'};
  }
};
const post   = async (p,b) => {
  const r = await fetch(BASE+p, { method:'POST',  credentials:'include', headers:{'Content-Type':'application/json', ..._authHeader()}, body:JSON.stringify(b) });
  return r.json();
};
const patch  = async (p,b) => {
  const r = await fetch(BASE+p, { method:'PATCH', credentials:'include', headers:{'Content-Type':'application/json', ..._authHeader()}, body:JSON.stringify(b) });
  return r.json();
};
const put    = async (p,b) => {
  const r = await fetch(BASE+p, { method:'PUT',   credentials:'include', headers:{'Content-Type':'application/json', ..._authHeader()}, body:JSON.stringify(b) });
  return r.json();
};
const del    = async p => { await fetch(BASE+p, { method:'DELETE', credentials:'include', headers: _authHeader() }); };

async function fetchAll(table) {
  let page=1, all=[];
  while(true){
    const r = await get(`tables/${table}?limit=100&page=${page}`);
    all = all.concat(r.data||[]);
    if((r.data||[]).length < 100) break;
    if(r.total > 0 && all.length >= r.total) break;
    page++;
  }
  return all;
}

/* ─── Formatters ──────────────────────────────────────────────────── */
const zarM = v => { const n=Number(v)||0; return n>=1e6?`R${(n/1e6).toFixed(1)}M`:n>=1e3?`R${(n/1e3).toFixed(0)}k`:`R${n.toLocaleString()}`; };
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-ZA',{day:'numeric',month:'short',year:'numeric'}) : '—';

/* ─── RBAC reference ─────────────────────────────────────────────── */
let RBAC = {
  'CEO':                 ['employee','team','fund','admin','ifa','portal','director'],
  'COO':                 ['employee','team','fund','admin','ifa','portal','director'],
  'Operations Manager':  ['employee','team','fund','admin'],
  'Finance Manager':     ['employee','team','fund','admin'],
  'Tech Lead':           ['employee','team','fund','admin'],
  'Investment Analyst':  ['employee','team','fund'],
  'Compliance Officer':  ['employee','admin'],
  'Internal Audit':      ['employee','admin'],
  'Client Relations':    ['employee','portal'],
  'Marketing':           ['employee'],
  'Marketing Associate': ['employee'],
  'Junior Analyst':      ['employee'],
  'Admin':               ['employee'],
};

const ALL_ROLES = [
  'CEO','COO','Operations Manager','Investment Analyst','Client Relations',
  'Compliance Officer','Internal Audit','Marketing','Marketing Associate',
  'Tech Lead','Finance Manager','Junior Analyst','Admin',
];
const APP_NAMES = {
  employee:'My Dashboard', team:'Team Dashboard', fund:'Fund Operations',
  admin:'Admin Console', ifa:'IFA Portal', portal:'Investor Portal', director:'Director Panel'
};
const APP_ICONS = {
  employee:'fa-user-circle', team:'fa-people-group', fund:'fa-chart-line',
  admin:'fa-shield-halved', ifa:'fa-handshake', portal:'fa-building-columns', director:'fa-crown'
};
const APP_COLORS = {
  employee:'#7c5cfc', team:'#00d4aa', fund:'#f59e0b',
  admin:'#e84393', ifa:'#06b6d4', portal:'#10b981', director:'#f59e0b'
};

const LEVEL_LABELS = { junior:'Junior', mid:'Mid-Level', senior:'Senior', lead:'Lead', executive:'Executive' };

/* ─── State ───────────────────────────────────────────────────────── */
let _session    = null;
let _employees  = [];
let _onboarding = [];
let _courses    = [];
let _payslips   = [];
let _kpiScores  = [];
let _editingEmp = null;
let _selectedColor = '#7c5cfc';
let _currentView   = 'overview';
let _dirCharts  = {};

/* ═══ INIT ════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', async () => {
  _session = StaffAuth.getSession();

  // ── JWT-only path: user logged in via /login.html (no staffSession) ──
  // Build a synthetic _session from the JWT so sidebar still renders.
  if (!_session) {
    try {
      const jwt = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token');
      if (jwt) {
        const payload = JSON.parse(atob(jwt.split('.')[1]));
        if (payload && payload.exp * 1000 > Date.now() &&
            (payload.role === 'director' || payload.role === 'admin')) {
          // Reconstruct a minimal session object from svc_user or JWT payload
          let u = {};
          try { u = JSON.parse(localStorage.getItem('svc_user') || '{}'); } catch (_) {}
          _session = {
            empId:          u.id || payload.id || '',
            email:          u.email || payload.email || '',
            firstName:      u.firstName || payload.firstName || 'Director',
            lastName:       u.lastName  || payload.lastName  || '',
            role:           u.role || payload.role || 'director',
            level:          'executive',
            avatarInitials: ((u.firstName||'D')[0] + (u.lastName||'')[0]).toUpperCase() || 'D',
            avatarColor:    '#7c5cfc',
          };
        }
      }
    } catch (_) {}
  }

  // ── Guard: if still no valid session, redirect to login ──
  if (!_session || !StaffAuth.isDirector(_session)) {
    window.location.replace('login.html');
    return;
  }

  // Populate sidebar user info
  const av = document.getElementById('sidebarAvatar');
  if (av) { av.textContent = _session.avatarInitials; av.style.background = _session.avatarColor || '#7c5cfc'; }
  document.getElementById('sidebarName').textContent = (_session.firstName || '') + ' ' + (_session.lastName || '');
  document.getElementById('sidebarRole').textContent = _session.role;

  // Live preview wiring for create form
  wirePreviewListeners();

  // Load RBAC matrix from API (non-blocking fallback to defaults)
  await loadRBACFromAPI();

  // Load data — wrapped so a fetch failure never leaves the spinner up
  try {
    await loadAll();
  } catch (err) {
    console.error('Director: loadAll failed:', err);
  }

  // Hide loader and reveal app regardless of data-load outcome
  document.getElementById('dir-loader').style.display = 'none';
  document.getElementById('dirApp').style.display = 'flex';

  navTo('overview', document.querySelector('[data-view=overview]'));

  // Auto-generate payslips on the 25th
  if (new Date().getDate() >= 25) {
    setTimeout(autoGenerateMissingPayslips, 1200);
  }
});

async function loadAll() {
  const [emps, ob, courses, payslips, kpis] = await Promise.all([
    fetchAll('employees'),
    fetchAll('employee_onboarding'),
    fetchAll('employee_courses'),
    fetchAll('payslips'),
    fetchAll('kpi_scores').catch(() => []),
  ]);
  _employees  = emps;
  _onboarding = ob;
  _courses    = courses;
  _payslips   = payslips;
  _kpiScores  = kpis;

  if (!emps.length) {
    try {
      const jwtRole = (() => { try { return JSON.parse(atob((localStorage.getItem('svc_token')||'').split('.')[1])).role; } catch{return 'n/a';} })();
      const probe = await fetch(BASE + 'tables/employees?limit=1', { credentials:'include', headers: _authHeader() });
      console.warn(`[Director] employees probe → HTTP ${probe.status}. JWT role: ${jwtRole}`);
      if (probe.status === 403) showToast(`Permission denied loading employees — JWT role "${jwtRole}" needs admin/director.`, 'error');
      else if (probe.status === 401) showToast('Session expired — please log in again.', 'error');
      else if (!probe.ok) showToast(`Could not load employees (HTTP ${probe.status}) — open console for details.`, 'error');
    } catch (_) {}
  }

  // Populate buddy dropdown
  const buddySel = document.getElementById('c-buddy');
  if (buddySel) {
    buddySel.innerHTML = '<option value="">None assigned</option>' +
      _employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name} — ${e.role||''}</option>`).join('');
  }

  // Update pending onboarding badge
  const pending = _onboarding.filter(o => o.status === 'in_progress' || o.status === 'not_started');
  const badge = document.getElementById('pending-ob-badge');
  if (badge) { badge.textContent = pending.length; badge.style.display = pending.length ? '' : 'none'; }
}

/* ═══ NAVIGATION ═══════════════════════════════════════════════════ */
const PAGE_META = {
  overview:    { title:'Dashboard',        sub:'Platform overview and quick stats' },
  employees:   { title:'All Employees',    sub:'Manage your full team roster' },
  create:      { title:'Add Employee',     sub:'Create a new employee and start their onboarding journey' },
  onboarding:  { title:'Onboarding',       sub:'Track new employee onboarding progress' },
  access:      { title:'Access & Roles',   sub:'Role-based access control matrix' },
  courses:     { title:'Course Library',   sub:'All available training courses' },
  payslips:    { title:'Payslips',         sub:'Generate and manage employee payslips' },
  performance: { title:'Performance',      sub:'KPI leaderboard, scores and team analytics' },
};

function navTo(view, btn) {
  _currentView = view;
  document.querySelectorAll('.dir-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.dir-nav-btn').forEach(b => b.classList.remove('active'));
  const vEl = document.getElementById('view-' + view);
  if (vEl) vEl.classList.add('active');
  if (btn) btn.classList.add('active');

  const meta = PAGE_META[view] || {};
  document.getElementById('pageTitle').textContent = meta.title || view;
  document.getElementById('pageSub').textContent   = meta.sub || '';

  // Render actions per view
  const actEl = document.getElementById('topbarActions');
  actEl.innerHTML = '';
  if (view === 'employees') {
    actEl.innerHTML = `
      <button class="btn btn--ghost btn--sm" onclick="exportEmployeesCSV()"><i class="fa-solid fa-file-csv"></i> Export CSV</button>
      <button class="btn btn--ghost btn--sm" onclick="exportEmployeesPDF()"><i class="fa-solid fa-file-pdf"></i> Export PDF</button>
      <button class="btn btn--gold btn--sm" onclick="navTo('create',document.querySelector('[data-view=create]'))"><i class="fa-solid fa-user-plus"></i> Add Employee</button>`;
  } else if (view === 'payslips') {
    actEl.innerHTML = `<button class="btn btn--ghost btn--sm" onclick="exportPayslipsSummaryCSV()"><i class="fa-solid fa-file-csv"></i> Export Summary</button>`;
  } else if (view === 'performance') {
    actEl.innerHTML = `<button class="btn btn--ghost btn--sm" onclick="exportPerformanceCSV()"><i class="fa-solid fa-file-csv"></i> Export CSV</button>`;
  } else if (view === 'onboarding') {
    actEl.innerHTML = `<button class="btn btn--ghost btn--sm" onclick="exportOnboardingCSV()"><i class="fa-solid fa-file-csv"></i> Export</button>`;
  }

  // Render view content
  const renders = {
    overview:    renderOverview,
    employees:   renderEmployees,
    onboarding:  renderOnboardingView,
    access:      renderAccessMatrix,
    courses:     renderCourseLibrary,
    payslips:    renderPayslips,
    performance: renderPerformanceView,
  };
  if (renders[view]) renders[view]();
}

/* ═══ OVERVIEW ══════════════════════════════════════════════════════ */
function renderOverview() {
  const active    = _employees.filter(e => e.status === 'active').length;
  const inProgOb  = _onboarding.filter(o => o.status === 'in_progress').length;
  const doneOb    = _onboarding.filter(o => o.status === 'completed').length;

  document.getElementById('overviewStats').innerHTML = `
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(124,92,252,0.1);color:#7c5cfc"><i class="fa-solid fa-users"></i></div>
      <div><div class="dir-stat-val">${_employees.length}</div><div class="dir-stat-label">Total Employees</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(16,185,129,0.1);color:#10b981"><i class="fa-solid fa-circle-check"></i></div>
      <div><div class="dir-stat-val">${active}</div><div class="dir-stat-label">Active</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(245,158,11,0.1);color:#f59e0b"><i class="fa-solid fa-rocket"></i></div>
      <div><div class="dir-stat-val">${inProgOb}</div><div class="dir-stat-label">Onboarding In Progress</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(0,212,170,0.1);color:#00d4aa"><i class="fa-solid fa-graduation-cap"></i></div>
      <div><div class="dir-stat-val">${_courses.length}</div><div class="dir-stat-label">Courses Available</div></div>
    </div>
  `;

  // Second KPI row — performance intel
  const nettTotal = _payslips.reduce((s,p) => s+(parseFloat(p.nett_pay)||0), 0);
  const latestMonth = _payslips.length ? _payslips.sort((a,b) => (b.pay_period||'').localeCompare(a.pay_period||''))[0].pay_period : null;
  const monthPayslips = latestMonth ? _payslips.filter(p => p.pay_period === latestMonth) : [];
  const monthNett = monthPayslips.reduce((s,p) => s+(parseFloat(p.nett_pay)||0), 0);
  const avgKpi = _kpiScores.length ? (_kpiScores.reduce((s,k) => s+(parseFloat(k.overall_score)||0), 0) / _kpiScores.length) : null;
  const totalXP = _employees.reduce((s,e) => s+(parseInt(e.xp_total)||0), 0);
  const stats2El = document.getElementById('overviewStats2');
  if (stats2El) stats2El.innerHTML = `
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(124,92,252,0.1);color:#a78bfa"><i class="fa-solid fa-chart-bar"></i></div>
      <div><div class="dir-stat-val">${avgKpi !== null ? avgKpi.toFixed(1)+'%' : '—'}</div><div class="dir-stat-label">Avg KPI Score</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(245,158,11,0.1);color:#f59e0b"><i class="fa-solid fa-file-invoice-dollar"></i></div>
      <div><div class="dir-stat-val">${zarM(monthNett)}</div><div class="dir-stat-label">Nett Payroll${latestMonth?' ('+latestMonth+')':''}</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(16,185,129,0.1);color:#10b981"><i class="fa-solid fa-circle-check"></i></div>
      <div><div class="dir-stat-val">${doneOb}</div><div class="dir-stat-label">Onboarding Completed</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(0,212,170,0.1);color:#00d4aa"><i class="fa-solid fa-star"></i></div>
      <div><div class="dir-stat-val">${totalXP.toLocaleString()}</div><div class="dir-stat-label">Total Team XP</div></div>
    </div>
  `;

  renderDeptChart();
  renderActivityFeed();

  // Recent employees (last 5 by start_date)
  const recent = [..._employees].sort((a,b) => new Date(b.start_date||b.created_at||0) - new Date(a.start_date||a.created_at||0)).slice(0,5);
  document.getElementById('recentEmpsTable').innerHTML = recent.length ? `
    <div class="dir-table-wrap"><table class="dir-table">
      <thead><tr><th>Employee</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>
        ${recent.map(e => `
          <tr style="cursor:pointer" onclick="openEmpDetail('${e.id}')">
            <td>
              <div style="display:flex;align-items:center;gap:10px">
                <div class="emp-row-avatar" style="background:${e.avatar_color||'#7c5cfc'}">${e.avatar_initials||'?'}</div>
                <div><div class="emp-row-name">${e.first_name} ${e.last_name}</div><div class="emp-row-email">${e.email||''}</div></div>
              </div>
            </td>
            <td><span class="role-chip">${e.role||'—'}</span></td>
            <td>${statusChip(e.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table></div>
  ` : '<div class="dir-empty"><i class="fa-solid fa-users"></i><h3>No employees yet</h3></div>';

  // Active onboarding
  const activeOb = _onboarding.filter(o => o.status !== 'completed').slice(0,5);
  document.getElementById('activeOnboardingList').innerHTML = activeOb.length ? activeOb.map(ob => {
    const emp = _employees.find(e => e.id === ob.employee_id);
    if (!emp) return '';
    const pct = ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : 0;
    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:8px;cursor:pointer" onclick="openObDetail('${ob.id}')">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div class="emp-row-avatar" style="background:${emp.avatar_color||'#7c5cfc'}">${emp.avatar_initials||'?'}</div>
          <div style="flex:1"><div style="font-size:0.85rem;font-weight:700">${emp.first_name} ${emp.last_name}</div><div style="font-size:0.72rem;color:var(--muted)">${emp.role||''}</div></div>
          <div style="font-size:0.8rem;font-weight:700;color:var(--gold)">${pct}%</div>
        </div>
        <div class="prog-bar"><div class="prog-bar-fill" style="width:${pct}%"></div></div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:6px">${ob.tasks_completed||0} of ${ob.tasks_total||0} tasks complete</div>
      </div>
    `;
  }).join('') : '<div class="dir-empty" style="padding:30px 20px"><i class="fa-solid fa-rocket" style="font-size:1.8rem"></i><p style="font-size:0.8rem">No active onboarding journeys.</p></div>';
}

/* ═══ EMPLOYEES TABLE ════════════════════════════════════════════════ */
let _empFilteredList = [];

function renderEmployees() {
  _empFilteredList = [..._employees];
  document.getElementById('empCount').textContent = _employees.length;
  renderEmpTable(_empFilteredList);
}

function filterEmployees() {
  const q      = (document.getElementById('empSearch')?.value||'').toLowerCase();
  const dept   = document.getElementById('empDeptFilter')?.value || '';
  const status = document.getElementById('empStatusFilter')?.value || '';
  _empFilteredList = _employees.filter(e => {
    if (q && !`${e.first_name} ${e.last_name} ${e.email} ${e.role} ${e.department}`.toLowerCase().includes(q)) return false;
    if (dept && e.department !== dept) return false;
    if (status && e.status !== status) return false;
    return true;
  });
  document.getElementById('empCount').textContent = _empFilteredList.length;
  renderEmpTable(_empFilteredList);
}

function renderEmpTable(list) {
  const tbody = document.getElementById('empTableBody');
  if (!list.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="dir-empty" style="padding:30px"><i class="fa-solid fa-magnifying-glass"></i><h3>No employees found</h3></div></td></tr>`; return; }
  tbody.innerHTML = list.map(e => {
    const ob = _onboarding.find(o => o.employee_id === e.id);
    const obPct = ob && ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : null;
    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="emp-row-avatar" style="background:${e.avatar_color||'#7c5cfc'}">${e.avatar_initials||'?'}</div>
            <div><div class="emp-row-name">${e.first_name} ${e.last_name}</div><div class="emp-row-email">${e.email||''}</div></div>
          </div>
        </td>
        <td><span class="role-chip">${e.role||'—'}</span></td>
        <td style="color:var(--muted2);font-size:0.8rem">${e.department||'—'}</td>
        <td><span class="chip chip--purple">${LEVEL_LABELS[e.level]||e.level||'—'}</span></td>
        <td>${statusChip(e.status)}</td>
        <td>
          ${ob ? `
            <div class="onboard-prog">
              <div style="flex:1;max-width:80px"><div class="prog-bar"><div class="prog-bar-fill" style="width:${obPct}%"></div></div></div>
              <span class="onboard-pct">${obPct}%</span>
            </div>
          ` : '<span style="color:var(--muted);font-size:0.75rem">—</span>'}
        </td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn btn--ghost btn--sm" onclick="openEmpDetail('${e.id}')" title="View details"><i class="fa-solid fa-eye"></i></button>
            <button class="btn btn--ghost btn--sm" onclick="openEmpEdit('${e.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <a class="btn btn--ghost btn--sm" href="employee.html?id=${e.id}" title="Open dashboard"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

/* ═══ EMPLOYEE DETAIL MODAL ══════════════════════════════════════════ */
function openEmpDetail(empId) {
  const e = _employees.find(x => x.id === empId);
  if (!e) return;
  const ob = _onboarding.find(o => o.employee_id === empId);
  const obPct = ob && ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : 0;
  const allowedApps = (e.level === 'executive' ? Object.keys(APP_NAMES) : (RBAC[e.role]||['employee']));

  const docBadge = (url, label) => url
    ? `<a href="${url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);border-radius:8px;padding:5px 12px;font-size:0.76rem;font-weight:600;color:#16a34a;text-decoration:none">
        <i class="fa-solid fa-file-check"></i> View ${label}
       </a>`
    : `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:5px 12px;font-size:0.76rem;color:var(--muted)">
        <i class="fa-solid fa-file-slash"></i> ${label} not uploaded
       </span>`;

  document.getElementById('empDetailBody').innerHTML = `
    <div class="emp-detail-panel">
      <div class="emp-detail-header">
        <div class="emp-detail-avatar" style="background:${e.avatar_color||'#7c5cfc'}">${e.avatar_initials||'?'}</div>
        <div>
          <div class="emp-detail-name">${e.first_name} ${e.last_name}</div>
          <div class="emp-detail-role">${e.role||''} · ${e.department||''}</div>
          <div class="emp-detail-meta">
            <span><i class="fa-solid fa-envelope"></i> ${e.email||'—'}</span>
            <span><i class="fa-solid fa-phone"></i> ${e.phone||'—'}</span>
            ${e.employee_number ? `<span style="font-family:monospace;font-size:0.78rem"><i class="fa-solid fa-id-badge"></i> ${e.employee_number}</span>` : ''}
            ${e.start_date ? `<span><i class="fa-solid fa-calendar"></i> Started ${fmtDate(e.start_date)}</span>` : ''}
          </div>
        </div>
        <div style="margin-left:auto;text-align:right">${statusChip(e.status)}<div style="margin-top:6px"><span class="chip chip--purple">${LEVEL_LABELS[e.level]||e.level||'—'}</span></div></div>
      </div>
      <div class="emp-detail-body">
        <div class="emp-detail-grid">
          <div class="emp-detail-field"><div class="emp-detail-label">XP Points</div><div class="emp-detail-value" style="color:#7c5cfc">${(Number(e.xp_points)||0).toLocaleString()} XP</div></div>
          <div class="emp-detail-field"><div class="emp-detail-label">Streak</div><div class="emp-detail-value">${e.streak_days||0} days 🔥</div></div>
          <div class="emp-detail-field"><div class="emp-detail-label">EVA Weight</div><div class="emp-detail-value">${e.eva_weight||1.0}</div></div>
          <div class="emp-detail-field"><div class="emp-detail-label">Base Salary</div><div class="emp-detail-value">${e.base_salary ? zarM(e.base_salary)+'/mo' : '—'}</div></div>
        </div>
        ${ob ? `
          <div style="margin-bottom:20px">
            <div class="emp-detail-label" style="margin-bottom:8px">Onboarding Progress</div>
            <div style="display:flex;align-items:center;gap:12px">
              <div class="prog-bar" style="flex:1"><div class="prog-bar-fill" style="width:${obPct}%"></div></div>
              <span style="font-size:0.88rem;font-weight:700;color:var(--gold)">${obPct}%</span>
              <span class="chip chip--onboard">${ob.status.replace('_',' ')}</span>
            </div>
            <div style="font-size:0.75rem;color:var(--muted);margin-top:5px">${ob.tasks_completed||0} of ${ob.tasks_total||0} tasks complete</div>
          </div>
        ` : ''}

        <!-- Documents section -->
        <div style="margin-bottom:20px">
          <div class="emp-detail-label" style="margin-bottom:10px"><i class="fa-solid fa-folder-open" style="margin-right:6px;color:var(--gold)"></i>Employee Documents</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            ${docBadge(e.proof_of_id_url, 'Proof of ID')}
            ${docBadge(e.proof_of_banking_url, 'Proof of Banking')}
          </div>
          ${e.bank_name ? `
            <div style="margin-top:12px;font-size:0.78rem;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap">
              <span><i class="fa-solid fa-building-columns"></i> ${e.bank_name}</span>
              ${e.bank_account_number ? `<span><i class="fa-solid fa-credit-card"></i> ••••${String(e.bank_account_number).slice(-4)}</span>` : ''}
              ${e.bank_account_type ? `<span>${e.bank_account_type}</span>` : ''}
            </div>
          ` : ''}
        </div>

        <div>
          <div class="emp-detail-label" style="margin-bottom:10px">App Access (${allowedApps.length} apps)</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${allowedApps.map(k => `
              <div style="display:inline-flex;align-items:center;gap:7px;background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:5px 11px;font-size:0.76rem;font-weight:600">
                <i class="fa-solid ${APP_ICONS[k]||'fa-circle'}" style="color:${APP_COLORS[k]||'#7c5cfc'}"></i>${APP_NAMES[k]||k}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('modalDeactivateBtn').textContent = e.status === 'active' ? 'Deactivate' : 'Reactivate';
  document.getElementById('modalDeactivateBtn').onclick = () => toggleEmpStatus(empId, e.status);
  document.getElementById('modalEditBtn').onclick = () => { closeModal('empDetailModal'); openEmpEdit(empId); };
  openModal('empDetailModal');
}

/* ═══ EDIT EMPLOYEE MODAL ════════════════════════════════════════════ */
function openEmpEdit(empId) {
  _editingEmp = _employees.find(e => e.id === empId);
  if (!_editingEmp) return;
  const e = _editingEmp;

  document.getElementById('editEmpBody').innerHTML = `
    <div class="form-grid">
      <div class="form-group"><label>First Name</label><input id="e-fname" value="${e.first_name||''}"/></div>
      <div class="form-group"><label>Last Name</label><input id="e-lname" value="${e.last_name||''}"/></div>
      <div class="form-group"><label>Email</label><input id="e-email" value="${e.email||''}"/></div>
      <div class="form-group"><label>Phone</label><input id="e-phone" value="${e.phone||''}"/></div>
      <div class="form-group"><label>Employee Number</label><input id="e-empnum" value="${e.employee_number||''}" placeholder="e.g. SVC-2025-0001" style="font-family:monospace"/></div>
      <div class="form-group"><label>Role</label>
        <select id="e-role">
          ${ALL_ROLES.map(r=>`<option ${r===e.role?'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Department</label>
        <select id="e-dept">
          ${['Executive','Operations','Investments','Client Services','Compliance','Marketing','Technology','Finance'].map(d=>`<option ${d===e.department?'selected':''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Level</label>
        <select id="e-level">
          ${['junior','mid','senior','lead','executive'].map(l=>`<option value="${l}" ${l===e.level?'selected':''}>${LEVEL_LABELS[l]}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>EVA Weight</label>
        <select id="e-eva">
          ${[0.5,0.8,1.0,1.2,1.5,1.8,2.0].map(v=>`<option value="${v}" ${v==e.eva_weight?'selected':''}>×${v}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Base Salary (ZAR)</label><input id="e-salary" type="number" value="${e.base_salary||''}"/></div>
      <div class="form-group"><label>Start Date</label><input id="e-start" type="date" value="${e.start_date?e.start_date.slice(0,10):''}"/></div>
      <div class="form-group full"><label>Bio</label><textarea id="e-bio" rows="2">${e.bio||''}</textarea></div>
    </div>
  `;
  openModal('editEmpModal');
}

async function saveEmployeeEdit() {
  if (!_editingEmp) return;
  const updates = {
    first_name:      document.getElementById('e-fname').value.trim(),
    last_name:       document.getElementById('e-lname').value.trim(),
    email:           document.getElementById('e-email').value.trim(),
    phone:           document.getElementById('e-phone').value.trim(),
    employee_number: document.getElementById('e-empnum').value.trim() || null,
    role:            document.getElementById('e-role').value,
    department:      document.getElementById('e-dept').value,
    level:           document.getElementById('e-level').value,
    eva_weight:      parseFloat(document.getElementById('e-eva').value),
    base_salary:     Number(document.getElementById('e-salary').value) || null,
    start_date:      document.getElementById('e-start').value || null,
    bio:             document.getElementById('e-bio').value.trim(),
  };
  if (!updates.first_name || !updates.last_name) { showToast('First and last name are required', 'error'); return; }

  try {
    const updated = await patch(`tables/employees/${_editingEmp.id}`, updates);
    const idx = _employees.findIndex(e => e.id === _editingEmp.id);
    if (idx >= 0) _employees[idx] = { ..._employees[idx], ...updates };
    closeModal('editEmpModal');
    showToast(`${updates.first_name} ${updates.last_name} updated successfully`);
    if (_currentView === 'employees') renderEmployees();
    if (_currentView === 'overview') renderOverview();
  } catch(err) { showToast('Failed to save changes', 'error'); }
}

async function toggleEmpStatus(empId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
  await patch(`tables/employees/${empId}`, { status: newStatus });
  const idx = _employees.findIndex(e => e.id === empId);
  if (idx >= 0) _employees[idx].status = newStatus;
  closeModal('empDetailModal');
  showToast(`Employee ${newStatus === 'active' ? 'reactivated' : 'deactivated'}`);
  if (_currentView === 'employees') renderEmployees();
}

/* ═══ CREATE EMPLOYEE ════════════════════════════════════════════════ */
let _previewDebounce = null;

function wirePreviewListeners() {
  ['c-fname','c-lname','c-role','c-dept'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { clearTimeout(_previewDebounce); _previewDebounce = setTimeout(updatePreview, 200); });
  });
}

function updatePreview() {
  const fn   = (document.getElementById('c-fname')?.value||'').trim();
  const ln   = (document.getElementById('c-lname')?.value||'').trim();
  const role = document.getElementById('c-role')?.value || 'Role';
  const dept = document.getElementById('c-dept')?.value || 'Department';
  const initials = (fn[0]||'?') + (ln[0]||'');

  const av = document.getElementById('prev-avatar');
  const nm = document.getElementById('prev-name');
  const rl = document.getElementById('prev-role');
  const dt = document.getElementById('prev-dept');

  if (av) { av.textContent = initials.toUpperCase(); av.style.background = _selectedColor; }
  if (nm) nm.textContent = fn && ln ? `${fn} ${ln}` : 'New Employee';
  if (rl) rl.textContent = role;
  if (dt) dt.textContent = dept;
}

function selectColor(el) {
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
  _selectedColor = el.dataset.color;
  updatePreview();
}

function resetCreateForm() {
  ['c-fname','c-lname','c-email','c-phone','c-dob','c-idnum','c-empnum','c-bio','c-welcome'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['c-role','c-dept'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
  document.getElementById('c-level').value = 'junior';
  document.getElementById('c-eva').value   = '1.0';
  document.getElementById('c-salary').value = '';
  document.getElementById('c-start').value  = '';
  document.getElementById('c-buddy').selectedIndex = 0;
  _selectedColor = '#7c5cfc';
  document.querySelectorAll('.color-swatch').forEach((s,i) => s.classList.toggle('selected', i===0));
  updatePreview();
}

async function createEmployee() {
  const fname = document.getElementById('c-fname').value.trim();
  const lname = document.getElementById('c-lname').value.trim();
  const email = document.getElementById('c-email').value.trim().toLowerCase();
  const role  = document.getElementById('c-role').value;
  const dept  = document.getElementById('c-dept').value;

  if (!fname || !lname) { showToast('First and last name are required', 'error'); return; }
  if (!email || !email.includes('@')) { showToast('A valid email address is required', 'error'); return; }
  if (!role)  { showToast('Please select a role', 'error'); return; }
  if (!dept)  { showToast('Please select a department', 'error'); return; }

  // Check email uniqueness
  if (_employees.find(e => e.email === email)) { showToast('An employee with this email already exists', 'error'); return; }

  const btn = document.getElementById('createEmpBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…';

  const empId   = 'EMP' + String(Date.now()).slice(-6);
  const initials = (fname[0]+lname[0]).toUpperCase();
  const salary   = Number(document.getElementById('c-salary').value) || 0;
  const level    = document.getElementById('c-level').value;
  const evaWeight= parseFloat(document.getElementById('c-eva').value);
  const buddy    = document.getElementById('c-buddy').value || null;
  const welcome  = document.getElementById('c-welcome').value.trim();
  const dob      = document.getElementById('c-dob').value || null;
  const idNum    = document.getElementById('c-idnum').value.trim() || null;
  const phone    = document.getElementById('c-phone').value.trim() || null;
  const bio      = document.getElementById('c-bio').value.trim() || null;
  const startDate= document.getElementById('c-start').value || new Date().toISOString().slice(0,10);
  const empNumInput = (document.getElementById('c-empnum')?.value || '').trim();
  const year     = new Date().getFullYear();
  const empNumber = empNumInput || `SVC-${year}-${String(_employees.length + 1).padStart(4, '0')}`;

  try {
    // 1. Create employee record
    const emp = await post('tables/employees', {
      id:               empId,
      first_name:       fname,
      last_name:        lname,
      email:            email,
      phone:            phone || null,
      role:             role,
      department:       dept,
      level:            level,
      avatar_initials:  initials,
      avatar_color:     _selectedColor,
      base_salary:      salary || 0,
      hire_date:        startDate,   // schema primary date column
      start_date:       startDate,   // convenience alias (also in schema)
      birth_date:       dob || null,
      id_number:        idNum || null,
      employee_number:  empNumber,
      bio:              bio || null,
      status:           'active',
      eva_weight:       evaWeight || 1.0,
      xp_points:        0,
      streak_days:      0,
      badges:           JSON.stringify([]),   // JSONB column — must be serialised
    });
    _employees.push(emp);

    // 2. Auto-enrol in the 3 onboarding courses (fire-and-forget — don't block employee creation)
    const onboardingCourses = ['CRS-OB-001','CRS-OB-002','CRS-OB-003'];
    for (const cid of onboardingCourses) {
      try {
        await post('tables/course_progress', {
          employee_id:        empId,
          course_id:          cid,
          status:             'enrolled',
          current_module:     1,
          modules_completed:  JSON.stringify([]),
          quiz_scores:        JSON.stringify([]),
          overall_quiz_score: 0,
          xp_earned:          0,
          kpi_applied:        false,
          started_at:         new Date().toISOString(),
        });
      } catch (_) { /* non-blocking — employee still created */ }
    }

    // 3. Create onboarding record with default task list
    const defaultTasks = buildDefaultTasks(empId);
    const obRecord = await post('tables/employee_onboarding', {
      employee_id:     empId,
      started_at:      new Date().toISOString(),
      status:          'in_progress',
      tasks_total:     defaultTasks.length,
      tasks_completed: 0,
      welcome_message: welcome || `Welcome to SV Capital, ${fname}! We're thrilled to have you on the team. Your onboarding journey starts now — please complete the steps below to get set up and ready to hit the ground running.`,
      assigned_buddy:  buddy || null,
      notes:           '',
      created_by:      _session.empId,
    });
    _onboarding.push(obRecord);

    // 4. Log activity
    await post('tables/activity_feed', {
      employee_id: empId,
      type:        'onboarding_started',
      title:       `Welcome to SV Capital, ${fname}!`,
      body:        `Your onboarding journey has started. Complete ${defaultTasks.length} steps to get fully set up.`,
      icon:        'fa-rocket',
      color:       '#f59e0b',
      xp_shown:    0,
      is_public:   true,
      created_at:  new Date().toISOString(),
    });

    showToast(`✅ ${fname} ${lname} created! Onboarding journey started.`);
    resetCreateForm();
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Employee & Start Onboarding';

    // Update pending badge
    const pending = _onboarding.filter(o => o.status === 'in_progress' || o.status === 'not_started');
    const badge = document.getElementById('pending-ob-badge');
    if (badge) { badge.textContent = pending.length; badge.style.display = pending.length ? '' : 'none'; }

    // Navigate to their onboarding
    setTimeout(() => navTo('onboarding', document.querySelector('[data-view=onboarding]')), 1200);

  } catch(err) {
    console.error(err);
    showToast('Failed to create employee. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Employee & Start Onboarding';
  }
}

function buildDefaultTasks(empId) {
  return [
    { task_key:'complete_profile',    category:'setup',      title:'Complete your profile',            description:'Add your phone number, date of birth, SA ID number, and emergency contact details.',              action_label:'Go to My Profile',    action_view:'profile',      icon:'fa-id-card',         xp_reward:50,  order_index:1,  is_required:true  },
    { task_key:'add_banking',         category:'setup',      title:'Add banking details',               description:'Add your bank account information for EVA bonus payments. All details are encrypted.',            action_label:'Go to My Profile',    action_view:'profile',      icon:'fa-building-columns', xp_reward:50,  order_index:2,  is_required:true  },
    { task_key:'course_orientation',  category:'learning',   title:'Complete: Welcome to SV Capital',   description:'Your first course — learn our story, products, values, and how you contribute to AUM growth.',     action_label:'Start Course',        action_view:'courses',      icon:'fa-gem',             xp_reward:200, order_index:3,  is_required:true  },
    { task_key:'course_platform',     category:'learning',   title:'Complete: Platform Walkthrough',    description:'A guided tour of every app on the staff platform. Learn how EVA, XP, and KPIs all connect.',       action_label:'Start Course',        action_view:'courses',      icon:'fa-laptop-code',     xp_reward:250, order_index:4,  is_required:true  },
    { task_key:'course_compliance',   category:'compliance', title:'Complete: Compliance & FICA',       description:'Mandatory for all employees. Covers FSCA regulation, FICA, POPIA, AML and your legal duties.',    action_label:'Start Course',        action_view:'courses',      icon:'fa-shield-halved',   xp_reward:200, order_index:5,  is_required:true  },
    { task_key:'first_checkin',       category:'system',     title:'Do your first daily check-in',      description:'Start building your attendance streak today. Takes 30 seconds — log your mood and plan your day.', action_label:'Daily Check-in',      action_view:'checkin',      icon:'fa-sun',             xp_reward:20,  order_index:6,  is_required:true  },
    { task_key:'set_first_okr',       category:'system',     title:'Set your first OKR',                description:'Create one objective with 3 key results for this period. Align it to your role\'s main KPI.',     action_label:'My OKRs',             action_view:'okrs',         icon:'fa-bullseye',        xp_reward:50,  order_index:7,  is_required:false },
    { task_key:'give_first_kudos',    category:'social',     title:'Give a colleague kudos',            description:'Welcome yourself to the team by giving a shout-out to a colleague. +25 XP for you.',             action_label:'Feedback & Kudos',    action_view:'feedback',     icon:'fa-hands-clapping',  xp_reward:25,  order_index:8,  is_required:false },
    { task_key:'view_eva_statement',  category:'system',     title:'Review your EVA statement',         description:'Understand exactly how your variable pay bonus is calculated — completely transparently.',         action_label:'EVA Statement',       action_view:'eva',          icon:'fa-money-bill-trend-up',xp_reward:20,order_index:9, is_required:false },
    { task_key:'upload_proof_banking',category:'compliance', title:'Upload proof of banking',           description:'Upload a bank statement or cancelled cheque to verify your banking details.',                     action_label:'Go to My Profile',    action_view:'profile',      icon:'fa-file-invoice',    xp_reward:30,  order_index:10, is_required:true  },
  ];
}

/* ═══ ONBOARDING VIEW ════════════════════════════════════════════════ */
function renderOnboardingView() {
  const filter = document.getElementById('ob-filter')?.value || 'all';
  let list = [..._onboarding];
  if (filter !== 'all') list = list.filter(o => o.status === filter);
  if (!list.length) { document.getElementById('onboardingList').innerHTML = `<div class="dir-empty"><i class="fa-solid fa-rocket"></i><h3>No onboarding records</h3><p>Create a new employee to start an onboarding journey.</p></div>`; return; }

  document.getElementById('onboardingList').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      ${list.map(ob => {
        const emp = _employees.find(e => e.id === ob.employee_id);
        if (!emp) return '';
        const pct = ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : 0;
        const buddy = _employees.find(e => e.id === ob.assigned_buddy);
        return `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;cursor:pointer" onclick="openObDetail('${ob.id}')">
            <div style="padding:18px 20px;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
                <div class="emp-row-avatar" style="background:${emp.avatar_color||'#7c5cfc'};width:42px;height:42px;font-size:0.85rem">${emp.avatar_initials||'?'}</div>
                <div style="flex:1">
                  <div style="font-size:0.92rem;font-weight:800">${emp.first_name} ${emp.last_name}</div>
                  <div style="font-size:0.75rem;color:var(--muted)">${emp.role||''} · ${emp.department||''}</div>
                </div>
                ${obStatusChip(ob.status)}
              </div>
              <div class="prog-bar" style="height:8px"><div class="prog-bar-fill" style="width:${pct}%;background:${pct>=100?'var(--teal)':'var(--gold)'}"></div></div>
              <div style="display:flex;justify-content:space-between;margin-top:7px;font-size:0.75rem;color:var(--muted)">
                <span>${ob.tasks_completed||0} of ${ob.tasks_total||0} tasks</span>
                <span style="font-weight:700;color:${pct>=100?'var(--teal)':'var(--gold)'}">${pct}% complete</span>
              </div>
            </div>
            <div style="padding:12px 20px;display:flex;align-items:center;justify-content:space-between;font-size:0.76rem;color:var(--muted)">
              <span><i class="fa-solid fa-calendar" style="margin-right:5px"></i>Started ${fmtDate(ob.started_at)}</span>
              ${buddy ? `<span><i class="fa-solid fa-user-group" style="margin-right:5px"></i>Buddy: ${buddy.first_name}</span>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function openObDetail(obId) {
  const ob = _onboarding.find(o => o.id === obId);
  if (!ob) return;
  const emp = _employees.find(e => e.id === ob.employee_id);
  if (!emp) return;
  const pct = ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : 0;
  const buddy = _employees.find(e => e.id === ob.assigned_buddy);
  const defaultTasks = buildDefaultTasks(ob.employee_id);

  document.getElementById('obDetailBody').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--border)">
      <div class="emp-row-avatar" style="background:${emp.avatar_color||'#7c5cfc'};width:52px;height:52px;font-size:1rem">${emp.avatar_initials||'?'}</div>
      <div style="flex:1">
        <div style="font-size:1.1rem;font-weight:800">${emp.first_name} ${emp.last_name}</div>
        <div style="font-size:0.8rem;color:var(--muted)">${emp.role||''} · ${emp.department||''}</div>
        ${buddy ? `<div style="font-size:0.75rem;color:var(--gold);margin-top:3px"><i class="fa-solid fa-user-group"></i> Buddy: ${buddy.first_name} ${buddy.last_name}</div>` : ''}
      </div>
      <div style="text-align:right">${obStatusChip(ob.status)}<div style="font-size:1.6rem;font-weight:900;color:var(--gold);margin-top:4px">${pct}%</div></div>
    </div>
    ${ob.welcome_message ? `
      <div class="dir-alert dir-alert--info" style="margin-bottom:20px">
        <i class="fa-solid fa-message"></i>
        <div><strong>Welcome message:</strong><br>${ob.welcome_message}</div>
      </div>
    ` : ''}
    <div style="margin-bottom:12px">
      <div class="prog-bar" style="height:10px"><div class="prog-bar-fill" style="width:${pct}%"></div></div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:6px">${ob.tasks_completed||0} of ${ob.tasks_total||0} tasks complete</div>
    </div>
    <div class="dir-sec-title" style="margin-bottom:12px">Onboarding Checklist</div>
    <div class="ob-checklist">
      ${defaultTasks.map((t, i) => {
        const isDone = (ob.tasks_completed||0) > i;
        const catColors = { setup:'#7c5cfc', learning:'#00d4aa', compliance:'#e84393', system:'#f59e0b', social:'#fb923c' };
        return `
          <div class="ob-task ${isDone?'done':''}">
            <div class="ob-task-check">${isDone?'<i class="fa-solid fa-check"></i>':''}</div>
            <div class="ob-task-icon" style="background:${catColors[t.category]||'#7c5cfc'}20;color:${catColors[t.category]||'#7c5cfc'}"><i class="fa-solid ${t.icon}"></i></div>
            <div style="flex:1">
              <div class="ob-task-title">${t.title}</div>
              <div class="ob-task-desc">${t.description}</div>
              <div class="ob-task-xp">+${t.xp_reward} XP ${t.is_required ? '· <span style="color:var(--danger)">Required</span>' : ''}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  const startBtn = document.getElementById('obStartBtn');
  startBtn.textContent = ob.status === 'completed' ? '✓ Completed' : 'View Employee Dashboard';
  startBtn.onclick = () => { window.open('employee.html?id=' + emp.id, '_blank'); };
  openModal('obDetailModal');
}

/* ═══ PAYSLIPS ══════════════════════════════════════════════════════ */

function calcAnnualTax(annualIncome) {
  const tiers = [
    [0,       237100,   0,      0.18],
    [237100,  370500,   42678,  0.26],
    [370500,  512800,   77362,  0.31],
    [512800,  673000,   121475, 0.36],
    [673000,  857900,   179147, 0.39],
    [857900,  1817000,  251258, 0.41],
    [1817000, Infinity, 644489, 0.45],
  ];
  let tax = 0;
  for (const [floor, ceil, base, rate] of tiers) {
    if (annualIncome <= floor) break;
    tax = base + (Math.min(annualIncome, ceil) - floor) * rate;
    if (annualIncome <= ceil) break;
  }
  return Math.max(0, tax - 17235);
}

function calcMonthlyPAYE(monthly) {
  return Math.round(calcAnnualTax(monthly * 12) / 12 * 100) / 100;
}

function calcUIF(gross) {
  return Math.min(Math.round(gross * 0.01 * 100) / 100, 177.12);
}

function renderPayslips() {
  const el = document.getElementById('payslipsContent');
  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  let periodOptions = '';
  for (let i = 0; i < 24; i++) {
    let m = currentMonth - i, y = currentYear;
    while (m <= 0) { m += 12; y--; }
    const val = `${y}-${String(m).padStart(2,'0')}`;
    periodOptions += `<option value="${val}" ${i===0?'selected':''}>${MONTHS[m-1]} ${y}</option>`;
  }

  const empOptions = _employees
    .filter(e => e.status === 'active')
    .sort((a,b) => (a.first_name+a.last_name).localeCompare(b.first_name+b.last_name))
    .map(e => `<option value="${e.id}">${e.first_name} ${e.last_name} · ${e.role||'—'}</option>`)
    .join('');

  const history = [..._payslips]
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start">

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px">
        <div style="font-size:1rem;font-weight:800;margin-bottom:18px;display:flex;align-items:center;gap:10px">
          <i class="fa-solid fa-file-invoice-dollar" style="color:var(--gold)"></i> Generate Payslip
        </div>
        <div class="form-grid">
          <div class="form-group full"><label>Employee <span class="req">*</span></label>
            <select id="ps-emp">${empOptions}</select>
          </div>
          <div class="form-group full"><label>Pay Period <span class="req">*</span></label>
            <select id="ps-period">${periodOptions}</select>
          </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Earnings</div>
          <div class="form-grid">
            <div class="form-group"><label>Basic Salary (ZAR)</label>
              <input id="ps-salary" type="number" placeholder="0.00"/>
            </div>
            <div class="form-group"><label>Bonus / Commission</label>
              <input id="ps-bonus" type="number" placeholder="0.00"/>
            </div>
            <div class="form-group"><label>Other Earnings</label>
              <input id="ps-other-earn" type="number" placeholder="0.00"/>
            </div>
          </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">
            Deductions <span style="font-weight:400;text-transform:none;letter-spacing:0">(auto-calculated, editable)</span>
          </div>
          <div class="form-grid">
            <div class="form-group"><label>PAYE Tax</label><input id="ps-tax" type="number" placeholder="auto"/></div>
            <div class="form-group"><label>UIF (employee)</label><input id="ps-uif" type="number" placeholder="auto"/></div>
            <div class="form-group"><label>Other Deductions</label><input id="ps-other-ded" type="number" placeholder="0.00"/></div>
          </div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
          <div style="font-size:0.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Notes (optional)</div>
          <textarea id="ps-notes" rows="2" style="width:100%;border:1.5px solid var(--border);border-radius:8px;padding:8px 10px;font-size:0.82rem;font-family:var(--font);resize:none;outline:none"></textarea>
        </div>
        <div id="ps-preview" style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.2);border-radius:10px;padding:14px;margin-top:16px">
          <div style="font-size:0.7rem;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Preview</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem">
            <div style="color:var(--muted)">Total Earnings</div><div id="pv-earn" style="text-align:right;font-weight:600">R 0.00</div>
            <div style="color:var(--muted)">Total Deductions</div><div id="pv-ded" style="text-align:right;font-weight:600">R 0.00</div>
            <div style="font-weight:700;font-size:0.88rem">Nett Pay</div><div id="pv-nett" style="text-align:right;font-weight:800;font-size:0.88rem;color:var(--gold)">R 0.00</div>
          </div>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn--gold" style="width:100%" id="psGenerateBtn">
            <i class="fa-solid fa-file-circle-plus"></i> Generate &amp; Save
          </button>
        </div>
      </div>

      <div>
        <div style="font-size:1rem;font-weight:800;margin-bottom:14px;display:flex;align-items:center;gap:10px">
          <i class="fa-solid fa-clock-rotate-left" style="color:var(--accent)"></i> Generated Payslips
        </div>
        <div id="ps-history">
          ${history.length === 0
            ? `<div class="dir-empty"><i class="fa-solid fa-file-invoice-dollar"></i><h3>No payslips yet</h3><p>Generate the first payslip using the form.</p></div>`
            : history.map(p => {
                const emp = _employees.find(e => e.id === p.employee_id);
                const label = emp ? `${emp.first_name} ${emp.last_name}` : p.employee_id;
                const [yr,mo] = p.pay_period.split('-');
                const moLabel = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo,10)-1] || mo;
                return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:14px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(245,158,11,0.1);color:var(--gold);display:flex;align-items:center;justify-content:center;flex-shrink:0">
                    <i class="fa-solid fa-file-invoice-dollar"></i>
                  </div>
                  <div style="flex:1;min-width:0">
                    <div style="font-weight:700;font-size:0.85rem">${label}</div>
                    <div style="font-size:0.73rem;color:var(--muted)">${moLabel} ${yr} · Nett R ${Number(p.nett_pay||0).toLocaleString('en-ZA',{minimumFractionDigits:2})}</div>
                  </div>
                  <button class="btn btn--ghost btn--sm" onclick="printPayslip('${p.id}')"><i class="fa-solid fa-print"></i> Print</button>
                  <button class="btn btn--danger btn--sm" style="opacity:0.7" onclick="deletePayslip('${p.id}')"><i class="fa-solid fa-trash"></i></button>
                </div>`;
              }).join('')
          }
        </div>
      </div>
    </div>
  `;

  // Wire inputs → live preview
  ['ps-salary','ps-bonus','ps-other-earn','ps-other-ded'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', _updatePayslipCalcs);
  });

  // Employee change → auto-fill salary
  document.getElementById('ps-emp')?.addEventListener('change', () => {
    const emp = _employees.find(e => e.id === document.getElementById('ps-emp').value);
    if (emp?.base_salary) {
      document.getElementById('ps-salary').value = Number(emp.base_salary).toFixed(2);
      _updatePayslipCalcs();
    }
  });

  // Generate button
  document.getElementById('psGenerateBtn')?.addEventListener('click', generatePayslip);

  // Pre-fill first employee's salary
  const firstEmpId = document.getElementById('ps-emp')?.value;
  const firstEmp = _employees.find(e => e.id === firstEmpId);
  if (firstEmp?.base_salary) {
    document.getElementById('ps-salary').value = Number(firstEmp.base_salary).toFixed(2);
    _updatePayslipCalcs();
  }
}

function _updatePayslipCalcs() {
  const salary    = parseFloat(document.getElementById('ps-salary')?.value)    || 0;
  const bonus     = parseFloat(document.getElementById('ps-bonus')?.value)     || 0;
  const otherEarn = parseFloat(document.getElementById('ps-other-earn')?.value)|| 0;
  const otherDed  = parseFloat(document.getElementById('ps-other-ded')?.value) || 0;

  const totalEarnings = salary + bonus + otherEarn;
  const tax = calcMonthlyPAYE(totalEarnings);
  const uif = calcUIF(totalEarnings);

  document.getElementById('ps-tax').value = tax.toFixed(2);
  document.getElementById('ps-uif').value = uif.toFixed(2);

  const totalDed = tax + uif + otherDed;
  const nett     = totalEarnings - totalDed;
  const fmt = n => `R ${n.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('pv-earn', fmt(totalEarnings));
  set('pv-ded',  fmt(totalDed));
  set('pv-nett', fmt(nett));
}

async function generatePayslip() {
  const empId  = document.getElementById('ps-emp')?.value;
  const period = document.getElementById('ps-period')?.value;
  if (!empId || !period) { showToast('Select an employee and pay period', 'error'); return; }
  if (_payslips.find(p => p.employee_id === empId && p.pay_period === period)) {
    showToast('A payslip for this employee and period already exists', 'error'); return;
  }

  const salary    = parseFloat(document.getElementById('ps-salary').value)    || 0;
  const bonus     = parseFloat(document.getElementById('ps-bonus').value)     || 0;
  const otherEarn = parseFloat(document.getElementById('ps-other-earn').value)|| 0;
  const tax       = parseFloat(document.getElementById('ps-tax').value)       || 0;
  const uif       = parseFloat(document.getElementById('ps-uif').value)       || 0;
  const otherDed  = parseFloat(document.getElementById('ps-other-ded').value) || 0;
  const notes     = document.getElementById('ps-notes').value.trim();

  const totalEarnings = salary + bonus + otherEarn;
  const totalDed      = tax + uif + otherDed;
  const nett          = totalEarnings - totalDed;
  const uifCompany    = calcUIF(totalEarnings);

  // YTD: sum all payslips for this employee in the same SA tax year (April–March)
  const [yr, mo] = period.split('-').map(Number);
  const taxYearStart = mo >= 4 ? `${yr}-04` : `${yr-1}-04`;
  const prior = _payslips.filter(p => p.employee_id === empId && p.pay_period >= taxYearStart && p.pay_period < period);
  const ytdEarnings = prior.reduce((s,p) => s + Number(p.total_earnings||0), 0) + totalEarnings;
  const ytdTax      = prior.reduce((s,p) => s + Number(p.tax||0), 0) + tax;

  // Pay date = last day of the pay period month
  const [yr2, mo2] = period.split('-');
  const payDate = `${yr2}-${mo2}-${new Date(Number(yr2), Number(mo2), 0).getDate()}`;

  const btn = document.getElementById('psGenerateBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

  try {
    const saved = await post('tables/payslips', {
      id:                                 'PAY' + String(Date.now()).slice(-9),
      employee_id:                        empId,
      pay_period:                         period,
      pay_date:                           payDate,
      basic_salary:                       salary,
      bonus,
      other_earnings:                     otherEarn,
      total_earnings:                     totalEarnings,
      tax,
      uif_employee:                       uif,
      other_deductions:                   otherDed,
      total_deductions:                   totalDed,
      nett_pay:                           nett,
      uif_company:                        uifCompany,
      ytd_taxable_earnings:               ytdEarnings,
      ytd_tax_paid:                       ytdTax,
      ytd_taxable_company_contributions:  0,
      ytd_taxable_fringe_benefits:        0,
      ytd_provision_annual_bonus:         0,
      notes,
      generated_by: _session.empId,
    });
    _payslips.push(saved);
    showToast('Payslip generated successfully!');
    printPayslip(saved.id);
    renderPayslips();
  } catch(err) {
    showToast('Failed to save payslip', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-file-circle-plus"></i> Generate &amp; Save';
  }
}

async function deletePayslip(id) {
  if (!confirm('Delete this payslip? This cannot be undone.')) return;
  await del(`tables/payslips/${id}`);
  _payslips = _payslips.filter(p => p.id !== id);
  showToast('Payslip deleted');
  renderPayslips();
}

function printPayslip(id) {
  const p   = _payslips.find(x => x.id === id);
  const emp = p ? _employees.find(e => e.id === p.employee_id) : null;
  if (!p || !emp) { showToast('Payslip not found', 'error'); return; }
  const w = window.open('', '_blank', 'width=900,height=720');
  if (!w) { showToast('Allow pop-ups to print payslips', 'error'); return; }
  w.document.write(buildPayslipHTML(p, emp));
  w.document.close();
  w.onload = () => w.print();
}

function buildPayslipHTML(p, emp) {
  const fmt = n => Number(n||0).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2});
  const maskAcc = n => { const s=String(n||''); return s.length>4?'*'.repeat(s.length-4)+s.slice(-4):s; };
  const rph = (Number(emp.base_salary||0)/173.33).toFixed(5);
  const payDateFmt = (p.pay_date||'').replace(/-/g,'/');
  const startFmt = emp.start_date?emp.start_date.slice(0,10).replace(/-/g,'/'):'—';
  const empCode = emp.employee_number||emp.id;
  const addrParts = [emp.address_line1,emp.address_line2,emp.address_city,emp.address_province,emp.address_postal_code].filter(Boolean);
  const addrHtml = addrParts.length?addrParts.join(', '):'—';
  const [yr,mo] = (p.pay_period||'').split('-');
  const moLabel = ['January','February','March','April','May','June','July','August','September','October','November','December'][(parseInt(mo,10)||1)-1]||mo;
  const LOGO = 'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGhlaWdodD0iMTA2LjkyMSIgdmlld0JveD0iMCAwIDQzMS4yMTggMTA2LjkyMSIgd2lkdGg9IjQzMS4yMTgiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGdyYWRpZW50VW5pdHM9Im9iamVjdEJvdW5kaW5nQm94IiBpZD0ibGluZWFyLWdyYWRpZW50IiB4MT0iMC44NzQiIHgyPSIwLjExIiB5MT0iMC4wMzQiIHkyPSIwLjk4NiI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmOWIwYyIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuMjA0IiBzdG9wLWNvbG9yPSIjZmY5NDBlIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC40OTIiIHN0b3AtY29sb3I9IiNmZjgyMTUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjgyNyIgc3RvcC1jb2xvcj0iI2ZmNjQyMSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuOTk3IiBzdG9wLWNvbG9yPSIjZmY1MjI5Ii8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGdyYWRpZW50VW5pdHM9Im9iamVjdEJvdW5kaW5nQm94IiBpZD0ibGluZWFyLWdyYWRpZW50LTIiIHgxPSIwLjUiIHgyPSIwLjUiIHkxPSIwLjAyNyIgeTI9IjAuOTk0Ij4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjZWRhNWZmIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMC4xNzUiIHN0b3AtY29sb3I9IiNlZmE5ZTUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjU0OSIgc3RvcC1jb2xvcj0iI2Y1YjNhNCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmZWMyNGYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgZ3JhZGllbnRVbml0cz0ib2JqZWN0Qm91bmRpbmdCb3giIGlkPSJsaW5lYXItZ3JhZGllbnQtMyIgeDI9IjEiIHkxPSIwLjUiIHkyPSIwLjUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM2NWVkMDAiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjk5NyIgc3RvcC1jb2xvcj0iIzAwOTZmZiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC00IiB4Mj0iMSIgeTE9IjAuNSIgeTI9IjAuNSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMC4wMDMiIHN0b3AtY29sb3I9IiMwMDk2ZmYiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNjVlZDAwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGhyZWY9IiNsaW5lYXItZ3JhZGllbnQtMyIgaWQ9ImxpbmVhci1ncmFkaWVudC01IiB4MT0iMC45NDMiIHgyPSIwLjAyNyIgeTE9IjAuMDQ0IiB5Mj0iMC45ODYiLz4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC02IiB4MT0iMC4xMzEiIHgyPSIwLjg4OSIgeTE9IjAuMDI5IiB5Mj0iMC45OTYiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAuMDAzIiBzdG9wLWNvbG9yPSIjZmZlODZhIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2ZmYjc4MiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC03IiB4MT0iMC4wNDkiIHgyPSIwLjk2NSIgeTE9IjAuMDQ0IiB5Mj0iMC45NzEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmZjliMGMiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjk5NyIgc3RvcC1jb2xvcj0iI2ZmNTIyOSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBncmFkaWVudFVuaXRzPSJvYmplY3RCb3VuZGluZ0JveCIgaWQ9ImxpbmVhci1ncmFkaWVudC04IiB4MT0iMC41IiB4Mj0iMC41IiB5MT0iMC4wNTYiIHkyPSIwLjg5MSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZlYzI0ZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNlZmE5ZTYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxnIGlkPSJMb2dvIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwKSI+CiAgICA8ZyBkYXRhLW5hbWU9Ikdyb3VwIDMxNDEiIGlkPSJHcm91cF8zMTQxIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMzg2MyAzMjY5LjgyNSkiPgogICAgICA8cGF0aCBkPSJNLTE0My4xNTYtMTMuMi0xNDguMTE1LDBoLTIuNTA4TC0xNTUuNi0xMy4yaDIuMzE4bDMuOTE0LDEwLjk4MiwzLjkzMy0xMC45ODJabTEyLjczLDcuNzE0YTYuNzcxLDYuNzcxLDAsMCwxLS4wNzYsMS4wNjRoLThhMi45LDIuOSwwLDAsMCwuOTMxLDIuMDE0LDIuOTM5LDIuOTM5LDAsMCwwLDIuMDUyLjc2LDIuNTM0LDIuNTM0LDAsMCwwLDIuNDctMS40NjNoMi4zMzdBNC43MTYsNC43MTYsMCwwLDEtMTMyLjQzLS43NTFhNS4wNDUsNS4wNDUsMCwwLDEtMy4wODguOTIyQTUuMzQ3LDUuMzQ3LDAsMCwxLTEzOC4yMDYtLjVhNC44LDQuOCwwLDAsMS0xLjg2Mi0xLjksNS44LDUuOCwwLDAsMS0uNjc0LTIuODQxLDUuOTMyLDUuOTMyLDAsMCwxLC42NTYtMi44NDEsNC42MSw0LjYxLDAsMCwxLDEuODQzLTEuODksNS40ODUsNS40ODUsMCwwLDEsMi43MjYtLjY2NSw1LjMzMiw1LjMzMiwwLDAsMSwyLjY0MS42NDYsNC41NjUsNC41NjUsMCwwLDEsMS44LDEuODE1QTUuNDY1LDUuNDY1LDAsMCwxLTEzMC40MjUtNS40OTFabS0yLjI2MS0uNjg0YTIuNDY1LDIuNDY1LDAsMCwwLS44NTUtMS45MTksMy4wNTcsMy4wNTcsMCwwLDAtMi4wNzEtLjcyMiwyLjc4MiwyLjc4MiwwLDAsMC0xLjkxOS43MTMsMi45NzgsMi45NzgsMCwwLDAtLjk1LDEuOTI4Wm0xMS00LjQ2NWE0LjcsNC43LDAsMCwxLDIuMjE0LjUxMywzLjY0OCwzLjY0OCwwLDAsMSwxLjUyOSwxLjUyLDUsNSwwLDAsMSwuNTUxLDIuNDMyVjBoLTIuMTQ3Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1NywyLjUsMi41LDAsMCwwLTEuOTE5LS43NSwyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NSwzLjAxMywzLjAxMywwLDAsMC0uNzEyLDIuMTU3VjBoLTIuMTY2Vi0xMC40NjloMi4xNjZ2MS4yYTMuNTg1LDMuNTg1LDAsMCwxLDEuMzU4LTEuMDA3QTQuMzQzLDQuMzQzLDAsMCwxLTEyMS42ODYtMTAuNjRaTS0xMTAuNzgtOC43djUuNzk1YTEuMTEyLDEuMTEyLDAsMCwwLC4yNzUuODQ2LDEuMzcsMS4zNywwLDAsMCwuOTQuMjU2aDEuMzNWMGgtMS43MWEzLjMsMy4zLDAsMCwxLTIuMjQyLS42ODQsMi44MTksMi44MTksMCwwLDEtLjc3OS0yLjIyM1YtOC43SC0xMTQuMnYtMS43NjdoMS4yMzV2LTIuNmgyLjE4NXYyLjZoMi41NDZWLTguN1ptMTUuMzUyLTEuNzY3VjBoLTIuMTY2Vi0xLjIzNWEzLjUwNiwzLjUwNiwwLDAsMS0xLjM0LDEuMDE2LDQuMjQ3LDQuMjQ3LDAsMCwxLTEuNzU3LjM3MUE0LjcsNC43LDAsMCwxLTEwMi45LS4zNjFhMy43MDYsMy43MDYsMCwwLDEtMS41MzktMS41MkE0LjkzMSw0LjkzMSwwLDAsMS0xMDUtNC4zMTN2LTYuMTU2aDIuMTQ3djUuODMzYTMuMDM5LDMuMDM5LDAsMCwwLC43LDIuMTU3LDIuNSwyLjUsMCwwLDAsMS45MTkuNzUxLDIuNTMzLDIuNTMzLDAsMCwwLDEuOTI5LS43NTEsMy4wMTMsMy4wMTMsMCwwLDAsLjcxMi0yLjE1N3YtNS44MzNabTYuMzQ2LDEuNTJhMy40LDMuNCwwLDAsMSwxLjI2My0xLjI0NSwzLjczNywzLjczNywwLDAsMSwxLjg3MS0uNDQ3Vi04LjRILTg2LjVhMi42MzgsMi42MzgsMCwwLDAtMS45MjkuNjQ2LDMuMDg5LDMuMDg5LDAsMCwwLS42NTUsMi4yNDJWMGgtMi4xNjZWLTEwLjQ2OWgyLjE2NlptMTYuMDU1LDMuNDU4QTYuNzcyLDYuNzcyLDAsMCwxLTczLjEtNC40MjdoLThhMi45LDIuOSwwLDAsMCwuOTMxLDIuMDE0LDIuOTM5LDIuOTM5LDAsMCwwLDIuMDUyLjc2LDIuNTM0LDIuNTM0LDAsMCwwLDIuNDctMS40NjNoMi4zMzdBNC43MTYsNC43MTYsMCwwLDEtNzUuMDMxLS43NTFhNS4wNDUsNS4wNDUsMCwwLDEtMy4wODguOTIyQTUuMzQ3LDUuMzQ3LDAsMCwxLTgwLjgwNy0uNWE0LjgsNC44LDAsMCwxLTEuODYyLTEuOSw1LjgsNS44LDAsMCwxLS42NzQtMi44NDEsNS45MzIsNS45MzIsMCwwLDEsLjY1NS0yLjg0MSw0LjYxLDQuNjEsMCwwLDEsMS44NDMtMS44OSw1LjQ4NSw1LjQ4NSwwLDAsMSwyLjcyNy0uNjY1LDUuMzMyLDUuMzMyLDAsMCwxLDIuNjQxLjY0Niw0LjU2NSw0LjU2NSwwLDAsMSwxLjgwNSwxLjgxNUE1LjQ2NSw1LjQ2NSwwLDAsMS03My4wMjctNS40OTFabS0yLjI2MS0uNjg0YTIuNDY1LDIuNDY1LDAsMCwwLS44NTUtMS45MTksMy4wNTcsMy4wNTcsMCwwLDAtMi4wNzEtLjcyMiwyLjc4MiwyLjc4MiwwLDAsMC0xLjkxOS43MTMsMi45NzgsMi45NzgsMCwwLDAtLjk1LDEuOTI4Wm0xOS4wNTctLjYwOGEyLjkyLDIuOTIsMCwwLDEsMS44MDUsMS4xMjEsMy4zLDMuMywwLDAsMSwuNzQxLDIuMTA5LDMuMjY4LDMuMjY4LDAsMCwxLS41MjMsMS44MTUsMy41NDEsMy41NDEsMCwwLDEtMS41MSwxLjI3Myw1LjM0LDUuMzQsMCwwLDEtMi4zLjQ2NUgtNjMuM1YtMTMuMmg1LjAzNWE1LjQsNS40LDAsMCwxLDIuMzE4LjQ1NiwzLjQsMy40LDAsMCwxLDEuNDYzLDEuMjI2LDMuMTE2LDMuMTE2LDAsMCwxLC40OTQsMS43MkEyLjk0NSwyLjk0NSwwLDAsMS01NC42LTcuOSwzLjU0LDMuNTQsMCwwLDEtNTYuMjMxLTYuNzgzWm0tNC45LS44NzRoMi42NzlhMi41NzMsMi41NzMsMCwwLDAsMS42NjItLjQ4NCwxLjY5MiwxLjY5MiwwLDAsMCwuNi0xLjQsMS43MjYsMS43MjYsMCwwLDAtLjYtMS40LDIuNTA2LDIuNTA2LDAsMCwwLTEuNjYyLS41aC0yLjY3OVptMi45MjYsNS44OUEyLjU4OSwyLjU4OSwwLDAsMC01Ni40NzgtMi4zYTEuODM4LDEuODM4LDAsMCwwLC42MjctMS40ODIsMS45MjMsMS45MjMsMCwwLDAtLjY2NS0xLjUzOSwyLjYyMiwyLjYyMiwwLDAsMC0xLjc2Ny0uNTdoLTIuODV2NC4xMjNabTE3LjgtMy43MjRhNi43NzIsNi43NzIsMCwwLDEtLjA3NiwxLjA2NGgtOGEyLjksMi45LDAsMCwwLC45MzEsMi4wMTQsMi45MzksMi45MzksMCwwLDAsMi4wNTIuNzYsMi41MzQsMi41MzQsMCwwLDAsMi40Ny0xLjQ2M2gyLjMzN2E0LjcxNiw0LjcxNiwwLDAsMS0xLjcyLDIuMzY2QTUuMDQ1LDUuMDQ1LDAsMCwxLTQ1LjUuMTcxLDUuMzQ3LDUuMzQ3LDAsMCwxLTQ4LjE4NC0uNWE0LjgsNC44LDAsMCwxLTEuODYyLTEuOSw1LjgsNS44LDAsMCwxLS42NzQtMi44NDEsNS45MzIsNS45MzIsMCwwLDEsLjY1Ni0yLjg0MSw0LjYxLDQuNjEsMCwwLDEsMS44NDMtMS44OUE1LjQ4NSw1LjQ4NSwwLDAsMS00NS41LTEwLjY0YTUuMzMyLDUuMzMyLDAsMCwxLDIuNjQxLjY0Niw0LjU2NSw0LjU2NSwwLDAsMSwxLjgwNSwxLjgxNUE1LjQ2NSw1LjQ2NSwwLDAsMS00MC40LTUuNDkxWm0tMi4yNjEtLjY4NGEyLjQ2NSwyLjQ2NSwwLDAsMC0uODU1LTEuOTE5LDMuMDU3LDMuMDU3LDAsMCwwLTIuMDcxLS43MjIsMi43ODIsMi43ODIsMCwwLDAtMS45MTkuNzEzLDIuOTc4LDIuOTc4LDAsMCwwLS45NSwxLjkyOFptMTUuMTQzLTQuMjk0LTYuNDIyLDE1LjM5aC0yLjI0MmwyLjEyOC01LjA5Mi00LjEyMy0xMC4zaDIuNDEzbDIuOTQ1LDcuOTgsMy4wNTktNy45OFpNLTIwLjAxNi4xNzFBNS4zNjEsNS4zNjEsMCwwLDEtMjIuNy0uNWE0Ljg0NSw0Ljg0NSwwLDAsMS0xLjg4MS0xLjksNS43MzEsNS43MzEsMCwwLDEtLjY4NC0yLjg0MSw1LjYyMSw1LjYyMSwwLDAsMSwuNy0yLjgzMSw0Ljg1Niw0Ljg1NiwwLDAsMSwxLjkxOS0xLjksNS41NjgsNS41NjgsMCwwLDEsMi43MTctLjY2NSw1LjU2OCw1LjU2OCwwLDAsMSwyLjcxNy42NjUsNC44NTYsNC44NTYsMCwwLDEsMS45MTksMS45LDUuNjIxLDUuNjIxLDAsMCwxLC43LDIuODMxQTUuNSw1LjUsMCwwLDEtMTUuMy0yLjQxMyw1LDUsMCwwLDEtMTcuMjcxLS41LDUuNjY4LDUuNjY4LDAsMCwxLTIwLjAxNi4xNzFabTAtMS44ODFhMy4yMjMsMy4yMjMsMCwwLDAsMS41NjgtLjQsMy4wNCwzLjA0LDAsMCwwLDEuMTg4LTEuMiwzLjg0OCwzLjg0OCwwLDAsMCwuNDU2LTEuOTM4LDMuOTI4LDMuOTI4LDAsMCwwLS40MzctMS45MjlBMi45NSwyLjk1LDAsMCwwLTE4LjQtOC4zNmEzLjE3LDMuMTcsMCwwLDAtMS41NTgtLjQsMy4xMTcsMy4xMTcsMCwwLDAtMS41NDkuNCwyLjg0OCwyLjg0OCwwLDAsMC0xLjEzLDEuMTg3LDQuMDc1LDQuMDc1LDAsMCwwLS40MTgsMS45MjksMy42NzMsMy42NzMsMCwwLDAsLjg2NSwyLjYxMkEyLjg1NywyLjg1NywwLDAsMC0yMC4wMTYtMS43MVptMTQuMTkzLTguOTNhNC43LDQuNywwLDAsMSwyLjIxNC41MTMsMy42NDgsMy42NDgsMCwwLDEsMS41MywxLjUyQTUsNSwwLDAsMS0xLjUzLTYuMTc1VjBILTMuNjc3Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1N0EyLjUsMi41LDAsMCwwLTYuMy04Ljc1OWEyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NUEzLjAxMywzLjAxMywwLDAsMC04Ljk0LTUuODUyVjBoLTIuMTY2Vi0xMC40NjlILTguOTR2MS4yYTMuNTg1LDMuNTg1LDAsMCwxLDEuMzU5LTEuMDA3QTQuMzQzLDQuMzQzLDAsMCwxLTUuODI0LTEwLjY0Wk0xLjgzMy01LjI4MmE1Ljc5NCw1Ljc5NCwwLDAsMSwuNjU1LTIuNzkzQTQuOCw0LjgsMCwwLDEsNC4yNzUtOS45NjVhNC44Miw0LjgyLDAsMCwxLDIuNTE4LS42NzUsNC45MSw0LjkxLDAsMCwxLDIuMDIzLjQ0N0E0LjE0LDQuMTQsMCwwLDEsMTAuNC05LjAwNlYtMTQuMDZoMi4xODVWMEgxMC40Vi0xLjU3N0E0LjA1NSw0LjA1NSwwLDAsMSw4LjkzLS4zMjMsNC41NjksNC41NjksMCwwLDEsNi43NzMuMTcxYTQuNjg1LDQuNjg1LDAsMCwxLTIuNS0uNjkzQTQuODk1LDQuODk1LDAsMCwxLDIuNDg5LTIuNDYxLDUuOTYyLDUuOTYyLDAsMCwxLDEuODMzLTUuMjgyWm04LjU2OS4wMzhhMy43OTEsMy43OTEsMCwwLDAtLjQ0Ni0xLjg4MUEzLjEzNCwzLjEzNCwwLDAsMCw4Ljc4Ny04LjM0MWEzLjA1NywzLjA1NywwLDAsMC0xLjU1OC0uNDE4LDMuMTEyLDMuMTEyLDAsMCwwLTEuNTU4LjQwOEEzLjA4MSwzLjA4MSwwLDAsMCw0LjUtNy4xNTRhMy43MzcsMy43MzcsMCwwLDAtLjQ0NywxLjg3MiwzLjksMy45LDAsMCwwLC40NDcsMS45QTMuMTUsMy4xNSwwLDAsMCw1LjY4MS0yLjEzOGEzLjAyMSwzLjAyMSwwLDAsMCwxLjU0OS40MjgsMy4wNTcsMy4wNTcsMCwwLDAsMS41NTgtLjQxOEEzLjExOSwzLjExOSwwLDAsMCw5Ljk1Ni0zLjM1MywzLjg0NSwzLjg0NSwwLDAsMCwxMC40LTUuMjQ0Wk0yNS41NjUtOC43djUuNzk1YTEuMTEyLDEuMTEyLDAsMCwwLC4yNzYuODQ2LDEuMzcsMS4zNywwLDAsMCwuOTQuMjU2aDEuMzNWMEgyNi40YTMuMywzLjMsMCwwLDEtMi4yNDItLjY4NCwyLjgxOSwyLjgxOSwwLDAsMS0uNzc5LTIuMjIzVi04LjdIMjIuMTQ1di0xLjc2N0gyMy4zOHYtMi42aDIuMTg1djIuNmgyLjU0NlYtOC43Wk0zNi44NS0xMC42NGE0LjM5MSw0LjM5MSwwLDAsMSwyLjEzOC41MTMsMy42NTEsMy42NTEsMCwwLDEsMS40ODIsMS41Miw1LjA3Miw1LjA3MiwwLDAsMSwuNTQyLDIuNDMyVjBIMzguODY0Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1NywyLjUsMi41LDAsMCwwLTEuOTE5LS43NSwyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NUEzLjAxMywzLjAxMywwLDAsMCwzMy42LTUuODUyVjBIMzEuNDM1Vi0xNC4wNkgzMy42djQuODA3QTMuNjMyLDMuNjMyLDAsMCwxLDM1LTEwLjI3OSw0LjY2OSw0LjY2OSwwLDAsMSwzNi44NS0xMC42NFpNNTQuNjkxLTUuNDkxYTYuNzcyLDYuNzcyLDAsMCwxLS4wNzYsMS4wNjRoLThhMi45LDIuOSwwLDAsMCwuOTMxLDIuMDE0LDIuOTM5LDIuOTM5LDAsMCwwLDIuMDUyLjc2LDIuNTM0LDIuNTM0LDAsMCwwLDIuNDctMS40NjNoMi4zMzdhNC43MTYsNC43MTYsMCwwLDEtMS43MiwyLjM2NkE1LjA0NSw1LjA0NSwwLDAsMSw0OS42LjE3MSw1LjM0Nyw1LjM0NywwLDAsMSw0Ni45MTEtLjVhNC44LDQuOCwwLDAsMS0xLjg2Mi0xLjksNS44LDUuOCwwLDAsMS0uNjc0LTIuODQxLDUuOTMyLDUuOTMyLDAsMCwxLC42NTYtMi44NDEsNC42MSw0LjYxLDAsMCwxLDEuODQzLTEuODlBNS40ODUsNS40ODUsMCwwLDEsNDkuNi0xMC42NGE1LjMzMiw1LjMzMiwwLDAsMSwyLjY0MS42NDYsNC41NjUsNC41NjUsMCwwLDEsMS44MDUsMS44MTVBNS40NjUsNS40NjUsMCwwLDEsNTQuNjkxLTUuNDkxWk01Mi40My02LjE3NWEyLjQ2NSwyLjQ2NSwwLDAsMC0uODU1LTEuOTE5QTMuMDU3LDMuMDU3LDAsMCwwLDQ5LjUtOC44MTZhMi43ODIsMi43ODIsMCwwLDAtMS45MTkuNzEzLDIuOTc4LDIuOTc4LDAsMCwwLS45NSwxLjkyOFpNNzAuNDQyLjEzM2E2Ljg0LDYuODQsMCwwLDEtMy4zOTEtLjg2NEE2LjQwNiw2LjQwNiwwLDAsMSw2NC42LTMuMTQ1YTYuOCw2LjgsMCwwLDEtLjktMy40ODcsNi43NDQsNi43NDQsMCwwLDEsLjktMy40NzcsNi40MjYsNi40MjYsMCwwLDEsMi40NTEtMi40LDYuODQsNi44NCwwLDAsMSwzLjM5MS0uODY0LDYuODc3LDYuODc3LDAsMCwxLDMuNDEuODY0LDYuMzU4LDYuMzU4LDAsMCwxLDIuNDQyLDIuNCw2LjgsNi44LDAsMCwxLC44OTMsMy40NzcsNi44NTIsNi44NTIsMCwwLDEtLjg5MywzLjQ4N0E2LjMzOCw2LjMzOCwwLDAsMSw3My44NTMtLjczMSw2Ljg3Nyw2Ljg3NywwLDAsMSw3MC40NDIuMTMzWm0wLTEuODgxYTQuNTUyLDQuNTUyLDAsMCwwLDIuMzM3LS42LDQuMTQ5LDQuMTQ5LDAsMCwwLDEuNjA1LTEuNzEsNS40OTEsNS40OTEsMCwwLDAsLjU3OS0yLjU3NUE1LjQzMyw1LjQzMywwLDAsMCw3NC4zODUtOS4yYTQuMSw0LjEsMCwwLDAtMS42MDUtMS42OTEsNC42MDksNC42MDksMCwwLDAtMi4zMzctLjU4OSw0LjYwOSw0LjYwOSwwLDAsMC0yLjMzNy41ODlBNC4xLDQuMSwwLDAsMCw2Ni41LTkuMmE1LjQzMyw1LjQzMywwLDAsMC0uNTc5LDIuNTY1QTUuNDkxLDUuNDkxLDAsMCwwLDY2LjUtNC4wNTZhNC4xNDksNC4xNDksMCwwLDAsMS42MDUsMS43MUE0LjU1Miw0LjU1MiwwLDAsMCw3MC40NDItMS43NDhabTEyLjM2OS03LjJhMy40LDMuNCwwLDAsMSwxLjI2My0xLjI0NSwzLjczNywzLjczNywwLDAsMSwxLjg3MS0uNDQ3Vi04LjRIODUuNGEyLjYzOCwyLjYzOCwwLDAsMC0xLjkyOS42NDYsMy4wODksMy4wODksMCwwLDAtLjY1NSwyLjI0MlYwSDgwLjY0NlYtMTAuNDY5aDIuMTY2Wm01LjczOCwzLjY2N0E1Ljc5NCw1Ljc5NCwwLDAsMSw4OS4yLTguMDc1YTQuOCw0LjgsMCwwLDEsMS43ODYtMS44OTEsNC44Miw0LjgyLDAsMCwxLDIuNTE4LS42NzUsNC45MSw0LjkxLDAsMCwxLDIuMDIzLjQ0Nyw0LjE0LDQuMTQsMCwwLDEsMS41ODcsMS4xODdWLTE0LjA2SDk5LjNWMEg5Ny4xMThWLTEuNTc3QTQuMDU1LDQuMDU1LDAsMCwxLDk1LjY0Ni0uMzIzYTQuNTY5LDQuNTY5LDAsMCwxLTIuMTU3LjQ5NCw0LjY4NSw0LjY4NSwwLDAsMS0yLjUtLjY5M0E0Ljg5NSw0Ljg5NSwwLDAsMSw4OS4yLTIuNDYxLDUuOTYyLDUuOTYyLDAsMCwxLDg4LjU0OS01LjI4MlptOC41NjkuMDM4YTMuNzkxLDMuNzkxLDAsMCwwLS40NDctMS44ODFBMy4xMzQsMy4xMzQsMCwwLDAsOTUuNS04LjM0MWEzLjA1NywzLjA1NywwLDAsMC0xLjU1OC0uNDE4LDMuMTEyLDMuMTEyLDAsMCwwLTEuNTU4LjQwOCwzLjA4MSwzLjA4MSwwLDAsMC0xLjE2OSwxLjIsMy43MzcsMy43MzcsMCwwLDAtLjQ0NiwxLjg3MiwzLjksMy45LDAsMCwwLC40NDYsMS45QTMuMTUsMy4xNSwwLDAsMCw5Mi40LTIuMTM4YTMuMDIxLDMuMDIxLDAsMCwwLDEuNTQ5LjQyOEEzLjA1NywzLjA1NywwLDAsMCw5NS41LTIuMTI4YTMuMTE5LDMuMTE5LDAsMCwwLDEuMTY5LTEuMjI1QTMuODQ1LDMuODQ1LDAsMCwwLDk3LjExOC01LjI0NFptNy40NjctNi42MTJhMS4zNDIsMS4zNDIsMCwwLDEtLjk4OC0uNCwxLjM0MiwxLjM0MiwwLDAsMS0uNC0uOTg4LDEuMzQyLDEuMzQyLDAsMCwxLC40LS45ODgsMS4zNDIsMS4zNDIsMCwwLDEsLjk4OC0uNCwxLjMxOSwxLjMxOSwwLDAsMSwuOTY5LjQsMS4zNDIsMS4zNDIsMCwwLDEsLjQuOTg4LDEuMzQyLDEuMzQyLDAsMCwxLS40Ljk4OEExLjMxOSwxLjMxOSwwLDAsMSwxMDQuNTg1LTExLjg1NlptMS4wNjQsMS4zODdWMGgtMi4xNjZWLTEwLjQ2OVptOS40NjItLjE3MWE0LjcsNC43LDAsMCwxLDIuMjE0LjUxMywzLjY0OCwzLjY0OCwwLDAsMSwxLjUyOSwxLjUyLDUsNSwwLDAsMSwuNTUxLDIuNDMyVjBoLTIuMTQ3Vi01Ljg1MmEzLjAzOSwzLjAzOSwwLDAsMC0uNy0yLjE1NywyLjUsMi41LDAsMCwwLTEuOTE5LS43NSwyLjUzMywyLjUzMywwLDAsMC0xLjkyOS43NUEzLjAxMywzLjAxMywwLDAsMCwxMTItNS44NTJWMGgtMi4xNjZWLTEwLjQ2OUgxMTJ2MS4yYTMuNTg1LDMuNTg1LDAsMCwxLDEuMzU4LTEuMDA3QTQuMzQzLDQuMzQzLDAsMCwxLDExNS4xMTEtMTAuNjRabTcuNjU3LDUuMzU4YTUuNzk0LDUuNzk0LDAsMCwxLC42NTUtMi43OTMsNC44LDQuOCwwLDAsMSwxLjc4Ni0xLjg5MSw0Ljc4NSw0Ljc4NSwwLDAsMSwyLjUtLjY3NSw0LjU3LDQuNTcsMCwwLDEsMi4xNTcuNDg0LDQuMzc2LDQuMzc2LDAsMCwxLDEuNDczLDEuMjA3di0xLjUyaDIuMTg1VjBoLTIuMTg1Vi0xLjU1OGE0LjMsNC4zLDAsMCwxLTEuNSwxLjIzNSw0LjYyNiw0LjYyNiwwLDAsMS0yLjE2Ni40OTQsNC42LDQuNiwwLDAsMS0yLjQ3LS42OTMsNC45MTgsNC45MTgsMCwwLDEtMS43NzctMS45MzhBNS45NjIsNS45NjIsMCwwLDEsMTIyLjc2OS01LjI4MlptOC41NjkuMDM4YTMuNzkxLDMuNzkxLDAsMCwwLS40NDctMS44ODEsMy4xMzQsMy4xMzQsMCwwLDAtMS4xNjktMS4yMTYsMy4wNTcsMy4wNTcsMCwwLDAtMS41NTgtLjQxOCwzLjExMiwzLjExMiwwLDAsMC0xLjU1OC40MDgsMy4wODEsMy4wODEsMCwwLDAtMS4xNjksMS4yLDMuNzM3LDMuNzM3LDAsMCwwLS40NDYsMS44NzIsMy45LDMuOSwwLDAsMCwuNDQ2LDEuOSwzLjE1LDMuMTUsMCwwLDAsMS4xNzgsMS4yNDQsMy4wMjEsMy4wMjEsMCwwLDAsMS41NDkuNDI4LDMuMDU3LDMuMDU3LDAsMCwwLDEuNTU4LS40MTgsMy4xMTgsMy4xMTgsMCwwLDAsMS4xNjktMS4yMjVBMy44NDUsMy44NDUsMCwwLDAsMTMxLjMzOC01LjI0NFptOC41MzEtMy43YTMuNCwzLjQsMCwwLDEsMS4yNjQtMS4yNDVBMy43MzcsMy43MzcsMCwwLDEsMTQzLTEwLjY0Vi04LjRoLS41NTFhMi42MzgsMi42MzgsMCwwLDAtMS45MjguNjQ2LDMuMDg5LDMuMDg5LDAsMCwwLS42NTYsMi4yNDJWMEgxMzcuN1YtMTAuNDY5aDIuMTY2Wm0xNS44ODQtMS41MkwxNDkuMzMsNC45MjFoLTIuMjQybDIuMTI4LTUuMDkyLTQuMTIzLTEwLjNoMi40MTNsMi45NDUsNy45OCwzLjA1OS03Ljk4WiIgZGF0YS1uYW1lPSJQYXRoIDE2NTAiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE2NTAiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDQxMzggLTMxODIuNDk3KSIvPgogICAgICA8cGF0aCBkPSJNMjg2Ljg2NS05NS4wNDZhMTAuNTkzLDEwLjU5MywwLDAsMS00LjI1OS04LjM5NGgxMC40NzNhMy45MDcsMy45MDcsMCwwLDAsMS4xLDIuNzA2LDMuNTM4LDMuNTM4LDAsMCwwLDIuNDU1Ljg1MSwzLjU0NywzLjU0NywwLDAsMCwyLjIzLS42NzYsMi4yNDIsMi4yNDIsMCwwLDAsLjg3Ny0xLjg3OSwyLjY1OSwyLjY1OSwwLDAsMC0xLjQ1My0yLjQwNiwyNS42ODYsMjUuNjg2LDAsMCwwLTQuNzExLTEuOSw0Mi4xOSw0Mi4xOSwwLDAsMS01LjU4Ny0yLjIzLDEwLjcsMTAuNywwLDAsMS0zLjcwOC0zLjE1Nyw4Ljc1Myw4Ljc1MywwLDAsMS0xLjU3OC01LjQzNyw5LjkxMiw5LjkxMiwwLDAsMSwxLjctNS44MzksMTAuNTM1LDEwLjUzNSwwLDAsMSw0LjcxLTMuNjgzLDE3LjU4OSwxNy41ODksMCwwLDEsNi44MTYtMS4yNTNxNi4xNjMsMCw5Ljg0NywyLjg4MmExMC4zNjcsMTAuMzY3LDAsMCwxLDMuOTMzLDguMDkzSDI5OS4wNDNhMy4xNTMsMy4xNTMsMCwwLDAtLjk3Ny0yLjQwNiwzLjUxNywzLjUxNywwLDAsMC0yLjM4LS44LDIuNTQ3LDIuNTQ3LDAsMCwwLTEuOC42NTEsMi40LDIuNCwwLDAsMC0uNywxLjg1NCwyLjI4MywyLjI4MywwLDAsMCwuNzc3LDEuNzI4LDcuMTE4LDcuMTE4LDAsMCwwLDEuOTI5LDEuMjUzcTEuMTUyLjUyNiwzLjQwOCwxLjMyN2E0Mi4wNzEsNDIuMDcxLDAsMCwxLDUuNTM2LDIuMjgsMTEuMywxMS4zLDAsMCwxLDMuNzU4LDMuMTU4LDguMTE0LDguMTE0LDAsMCwxLDEuNTc5LDUuMTM2LDEwLjQsMTAuNCwwLDAsMS0xLjU3OSw1LjY2MywxMC44MzQsMTAuODM0LDAsMCwxLTQuNTU5LDMuOTU5LDE1LjksMTUuOSwwLDAsMS03LjA0MSwxLjQ1M0ExNi41NjQsMTYuNTY0LDAsMCwxLDI4Ni44NjUtOTUuMDQ2WiIgZGF0YS1uYW1lPSJQYXRoIDE1ODAiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODAiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2OTcuOTIgLTMxMTkuNjg5KSIvPgogICAgICA8cGF0aCBkPSJNMzYyLjUxNC0xMjcuNjA2LDM1MC4zMzctOTIuMjc3SDMzNy43NTlsLTEyLjIyNy0zNS4zMjloMTAuNTIzbDguMDE4LDI1LjUwNiw3Ljk2OC0yNS41MDZaIiBkYXRhLW5hbWU9IlBhdGggMTU4MSIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTU4MSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzY4Ny4wMTUgLTMxMTkuODc3KSIvPgogICAgICA8cGF0aCBkPSJNMzk5LjMyMi0xMTkuNDMyYTE1LjY2MywxNS42NjMsMCwwLDEsNi4xODgtNi4zNjUsMTguMzI2LDE4LjMyNiwwLDAsMSw5LjIyMS0yLjI4LDE3LjQ5LDE3LjQ5LDAsMCwxLDExLjEyNSwzLjUzMywxNi4wMjksMTYuMDI5LDAsMCwxLDUuODEyLDkuNkg0MjEuMUE3LjA4OSw3LjA4OSwwLDAsMCw0MTguNDY0LTExOGE3LjE1Nyw3LjE1NywwLDAsMC0zLjg4My0xLjA1Myw2LjcyMiw2LjcyMiwwLDAsMC01LjQzOCwyLjQzLDkuOCw5LjgsMCwwLDAtMi4wMjksNi40ODksOS44ODMsOS44ODMsMCwwLDAsMi4wMjksNi41NCw2LjcyMiw2LjcyMiwwLDAsMCw1LjQzOCwyLjQzLDcuMTU4LDcuMTU4LDAsMCwwLDMuODgzLTEuMDUzLDcuMDg1LDcuMDg1LDAsMCwwLDIuNjMxLTMuMDU2aDEwLjU3M2ExNi4wMjksMTYuMDI5LDAsMCwxLTUuODEyLDkuNiwxNy40OSwxNy40OSwwLDAsMS0xMS4xMjUsMy41MzMsMTguMzExLDE4LjMxMSwwLDAsMS05LjIyMS0yLjI4LDE1LjY1MiwxNS42NTIsMCwwLDEtNi4xODgtNi4zNjQsMTkuNTQyLDE5LjU0MiwwLDAsMS0yLjE4LTkuMzQ2QTE5LjQzNCwxOS40MzQsMCwwLDEsMzk5LjMyMi0xMTkuNDMyWiIgZGF0YS1uYW1lPSJQYXRoIDE1ODIiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODIiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2NjguODIzIC0zMTE5Ljc1OCkiLz4KICAgICAgPHBhdGggZD0iTTQ3NC41NjMtOTguMDRINDYyLjAzNWwtMS45LDUuNzYzSDQ0OS44MDlsMTIuODc4LTM1LjMyOWgxMS4zMjZsMTIuODI4LDM1LjMyOUg0NzYuNDY3Wm0tMi40NTUtNy41MTdMNDY4LjMtMTE2Ljk4MmwtMy43NTksMTEuNDI1WiIgZGF0YS1uYW1lPSJQYXRoIDE1ODMiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODMiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2NTUuNDQzIC0zMTE5Ljg3NykiLz4KICAgICAgPHBhdGggZD0iTTUzMy41NDMtMTA5Ljk5MmExMC42ODUsMTAuNjg1LDAsMCwxLTQuNDYsNC4yMDksMTUuNDI5LDE1LjQyOSwwLDAsMS03LjI5MSwxLjU3OGgtNC44NjF2MTEuOTI2aC05LjgyMnYtMzUuMzI5aDE0LjY4M2ExNS45NDMsMTUuOTQzLDAsMCwxLDcuMjQxLDEuNSwxMC4zNCwxMC4zNCwwLDAsMSw0LjQ4NSw0LjE1OSwxMi4yMSwxMi4yMSwwLDAsMSwxLjUsNi4xMTRBMTEuNzIxLDExLjcyMSwwLDAsMSw1MzMuNTQzLTEwOS45OTJaTTUyNS0xMTUuODNxMC0zLjg1OC00LjE2LTMuODU5aC0zLjkwOXY3LjY2N2gzLjkwOVE1MjUtMTEyLjAyMSw1MjUtMTE1LjgzWiIgZGF0YS1uYW1lPSJQYXRoIDE1ODQiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE1ODQiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2NDAuODg2IC0zMTE5Ljg3NykiLz4KICAgICAgPHBhdGggZD0iTTU2My4wMTMtMTI3LjYwNnYzNS4zMjloLTkuODIydi0zNS4zMjlaIiBkYXRhLW5hbWU9IlBhdGggMTU4NSIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTU4NSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzYyOS4xOCAtMzExOS44NzcpIi8+CiAgICAgIDxwYXRoIGQ9Ik02MDMuMTg0LTEyNy42MDZ2Ny44MThoLTkuNDIxdjI3LjUxMWgtOS44MjJ2LTI3LjUxMWgtOS4zMnYtNy44MThaIiBkYXRhLW5hbWU9IlBhdGggMTU4NiIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTU4NiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzYyMy43MzUgLTMxMTkuODc3KSIvPgogICAgICA8cGF0aCBkPSJNNjQyLjctOTguMDRINjMwLjE3NmwtMS45LDUuNzYzSDYxNy45NDlsMTIuODc4LTM1LjMyOWgxMS4zMjVMNjU0Ljk4LTkyLjI3N0g2NDQuNjA4Wm0tMi40NTYtNy41MTctMy44MDktMTEuNDI1LTMuNzU4LDExLjQyNVoiIGRhdGEtbmFtZT0iUGF0aCAxNTg3IiBmaWxsPSIjMzAzMDMwIiBpZD0iUGF0aF8xNTg3IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzNjEyLjcyOCAtMzExOS44NzcpIi8+CiAgICAgIDxwYXRoIGQ9Ik02ODUuMDcxLTk5Ljc5NGgxMC45NzR2Ny41MTdoLTIwLjh2LTM1LjMyOWg5LjgyMloiIGRhdGEtbmFtZT0iUGF0aCAxNTg4IiBmaWxsPSIjMzAzMDMwIiBpZD0iUGF0aF8xNTg4IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzNTk4LjE3MiAtMzExOS44NzcpIi8+CiAgICAgIDxnIGRhdGEtbmFtZT0iR3JvdXAgMzE0MSIgaWQ9Ikdyb3VwXzMxNDEtMiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzg2MyAtMzI2OS44MjUpIj4KICAgICAgICA8cGF0aCBkPSJNMTg2LjgzNy03OC4wNDFzLTEwLjQxMS0yMS42MTgtLjA3My00MS43MjYsMzMuOTc1LTI0LjIyMywzMy45NzUtMjQuMjIzLDEwLjQxLDIxLjYxOS4wNzMsNDEuNzI3UzE4Ni44MzctNzguMDQxLDE4Ni44MzctNzguMDQxWiIgZGF0YS1uYW1lPSJQYXRoIDE2MTMiIGZpbGw9InVybCgjbGluZWFyLWdyYWRpZW50KSIgaWQ9IlBhdGhfMTYxMyIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTM5LjU2OSAxNTcuOTY5KSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xODAuOTYzLTgyLjcwOHMyMC42NTgtMTUuNjEyLDIwLjY1OC00MC4wMTEtMjAuNjU4LTQwLjAxMS0yMC42NTgtNDAuMDExLTIwLjY1NywxNS42MTItMjAuNjU3LDQwLjAxMVMxODAuOTYzLTgyLjcwOCwxODAuOTYzLTgyLjcwOFoiIGRhdGEtbmFtZT0iUGF0aCAxNjE0IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC0yKSIgaWQ9IlBhdGhfMTYxNCIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTM0LjAxIDE2Mi43MykiLz4KICAgICAgICA8cGF0aCBkPSJNMTQ0LjAyNi00Ni44NzhhMTguNzkzLDE4Ljc5MywwLDAsMCwxMi41ODgsNS4wODdBMTguNzkxLDE4Ljc5MSwwLDAsMCwxNjkuMi00Ni44NzdhMTguNzksMTguNzksMCwwLDAtMTIuNTg3LTUuMDg3QTE4LjgsMTguOCwwLDAsMCwxNDQuMDI2LTQ2Ljg3OFoiIGRhdGEtbmFtZT0iUGF0aCAxNjE2IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC0zKSIgaWQ9IlBhdGhfMTYxNiIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTI5Ljg3NCAxMzQuNTkxKSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xOTcuMTE1LTQ2Ljg3OEExOC43OSwxOC43OSwwLDAsMCwyMDkuNy00MS43OTFhMTguNzk0LDE4Ljc5NCwwLDAsMCwxMi41ODgtNS4wODZBMTguNzkzLDE4Ljc5MywwLDAsMCwyMDkuNy01MS45NjQsMTguNzkxLDE4Ljc5MSwwLDAsMCwxOTcuMTE1LTQ2Ljg3OFoiIGRhdGEtbmFtZT0iUGF0aCAxNjE3IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC00KSIgaWQ9IlBhdGhfMTYxNyIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTQzLjM2MiAxMzQuNTkxKSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xODguMTkzLTcxLjY4OXMtMi45MzUtMjEuMSwxMS4yNjItMzUuMywzNS4zLTExLjI2MSwzNS4zLTExLjI2MSwyLjkzNiwyMS4xLTExLjI2MSwzNS4zUzE4OC4xOTMtNzEuNjg5LDE4OC4xOTMtNzEuNjg5WiIgZGF0YS1uYW1lPSJQYXRoIDE2MTgiIGZpbGw9InVybCgjbGluZWFyLWdyYWRpZW50LTUpIiBpZD0iUGF0aF8xNjE4IiBvcGFjaXR5PSIwLjgiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xNDEuMDMxIDE1MS40OTQpIi8+CiAgICAgICAgPHBhdGggZD0iTTE3NC40MzMtNzguMDQxczEwLjQxMS0yMS42MTguMDc0LTQxLjcyNi0zMy45NzUtMjQuMjIzLTMzLjk3NS0yNC4yMjMtMTAuNDExLDIxLjYxOS0uMDc0LDQxLjcyN1MxNzQuNDMzLTc4LjA0MSwxNzQuNDMzLTc4LjA0MVoiIGRhdGEtbmFtZT0iUGF0aCAxNjE5IiBmaWxsPSJ1cmwoI2xpbmVhci1ncmFkaWVudC02KSIgaWQ9IlBhdGhfMTYxOSIgb3BhY2l0eT0iMC44IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMTI3LjgwNiAxNTcuOTY5KSIvPgogICAgICAgIDxwYXRoIGQ9Ik0xNzEuODctNzEuNjg5czIuOTM1LTIxLjEtMTEuMjYyLTM1LjMtMzUuMy0xMS4yNjEtMzUuMy0xMS4yNjEtMi45MzUsMjEuMSwxMS4yNjIsMzUuM1MxNzEuODctNzEuNjg5LDE3MS44Ny03MS42ODlaIiBkYXRhLW5hbWU9IlBhdGggMTYyMCIgZmlsbD0idXJsKCNsaW5lYXItZ3JhZGllbnQtNykiIGlkPSJQYXRoXzE2MjAiIG9wYWNpdHk9IjAuOCIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTEyNS4wNTUgMTUxLjQ5NCkiLz4KICAgICAgICA8cGF0aCBkPSJNMTg2LjI3LTI2LjA5czUuMDc0LTMuODM1LDUuMDc0LTkuODI3LTUuMDc0LTkuODI4LTUuMDc0LTkuODI4UzE4MS4yLTQxLjkxLDE4MS4yLTM1LjkxNywxODYuMjctMjYuMDksMTg2LjI3LTI2LjA5WiIgZGF0YS1uYW1lPSJQYXRoIDE2MTUiIGZpbGw9InVybCgjbGluZWFyLWdyYWRpZW50LTgpIiBpZD0iUGF0aF8xNjE1IiBvcGFjaXR5PSIwLjgiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xMzkuMzE4IDEzMy4wMSkiLz4KICAgICAgICA8ZyBkYXRhLW5hbWU9Ikdyb3VwIDMwMzgiIGlkPSJHcm91cF8zMDM4IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg4OS4xODcgMTMuNDQxKSI+CiAgICAgICAgICA8cGF0aCBkPSJNMTIyLjYxNSwxOC4wMTh2LjY3NEgxMjEuNXYzLjQ5MWgtLjgzNVYxOC42OTNoLTEuMTF2LS42NzRaIiBkYXRhLW5hbWU9IlBhdGggMTYyMyIgZmlsbD0iIzMwMzAzMCIgaWQ9IlBhdGhfMTYyMyIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTExOS41NTkgLTE4LjAxOCkiLz4KICAgICAgICAgIDxwYXRoIGQ9Ik0xMjguODcsMTguMDE4bC0xLjMyNSwzLjEtMS4zMjQtMy4xaC0uOTV2NC4xNjZoLjgzNnYtMi43MWwxLjEyMSwyLjcxaC42MzNsMS4xMTYtMi43MXYyLjcxaC44MzZWMTguMDE4WiIgZGF0YS1uYW1lPSJQYXRoIDE2MjQiIGZpbGw9IiMzMDMwMzAiIGlkPSJQYXRoXzE2MjQiIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0xMjEuMDEgLTE4LjAxOCkiLz4KICAgICAgICA8L2c+CiAgICAgIDwvZz4KICAgIDwvZz4KICA8L2c+Cjwvc3ZnPg==';
  const hasBanking = emp.bank_name || emp.bank_account_number;
  const bankSection = hasBanking ? `
<div class="bank">
  <div class="bank-lbl">&#128197; Payment Paid To</div>
  <div class="bank-grid">
    <div><div class="bk-l">Bank</div><div class="bk-v">${emp.bank_name||'—'}</div></div>
    <div><div class="bk-l">Account Number</div><div class="bk-v">${emp.bank_account_number?maskAcc(emp.bank_account_number):'—'}</div></div>
    <div><div class="bk-l">Account Type</div><div class="bk-v">${emp.bank_account_type||'—'}</div></div>
    <div><div class="bk-l">Account Holder</div><div class="bk-v">${emp.bank_account_holder||emp.first_name+' '+emp.last_name}</div></div>
  </div>
</div>` : '';

  const bonusRow = Number(p.bonus||0)>0 ? `<tr><td>Bonus / Commission</td><td></td><td class="r">${fmt(p.bonus)}</td><td></td><td></td><td></td></tr>` : '';
  const otherEarnRow = Number(p.other_earnings||0)>0 ? `<tr><td>Other earnings</td><td></td><td class="r">${fmt(p.other_earnings)}</td><td></td><td></td><td></td></tr>` : '';
  const otherDedRow = Number(p.other_deductions||0)>0 ? `<tr><td></td><td></td><td></td><td>Other deductions</td><td></td><td class="r">${fmt(p.other_deductions)}</td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>Payslip ${moLabel} ${yr} ${emp.first_name} ${emp.last_name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{background:#e8edf2}
body{font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;color:#1a1a1a;min-height:100vh;padding:24px 0}
.page{background:#fff;max-width:820px;margin:0 auto;box-shadow:0 4px 40px rgba(0,0,0,0.18);border-radius:3px;overflow:hidden}
.hdr{background:linear-gradient(135deg,#0d2535 0%,#1a3a4a 100%);padding:22px 30px;display:flex;justify-content:space-between;align-items:flex-start}
.hdr-co-name{font-size:14pt;font-weight:900;color:#fff;letter-spacing:-0.02em;margin-bottom:7px}
.hdr-co-addr{font-size:8pt;color:rgba(255,255,255,0.6);line-height:1.65}
.hdr-right{text-align:right;min-width:180px}
.hdr-pd-lbl{font-size:7pt;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
.hdr-pd-val{font-size:13pt;font-weight:800;color:#FF9B0C;margin-bottom:12px;letter-spacing:0.02em}
.hdr-logo{width:170px;height:auto;display:block;margin-left:auto}
.emp-strip{padding:16px 30px;background:#f7f9fc;border-bottom:2px solid #e2e8f0;display:grid;grid-template-columns:1fr 1fr;gap:4px 36px}
.er{display:flex;padding:2.5px 0;font-size:8.5pt}
.el{font-weight:700;color:#6b7280;min-width:128px;flex-shrink:0;font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em}
.ev{color:#111827;font-weight:500}
.sec{background:#0d2535;color:#fff;font-size:7pt;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:6px 30px}
.tw{padding:0 30px}
table{width:100%;border-collapse:collapse;font-size:8.8pt}
th{font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;padding:9px 5px 7px;border-bottom:1.5px solid #cbd5e1;text-align:left}
th.r,td.r{text-align:right}
td{padding:5.5px 5px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#374151}
.tr-tot td{font-weight:700;border-top:1.5px solid #94a3b8;border-bottom:1.5px solid #94a3b8;background:#f8fafc;color:#0f172a;padding:8px 5px}
.tr-nett td{font-weight:800;font-size:11.5pt;color:#0d2535;padding:10px 5px;border-bottom:2.5px solid #FF8215}
.tr-nett td.r{color:#FF8215}
.bank{padding:14px 30px 16px;background:#fffbf5;border-top:1.5px solid #fed7aa;border-bottom:1.5px solid #fed7aa;margin-top:4px}
.bank-lbl{font-size:7.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#b45309;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.bank-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 16px}
.bk-l{font-size:7pt;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.bk-v{font-size:9pt;color:#431407;font-weight:600}
.ftr{padding:11px 30px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #e2e8f0;background:#f9fafb}
.ftr-l{font-size:6.5pt;color:#9ca3af;font-style:italic}
.ftr-r{font-size:6.5pt;color:#9ca3af}
.print-row{padding:18px;text-align:center;background:#f0f4f8}
.pbtn{padding:11px 36px;background:linear-gradient(135deg,#FF9B0C,#FF5229);color:#fff;border:none;border-radius:8px;font-size:10pt;font-weight:700;cursor:pointer;font-family:Arial;letter-spacing:.02em;box-shadow:0 3px 12px rgba(255,130,21,0.35)}
@media print{html{background:#fff}body{padding:0}.page{box-shadow:none;border-radius:0}.print-row{display:none}}
</style></head>
<body><div class="page">

<div class="hdr">
  <div>
    <div class="hdr-co-name">Smartvest Capital (Pty) Ltd</div>
    <div class="hdr-co-addr">The Station · 63 Peter Place · Bryanston<br>Johannesburg · 2191<br>Reg. No: 2017/499533/07 &nbsp;|&nbsp; FSP Licence: #52449</div>
  </div>
  <div class="hdr-right">
    <div class="hdr-pd-lbl">Pay Date</div>
    <div class="hdr-pd-val">${payDateFmt}</div>
    <img class="hdr-logo" src="data:image/svg+xml;base64,${LOGO}" alt="SV Capital"/>
  </div>
</div>

<div class="emp-strip">
  <div>
    <div class="er"><span class="el">Employee</span><span class="ev">${emp.first_name} ${emp.last_name}</span></div>
    <div class="er"><span class="el">Job Title</span><span class="ev">${emp.role||'—'}</span></div>
    <div class="er"><span class="el">Address</span><span class="ev">${addrHtml}</span></div>
  </div>
  <div>
    <div class="er"><span class="el">Employee Code</span><span class="ev">${empCode}</span></div>
    <div class="er"><span class="el">Identity Number</span><span class="ev">${emp.id_number||'—'}</span></div>
    <div class="er"><span class="el">Employed From</span><span class="ev">${startFmt}</span></div>
    <div class="er"><span class="el">Rate Per Hour</span><span class="ev">R ${rph}</span></div>
  </div>
</div>

<div class="sec" style="margin-top:14px">Earnings &amp; Deductions — ${moLabel} ${yr}</div>
<div class="tw" style="padding-top:10px">
<table>
  <thead><tr>
    <th style="width:32%">Earnings</th><th style="width:10%">Units</th>
    <th class="r" style="width:15%">Amount (R)</th>
    <th style="width:25%">Deductions</th>
    <th class="r" style="width:8%">Opening Bal.</th>
    <th class="r" style="width:10%">Amount (R)</th>
  </tr></thead>
  <tbody>
    <tr><td>Basic salary</td><td></td><td class="r">${fmt(p.basic_salary)}</td><td>PAYE Tax</td><td></td><td class="r">${fmt(p.tax)}</td></tr>
    ${bonusRow}
    ${otherEarnRow}
    <tr><td></td><td></td><td></td><td>Unemployment Insurance Fund</td><td></td><td class="r">${fmt(p.uif_employee)}</td></tr>
    ${otherDedRow}
  </tbody>
  <tfoot>
    <tr class="tr-tot"><td>Total Earnings</td><td></td><td class="r">${fmt(p.total_earnings)}</td><td>Total Deductions</td><td></td><td class="r">${fmt(p.total_deductions)}</td></tr>
    <tr class="tr-nett"><td colspan="3"></td><td><strong>Nett Pay</strong></td><td></td><td class="r"><strong>${fmt(p.nett_pay)}</strong></td></tr>
  </tfoot>
</table>
</div>

<div class="sec" style="margin-top:14px">Company Contributions &amp; Year-to-Date Totals</div>
<div class="tw" style="padding-top:10px;padding-bottom:12px">
<table>
  <thead><tr>
    <th style="width:30%">Company Contributions</th><th class="r" style="width:20%">Amount (R)</th>
    <th style="width:30%">YTD Totals</th><th class="r" style="width:20%">Amount (R)</th>
  </tr></thead>
  <tbody>
    <tr><td>Unemployment Insurance Fund</td><td class="r">${fmt(p.uif_company)}</td><td><b>Taxable earnings</b></td><td class="r"><b>${fmt(p.ytd_taxable_earnings)}</b></td></tr>
    <tr><td></td><td></td><td><b>Taxable company contributions</b></td><td class="r"><b>${fmt(p.ytd_taxable_company_contributions||0)}</b></td></tr>
    <tr><td></td><td></td><td><b>Taxable fringe benefits</b></td><td class="r"><b>${fmt(p.ytd_taxable_fringe_benefits||0)}</b></td></tr>
    <tr><td></td><td></td><td><b>Provision for tax on annual bonus</b></td><td class="r"><b>${fmt(p.ytd_provision_annual_bonus||0)}</b></td></tr>
    <tr><td></td><td></td><td><b>Tax paid</b></td><td class="r"><b>${fmt(p.ytd_tax_paid)}</b></td></tr>
  </tbody>
</table>
</div>

${bankSection}

<div class="ftr">
  <div class="ftr-l">CONFIDENTIAL — This payslip is for the named employee only and must not be shared.</div>
  <div class="ftr-r">Smartvest Capital (Pty) Ltd &nbsp;·&nbsp; ${moLabel} ${yr}</div>
</div>

<div class="print-row">
  <button class="pbtn" onclick="window.print()">Download / Save as PDF</button>
</div>
</div></body></html>`;
}
async function autoGenerateMissingPayslips() {
  const today = new Date();
  const yr  = today.getFullYear();
  const mo  = today.getMonth() + 1;
  const period  = `${yr}-${String(mo).padStart(2,'0')}`;
  const lastDay = new Date(yr, mo, 0).getDate();
  const payDate = `${yr}-${String(mo).padStart(2,'0')}-${lastDay}`;

  const activeEmps = _employees.filter(e => e.status === 'active' && Number(e.base_salary||0) > 0);
  const missing = activeEmps.filter(e => !_payslips.some(p => p.employee_id === e.id && p.pay_period === period));
  if (!missing.length) return;

  const taxYearStart = mo >= 4 ? `${yr}-04` : `${yr-1}-04`;
  let count = 0;

  for (const emp of missing) {
    const salary  = Number(emp.base_salary||0);
    const tax     = calcMonthlyPAYE(salary);
    const uif     = calcUIF(salary);
    const totalDed = tax + uif;
    const nett    = salary - totalDed;

    const prior = _payslips.filter(p => p.employee_id === emp.id && p.pay_period >= taxYearStart && p.pay_period < period);
    const ytdEarnings = prior.reduce((s,p)=>s+Number(p.total_earnings||0),0) + salary;
    const ytdTax      = prior.reduce((s,p)=>s+Number(p.tax||0),0) + tax;

    const id = 'PAY' + String(Date.now() + Math.round(Math.random()*1000)).slice(-9);
    try {
      const saved = await post('tables/payslips', {
        id, employee_id: emp.id, pay_period: period, pay_date: payDate,
        basic_salary: salary, bonus: 0, other_earnings: 0, total_earnings: salary,
        tax, uif_employee: uif, other_deductions: 0,
        total_deductions: totalDed, nett_pay: nett, uif_company: calcUIF(salary),
        ytd_taxable_earnings: ytdEarnings, ytd_tax_paid: ytdTax,
        ytd_taxable_company_contributions: 0, ytd_taxable_fringe_benefits: 0,
        ytd_provision_annual_bonus: 0,
        notes: 'Auto-generated on 25th of month',
        generated_by: _session?.empId || 'system',
      });
      _payslips.push(saved);
      count++;
    } catch(_) {}
  }

  if (count > 0) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    showToast(`Auto-generated ${count} payslip${count > 1 ? 's' : ''} for ${months[mo-1]} ${yr}`, 'success');
    if (_currentView === 'payslips') renderPayslips();
  }
}
window.autoGenerateMissingPayslips = autoGenerateMissingPayslips;

window.updatePayslipCalcs = _updatePayslipCalcs;
window.generatePayslip    = generatePayslip;
window.deletePayslip      = deletePayslip;
window.printPayslip       = printPayslip;

/* ═══ ACCESS MATRIX ═════════════════════════════════════════════════ */
async function loadRBACFromAPI() {
  try {
    const base = window.__SVC_API_BASE__ || '/api/';
    const r = await fetch(base + 'settings/rbac');
    if (!r.ok) return;
    const data = await r.json();
    if (data && data.matrix && typeof data.matrix === 'object' && !Array.isArray(data.matrix)) {
      RBAC = data.matrix;
    }
  } catch (_) {}
}

function onRbacToggle(cb) {
  const role = cb.dataset.role;
  const app  = cb.dataset.app;
  if (!RBAC[role]) RBAC[role] = [];
  if (cb.checked) {
    if (!RBAC[role].includes(app)) RBAC[role].push(app);
  } else {
    RBAC[role] = RBAC[role].filter(a => a !== app);
  }
}

async function saveRBAC() {
  const btn = document.getElementById('rbacSaveBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px"></i>Saving…'; }
  try {
    const base = window.__SVC_API_BASE__ || '/api/';
    const r = await fetch(base + 'settings/rbac', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ..._authHeader() },
      body: JSON.stringify({ matrix: RBAC }),
    });
    const data = await r.json();
    if (data.ok) {
      showToast('Access matrix saved successfully', 'success');
    } else {
      showToast(data.error || 'Failed to save matrix', 'error');
    }
  } catch (e) {
    showToast('Network error — could not save matrix', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save Changes'; }
  }
}

function renderAccessMatrix() {
  // Employee access list
  const q = (document.getElementById('accessSearch')?.value || '').toLowerCase();
  const filtered = _employees.filter(e =>
    !q || `${e.first_name} ${e.last_name} ${e.role} ${e.email}`.toLowerCase().includes(q)
  );

  document.getElementById('empAccessList').innerHTML = `
    <div class="dir-table-wrap">
      <table class="dir-table">
        <thead><tr>
          <th>Employee</th><th>Role</th><th>Level</th>
          ${Object.keys(APP_NAMES).map(k=>`<th style="text-align:center;font-size:0.65rem"><i class="fa-solid ${APP_ICONS[k]}" style="color:${APP_COLORS[k]}"></i><br>${APP_NAMES[k].replace(' ','<br>')}</th>`).join('')}
          <th>Edit</th>
        </tr></thead>
        <tbody>
          ${filtered.map(e => {
            const apps = e.level === 'executive' ? Object.keys(APP_NAMES) : (RBAC[e.role] || []);
            return `<tr>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <div class="emp-row-avatar" style="background:${e.avatar_color||'#7c5cfc'};width:28px;height:28px;font-size:0.65rem">${e.avatar_initials||'?'}</div>
                  <div>
                    <div class="emp-row-name" style="font-size:0.8rem">${e.first_name} ${e.last_name}</div>
                    <div class="emp-row-email" style="font-size:0.7rem">${e.email||''}</div>
                  </div>
                </div>
              </td>
              <td><span class="role-chip" style="font-size:0.72rem">${e.role||'—'}</span></td>
              <td style="font-size:0.75rem;color:var(--muted)">${LEVEL_LABELS[e.level]||e.level||'—'}</td>
              ${Object.keys(APP_NAMES).map(k=>`
                <td style="text-align:center">
                  ${apps.includes(k)
                    ? `<i class="fa-solid fa-circle-check" style="color:#10b981;font-size:0.85rem"></i>`
                    : `<i class="fa-solid fa-circle-xmark" style="color:var(--border2);font-size:0.85rem"></i>`
                  }
                </td>
              `).join('')}
              <td>
                <button class="btn btn--ghost btn--sm" style="font-size:0.72rem" onclick="openEmpEdit('${e.id}')">
                  <i class="fa-solid fa-pen"></i> Edit
                </button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // RBAC matrix (editable)
  const allApps = Object.keys(APP_NAMES);
  document.getElementById('rbacMatrix').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
      <div style="font-size:0.82rem;color:var(--muted)">Toggle checkboxes to change app access per role, then click Save.</div>
      <button id="rbacSaveBtn" class="btn btn--primary btn--sm" onclick="saveRBAC()" style="min-width:130px">
        <i class="fa-solid fa-floppy-disk" style="margin-right:6px"></i>Save Changes
      </button>
    </div>
    <div class="dir-table-wrap" style="overflow-x:auto">
      <table class="dir-table">
        <thead>
          <tr>
            <th>Role</th>
            ${allApps.map(k=>`<th style="text-align:center;min-width:68px"><i class="fa-solid ${APP_ICONS[k]}" style="color:${APP_COLORS[k]}"></i><br><span style="font-size:0.6rem">${APP_NAMES[k].replace(' ','<br>')}</span></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${Object.entries(RBAC).map(([role,apps])=>`
            <tr>
              <td><span class="role-chip" style="font-size:0.76rem">${role}</span></td>
              ${allApps.map(k=>`
                <td style="text-align:center">
                  <input type="checkbox"
                    class="rbac-cb"
                    data-role="${role.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"
                    data-app="${k}"
                    ${apps.includes(k) ? 'checked' : ''}
                    onchange="onRbacToggle(this)"
                    style="width:17px;height:17px;cursor:pointer;accent-color:${APP_COLORS[k]}"
                  >
                </td>
              `).join('')}
            </tr>
          `).join('')}
          <tr style="background:rgba(245,158,11,0.04);border-top:2px solid rgba(245,158,11,0.2)">
            <td>
              <span class="chip chip--onboard">Executive level</span>
              <div style="font-size:0.68rem;color:var(--muted);margin-top:3px">Overrides role</div>
            </td>
            ${allApps.map(()=>`<td style="text-align:center"><i class="fa-solid fa-circle-check" style="color:var(--gold);font-size:0.95rem"></i></td>`).join('')}
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

/* ═══ COURSE LIBRARY ════════════════════════════════════════════════ */
function renderCourseLibrary() {
  document.getElementById('courseCount').textContent = _courses.length;
  const catColors = {aum_growth:'#7c5cfc',technical:'#4fc3f7',compliance:'#0984e3',leadership:'#f9c846',client_relations:'#fd79a8',innovation:'#00d4aa',soft_skills:'#ffb347'};
  document.getElementById('courseGrid').innerHTML = _courses.map(c => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden">
      <div style="height:6px;background:${catColors[c.category]||'#7c5cfc'}"></div>
      <div style="padding:18px">
        <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
          <div style="width:40px;height:40px;border-radius:10px;background:${c.thumbnail_color||'#7c5cfc'}20;color:${c.thumbnail_color||'#7c5cfc'};display:flex;align-items:center;justify-content:center;font-size:0.9rem;flex-shrink:0"><i class="fa-solid ${c.thumbnail_icon||'fa-book'}"></i></div>
          <div>
            <div style="font-size:0.88rem;font-weight:700;line-height:1.3">${c.title}</div>
            <div style="font-size:0.72rem;color:var(--muted);margin-top:3px">${c.category?.replace('_',' ')?.toUpperCase()} · ${c.difficulty||'beginner'}</div>
          </div>
        </div>
        <div style="font-size:0.78rem;color:var(--muted2);line-height:1.5;margin-bottom:12px">${(c.description||'').slice(0,120)}…</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:0.7rem;background:rgba(245,158,11,0.1);color:var(--gold);border-radius:6px;padding:2px 8px;font-weight:700">${c.xp_reward||0} XP</span>
          <span style="font-size:0.7rem;color:var(--muted)"><i class="fa-solid fa-clock" style="margin-right:3px"></i>${c.estimated_minutes||30} min</span>
          <span style="font-size:0.7rem;color:var(--muted)"><i class="fa-solid fa-layer-group" style="margin-right:3px"></i>${c.modules_count||3} modules</span>
          ${c.ai_generated ? '<span style="font-size:0.68rem;background:rgba(124,92,252,0.1);color:#7c5cfc;border-radius:6px;padding:2px 8px;font-weight:700"><i class="fa-solid fa-robot" style="margin-right:3px"></i>AI</span>' : ''}
        </div>
      </div>
    </div>
  `).join('');
}

/* ═══ HELPERS ═══════════════════════════════════════════════════════ */
function statusChip(status) {
  const map = { active:'chip--active', inactive:'chip--off', on_leave:'chip--onboard' };
  return `<span class="chip ${map[status]||'chip--off'}">${status||'—'}</span>`;
}
function obStatusChip(status) {
  const map = { in_progress:'chip--onboard', completed:'chip--done', not_started:'chip--off' };
  return `<span class="chip ${map[status]||'chip--off'}" style="font-size:0.7rem">${(status||'').replace('_',' ')}</span>`;
}

function openModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// Close modals on overlay click
document.querySelectorAll('.dir-modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('show'); });
});

let _toastTimer = null;
function showToast(msg, type='success') {
  const t = document.getElementById('dir-toast');
  const m = document.getElementById('dir-toast-msg');
  if (!t || !m) return;
  m.textContent = msg;
  t.querySelector('i').className = type === 'error'
    ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check';
  t.querySelector('i').style.color = type === 'error' ? '#ef4444' : '#00d4aa';
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

/* ═══════════════════════════════════════════════════════════════════════
   DIRECTOR PANEL — HELP SYSTEM
   Contextual sliding help panel for all 6 Director views.
   ═══════════════════════════════════════════════════════════════════════ */

const DIR_HELP = {
  overview: {
    title: 'Dashboard Overview',
    icon:  'fa-gauge-high',
    intro: 'Your Director command centre — live platform stats, recent employee activity, and active onboarding journeys at a glance.',
    sections: [
      { heading: 'Stats Cards', icon: 'fa-chart-bar', color: '#7c5cfc',
        text: 'Four key metrics updated in real time: total employees, active headcount, onboarding journeys in progress, and number of courses in the library. These pull directly from the live database.' },
      { heading: 'Recent Employees', icon: 'fa-users', color: '#00d4aa',
        text: 'The last employees added to the platform. Click any row to open their full detail card — view role, level, app access permissions, and onboarding progress.' },
      { heading: 'Active Onboarding', icon: 'fa-rocket', color: '#f59e0b',
        text: 'Employees who are currently in progress on their onboarding journey. The progress bar shows percentage of the 10 required tasks completed. Click to open the full checklist detail.' },
    ]
  },
  employees: {
    title: 'All Employees',
    icon:  'fa-users',
    intro: 'The full company roster — searchable, with quick access to every employee\'s profile, permissions, and onboarding status.',
    sections: [
      { heading: 'Employee Table', icon: 'fa-table', color: '#7c5cfc',
        text: 'Columns: Employee (avatar + name + email), Role, Department, Level, Status (active/inactive), Onboarding progress bar, and Actions (View, Edit, Activate/Deactivate). Click the row or the View button to open the full detail modal.' },
      { heading: 'Search', icon: 'fa-magnifying-glass', color: '#00d4aa',
        text: 'The search box filters by name, email, role, or department in real time — no page reload. Type at least 1 character to filter. Search resets when cleared.' },
      { heading: 'Employee Detail Modal', icon: 'fa-id-card', color: '#f59e0b',
        text: 'Opens when you click View. Shows: personal info, XP, EVA weight, base salary, onboarding progress, and a full list of the apps this employee has access to based on their role and level.' },
      { heading: 'Edit Employee', icon: 'fa-pen', color: '#e84393',
        text: 'Allows updating name, email, phone, role, department, level, EVA weight, salary, start date, and bio. Changing role or level will automatically update their RBAC app access.' },
      { heading: 'Activate / Deactivate', icon: 'fa-toggle-on', color: '#ef4444',
        text: 'Inactive employees cannot log in to any staff portal. Use this to offboard employees without deleting their data. Reactivation restores all access immediately.' },
    ]
  },
  create: {
    title: 'Add Employee',
    icon:  'fa-user-plus',
    intro: 'Create a new employee account. On submission, the system automatically starts their onboarding journey — 3 mandatory courses are enrolled and a welcome message is delivered.',
    sections: [
      { heading: 'Personal Information', icon: 'fa-id-card', color: '#7c5cfc',
        text: 'First name, last name, and work email are required. Phone, date of birth, and SA ID number are optional but important — the SA ID last 4 digits become the employee\'s default login PIN.' },
      { heading: 'Role & Position', icon: 'fa-briefcase', color: '#00d4aa',
        text: 'Role determines which apps the employee can access (see RBAC matrix). Level determines seniority tier. EVA Weight (0.5×–2.0×) scales their variable bonus allocation.' },
      { heading: 'Live Preview Card', icon: 'fa-eye', color: '#f59e0b',
        text: 'The right panel updates in real time as you type — showing the employee\'s avatar initials, name, role, department, and colour. The 3 auto-enrolled onboarding courses are also shown.' },
      { heading: 'Onboarding Settings', icon: 'fa-rocket', color: '#e84393',
        text: 'Assign an onboarding buddy — a peer who guides the new employee. Write a personalised welcome message (shown as a banner on their first login). Both are optional but highly recommended.' },
      { heading: 'Auto-Onboarding Flow', icon: 'fa-bolt', color: '#10b981',
        text: 'On creation: (1) Employee record created. (2) Auto-enrolled in CRS-OB-001, CRS-OB-002, CRS-OB-003. (3) Onboarding journey record created with 10 default tasks. (4) Activity feed entry logged. (5) Welcome banner shown on employee\'s portal.' },
    ]
  },
  onboarding: {
    title: 'Onboarding Journeys',
    icon:  'fa-rocket',
    intro: 'Track every new employee\'s onboarding progress — task completion, course enrolment, and overall percentage towards being "fully set up".',
    sections: [
      { heading: 'Journey Cards', icon: 'fa-layer-group', color: '#7c5cfc',
        text: 'Each card shows the employee\'s name, role, current status chip (In Progress / Completed / Not Started), progress bar, task count, start date, and assigned buddy. Click any card to open the full checklist.' },
      { heading: 'Filter', icon: 'fa-filter', color: '#00d4aa',
        text: 'Use the dropdown filter to show All, In Progress, Completed, or Not Started journeys. This helps prioritise who needs a follow-up.' },
      { heading: '10-Task Checklist', icon: 'fa-list-check', color: '#f59e0b',
        text: 'Every employee has the same 10 default tasks: Complete Profile, Add Banking, 3 Courses, First Check-in, First OKR, Give Kudos, View EVA Statement, Upload Proof of Banking. Tasks auto-complete as the employee takes each action on their portal.' },
      { heading: 'Auto-Completion', icon: 'fa-circle-check', color: '#10b981',
        text: 'Tasks complete automatically when the employee takes the corresponding action — e.g. saving their profile, submitting a check-in, completing a course. No manual marking needed. The director receives an activity feed notification when all required tasks are done.' },
      { heading: 'Completion Notification', icon: 'fa-bell', color: '#e84393',
        text: 'When an employee completes all required onboarding tasks, you (the creating director) automatically receive an activity feed notification. Check your My Dashboard → Activity Feed to see it.' },
    ]
  },
  access: {
    title: 'Access & Roles',
    icon:  'fa-key',
    intro: 'The full RBAC (Role-Based Access Control) matrix showing every role\'s app permissions — and how executive level overrides all role restrictions.',
    sections: [
      { heading: 'Reading the Matrix', icon: 'fa-table', color: '#7c5cfc',
        text: 'Rows = roles. Columns = apps. Green ✓ = access granted. Grey ✗ = no access. The gold "Executive level" row at the bottom shows that executive-level employees always get all 7 apps regardless of their role.' },
      { heading: '7 App Keys', icon: 'fa-grid-2', color: '#00d4aa',
        text: 'My Dashboard (employee), Team Dashboard (team), Fund Operations (fund), Admin Console (admin), IFA Portal (ifa), Investor Portal (portal), Director Panel (director). Access is enforced on page load by StaffAuth.guard().' },
      { heading: 'Changing Access', icon: 'fa-sliders', color: '#f59e0b',
        text: 'To change an employee\'s access, update their Role or Level in the All Employees view. Access updates immediately on their next login. No separate permission management is needed.' },
      { heading: 'Director Panel Access', icon: 'fa-crown', color: '#e84393',
        text: 'Only CEO role and executive-level employees can access the Director Panel. This is enforced by StaffAuth.isDirector() which checks role === "CEO" OR level === "executive".' },
    ]
  },
  courses: {
    title: 'Course Library',
    icon:  'fa-graduation-cap',
    intro: 'All training courses available on the platform — both AI-generated employee courses and the 3 pre-seeded onboarding courses.',
    sections: [
      { heading: 'Course Cards', icon: 'fa-layer-group', color: '#7c5cfc',
        text: 'Each card shows: title, category (colour-coded), difficulty, XP reward, estimated minutes, module count, and an AI badge if the course was generated by the AI generator.' },
      { heading: 'Onboarding Courses', icon: 'fa-rocket', color: '#f59e0b',
        text: 'CRS-OB-001 (Welcome to SV Capital), CRS-OB-002 (Platform Walkthrough), and CRS-OB-003 (Compliance & FICA) are the 3 mandatory courses auto-enrolled for every new employee.' },
      { heading: 'AI-Generated Courses', icon: 'fa-robot', color: '#00d4aa',
        text: 'Employees can generate personalised courses from their My Dashboard → My Courses view. These appear here with the AI badge. Each has 3 modules, rich lesson content, and MCQ quizzes.' },
      { heading: 'KPI Boost Mapping', icon: 'fa-chart-bar', color: '#e84393',
        text: 'Each course is linked to a KPI dimension. Completing a course auto-boosts that dimension score for the employee. You can see which KPI each course targets on the card (shown as category).' },
    ]
  },
};

let _dirHelpOpen = false;

function toggleDirHelp() {
  _dirHelpOpen = !_dirHelpOpen;
  const panel   = document.getElementById('dirHelpPanel');
  const overlay = document.getElementById('dirHelpOverlay');
  panel.style.right  = _dirHelpOpen ? '0' : '-420px';
  overlay.style.display = _dirHelpOpen ? 'block' : 'none';
  if (_dirHelpOpen) renderDirHelp(_currentView);
}

function renderDirHelp(view) {
  const hc = DIR_HELP[view] || DIR_HELP['overview'];
  const ctxEl = document.getElementById('dir-help-context');
  const body  = document.getElementById('dirHelpBody');
  if (ctxEl) ctxEl.textContent = hc.title;
  if (!body) return;

  body.innerHTML = `
    <!-- Intro -->
    <div style="background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.18);
                border-radius:12px;padding:16px;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:28px;height:28px;border-radius:8px;background:rgba(245,158,11,0.15);
                    color:#f59e0b;display:flex;align-items:center;justify-content:center;font-size:0.78rem;flex-shrink:0">
          <i class="fa-solid ${hc.icon}"></i>
        </div>
        <div style="font-size:0.88rem;font-weight:800;color:#f59e0b">${hc.title}</div>
      </div>
      <div style="font-size:0.8rem;color:#d1d5db;line-height:1.6">${hc.intro}</div>
    </div>

    <!-- Sections -->
    ${hc.sections.map(s => `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
                  border-radius:10px;padding:14px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:7px">
          <div style="width:26px;height:26px;border-radius:7px;background:${s.color}20;color:${s.color};
                      display:flex;align-items:center;justify-content:center;font-size:0.72rem;flex-shrink:0">
            <i class="fa-solid ${s.icon}"></i>
          </div>
          <div style="font-size:0.82rem;font-weight:700;color:#e8eaf6">${s.heading}</div>
        </div>
        <div style="font-size:0.78rem;color:#9ca3af;line-height:1.7;padding-left:35px">${s.text}</div>
      </div>
    `).join('')}

    <!-- Quick nav -->
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
                border-radius:10px;padding:14px;margin-top:8px">
      <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;
                  color:#6b7280;margin-bottom:10px">Jump to view</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${Object.entries(DIR_HELP).map(([key, hc]) => `
          <button onclick="navTo('${key}',document.querySelector('[data-view=${key}]'));renderDirHelp('${key}');"
            style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);
                   border-radius:6px;padding:4px 10px;font-size:0.72rem;font-weight:600;color:#9ca3af;
                   cursor:pointer;font-family:inherit;transition:all 0.15s"
            onmouseover="this.style.background='rgba(245,158,11,0.12)';this.style.color='#fcd34d'"
            onmouseout="this.style.background='rgba(255,255,255,0.05)';this.style.color='#9ca3af'">
            <i class="fa-solid ${hc.icon}" style="margin-right:4px;font-size:0.68rem"></i>${hc.title}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

/* ═══ DEPT CHART ══════════════════════════════════════════════════ */
function renderDeptChart() {
  const ctx = document.getElementById('deptChart');
  if (!ctx) return;
  if (_dirCharts.dept) { _dirCharts.dept.destroy(); }
  const deptCounts = {};
  _employees.filter(e => e.status === 'active').forEach(e => {
    const d = e.department || 'Other';
    deptCounts[d] = (deptCounts[d] || 0) + 1;
  });
  const labels = Object.keys(deptCounts);
  const values = Object.values(deptCounts);
  const palette = ['#7c5cfc','#f59e0b','#10b981','#00d4aa','#60a5fa','#f87171','#a78bfa','#34d399'];
  _dirCharts.dept = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label:'Headcount', data: values, backgroundColor: palette.slice(0, labels.length), borderRadius: 6, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color:'#9ca3af', font:{size:11} }, grid: { display: false } },
        y: { ticks: { color:'#9ca3af', stepSize:1 }, grid: { color:'rgba(255,255,255,0.04)' }, beginAtZero: true }
      }
    }
  });
}

/* ═══ ACTIVITY FEED ══════════════════════════════════════════════ */
function renderActivityFeed() {
  const el = document.getElementById('dirActivityFeed');
  if (!el) return;
  const events = [];
  [..._employees].sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0)).slice(0,3).forEach(e => {
    events.push({ icon:'fa-user-plus', color:'#10b981', text:`<b>${e.first_name} ${e.last_name}</b> joined as ${e.role||'employee'}`, date: e.created_at });
  });
  _onboarding.filter(o => o.status === 'completed').slice(0,3).forEach(ob => {
    const emp = _employees.find(e => e.id === ob.employee_id);
    if (emp) events.push({ icon:'fa-rocket', color:'#f59e0b', text:`<b>${emp.first_name} ${emp.last_name}</b> completed onboarding`, date: ob.updated_at });
  });
  _onboarding.filter(o => o.status === 'in_progress').slice(0,2).forEach(ob => {
    const emp = _employees.find(e => e.id === ob.employee_id);
    const pct = ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : 0;
    if (emp) events.push({ icon:'fa-spinner', color:'#60a5fa', text:`<b>${emp.first_name} ${emp.last_name}</b> — onboarding ${pct}% complete`, date: ob.updated_at });
  });
  events.sort((a,b) => new Date(b.date||0) - new Date(a.date||0));
  if (!events.length) { el.innerHTML = `<div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:20px">No recent activity</div>`; return; }
  el.innerHTML = events.slice(0,8).map(ev => `
    <div style="display:flex;align-items:flex-start;gap:10px;font-size:0.8rem">
      <div style="width:24px;height:24px;border-radius:6px;background:${ev.color}1a;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">
        <i class="fa-solid ${ev.icon}" style="color:${ev.color};font-size:0.7rem"></i>
      </div>
      <div style="flex:1;line-height:1.45;color:var(--muted2)">${ev.text}${ev.date ? `<span style="display:block;font-size:0.68rem;color:var(--muted);margin-top:1px">${fmtDate(ev.date)}</span>` : ''}</div>
    </div>`).join('');
}

/* ═══ PERFORMANCE VIEW ═══════════════════════════════════════════ */
function renderPerformanceView() {
  const empData = _employees.map(e => {
    const scores = _kpiScores.filter(k => k.employee_id === e.id);
    const latest = scores.sort((a,b) => (b.period||'').localeCompare(a.period||''))[0];
    return { ...e, kpi: latest ? parseFloat(latest.overall_score)||0 : null };
  }).sort((a,b) => (b.kpi||0) - (a.kpi||0));

  const withKpi = empData.filter(e => e.kpi !== null);
  const avgKpi = withKpi.length ? withKpi.reduce((s,e)=>s+e.kpi,0)/withKpi.length : 0;
  const topKpi = withKpi[0]?.kpi || 0;
  const totalPayroll = _payslips.reduce((s,p)=>s+(parseFloat(p.nett_pay)||0),0);
  const avgEva = _employees.length ? _employees.reduce((s,e)=>s+(parseFloat(e.eva_weight)||0),0)/_employees.length : 0;

  const perfStats = document.getElementById('perfStats');
  if (perfStats) perfStats.innerHTML = `
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(124,92,252,.1);color:#a78bfa"><i class="fa-solid fa-chart-bar"></i></div>
      <div><div class="dir-stat-val">${avgKpi.toFixed(1)}%</div><div class="dir-stat-label">Avg KPI Score</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(16,185,129,.1);color:#10b981"><i class="fa-solid fa-trophy"></i></div>
      <div><div class="dir-stat-val">${topKpi.toFixed(1)}%</div><div class="dir-stat-label">Top Score</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(245,158,11,.1);color:#f59e0b"><i class="fa-solid fa-file-invoice-dollar"></i></div>
      <div><div class="dir-stat-val">${zarM(totalPayroll)}</div><div class="dir-stat-label">Total Payroll (all time)</div></div>
    </div>
    <div class="dir-stat">
      <div class="dir-stat-icon" style="background:rgba(0,212,170,.1);color:#00d4aa"><i class="fa-solid fa-scale-balanced"></i></div>
      <div><div class="dir-stat-val">${avgEva.toFixed(2)}x</div><div class="dir-stat-label">Avg EVA Weight</div></div>
    </div>
  `;

  // KPI radar chart — avg scores per dimension
  const dims = ['strategy','execution','client','compliance','innovation','leadership','teamwork','growth'];
  const dimLabels = ['Strategy','Execution','Client','Compliance','Innovation','Leadership','Teamwork','Growth'];
  const dimAvgs = dims.map(d => {
    const vals = _kpiScores.map(k => parseFloat(k[d+'_score'])||0).filter(v=>v>0);
    return vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : 0;
  });
  const radarCtx = document.getElementById('perfRadarChart');
  if (radarCtx) {
    if (_dirCharts.perfRadar) _dirCharts.perfRadar.destroy();
    _dirCharts.perfRadar = new Chart(radarCtx, {
      type: 'radar',
      data: {
        labels: dimLabels,
        datasets: [{
          label: 'Team Avg', data: dimAvgs,
          backgroundColor: 'rgba(124,92,252,0.15)', borderColor: '#7c5cfc', borderWidth: 2,
          pointBackgroundColor: '#7c5cfc', pointRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { r: {
          ticks: { display: false, stepSize: 25 },
          grid: { color: 'rgba(255,255,255,0.07)' },
          angleLines: { color: 'rgba(255,255,255,0.07)' },
          pointLabels: { color: '#9ca3af', font: { size: 10 } },
          min: 0, max: 100
        }}
      }
    });
  }

  // Dept avg score bar chart
  const deptCtx = document.getElementById('perfDeptChart');
  if (deptCtx) {
    if (_dirCharts.perfDept) _dirCharts.perfDept.destroy();
    const deptMap = {};
    empData.forEach(e => {
      if (e.kpi === null) return;
      const d = e.department || 'Other';
      if (!deptMap[d]) deptMap[d] = [];
      deptMap[d].push(e.kpi);
    });
    const dLabels = Object.keys(deptMap);
    const dAvgs = dLabels.map(d => deptMap[d].reduce((s,v)=>s+v,0)/deptMap[d].length);
    const palette = ['#7c5cfc','#f59e0b','#10b981','#00d4aa','#60a5fa','#f87171','#a78bfa','#34d399'];
    _dirCharts.perfDept = new Chart(deptCtx, {
      type: 'bar',
      data: { labels: dLabels, datasets: [{ label:'Avg KPI %', data: dAvgs.map(v=>+v.toFixed(1)), backgroundColor: palette.slice(0,dLabels.length), borderRadius:5 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color:'#9ca3af', font:{size:11} }, grid: { display:false } },
          y: { ticks: { color:'#9ca3af', callback:v=>v+'%' }, grid: { color:'rgba(255,255,255,0.04)' }, min:0, max:100 }
        }
      }
    });
  }

  // Leaderboard table
  const tbody = document.getElementById('perfLeaderboard');
  if (!tbody) return;
  if (!empData.length) { tbody.innerHTML = `<tr><td colspan="7"><div class="dir-empty">No employee data</div></td></tr>`; return; }
  const LEVELS = [{level:1,title:'Analyst',minXP:0},{level:2,title:'Associate',minXP:500},{level:3,title:'Senior',minXP:1200},{level:4,title:'Lead',minXP:2500},{level:5,title:'Director',minXP:4500},{level:6,title:'MVP',minXP:7000}];
  function xpLevel(xp) { return [...LEVELS].reverse().find(l => (xp||0) >= l.minXP) || LEVELS[0]; }
  tbody.innerHTML = empData.map((e, i) => {
    const lv = xpLevel(e.xp_total);
    const kpiColor = e.kpi === null ? '#6b7280' : e.kpi >= 75 ? '#10b981' : e.kpi >= 50 ? '#f59e0b' : '#ef4444';
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:22px;text-align:center;font-size:0.75rem;font-weight:700;color:${i<3?'#f59e0b':'#6b7280'}">${i+1}</div>
          <div class="emp-row-avatar" style="background:${e.avatar_color||'#7c5cfc'}">${e.avatar_initials||'?'}</div>
          <div><div class="emp-row-name">${e.first_name} ${e.last_name}</div><div class="emp-row-email">${e.role||''}</div></div>
        </div>
      </td>
      <td style="color:var(--muted2);font-size:0.8rem">${e.department||'—'}</td>
      <td><span style="font-weight:700;color:${kpiColor}">${e.kpi !== null ? e.kpi.toFixed(1)+'%' : '—'}</span></td>
      <td style="color:var(--muted2)">${e.eva_weight||'1.0'}x</td>
      <td style="color:var(--muted2)">${(e.xp_total||0).toLocaleString()} XP</td>
      <td><span style="background:${lv.color}22;color:${lv.color};border-radius:6px;padding:2px 8px;font-size:0.72rem;font-weight:700">${lv.title}</span></td>
      <td>${statusChip(e.status)}</td>
    </tr>`;
  }).join('');
}

/* ═══ CSV / PDF EXPORTS ══════════════════════════════════════════ */
function _dirCsvDownload(filename, headers, rows) {
  const esc = v => { const s=String(v==null?'':v); return (s.includes(',')||s.includes('"')||s.includes('\n'))?'"'+s.replace(/"/g,'""')+'"':s; };
  const csv = [headers.map(esc).join(','), ...rows.map(r=>r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  showToast('CSV export started', 'success');
}

function exportEmployeesCSV() {
  if (!_employees.length) { showToast('No employees to export', 'error'); return; }
  const headers = ['First Name','Last Name','Email','Role','Department','Level','Status','Start Date','Salary','EVA Weight'];
  const rows = _employees.map(e => [
    e.first_name, e.last_name, e.email, e.role, e.department,
    LEVEL_LABELS[e.level]||e.level, e.status, e.start_date||'', e.salary||'', e.eva_weight||''
  ]);
  _dirCsvDownload('employees.csv', headers, rows);
}

function exportEmployeesPDF() {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) { showToast('PDF library not loaded', 'error'); return; }
  if (!_employees.length) { showToast('No employees to export', 'error'); return; }
  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });
  doc.setFontSize(16); doc.setTextColor(245,158,11);
  doc.text('SV Capital — Employee Register', 14, 16);
  doc.setFontSize(9); doc.setTextColor(100,116,139);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-ZA')} · ${_employees.length} employees`, 14, 22);
  doc.autoTable({
    startY: 27,
    head: [['Name','Email','Role','Dept','Level','Status','Start Date']],
    body: _employees.map(e => [
      `${e.first_name} ${e.last_name}`, e.email||'', e.role||'',
      e.department||'', LEVEL_LABELS[e.level]||e.level||'',
      e.status||'', e.start_date||''
    ]),
    styles:{ fontSize:8, cellPadding:3 },
    headStyles:{ fillColor:[17,19,24], textColor:[245,158,11], fontStyle:'bold' },
    alternateRowStyles:{ fillColor:[245,247,250] },
    theme:'grid'
  });
  doc.save('employees.pdf');
  showToast('PDF export started', 'success');
}

function exportPayslipsSummaryCSV() {
  if (!_payslips.length) { showToast('No payslips to export', 'error'); return; }
  const headers = ['Employee ID','Pay Period','Gross Pay','PAYE','UIF','Other Ded','Nett Pay','Notes'];
  const rows = _payslips.map(p => [
    p.employee_id||'', p.pay_period||'',
    p.gross_pay||0, p.paye||0, p.uif||0, p.other_deductions||0, p.nett_pay||0, p.notes||''
  ]);
  _dirCsvDownload('payslips_summary.csv', headers, rows);
}

function exportOnboardingCSV() {
  if (!_onboarding.length) { showToast('No onboarding records to export', 'error'); return; }
  const headers = ['Employee','Role','Status','Tasks Done','Tasks Total','Progress %','Start Date','Buddy'];
  const rows = _onboarding.map(ob => {
    const emp = _employees.find(e => e.id === ob.employee_id);
    const pct = ob.tasks_total > 0 ? Math.round((ob.tasks_completed||0)/ob.tasks_total*100) : 0;
    return [
      emp ? `${emp.first_name} ${emp.last_name}` : ob.employee_id,
      emp?.role||'', ob.status||'', ob.tasks_completed||0, ob.tasks_total||0, pct+'%',
      ob.start_date||'', ob.buddy_name||''
    ];
  });
  _dirCsvDownload('onboarding_report.csv', headers, rows);
}

function exportPerformanceCSV() {
  const headers = ['Employee','Department','Role','KPI Score','EVA Weight','XP','Level','Status'];
  const rows = _employees.map(e => {
    const scores = _kpiScores.filter(k => k.employee_id === e.id);
    const latest = scores.sort((a,b)=>(b.period||'').localeCompare(a.period||''))[0];
    const kpi = latest ? parseFloat(latest.overall_score)||0 : '';
    return [
      `${e.first_name} ${e.last_name}`, e.department||'', e.role||'',
      kpi !== '' ? kpi.toFixed(1)+'%' : '—',
      e.eva_weight||'1.0', e.xp_total||0, LEVEL_LABELS[e.level]||e.level||'', e.status||''
    ];
  });
  _dirCsvDownload('performance_report.csv', headers, rows);
}

/* ═══ COMMAND PALETTE ════════════════════════════════════════════ */
const DIR_CMD_ITEMS = [
  { label:'Dashboard',       icon:'fa-gauge-high',          view:'overview' },
  { label:'All Employees',   icon:'fa-users',               view:'employees' },
  { label:'Add Employee',    icon:'fa-user-plus',           view:'create' },
  { label:'Onboarding',      icon:'fa-rocket',              view:'onboarding' },
  { label:'Access & Roles',  icon:'fa-key',                 view:'access' },
  { label:'Course Library',  icon:'fa-graduation-cap',      view:'courses' },
  { label:'Payslips',        icon:'fa-file-invoice-dollar', view:'payslips' },
  { label:'Performance',     icon:'fa-chart-bar',           view:'performance' },
  { label:'Export Employees CSV', icon:'fa-file-csv',       action: ()=>exportEmployeesCSV() },
  { label:'Export Employees PDF', icon:'fa-file-pdf',       action: ()=>exportEmployeesPDF() },
  { label:'Export Payslips CSV',  icon:'fa-file-csv',       action: ()=>exportPayslipsSummaryCSV() },
  { label:'Export Onboarding CSV',icon:'fa-file-csv',       action: ()=>exportOnboardingCSV() },
  { label:'Export Performance CSV',icon:'fa-file-csv',      action: ()=>exportPerformanceCSV() },
  { label:'App Hub',         icon:'fa-grid-2',              href:'hub.html' },
  { label:'My Dashboard',    icon:'fa-user-circle',         href:'employee.html' },
  { label:'Team Dashboard',  icon:'fa-people-group',        href:'index.html' },
];
let _dirCmdActive = -1;

function openDirCmdPalette() {
  const ov = document.getElementById('dirCmdOverlay');
  if (!ov) return;
  ov.style.display = 'flex';
  _dirCmdActive = -1;
  const inp = document.getElementById('dirCmdInput');
  if (inp) { inp.value = ''; inp.focus(); }
  renderDirCmdResults('');
}

function closeDirCmdPalette() {
  const ov = document.getElementById('dirCmdOverlay');
  if (ov) ov.style.display = 'none';
}

function renderDirCmdResults(q) {
  const el = document.getElementById('dirCmdResults');
  if (!el) return;
  _dirCmdActive = -1;
  const query = (q||'').toLowerCase().trim();
  const filtered = query ? DIR_CMD_ITEMS.filter(c=>c.label.toLowerCase().includes(query)) : DIR_CMD_ITEMS;
  if (!filtered.length) {
    el.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px">No results for "${q}"</div>`;
    el._filtered = []; return;
  }
  el.innerHTML = filtered.map((c,i) =>
    `<div class="dir-cmd-item" data-idx="${i}" onmouseenter="dirCmdHover(${i})" onclick="dirCmdSelect(${i})"
      style="display:flex;align-items:center;gap:12px;padding:10px 18px;cursor:pointer;transition:background .1s;color:#e8eaf6;font-size:13px">
      <i class="fa-solid ${c.icon}" style="width:16px;text-align:center;color:#6b7280;font-size:13px"></i>
      <span>${c.label}</span>
      ${c.view?`<kbd style="margin-left:auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:4px;font-size:10px;padding:1px 6px;color:#6b7280">${c.view}</kbd>`:''}
    </div>`
  ).join('');
  el._filtered = filtered;
}

function dirCmdHover(idx) {
  _dirCmdActive = idx;
  document.querySelectorAll('.dir-cmd-item').forEach((el,i) => {
    el.style.background = i === idx ? 'rgba(245,158,11,.1)' : '';
  });
}

function dirCmdSelect(idx) {
  const el = document.getElementById('dirCmdResults');
  const filtered = el?._filtered || DIR_CMD_ITEMS;
  const item = filtered[idx];
  if (!item) return;
  closeDirCmdPalette();
  if (item.action) { item.action(); return; }
  if (item.href)   { window.location.href = item.href; return; }
  if (item.view)   navTo(item.view, document.querySelector(`[data-view="${item.view}"]`));
}

function dirCmdKeyNav(e) {
  const el = document.getElementById('dirCmdResults');
  const filtered = el?._filtered || [];
  const count = filtered.length;
  if (!count) return;
  if (e.key==='ArrowDown')  { e.preventDefault(); dirCmdHover((_dirCmdActive+1)%count); }
  if (e.key==='ArrowUp')    { e.preventDefault(); dirCmdHover((_dirCmdActive-1+count)%count); }
  if (e.key==='Enter')      { e.preventDefault(); if (_dirCmdActive>=0) dirCmdSelect(_dirCmdActive); else if(count>0) dirCmdSelect(0); }
  if (e.key==='Escape')     { closeDirCmdPalette(); }
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key==='k') { e.preventDefault(); openDirCmdPalette(); }
  if (e.key==='Escape') { const ov=document.getElementById('dirCmdOverlay'); if(ov&&ov.style.display!=='none') closeDirCmdPalette(); }
});

// Auto-update help panel when navigating
const _dirOrigNavTo = navTo;
window.navTo = function(view, btn) {
  _dirOrigNavTo(view, btn);
  if (_dirHelpOpen) renderDirHelp(view);
};

window.toggleDirHelp  = toggleDirHelp;
window.renderDirHelp  = renderDirHelp;
