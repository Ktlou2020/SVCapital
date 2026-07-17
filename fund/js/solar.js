/* ============================================================
   SV Capital — Solar Investment Management
   fund/js/solar.js
   NAV Engine + Full CRUD + Charts
   ============================================================ */

'use strict';

const SOL_BASE = '/api/';

/* ── API HELPERS ──────────────────────────────────────────── */
function _solGetToken() {
  return localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token') || null;
}
async function solFetch(path, opts = {}) {
  const token = _solGetToken();
  opts.headers = Object.assign(
    token ? { Authorization: `Bearer ${token}` } : {},
    opts.headers || {}
  );
  opts.credentials = 'include';
  const r = await fetch(SOL_BASE + path, opts);
  if (r.status === 401) { let l='/login.html'; try{const s=JSON.parse(localStorage.getItem('staffSession')||'null');if(s&&s.empId&&s.expiresAt>Date.now())l='/team/login.html';}catch(_){} window.location.replace(l); throw new Error('Session expired'); }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`API ${r.status}: ${t}`); }
  return r;
}
async function solGet(path)       { return (await solFetch(path)).json(); }
async function solPost(path, d)   { return (await solFetch(path, { method:'POST',  headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) })).json(); }
async function solPatch(path, d)  { return (await solFetch(path, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) })).json(); }
async function solDelete(path)    { return solFetch(path, { method:'DELETE' }); }

async function solFetchAll(table) {
  const PAGE = 100; let page = 1, all = [];
  while (true) {
    let res;
    try { res = await solGet(`tables/${table}?limit=${PAGE}&page=${page}`); } catch(e) { break; }
    const rows = res.data || [];
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    if (res.total > 0 && all.length >= res.total) break;
    page++;
  }
  return all;
}

/* ── TOAST ─────────────────────────────────────────────────── */
const SToast = {
  show(msg, type = 'success') {
    const c = document.getElementById('solToastContainer');
    if (!c) return;
    const icons = { success:'fa-check-circle', error:'fa-exclamation-circle', info:'fa-info-circle' };
    const el = document.createElement('div');
    el.className = `sol-toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icons[type]||icons.info}" style="color:${type==='error'?'#f87171':type==='success'?'#74c69d':'#fec24f'}"></i><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }
};

/* ── FORMAT HELPERS ────────────────────────────────────────── */
const sfmt = {
  zar:  v => v == null || isNaN(v) ? '—' : 'R' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits:2, maximumFractionDigits:2 }),
  zarM: v => { if (v == null || isNaN(v)) return '—'; const n=Number(v); return n>=1e6?'R'+(n/1e6).toFixed(2)+'M':n>=1e3?'R'+(n/1e3).toFixed(1)+'k':'R'+n.toFixed(0); },
  pct:  v => v == null || isNaN(v) ? '—' : Number(v).toFixed(2) + '%',
  date: v => { if (!v) return '—'; try { return new Date(v).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' }); } catch { return v; } },
  days: v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-ZA') + ' days',
};

/* ── STATE ──────────────────────────────────────────────────── */
const SOL = {
  projects: [],
  currentView: 'dashboard',
  charts: {},
  editingId: null,
  docsProjectId: null,
  currentDocs: []
};

/* ══════════════════════════════════════════════════════════════
   NAV ENGINE
══════════════════════════════════════════════════════════════ */
const SolarNAV = {

  /**
   * Calculate accrued returns for a single project.
   * AccruedReturn = capital × annualRate × (daysElapsed / 365)
   */
  projectNAV(proj) {
    const capital     = parseFloat(proj.capital_deployed) || 0;
    const annualRate  = parseFloat(proj.annual_rate) || 0;
    const startDate   = proj.start_date ? new Date(proj.start_date) : null;
    const maturityDate= proj.maturity_date ? new Date(proj.maturity_date) : null;
    const now         = new Date();

    let daysElapsed = 0;
    if (startDate) {
      const endPoint = (proj.status === 'matured' && maturityDate) ? maturityDate : now;
      daysElapsed = Math.max(0, Math.round((endPoint - startDate) / 86400000));
    }

    const totalTermDays = (startDate && maturityDate)
      ? Math.max(1, Math.round((maturityDate - startDate) / 86400000))
      : (parseFloat(proj.term_years) || 1) * 365;

    const accruedReturn   = capital * annualRate * (daysElapsed / 365);
    const contractedReturn= parseFloat(proj.contracted_return) || (capital * annualRate * (totalTermDays / 365));
    const actualReturn    = parseFloat(proj.actual_return) || 0;
    const nav             = capital + accruedReturn;          // NAV = capital + accrued
    const progressPct     = totalTermDays > 0 ? Math.min(100, (daysElapsed / totalTermDays) * 100) : 0;
    const returnPct       = capital > 0 ? (accruedReturn / capital) * 100 : 0;
    const daysRemaining   = Math.max(0, totalTermDays - daysElapsed);

    return {
      capital, annualRate, daysElapsed, totalTermDays, daysRemaining,
      accruedReturn, contractedReturn, actualReturn, nav,
      progressPct, returnPct
    };
  },

  /**
   * Aggregate NAV across all projects
   */
  portfolioNAV(projects) {
    const active  = projects.filter(p => p.status === 'active');
    const matured = projects.filter(p => p.status === 'matured');

    let totalCapital = 0, totalAccrued = 0, totalContracted = 0, totalActual = 0;

    active.forEach(p => {
      const n = SolarNAV.projectNAV(p);
      totalCapital    += n.capital;
      totalAccrued    += n.accruedReturn;
      totalContracted += n.contractedReturn;
    });

    matured.forEach(p => {
      totalCapital    += parseFloat(p.capital_deployed) || 0;
      totalContracted += parseFloat(p.contracted_return) || 0;
      totalActual     += parseFloat(p.actual_return) || 0;
    });

    const portfolioNAV  = totalCapital + totalAccrued;
    const overallReturnPct = totalCapital > 0 ? (totalAccrued / totalCapital) * 100 : 0;

    return {
      activeCount: active.length,
      maturedCount: matured.length,
      totalProjects: projects.length,
      totalCapital, totalAccrued, totalContracted, totalActual,
      portfolioNAV, overallReturnPct
    };
  }
};

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
});

async function loadAll() {
  SOL.projects = await solFetchAll('solar_projects');
  const view = SOL.currentView || 'dashboard';
  const btn  = document.querySelector(`[data-view="${view}"]`);
  solNavigate(view, btn);
}

function solNavigate(view, btn) {
  SOL.currentView = view;
  document.querySelectorAll('.sol-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.sol-nav-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('sol-view-' + view);
  if (el) el.classList.add('active');
  if (btn) btn.classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    projects:  'All Projects',
    add:       'Add Project',
    nav:       'NAV Calculator'
  };
  document.getElementById('solTopTitle').textContent = titles[view] || view;

  const loaders = {
    dashboard: renderDashboard,
    projects:  renderProjectsView,
    nav:       renderNAVCalculator
  };
  if (loaders[view]) loaders[view]();
}

/* ══════════════════════════════════════════════════════════════
   VIEW: DASHBOARD
══════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const el = document.getElementById('sol-view-dashboard');
  const pNav = SolarNAV.portfolioNAV(SOL.projects);
  const now  = new Date().toLocaleDateString('en-ZA', { day:'2-digit', month:'long', year:'numeric' });

  // Chart data: capital by project
  const activeProjs = SOL.projects.filter(p => p.status === 'active');
  const chartLabels = activeProjs.map(p => p.project_name ? p.project_name.substring(0,24) + (p.project_name.length > 24 ? '…' : '') : p.id);
  const chartCapital = activeProjs.map(p => parseFloat(p.capital_deployed) || 0);
  const chartAccrued = activeProjs.map(p => SolarNAV.projectNAV(p).accruedReturn);

  // Product type breakdown
  const typeBreakdown = { '5yr': 0, '6yr': 0, '7yr': 0 };
  SOL.projects.filter(p => p.status === 'active').forEach(p => {
    const t = p.product_type || '7yr';
    typeBreakdown[t] = (typeBreakdown[t] || 0) + (parseFloat(p.capital_deployed) || 0);
  });

  el.innerHTML = `
    <!-- NAV Hero -->
    <div class="sol-nav-hero">
      <div>
        <div class="sol-hero-label"><i class="fa-solid fa-solar-panel"></i> &nbsp;Solar Finance — Portfolio NAV</div>
        <div class="sol-hero-value">${sfmt.zarM(pNav.portfolioNAV)}</div>
        <div class="sol-hero-sub">Capital + Accrued Returns &nbsp;·&nbsp; as at ${now}</div>
      </div>
      <div class="sol-hero-stats">
        <div class="sol-hero-stat">
          <div class="sol-hero-stat-label">Unrealised Return</div>
          <div class="sol-hero-stat-val" style="color:#74c69d">+${sfmt.zarM(pNav.totalAccrued)}</div>
          <div class="sol-hero-stat-sub">${pNav.overallReturnPct.toFixed(2)}% accrued</div>
        </div>
        <div class="sol-hero-stat">
          <div class="sol-hero-stat-label">Active Projects</div>
          <div class="sol-hero-stat-val">${pNav.activeCount}</div>
          <div class="sol-hero-stat-sub">${pNav.maturedCount} matured</div>
        </div>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="sol-kpi-row">
      <div class="sol-kpi gold">
        <div class="sol-kpi-label">Capital Deployed</div>
        <div class="sol-kpi-value">${sfmt.zarM(pNav.totalCapital)}</div>
        <div class="sol-kpi-sub">Across ${pNav.activeCount} active projects</div>
      </div>
      <div class="sol-kpi green">
        <div class="sol-kpi-label">Accrued Returns</div>
        <div class="sol-kpi-value">${sfmt.zarM(pNav.totalAccrued)}</div>
        <div class="sol-kpi-sub">${pNav.overallReturnPct.toFixed(2)}% of capital</div>
      </div>
      <div class="sol-kpi blue">
        <div class="sol-kpi-label">Contracted Returns</div>
        <div class="sol-kpi-value">${sfmt.zarM(pNav.totalContracted)}</div>
        <div class="sol-kpi-sub">Over full investment terms</div>
      </div>
      <div class="sol-kpi" style="">
        <div class="sol-kpi-label">Matured / Realised</div>
        <div class="sol-kpi-value" style="color:#eda5ff">${sfmt.zarM(pNav.totalActual)}</div>
        <div class="sol-kpi-sub">${pNav.maturedCount} project${pNav.maturedCount!==1?'s':''} matured</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <!-- Capital by project chart -->
      <div class="sol-card">
        <div class="sol-card-hd">
          <span class="sol-card-title"><i class="fa-solid fa-chart-bar" style="color:var(--sol-gold)"></i> &nbsp;Capital Deployment by Project</span>
        </div>
        <div class="sol-card-body">
          <div class="sol-chart-wrap"><canvas id="solCapitalChart"></canvas></div>
        </div>
      </div>
      <!-- Product type breakdown -->
      <div class="sol-card">
        <div class="sol-card-hd">
          <span class="sol-card-title"><i class="fa-solid fa-chart-pie" style="color:var(--sol-gold)"></i> &nbsp;Capital by Product Term</span>
        </div>
        <div class="sol-card-body">
          <div class="sol-chart-wrap"><canvas id="solTypeChart"></canvas></div>
        </div>
      </div>
    </div>

    <!-- Recent projects table -->
    <div class="sol-card">
      <div class="sol-card-hd">
        <span class="sol-card-title"><i class="fa-solid fa-solar-panel" style="color:var(--sol-gold)"></i> &nbsp;Active Projects — NAV Snapshot</span>
        <button class="sol-btn sol-btn-secondary sol-btn-sm" onclick="solNavigate('projects',document.querySelector('[data-view=projects]'))">
          View All <i class="fa-solid fa-arrow-right"></i>
        </button>
      </div>
      <div style="overflow-x:auto">
        <table class="sol-table">
          <thead><tr>
            <th>Project</th><th>Type</th><th>Status</th>
            <th class="num">Capital (R)</th><th class="num">Accrued (R)</th>
            <th class="num">NAV (R)</th><th class="num">Progress</th>
          </tr></thead>
          <tbody>
            ${SOL.projects.slice(0,6).map(p => {
              const n = SolarNAV.projectNAV(p);
              return `<tr>
                <td>
                  <div style="font-weight:600">${p.project_name||p.id}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,.4)">${p.location||''}</div>
                </td>
                <td><span class="sol-term-pill">${p.product_type||'—'}</span></td>
                <td><span class="sol-badge sol-badge-${p.status||'active'}">${p.status||'active'}</span></td>
                <td class="num">${sfmt.zarM(n.capital)}</td>
                <td class="num" style="color:#74c69d">+${sfmt.zarM(n.accruedReturn)}</td>
                <td class="num" style="color:var(--sol-gold);font-weight:700">${sfmt.zarM(n.nav)}</td>
                <td class="num">
                  <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
                    <div style="width:60px;background:rgba(255,255,255,.08);border-radius:4px;height:4px">
                      <div style="width:${n.progressPct.toFixed(0)}%;background:var(--sol-gold);height:100%;border-radius:4px"></div>
                    </div>
                    <span style="font-size:11px;color:rgba(255,255,255,.5)">${n.progressPct.toFixed(0)}%</span>
                  </div>
                </td>
              </tr>`;
            }).join('')}
            ${SOL.projects.length === 0 ? `<tr><td colspan="7" style="text-align:center;padding:32px;color:rgba(255,255,255,.3)"><i class="fa-solid fa-solar-panel" style="font-size:24px;display:block;margin-bottom:8px"></i>No projects yet. <a href="#" onclick="openAddProjectModal();return false;" style="color:var(--sol-gold)">Add your first project</a></td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Charts
  requestAnimationFrame(() => {
    if (SOL.charts.capital) { SOL.charts.capital.destroy(); delete SOL.charts.capital; }
    if (SOL.charts.type)    { SOL.charts.type.destroy();    delete SOL.charts.type; }

    const chartDefaults = {
      plugins: { legend: { labels: { color:'rgba(255,255,255,.6)', font: { family:'Poppins', size:11 } } } }
    };

    const capCtx = document.getElementById('solCapitalChart');
    if (capCtx && activeProjs.length > 0) {
      SOL.charts.capital = new Chart(capCtx, {
        type: 'bar',
        data: {
          labels: chartLabels,
          datasets: [
            { label:'Capital Deployed', data: chartCapital, backgroundColor:'rgba(254,194,79,.7)', borderColor:'rgba(254,194,79,1)', borderRadius:6 },
            { label:'Accrued Returns',  data: chartAccrued, backgroundColor:'rgba(116,198,157,.6)', borderColor:'rgba(116,198,157,1)', borderRadius:6 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { ...chartDefaults.plugins },
          scales: {
            x: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:10} }, grid:{ color:'rgba(255,255,255,.05)' } },
            y: { ticks:{ color:'rgba(255,255,255,.5)', callback: v => 'R'+(v/1e6).toFixed(1)+'M' }, grid:{ color:'rgba(255,255,255,.05)' } }
          }
        }
      });
    }

    const typeCtx = document.getElementById('solTypeChart');
    const typeVals = Object.values(typeBreakdown);
    if (typeCtx && typeVals.some(v => v > 0)) {
      SOL.charts.type = new Chart(typeCtx, {
        type: 'doughnut',
        data: {
          labels: ['5-Year', '6-Year', '7-Year'],
          datasets: [{ data: typeVals, backgroundColor:['rgba(96,165,250,.8)','rgba(254,194,79,.8)','rgba(116,198,157,.8)'], borderColor:'#131720', borderWidth:2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { ...chartDefaults.plugins }
        }
      });
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   VIEW: ALL PROJECTS
══════════════════════════════════════════════════════════════ */
function renderProjectsView() {
  const el = document.getElementById('sol-view-projects');

  el.innerHTML = `
    <div class="sol-filter-bar">
      <div class="sol-search">
        <i class="fa-solid fa-search"></i>
        <input type="text" id="solSearchInput" placeholder="Search project name or location…" oninput="filterProjects()">
      </div>
      <select class="sol-select" id="solStatusFilter" onchange="filterProjects()">
        <option value="">All Statuses</option>
        <option value="active">Active</option>
        <option value="matured">Matured</option>
        <option value="pending">Pending</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <select class="sol-select" id="solTypeFilter" onchange="filterProjects()">
        <option value="">All Types</option>
        <option value="5yr">5-Year</option>
        <option value="6yr">6-Year</option>
        <option value="7yr">7-Year</option>
      </select>
      <button class="sol-btn sol-btn-primary" onclick="openAddProjectModal()">
        <i class="fa-solid fa-plus"></i> Add Project
      </button>
    </div>
    <div id="solProjectsContainer">
      ${renderProjectCards(SOL.projects)}
    </div>
  `;
}

function filterProjects() {
  const q       = (document.getElementById('solSearchInput')?.value || '').toLowerCase();
  const status  = document.getElementById('solStatusFilter')?.value  || '';
  const type    = document.getElementById('solTypeFilter')?.value    || '';

  const filtered = SOL.projects.filter(p => {
    const matchQ      = !q || (p.project_name||'').toLowerCase().includes(q) || (p.location||'').toLowerCase().includes(q);
    const matchStatus = !status || p.status === status;
    const matchType   = !type   || p.product_type === type;
    return matchQ && matchStatus && matchType;
  });

  const container = document.getElementById('solProjectsContainer');
  if (container) container.innerHTML = renderProjectCards(filtered);
}

function renderProjectCards(projects) {
  if (!projects.length) return `<div class="sol-loading" style="padding:60px"><i class="fa-solid fa-solar-panel" style="font-size:36px;margin-bottom:12px;color:rgba(255,255,255,.2)"></i><span style="color:rgba(255,255,255,.3)">No projects found</span></div>`;

  return `<div class="sol-projects-grid">${projects.map(p => {
    const n = SolarNAV.projectNAV(p);
    const navColor = n.accruedReturn >= 0 ? '#74c69d' : '#f87171';
    return `
    <div class="sol-proj-card">
      <div class="sol-proj-hd">
        <div>
          <div class="sol-proj-name">${p.project_name||p.id}</div>
          <div class="sol-proj-loc"><i class="fa-solid fa-location-dot" style="margin-right:4px;opacity:.6"></i>${p.location||'—'}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">
          <span class="sol-badge sol-badge-${p.status||'active'}">${p.status||'active'}</span>
          <span class="sol-term-pill">${p.product_type||'—'}</span>
        </div>
      </div>
      <div class="sol-proj-body">
        <div class="sol-proj-row">
          <span class="sol-proj-row-label">Capital Deployed</span>
          <span class="sol-proj-row-val">${sfmt.zar(n.capital)}</span>
        </div>
        <div class="sol-proj-row">
          <span class="sol-proj-row-label">Annual Rate</span>
          <span class="sol-proj-row-val">${sfmt.pct(n.annualRate * 100)}</span>
        </div>
        <div class="sol-proj-row">
          <span class="sol-proj-row-label">Days Elapsed / Remaining</span>
          <span class="sol-proj-row-val">${n.daysElapsed} / ${n.daysRemaining}</span>
        </div>
        <div class="sol-proj-row">
          <span class="sol-proj-row-label">Start → Maturity</span>
          <span class="sol-proj-row-val" style="font-size:12px">${sfmt.date(p.start_date)} → ${sfmt.date(p.maturity_date)}</span>
        </div>
        <div class="sol-proj-row">
          <span class="sol-proj-row-label">Capacity</span>
          <span class="sol-proj-row-val">${p.capacity_kw ? p.capacity_kw + ' kW' : '—'}</span>
        </div>

        <!-- Progress bar -->
        <div style="margin:4px 0 2px;font-size:11px;color:rgba(255,255,255,.4)">Term progress</div>
        <div class="sol-progress-wrap">
          <div class="sol-progress-fill" style="width:${Math.min(100,n.progressPct).toFixed(1)}%"></div>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,.35);margin-bottom:8px">${n.progressPct.toFixed(1)}% of ${p.term_years||'?'}-year term</div>

        <!-- NAV summary -->
        <div class="sol-proj-nav">
          <div>
            <div class="sol-proj-nav-label">Accrued Return</div>
            <div class="sol-proj-nav-val" style="color:${navColor}">+${sfmt.zar(n.accruedReturn)}</div>
          </div>
          <div style="text-align:right">
            <div class="sol-proj-nav-label">Current NAV</div>
            <div class="sol-proj-nav-val" style="color:var(--sol-gold)">${sfmt.zar(n.nav)}</div>
          </div>
        </div>

        <!-- Actions -->
        <div class="sol-proj-actions">
          <button class="sol-btn sol-btn-secondary sol-btn-sm" style="flex:1" onclick="openEditProjectModal('${p.id}')">
            <i class="fa-solid fa-pen"></i> Edit
          </button>
          <button class="sol-doc-btn sol-btn sol-btn-sm" onclick="openSolarDocs('${p.id}')" title="Supporting Documents">
            <i class="fa-solid fa-paperclip"></i> Docs
          </button>
          <button class="sol-btn sol-btn-danger sol-btn-sm" onclick="deleteProject('${p.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

/* ══════════════════════════════════════════════════════════════
   VIEW: NAV CALCULATOR
══════════════════════════════════════════════════════════════ */
function renderNAVCalculator() {
  const el = document.getElementById('sol-view-nav');
  const pNav = SolarNAV.portfolioNAV(SOL.projects);

  // Build per-project nav rows
  const projRows = SOL.projects.map(p => {
    const n = SolarNAV.projectNAV(p);
    return `
      <tr>
        <td>
          <div style="font-weight:600;font-size:13px">${p.project_name||p.id}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.4)">${p.location||''}</div>
        </td>
        <td><span class="sol-term-pill">${p.product_type||'—'}</span></td>
        <td><span class="sol-badge sol-badge-${p.status||'active'}">${p.status||'active'}</span></td>
        <td class="num">${sfmt.zar(n.capital)}</td>
        <td class="num">${sfmt.pct(n.annualRate * 100)}</td>
        <td class="num">${n.daysElapsed}</td>
        <td class="num" style="color:#74c69d">+${sfmt.zar(n.accruedReturn)}</td>
        <td class="num" style="color:var(--sol-gold);font-weight:700">${sfmt.zar(n.nav)}</td>
        <td class="num">${sfmt.pct(n.returnPct)}</td>
      </tr>`;
  }).join('');

  el.innerHTML = `
    <!-- Portfolio NAV Panel -->
    <div class="sol-calc-panel" style="margin-bottom:24px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--sol-gold);margin-bottom:18px;font-weight:700">
        <i class="fa-solid fa-calculator"></i> &nbsp;Solar Portfolio — Live NAV
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-bottom:24px">
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">PORTFOLIO NAV</div>
          <div class="sol-calc-result">${sfmt.zarM(pNav.portfolioNAV)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">Capital + Accrued Returns</div>
        </div>
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">TOTAL CAPITAL</div>
          <div style="font-size:28px;font-weight:900;color:#fff">${sfmt.zarM(pNav.totalCapital)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">${pNav.activeCount} active project${pNav.activeCount!==1?'s':''}</div>
        </div>
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">TOTAL ACCRUED</div>
          <div style="font-size:28px;font-weight:900;color:#74c69d">+${sfmt.zarM(pNav.totalAccrued)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">${pNav.overallReturnPct.toFixed(2)}% of capital</div>
        </div>
      </div>
      <div class="sol-calc-row">
        <span class="sol-calc-row-label">Total Capital Deployed</span>
        <span class="sol-calc-row-val">${sfmt.zar(pNav.totalCapital)}</span>
      </div>
      <div class="sol-calc-row">
        <span class="sol-calc-row-label">Total Accrued Returns</span>
        <span class="sol-calc-row-val" style="color:#74c69d">+ ${sfmt.zar(pNav.totalAccrued)}</span>
      </div>
      <div class="sol-calc-row">
        <span class="sol-calc-row-label">Total Contracted Returns (full term)</span>
        <span class="sol-calc-row-val">${sfmt.zar(pNav.totalContracted)}</span>
      </div>
      <div class="sol-calc-row" style="border-top:1px solid rgba(254,194,79,.3);padding-top:12px;margin-top:8px">
        <span style="color:#fff;font-weight:700">Portfolio NAV (Capital + Accrued)</span>
        <span style="color:var(--sol-gold);font-weight:900;font-size:17px">${sfmt.zar(pNav.portfolioNAV)}</span>
      </div>
    </div>

    <!-- Formula explanation -->
    <div class="sol-card" style="margin-bottom:20px">
      <div class="sol-card-hd">
        <span class="sol-card-title"><i class="fa-solid fa-info-circle" style="color:var(--sol-gold)"></i> &nbsp;NAV Calculation Method</span>
      </div>
      <div class="sol-card-body" style="font-size:13px;line-height:1.9;color:rgba(255,255,255,.6)">
        <p><strong style="color:#fff">Accrued Return</strong> = Capital × Annual Rate × (Days Elapsed ÷ 365)</p>
        <p><strong style="color:#fff">Project NAV</strong> = Capital Deployed + Accrued Return</p>
        <p><strong style="color:#fff">Portfolio NAV</strong> = Σ (Capital + Accrued) across all active projects</p>
        <p style="margin-top:8px;font-size:12px;color:rgba(255,255,255,.35)">
          NAV is calculated daily against the deployment date. For matured projects, the accrued return is capped at the maturity date.
        </p>
      </div>
    </div>

    <!-- Per-project NAV table -->
    <div class="sol-card">
      <div class="sol-card-hd">
        <span class="sol-card-title"><i class="fa-solid fa-table" style="color:var(--sol-gold)"></i> &nbsp;Per-Project NAV Breakdown</span>
      </div>
      <div style="overflow-x:auto">
        <table class="sol-table">
          <thead><tr>
            <th>Project</th><th>Type</th><th>Status</th>
            <th class="num">Capital (R)</th><th class="num">Rate</th><th class="num">Days</th>
            <th class="num">Accrued (R)</th><th class="num">NAV (R)</th><th class="num">Return %</th>
          </tr></thead>
          <tbody>${projRows || `<tr><td colspan="9" style="text-align:center;padding:24px;color:rgba(255,255,255,.3)">No projects found</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}

/* ══════════════════════════════════════════════════════════════
   PROJECT CRUD — Modal
══════════════════════════════════════════════════════════════ */
function openAddProjectModal() {
  SOL.editingId = null;
  document.getElementById('solModalTitle').textContent = 'Add Solar Project';
  document.getElementById('sol_form_id').value = '';
  document.getElementById('solProjectForm').reset();
  document.getElementById('solProjectModal').classList.add('open');
}

function openEditProjectModal(id) {
  const p = SOL.projects.find(x => x.id === id);
  if (!p) return;
  SOL.editingId = id;
  document.getElementById('solModalTitle').textContent = 'Edit Solar Project';
  document.getElementById('sol_form_id').value = id;

  const setVal = (fid, val) => { const el = document.getElementById(fid); if (el) el.value = val ?? ''; };
  setVal('sp_name',              p.project_name);
  setVal('sp_location',          p.location);
  setVal('sp_capacity',          p.capacity_kw);
  setVal('sp_investors',         p.investor_count);
  setVal('sp_product_type',      p.product_type || '7yr');
  setVal('sp_status',            p.status || 'active');
  setVal('sp_term_years',        p.term_years);
  setVal('sp_capital',           p.capital_deployed);
  setVal('sp_rate_pct',          p.annual_rate ? (parseFloat(p.annual_rate) * 100).toFixed(4) : '');
  setVal('sp_contracted_return', p.contracted_return);
  setVal('sp_start_date',        p.start_date ? p.start_date.split('T')[0] : '');
  setVal('sp_maturity_date',     p.maturity_date ? p.maturity_date.split('T')[0] : '');
  setVal('sp_actual_return',     p.actual_return);
  setVal('sp_notes',             p.notes);

  document.getElementById('solProjectModal').classList.add('open');
}

function closeProjectModal() {
  document.getElementById('solProjectModal').classList.remove('open');
  SOL.editingId = null;
}

async function saveProjectForm() {
  const getVal = fid => { const el = document.getElementById(fid); return el ? el.value.trim() : ''; };

  const name = getVal('sp_name');
  if (!name) { SToast.show('Project name is required', 'error'); return; }

  const ratePct = parseFloat(getVal('sp_rate_pct')) || 0;

  const data = {
    project_name:       name,
    location:           getVal('sp_location') || null,
    capacity_kw:        parseFloat(getVal('sp_capacity'))          || null,
    investor_count:     parseInt(getVal('sp_investors'))           || null,
    product_type:       getVal('sp_product_type') || '7yr',
    status:             getVal('sp_status') || 'active',
    term_years:         parseInt(getVal('sp_term_years'))          || null,
    capital_deployed:   parseFloat(getVal('sp_capital'))           || 0,
    annual_rate:        ratePct / 100,
    contracted_return:  parseFloat(getVal('sp_contracted_return')) || null,
    start_date:         getVal('sp_start_date')    ? new Date(getVal('sp_start_date')).toISOString()    : null,
    maturity_date:      getVal('sp_maturity_date') ? new Date(getVal('sp_maturity_date')).toISOString() : null,
    actual_return:      parseFloat(getVal('sp_actual_return'))     || 0,
    notes:              getVal('sp_notes') || null,
  };

  const btn = document.getElementById('solSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

  try {
    if (SOL.editingId) {
      const updated = await solPatch(`tables/solar_projects/${SOL.editingId}`, data);
      const idx = SOL.projects.findIndex(x => x.id === SOL.editingId);
      if (idx !== -1) SOL.projects[idx] = { ...SOL.projects[idx], ...updated };
      SToast.show('Project updated', 'success');
    } else {
      data.id = `SOL-${Date.now()}`;
      const created = await solPost('tables/solar_projects', data);
      SOL.projects.unshift(created);
      SToast.show('Project added', 'success');
    }
    closeProjectModal();
    // Re-render current view
    const view = SOL.currentView;
    if (view === 'dashboard') renderDashboard();
    else if (view === 'projects') renderProjectsView();
    else if (view === 'nav') renderNAVCalculator();
  } catch(e) {
    SToast.show('Error saving project: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Project';
  }
}

async function deleteProject(id) {
  const p = SOL.projects.find(x => x.id === id);
  if (!confirm(`Delete "${p?.project_name || id}"? This cannot be undone.`)) return;
  try {
    await solDelete(`tables/solar_projects/${id}`);
    SOL.projects = SOL.projects.filter(x => x.id !== id);
    const view = SOL.currentView;
    if (view === 'dashboard') renderDashboard();
    else if (view === 'projects') renderProjectsView();
    else if (view === 'nav') renderNAVCalculator();
    SToast.show('Project deleted', 'success');
  } catch(e) {
    SToast.show('Error deleting project', 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   SOLAR DOCUMENT MANAGEMENT
══════════════════════════════════════════════════════════════ */

const DOC_TYPES_SOLAR = {
  ppa_agreement:           'PPA Agreement',
  installation_certificate:'Installation Certificate',
  municipal_approval:      'Municipal Approval',
  investor_agreement:      'Investor Agreement',
  compliance_certificate:  'Compliance Certificate',
  engineering_report:      'Engineering Report',
  insurance_policy:        'Insurance Policy',
  grid_connection:         'Grid Connection',
  financial_model:         'Financial Model',
  other:                   'Other'
};

/* Solar-specific doc icons re-use the same mapping */
const SOL_DOC_ICONS = {
  'application/pdf': 'fa-file-pdf',
  'image/jpeg':      'fa-file-image',
  'image/png':       'fa-file-image',
  'image/webp':      'fa-file-image',
  default:           'fa-file-alt'
};

function solFmtBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

async function openSolarDocs(projectId) {
  SOL.docsProjectId = projectId;
  const proj = SOL.projects.find(x => x.id === projectId);
  const title = proj ? proj.project_name : projectId;
  const overlay = document.getElementById('solDocsOverlay');
  const titleEl = document.getElementById('solDocsTitle');
  if (titleEl) titleEl.textContent = `Documents — ${title}`;
  if (overlay) overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  await refreshSolarDocsList(projectId);
}

function closeSolarDocs() {
  const overlay = document.getElementById('solDocsOverlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
  SOL.docsProjectId = null;
  SOL.currentDocs = [];
}

async function refreshSolarDocsList(projectId) {
  const body = document.getElementById('solDocsBody');
  if (!body) return;
  body.innerHTML = `<div class="sol-loading"><div class="sol-spinner"></div></div>`;
  try {
    const all = await solFetchAll('solar_documents');
    SOL.currentDocs = all.filter(d => d.project_id === projectId);
    renderSolarDocsPanel(SOL.currentDocs);
  } catch(e) {
    body.innerHTML = `<div class="sol-loading" style="color:#f87171"><i class="fa-solid fa-circle-exclamation"></i> Failed to load documents</div>`;
  }
}

function renderSolarDocsPanel(docs) {
  const body = document.getElementById('solDocsBody');
  if (!body) return;

  const typeOptions = Object.entries(DOC_TYPES_SOLAR).map(([v,l]) =>
    `<option value="${v}">${l}</option>`).join('');

  const fileList = docs.length === 0
    ? `<div class="sol-doc-empty"><i class="fa-solid fa-folder-open"></i><p>No documents yet</p><p style="font-size:11px;opacity:.6">Upload files using the zone above</p></div>`
    : docs.map(d => {
        const iconClass = SOL_DOC_ICONS[d.mime_type] || SOL_DOC_ICONS.default;
        const isImage   = d.mime_type && d.mime_type.startsWith('image/');
        const label     = DOC_TYPES_SOLAR[d.doc_type] || d.doc_type || 'Document';
        const dt        = d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'}) : '—';
        return `
        <div class="sol-doc-item">
          <div class="sol-doc-icon ${d.mime_type==='application/pdf'?'pdf':'img'}">
            <i class="fa-solid ${iconClass}"></i>
          </div>
          <div class="sol-doc-info">
            <div class="sol-doc-name">${d.doc_name || 'Unnamed'}</div>
            <div class="sol-doc-meta"><span class="sol-doc-type-pill">${label}</span> · ${solFmtBytes(d.file_size)} · ${dt}</div>
            ${d.notes ? `<div class="sol-doc-notes">${d.notes}</div>` : ''}
          </div>
          <div class="sol-doc-actions">
            ${isImage ? `<button class="sol-btn sol-btn-secondary sol-btn-sm" onclick="solPreviewDocImage('${d.doc_url}','${(d.doc_name||'').replace(/'/g,'')}')" title="Preview"><i class="fa-solid fa-eye"></i></button>` : ''}
            <a href="${d.doc_url}" download="${d.doc_name||'document'}" class="sol-btn sol-btn-secondary sol-btn-sm" title="Download"><i class="fa-solid fa-download"></i></a>
            <button class="sol-btn sol-btn-danger sol-btn-sm" onclick="deleteSolarDoc('${d.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>`;
      }).join('');

  body.innerHTML = `
    <!-- Upload zone -->
    <div class="sol-doc-upload-zone" id="solDocDropZone"
         ondragover="event.preventDefault();this.classList.add('drag-over')"
         ondragleave="this.classList.remove('drag-over')"
         ondrop="handleSolarDocDrop(event);this.classList.remove('drag-over')">
      <i class="fa-solid fa-cloud-arrow-up" style="font-size:28px;color:var(--sol-gold);margin-bottom:8px"></i>
      <p style="font-size:13px;font-weight:600;color:#fff;margin:0 0 4px">Drop files here or click to browse</p>
      <p style="font-size:11px;color:rgba(255,255,255,.4);margin:0">PDF, JPG, PNG, WEBP · max 10 MB per file</p>
      <input type="file" id="solDocFileInput" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple style="display:none" onchange="handleSolarDocFileSelect(this)">
      <button class="sol-btn sol-btn-secondary sol-btn-sm" style="margin-top:12px" onclick="document.getElementById('solDocFileInput').click()">
        <i class="fa-solid fa-folder-open"></i> Browse Files
      </button>
    </div>

    <!-- Upload options -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0">
      <div>
        <label style="font-size:11px;font-weight:600;color:rgba(255,255,255,.5);display:block;margin-bottom:5px">Document Type</label>
        <select id="solDocType" class="sol-doc-select">
          <option value="">— Select type —</option>
          ${typeOptions}
        </select>
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:rgba(255,255,255,.5);display:block;margin-bottom:5px">Notes (optional)</label>
        <input type="text" id="solDocNotes" placeholder="e.g. Signed copy" class="sol-doc-input">
      </div>
    </div>

    <!-- Upload progress -->
    <div id="solDocUploadProgress" style="display:none;margin-bottom:14px">
      <div style="font-size:12px;color:rgba(255,255,255,.5);margin-bottom:6px"><i class="fa-solid fa-spinner fa-spin"></i> Uploading…</div>
      <div style="background:rgba(255,255,255,.08);border-radius:4px;height:4px"><div id="solDocProgressBar" style="background:var(--sol-gold);height:100%;border-radius:4px;width:0%;transition:width .3s"></div></div>
    </div>

    <!-- Section divider -->
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.3);padding:4px 0 12px;border-top:1px solid rgba(255,255,255,.07);margin-top:4px">
      ${docs.length} document${docs.length!==1?'s':''} attached
    </div>

    <!-- File list -->
    <div id="solDocList">
      ${fileList}
    </div>
  `;

  // Wire drop zone click
  const zone = document.getElementById('solDocDropZone');
  if (zone) zone.addEventListener('click', (e) => {
    if (!e.target.closest('button')) document.getElementById('solDocFileInput')?.click();
  });
}

function handleSolarDocDrop(event) {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) processSolarDocFiles(files);
}

function handleSolarDocFileSelect(input) {
  const files = Array.from(input.files || []);
  if (files.length) processSolarDocFiles(files);
  input.value = '';
}

function processSolarDocFiles(files) {
  const ALLOWED = ['application/pdf','image/jpeg','image/png','image/webp'];
  const MAX     = 10 * 1024 * 1024;

  const valid = files.filter(f => {
    if (!ALLOWED.includes(f.type)) { SToast.show(`${f.name}: unsupported file type`, 'error'); return false; }
    if (f.size > MAX)              { SToast.show(`${f.name}: exceeds 10 MB limit`, 'error'); return false; }
    return true;
  });
  if (!valid.length) return;

  const prog = document.getElementById('solDocUploadProgress');
  const bar  = document.getElementById('solDocProgressBar');
  if (prog) prog.style.display = 'block';

  let done = 0;
  valid.forEach(file => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        await uploadSolarDocData(file, e.target.result);
        done++;
        if (bar) bar.style.width = Math.round((done / valid.length) * 100) + '%';
        if (done === valid.length) {
          setTimeout(() => { if (prog) prog.style.display = 'none'; if (bar) bar.style.width = '0%'; }, 600);
          await refreshSolarDocsList(SOL.docsProjectId);
          SToast.show(`${done} file${done>1?'s':''} uploaded`, 'success');
        }
      } catch(err) {
        SToast.show('Upload failed: ' + err.message, 'error');
        if (prog) prog.style.display = 'none';
      }
    };
    reader.readAsDataURL(file);
  });
}

async function uploadSolarDocData(file, dataUrl) {
  const docType = document.getElementById('solDocType')?.value || 'other';
  const notes   = document.getElementById('solDocNotes')?.value || '';
  await solPost('tables/solar_documents', {
    id:           `SDOC-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    project_id:   SOL.docsProjectId,
    doc_type:     docType || 'other',
    doc_name:     file.name,
    doc_url:      dataUrl,
    file_size:    file.size,
    mime_type:    file.type,
    notes:        notes || null,
    uploaded_by:  'fund_user',
    uploaded_at:  new Date().toISOString()
  });
}

async function deleteSolarDoc(docId) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  try {
    await solDelete(`tables/solar_documents/${docId}`);
    SOL.currentDocs = SOL.currentDocs.filter(d => d.id !== docId);
    renderSolarDocsPanel(SOL.currentDocs);
    SToast.show('Document deleted', 'success');
  } catch(e) {
    SToast.show('Error deleting document', 'error');
  }
}

function solPreviewDocImage(url, name) {
  let lb = document.getElementById('solImgLightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'solImgLightbox';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;cursor:zoom-out';
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  }
  lb.innerHTML = `
    <div style="font-size:12px;color:rgba(255,255,255,.5)">${name}</div>
    <img src="${url}" style="max-width:90vw;max-height:82vh;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.7)" alt="${name}">
    <div style="font-size:11px;color:rgba(255,255,255,.3)">Click anywhere to close</div>
  `;
}
