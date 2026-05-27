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
    return r.ok ? r.json() : {data:[],total:0};
  } catch { return {data:[],total:0}; }
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
const RBAC = {
  'CEO':                ['employee','team','fund','admin','ifa','portal','director'],
  'Operations Manager': ['employee','team','fund','admin'],
  'Finance Manager':    ['employee','team','fund','admin'],
  'Tech Lead':          ['employee','team','fund','admin'],
  'Investment Analyst': ['employee','team','fund'],
  'Compliance Officer': ['employee','admin'],
  'Client Relations':   ['employee','portal'],
  'Marketing':          ['employee'],
  'Junior Analyst':     ['employee'],
  'Admin':              ['employee'],
};
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
let _editingEmp = null;
let _selectedColor = '#7c5cfc';
let _currentView   = 'overview';

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
});

async function loadAll() {
  const [emps, ob, courses] = await Promise.all([
    fetchAll('employees'),
    fetchAll('employee_onboarding'),
    fetchAll('employee_courses'),
  ]);
  _employees  = emps;
  _onboarding = ob;
  _courses    = courses;

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
  overview:   { title:'Dashboard',       sub:'Platform overview and quick stats' },
  employees:  { title:'All Employees',   sub:'Manage your full team roster' },
  create:     { title:'Add Employee',    sub:'Create a new employee and start their onboarding journey' },
  onboarding: { title:'Onboarding',      sub:'Track new employee onboarding progress' },
  access:     { title:'Access & Roles',  sub:'Role-based access control matrix' },
  courses:    { title:'Course Library',  sub:'All available training courses' },
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
    actEl.innerHTML = `<button class="btn btn--gold btn--sm" onclick="navTo('create',document.querySelector('[data-view=create]'))"><i class="fa-solid fa-user-plus"></i> Add Employee</button>`;
  }

  // Render view content
  const renders = {
    overview:   renderOverview,
    employees:  renderEmployees,
    onboarding: renderOnboardingView,
    access:     renderAccessMatrix,
    courses:    renderCourseLibrary,
  };
  if (renders[view]) renders[view]();
}

/* ═══ OVERVIEW ══════════════════════════════════════════════════════ */
function renderOverview() {
  const active    = _employees.filter(e => e.status === 'active').length;
  const totalOb   = _onboarding.length;
  const doneOb    = _onboarding.filter(o => o.status === 'completed').length;
  const inProgOb  = _onboarding.filter(o => o.status === 'in_progress').length;

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
  const q = (document.getElementById('empSearch')?.value||'').toLowerCase();
  _empFilteredList = _employees.filter(e =>
    `${e.first_name} ${e.last_name} ${e.email} ${e.role} ${e.department}`.toLowerCase().includes(q)
  );
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
      <div class="form-group"><label>Role</label>
        <select id="e-role">
          ${['CEO','Operations Manager','Investment Analyst','Client Relations','Compliance Officer','Marketing','Tech Lead','Finance Manager','Junior Analyst','Admin'].map(r=>`<option ${r===e.role?'selected':''}>${r}</option>`).join('')}
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
    first_name:  document.getElementById('e-fname').value.trim(),
    last_name:   document.getElementById('e-lname').value.trim(),
    email:       document.getElementById('e-email').value.trim(),
    phone:       document.getElementById('e-phone').value.trim(),
    role:        document.getElementById('e-role').value,
    department:  document.getElementById('e-dept').value,
    level:       document.getElementById('e-level').value,
    eva_weight:  parseFloat(document.getElementById('e-eva').value),
    base_salary: Number(document.getElementById('e-salary').value) || null,
    start_date:  document.getElementById('e-start').value || null,
    bio:         document.getElementById('e-bio').value.trim(),
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
  ['c-fname','c-lname','c-email','c-phone','c-dob','c-idnum','c-bio','c-welcome'].forEach(id => {
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

/* ═══ ACCESS MATRIX ═════════════════════════════════════════════════ */
function renderAccessMatrix() {
  const allApps = Object.keys(APP_NAMES);
  document.getElementById('rbacMatrix').innerHTML = `
    <div class="dir-table-wrap" style="overflow-x:auto">
      <table class="dir-table">
        <thead>
          <tr>
            <th>Role</th>
            ${allApps.map(k=>`<th style="text-align:center"><i class="fa-solid ${APP_ICONS[k]}" style="color:${APP_COLORS[k]}"></i><br><span style="font-size:0.6rem">${APP_NAMES[k].replace(' ','<br>')}</span></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${Object.entries(RBAC).map(([role,apps])=>`
            <tr>
              <td><span class="role-chip" style="font-size:0.76rem">${role}</span></td>
              ${allApps.map(k=>`
                <td style="text-align:center">
                  ${apps.includes(k)
                    ? `<i class="fa-solid fa-circle-check" style="color:#10b981;font-size:0.95rem"></i>`
                    : `<i class="fa-solid fa-circle-xmark" style="color:var(--border2);font-size:0.95rem"></i>`
                  }
                </td>
              `).join('')}
            </tr>
          `).join('')}
          <tr style="background:rgba(245,158,11,0.04);border-top:2px solid rgba(245,158,11,0.2)">
            <td><span class="chip chip--onboard">Executive level</span><div style="font-size:0.68rem;color:var(--muted);margin-top:3px">Overrides role</div></td>
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

// Auto-update help panel when navigating
const _dirOrigNavTo = navTo;
window.navTo = function(view, btn) {
  _dirOrigNavTo(view, btn);
  if (_dirHelpOpen) renderDirHelp(view);
};

window.toggleDirHelp  = toggleDirHelp;
window.renderDirHelp  = renderDirHelp;
