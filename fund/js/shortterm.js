/* ============================================================
   SV Capital — Short-Term Investment Management
   fund/js/shortterm.js
   NAV Engine + Overdue Detection + Fund Return Calculator + CRUD
   ============================================================ */

'use strict';

const STL_BASE = '/api/';

/* ── API HELPERS ──────────────────────────────────────────── */
function _stlGetToken() {
  return localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token') || null;
}
async function stlFetch(path, opts = {}) {
  const token = _stlGetToken();
  opts.headers = Object.assign(
    token ? { Authorization: `Bearer ${token}` } : {},
    opts.headers || {}
  );
  opts.credentials = 'include';
  const r = await fetch(STL_BASE + path, opts);
  if (r.status === 401) { let l='/login.html'; try{const s=JSON.parse(localStorage.getItem('staffSession')||'null');if(s&&s.empId&&s.expiresAt>Date.now())l='/team/login.html';}catch(_){} window.location.replace(l); throw new Error('Session expired'); }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`API ${r.status}: ${t}`); }
  return r;
}
async function stlGet(path)       { return (await stlFetch(path)).json(); }
async function stlPost(path, d)   { return (await stlFetch(path, { method:'POST',  headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) })).json(); }
async function stlPatch(path, d)  { return (await stlFetch(path, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) })).json(); }
async function stlDelete(path)    { return stlFetch(path, { method:'DELETE' }); }

async function stlFetchAll(table) {
  const PAGE = 100; let page = 1, all = [];
  while (true) {
    let res;
    try { res = await stlGet(`tables/${table}?limit=${PAGE}&page=${page}`); } catch(e) { break; }
    const rows = res.data || [];
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    if (res.total > 0 && all.length >= res.total) break;
    page++;
  }
  return all;
}

/* ── TOAST ─────────────────────────────────────────────────── */
const STLToast = {
  show(msg, type = 'success') {
    const c = document.getElementById('stlToastContainer');
    if (!c) return;
    const icons = { success:'fa-check-circle', error:'fa-exclamation-circle', info:'fa-info-circle' };
    const el = document.createElement('div');
    el.className = `stl-toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icons[type]||icons.info}" style="color:${type==='error'?'#f87171':type==='success'?'#4ade80':'#656565'}"></i><span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }
};

/* ── FORMAT HELPERS ──────────────────────────────────────── */
const stlfmt = {
  zar:  v => v == null || isNaN(v) ? '—' : 'R' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits:2, maximumFractionDigits:2 }),
  zarM: v => { if (v == null || isNaN(v)) return '—'; const n=Number(v); return n>=1e6?'R'+(n/1e6).toFixed(2)+'M':n>=1e3?'R'+(n/1e3).toFixed(1)+'k':'R'+n.toFixed(0); },
  pct:  v => v == null || isNaN(v) ? '—' : Number(v).toFixed(2) + '%',
  date: v => { if (!v) return '—'; try { return new Date(v).toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' }); } catch { return v; } },
  num:  v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-ZA'),
};

/* ── STATE ──────────────────────────────────────────────────── */
const STL = {
  loans: [],
  currentView: 'dashboard',
  charts: {},
  editingId: null,
  docsLoanId: null,
  currentDocs: []
};

/* ══════════════════════════════════════════════════════════════
   NAV ENGINE
══════════════════════════════════════════════════════════════ */
const LoanNAV = {

  /**
   * Calculate NAV and accrued interest for a single loan.
   * For rate-based loans: AccruedInterest = principal × rate × (daysElapsed / 365)
   * For fixed-interest loans: use interest_amount directly
   * NAV = outstandingPrincipal + accruedInterest
   */
  loanNAV(loan) {
    const principal     = parseFloat(loan.amount_disbursed)   || 0;
    const annualRate    = parseFloat(loan.interest_rate)       || 0;
    const fixedInterest = parseFloat(loan.interest_amount)     || 0;
    const totalRepayable= parseFloat(loan.total_repayable)     || (principal + fixedInterest);
    const partialPaid   = parseFloat(loan.partial_repayments)  || 0;
    const disbDate      = loan.disbursement_date ? new Date(loan.disbursement_date) : null;
    const dueDate       = loan.repayment_date    ? new Date(loan.repayment_date)    : null;
    const repaidDate    = loan.actual_repayment_date ? new Date(loan.actual_repayment_date) : null;
    const now           = new Date();

    // Days elapsed since disbursement (capped at repayment date for repaid loans)
    let daysElapsed = 0;
    if (disbDate) {
      const endpoint = repaidDate || now;
      daysElapsed = Math.max(0, Math.round((endpoint - disbDate) / 86400000));
    }

    // Days overdue (positive if past due date without full repayment)
    let daysOverdue = 0;
    if (dueDate && !repaidDate && loan.status !== 'repaid' && loan.status !== 'written_off') {
      daysOverdue = Math.max(0, Math.round((now - dueDate) / 86400000));
    }

    // Accrued interest calculation
    let accruedInterest;
    if (fixedInterest > 0) {
      // Fixed interest — use agreed amount (pro-rated if partial term)
      accruedInterest = fixedInterest;
    } else if (annualRate > 0 && disbDate) {
      accruedInterest = principal * annualRate * (daysElapsed / 365);
    } else {
      accruedInterest = totalRepayable - principal;
    }

    // Outstanding principal = principal - partial payments toward principal
    // For simplicity: outstanding = max(0, totalRepayable - partialPaid)
    const outstandingBalance = Math.max(0, totalRepayable - partialPaid);
    const nav = outstandingBalance > 0 ? outstandingBalance : 0;

    // If repaid in full, NAV = 0 (realised)
    const isFullyRepaid = loan.status === 'repaid' || partialPaid >= totalRepayable;
    const navFinal = isFullyRepaid ? 0 : nav;

    // Realised return
    const realisedReturn = isFullyRepaid
      ? (repaidDate ? totalRepayable - principal : partialPaid - principal)
      : partialPaid - principal > 0 ? partialPaid - principal : 0;

    return {
      principal, annualRate, fixedInterest, totalRepayable,
      partialPaid, daysElapsed, daysOverdue, accruedInterest,
      outstandingBalance, nav: navFinal,
      isFullyRepaid, realisedReturn,
      isOverdue: daysOverdue > 0
    };
  },

  /**
   * Portfolio-level NAV and fund return metrics
   */
  portfolioNAV(loans) {
    const active  = loans.filter(l => l.status === 'active' || l.status === 'partial');
    const repaid  = loans.filter(l => l.status === 'repaid');
    const overdue = loans.filter(l => l.status === 'overdue');

    let totalDisbursed   = 0;
    let totalOutstanding = 0;
    let totalRepaid      = 0;
    let totalInterestEarned = 0;

    loans.forEach(l => {
      const n = LoanNAV.loanNAV(l);
      totalDisbursed   += n.principal;
      if (!n.isFullyRepaid) totalOutstanding += n.nav;
      if (n.isFullyRepaid)  totalRepaid      += n.totalRepayable;
      totalInterestEarned += n.isFullyRepaid ? n.realisedReturn : n.accruedInterest;
    });

    // NAV = outstanding principal + accrued interest on active loans
    const portfolioNAV = totalOutstanding;

    // Fund Return = (totalRepaid - totalDisbursedOnRepaid) / totalDisbursedOnRepaid × 100
    const disbursedOnRepaid = repaid.reduce((s,l) => s + (parseFloat(l.amount_disbursed)||0), 0);
    const fundReturn = disbursedOnRepaid > 0
      ? ((totalRepaid - disbursedOnRepaid) / disbursedOnRepaid) * 100
      : 0;

    // Overall portfolio return including accrued
    const overallReturn = totalDisbursed > 0
      ? (totalInterestEarned / totalDisbursed) * 100
      : 0;

    return {
      totalLoans:     loans.length,
      activeCount:    active.length,
      repaidCount:    repaid.length,
      overdueCount:   overdue.length,
      totalDisbursed, totalOutstanding, totalRepaid,
      totalInterestEarned, portfolioNAV,
      fundReturn, overallReturn
    };
  }
};

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await loadSTLAll();
});

async function loadSTLAll() {
  STL.loans = await stlFetchAll('shortterm_loans');
  // Auto-detect overdue status
  STL.loans = STL.loans.map(l => {
    if (l.status === 'active' && l.repayment_date) {
      const dueDate = new Date(l.repayment_date);
      if (new Date() > dueDate) {
        return { ...l, status: 'overdue' };
      }
    }
    return l;
  });
  // Update overdue badge
  const overdueCount = STL.loans.filter(l => l.status === 'overdue').length;
  const badge = document.getElementById('stlOverdueBadge');
  if (badge) {
    badge.textContent = overdueCount;
    badge.style.display = overdueCount > 0 ? 'inline-block' : 'none';
  }
  stlNavigate(STL.currentView || 'dashboard', document.querySelector(`[data-view="${STL.currentView||'dashboard'}"]`));
}

function stlNavigate(view, btn) {
  STL.currentView = view;
  document.querySelectorAll('.stl-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.stl-nav-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('stl-view-' + view);
  if (el) el.classList.add('active');
  if (btn) btn.classList.add('active');

  const titles = { dashboard:'Dashboard', loans:'All Loans', overdue:'Overdue Loans', returns:'NAV & Fund Returns' };
  document.getElementById('stlTopTitle').textContent = titles[view] || view;

  const loaders = { dashboard: renderSTLDashboard, loans: renderLoansView, overdue: renderOverdueView, returns: renderReturnsView };
  if (loaders[view]) loaders[view]();
}

/* ══════════════════════════════════════════════════════════════
   VIEW: DASHBOARD
══════════════════════════════════════════════════════════════ */
function renderSTLDashboard() {
  const el   = document.getElementById('stl-view-dashboard');
  const pNav = LoanNAV.portfolioNAV(STL.loans);
  const now  = new Date().toLocaleDateString('en-ZA', { day:'2-digit', month:'long', year:'numeric' });

  // Chart data: disbursements by status
  const statusCounts = { active:0, repaid:0, overdue:0, partial:0, written_off:0 };
  STL.loans.forEach(l => { statusCounts[l.status] = (statusCounts[l.status]||0) + 1; });

  // Monthly disbursements (last 6 months)
  const months = [];
  const monthDisbursed = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const key = d.toLocaleDateString('en-ZA', { month:'short', year:'2-digit' });
    months.push(key); monthDisbursed[key] = 0;
  }
  STL.loans.forEach(l => {
    if (!l.disbursement_date) return;
    const d = new Date(l.disbursement_date);
    const key = d.toLocaleDateString('en-ZA', { month:'short', year:'2-digit' });
    if (key in monthDisbursed) monthDisbursed[key] += parseFloat(l.amount_disbursed) || 0;
  });

  el.innerHTML = `
    <!-- NAV Hero -->
    <div class="stl-nav-hero">
      <div>
        <div class="stl-hero-label"><i class="fa-solid fa-hand-holding-dollar"></i> &nbsp;Short-Term Portfolio — NAV</div>
        <div class="stl-hero-value">${stlfmt.zarM(pNav.portfolioNAV)}</div>
        <div class="stl-hero-sub">Outstanding Principal + Accrued Interest &nbsp;·&nbsp; ${now}</div>
      </div>
      <div class="stl-hero-stats">
        <div>
          <div class="stl-hero-stat-label">Fund Return (Realised)</div>
          <div class="stl-hero-stat-val" style="color:${pNav.fundReturn >= 0 ? '#4ade80' : '#f87171'}">${pNav.fundReturn >= 0 ? '+' : ''}${pNav.fundReturn.toFixed(2)}%</div>
          <div class="stl-hero-stat-sub">On fully repaid loans</div>
        </div>
        <div style="text-align:right">
          <div class="stl-hero-stat-label">Active / Overdue</div>
          <div class="stl-hero-stat-val">${pNav.activeCount} <span style="color:#f87171;font-size:16px">/ ${pNav.overdueCount}</span></div>
          <div class="stl-hero-stat-sub">${pNav.repaidCount} repaid</div>
        </div>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="stl-kpi-row">
      <div class="stl-kpi blue">
        <div class="stl-kpi-label">Total Disbursed</div>
        <div class="stl-kpi-value">${stlfmt.zarM(pNav.totalDisbursed)}</div>
        <div class="stl-kpi-sub">Across ${pNav.totalLoans} loan${pNav.totalLoans!==1?'s':''}</div>
      </div>
      <div class="stl-kpi teal">
        <div class="stl-kpi-label">Outstanding (NAV)</div>
        <div class="stl-kpi-value">${stlfmt.zarM(pNav.totalOutstanding)}</div>
        <div class="stl-kpi-sub">${pNav.activeCount} active loan${pNav.activeCount!==1?'s':''}</div>
      </div>
      <div class="stl-kpi green">
        <div class="stl-kpi-label">Interest Earned</div>
        <div class="stl-kpi-value">${stlfmt.zarM(pNav.totalInterestEarned)}</div>
        <div class="stl-kpi-sub">Accrued + realised</div>
      </div>
      <div class="stl-kpi${pNav.overdueCount > 0 ? ' red' : ' green'}">
        <div class="stl-kpi-label">Overdue Loans</div>
        <div class="stl-kpi-value">${pNav.overdueCount}</div>
        <div class="stl-kpi-sub">${pNav.overdueCount > 0 ? 'Requires attention' : 'All on track'}</div>
      </div>
      <div class="stl-kpi amber">
        <div class="stl-kpi-label">Fund Return</div>
        <div class="stl-kpi-value">${pNav.fundReturn.toFixed(2)}%</div>
        <div class="stl-kpi-sub">Realised on repaid</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
      <!-- Monthly disbursements chart -->
      <div class="stl-card">
        <div class="stl-card-hd"><span class="stl-card-title"><i class="fa-solid fa-chart-bar" style="color:var(--stl-blue)"></i> &nbsp;Monthly Disbursements (6m)</span></div>
        <div class="stl-card-body"><div class="stl-chart-wrap"><canvas id="stlMonthChart"></canvas></div></div>
      </div>
      <!-- Status breakdown doughnut -->
      <div class="stl-card">
        <div class="stl-card-hd"><span class="stl-card-title"><i class="fa-solid fa-chart-pie" style="color:var(--stl-blue)"></i> &nbsp;Loan Status Breakdown</span></div>
        <div class="stl-card-body"><div class="stl-chart-wrap"><canvas id="stlStatusChart"></canvas></div></div>
      </div>
    </div>

    <!-- Recent loans -->
    <div class="stl-card">
      <div class="stl-card-hd">
        <span class="stl-card-title"><i class="fa-solid fa-file-invoice-dollar" style="color:var(--stl-blue)"></i> &nbsp;Recent Loans</span>
        <button class="stl-btn stl-btn-secondary stl-btn-sm" onclick="stlNavigate('loans',document.querySelector('[data-view=loans]'))">View All <i class="fa-solid fa-arrow-right"></i></button>
      </div>
      <div style="overflow-x:auto">
        <table class="stl-table">
          <thead><tr>
            <th>Business</th><th>Ref</th><th>Status</th>
            <th class="num">Disbursed</th><th class="num">Total Repayable</th>
            <th class="num">Outstanding NAV</th><th>Due Date</th>
          </tr></thead>
          <tbody>
            ${STL.loans.slice(0,6).map(l => {
              const n = LoanNAV.loanNAV(l);
              return `<tr class="${l.status === 'overdue' ? 'row-overdue' : ''}">
                <td>
                  <div style="font-weight:600">${l.business_name||'—'}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,.4);display:flex;align-items:center;gap:8px;margin-top:3px">
                    ${l.contact_name||''}
                    <button class="stl-doc-btn" onclick="openLoanDocs('${l.id}')" style="padding:2px 7px;font-size:10px"><i class="fa-solid fa-paperclip"></i> Docs</button>
                  </div>
                </td>
                <td style="font-family:monospace;font-size:12px">${l.loan_ref||l.id}</td>
                <td><span class="stl-badge stl-badge-${l.status||'active'}">${(l.status||'active').replace('_',' ')}</span>${n.daysOverdue > 0 ? `<div class="stl-overdue-pill" style="margin-top:3px"><i class="fa-solid fa-clock"></i>${n.daysOverdue}d overdue</div>` : ''}</td>
                <td class="num">${stlfmt.zar(n.principal)}</td>
                <td class="num">${stlfmt.zar(n.totalRepayable)}</td>
                <td class="num" style="color:${n.isFullyRepaid ? '#4ade80' : n.isOverdue ? '#f87171' : '#656565'};font-weight:700">${n.isFullyRepaid ? '<span style="color:#4ade80">Repaid</span>' : stlfmt.zar(n.nav)}</td>
                <td>${stlfmt.date(l.repayment_date)}${n.daysOverdue > 0 ? `<div style="font-size:11px;color:#f87171">+${n.daysOverdue} days</div>` : ''}</td>
              </tr>`;
            }).join('')}
            ${STL.loans.length === 0 ? `<tr><td colspan="7" style="text-align:center;padding:32px;color:rgba(255,255,255,.3)">No loans yet. <a href="#" onclick="openAddLoanModal();return false;" style="color:var(--stl-blue)">Add your first loan</a></td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    if (STL.charts.month)  { STL.charts.month.destroy();  delete STL.charts.month; }
    if (STL.charts.status) { STL.charts.status.destroy(); delete STL.charts.status; }

    const chartDefaults = { plugins: { legend: { labels: { color:'rgba(255,255,255,.6)', font:{ family:'Poppins', size:11 } } } } };

    const monthCtx = document.getElementById('stlMonthChart');
    if (monthCtx) {
      STL.charts.month = new Chart(monthCtx, {
        type: 'bar',
        data: {
          labels: months,
          datasets: [{ label:'Disbursed (R)', data: months.map(m => monthDisbursed[m]||0), backgroundColor:'rgba(59,130,246,.7)', borderColor:'rgba(59,130,246,1)', borderRadius: 6 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { ...chartDefaults.plugins },
          scales: {
            x: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:10} }, grid:{ color:'rgba(255,255,255,.05)' } },
            y: { ticks:{ color:'rgba(255,255,255,.5)', callback: v => 'R'+(v/1e3).toFixed(0)+'k' }, grid:{ color:'rgba(255,255,255,.05)' } }
          }
        }
      });
    }

    const statusCtx = document.getElementById('stlStatusChart');
    const statusVals = [statusCounts.active||0, statusCounts.repaid||0, statusCounts.overdue||0, statusCounts.partial||0, statusCounts.written_off||0];
    if (statusCtx && statusVals.some(v => v > 0)) {
      STL.charts.status = new Chart(statusCtx, {
        type: 'doughnut',
        data: {
          labels: ['Active','Repaid','Overdue','Partial','Written Off'],
          datasets: [{ data: statusVals, backgroundColor:['rgba(59,130,246,.8)','rgba(34,197,94,.8)','rgba(239,68,68,.8)','rgba(245,158,11,.8)','rgba(156,163,175,.5)'], borderColor:'#111827', borderWidth: 2 }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { ...chartDefaults.plugins } }
      });
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   VIEW: ALL LOANS
══════════════════════════════════════════════════════════════ */
function renderLoansView() {
  const el = document.getElementById('stl-view-loans');
  el.innerHTML = `
    <div class="stl-filter-bar">
      <div class="stl-search">
        <i class="fa-solid fa-search"></i>
        <input type="text" id="stlSearchInput" placeholder="Search business name or ref…" oninput="filterLoans()">
      </div>
      <select class="stl-select" id="stlStatusFilter" onchange="filterLoans()">
        <option value="">All Statuses</option>
        <option value="active">Active</option>
        <option value="repaid">Repaid</option>
        <option value="overdue">Overdue</option>
        <option value="partial">Partial</option>
        <option value="written_off">Written Off</option>
      </select>
      <button class="stl-btn stl-btn-primary" onclick="openAddLoanModal()">
        <i class="fa-solid fa-plus"></i> New Loan
      </button>
    </div>
    <div id="stlLoansTableWrap">
      ${renderLoansTable(STL.loans)}
    </div>
  `;
}

function filterLoans() {
  const q      = (document.getElementById('stlSearchInput')?.value || '').toLowerCase();
  const status = document.getElementById('stlStatusFilter')?.value || '';
  const filtered = STL.loans.filter(l => {
    const matchQ = !q || (l.business_name||'').toLowerCase().includes(q) || (l.loan_ref||'').toLowerCase().includes(q);
    const matchS = !status || l.status === status;
    return matchQ && matchS;
  });
  const wrap = document.getElementById('stlLoansTableWrap');
  if (wrap) wrap.innerHTML = renderLoansTable(filtered);
}

function renderLoansTable(loans) {
  if (!loans.length) return `<div class="stl-loading"><i class="fa-solid fa-file-invoice-dollar" style="font-size:32px;color:rgba(255,255,255,.15)"></i><span>No loans found</span></div>`;

  return `
    <div class="stl-card">
      <div style="overflow-x:auto">
        <table class="stl-table">
          <thead><tr>
            <th>Business</th><th>Ref</th><th>Status</th>
            <th class="num">Disbursed</th><th class="num">Interest</th>
            <th class="num">Total Repayable</th><th class="num">Partial Paid</th>
            <th class="num">Outstanding NAV</th>
            <th>Disbursed</th><th>Due Date</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${loans.map(l => {
              const n = LoanNAV.loanNAV(l);
              return `<tr class="${l.status === 'overdue' ? 'row-overdue' : ''}">
                <td>
                  <div style="font-weight:600">${l.business_name||'—'}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,.4)">${l.contact_name||''} ${l.contact_phone ? '· '+l.contact_phone : ''}</div>
                </td>
                <td style="font-family:monospace;font-size:12px">${l.loan_ref||l.id}</td>
                <td>
                  <span class="stl-badge stl-badge-${l.status||'active'}">${(l.status||'active').replace('_',' ')}</span>
                  ${n.daysOverdue > 0 ? `<div class="stl-overdue-pill" style="margin-top:3px"><i class="fa-solid fa-clock"></i> ${n.daysOverdue}d overdue</div>` : ''}
                </td>
                <td class="num">${stlfmt.zar(n.principal)}</td>
                <td class="num" style="color:#656565">${stlfmt.zar(n.fixedInterest || (n.principal * n.annualRate))}</td>
                <td class="num">${stlfmt.zar(n.totalRepayable)}</td>
                <td class="num" style="color:${n.partialPaid > 0 ? '#fbbf24' : 'rgba(255,255,255,.4)'}">${n.partialPaid > 0 ? stlfmt.zar(n.partialPaid) : '—'}</td>
                <td class="num" style="color:${n.isFullyRepaid ? '#4ade80' : n.isOverdue ? '#f87171' : '#656565'};font-weight:700">
                  ${n.isFullyRepaid ? '<span style="color:#4ade80"><i class="fa-solid fa-check"></i> Repaid</span>' : stlfmt.zar(n.nav)}
                </td>
                <td style="font-size:12px">${stlfmt.date(l.disbursement_date)}</td>
                <td>
                  <div style="font-size:12px">${stlfmt.date(l.repayment_date)}</div>
                  ${n.daysOverdue > 0 ? `<div style="font-size:11px;color:#f87171;font-weight:600">+${n.daysOverdue} days late</div>` : ''}
                </td>
                <td style="white-space:nowrap">
                  <button class="stl-btn stl-btn-secondary stl-btn-sm" onclick="openEditLoanModal('${l.id}')" title="Edit">
                    <i class="fa-solid fa-pen"></i>
                  </button>
                  <button class="stl-doc-btn" onclick="openLoanDocs('${l.id}')" title="Documents" style="margin-left:4px">
                    <i class="fa-solid fa-paperclip"></i> Docs
                  </button>
                  <button class="stl-btn stl-btn-danger stl-btn-sm" onclick="deleteLoan('${l.id}')" title="Delete" style="margin-left:4px">
                    <i class="fa-solid fa-trash"></i>
                  </button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   VIEW: OVERDUE
══════════════════════════════════════════════════════════════ */
function renderOverdueView() {
  const el = document.getElementById('stl-view-overdue');
  const overdue = STL.loans.filter(l => l.status === 'overdue' || (l.status === 'partial' && l.repayment_date && new Date() > new Date(l.repayment_date)));

  if (!overdue.length) {
    el.innerHTML = `
      <div class="stl-loading" style="padding:80px">
        <i class="fa-solid fa-check-circle" style="font-size:48px;color:#4ade80;margin-bottom:12px"></i>
        <span style="font-size:16px;color:#4ade80;font-weight:700">No overdue loans!</span>
        <span style="color:rgba(255,255,255,.4)">All active loans are within their agreed repayment dates.</span>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:12px">
      <i class="fa-solid fa-triangle-exclamation" style="color:#f87171;font-size:20px"></i>
      <div>
        <div style="font-weight:700;color:#fff">${overdue.length} overdue loan${overdue.length!==1?'s':''} require attention</div>
        <div style="font-size:12px;color:rgba(255,255,255,.5)">Total outstanding: ${stlfmt.zar(overdue.reduce((s,l) => { const n=LoanNAV.loanNAV(l); return s + n.nav; }, 0))}</div>
      </div>
    </div>
    ${overdue.map(l => {
      const n = LoanNAV.loanNAV(l);
      return `
      <div class="stl-card" style="border-color:rgba(239,68,68,.25)">
        <div class="stl-card-hd" style="background:rgba(239,68,68,.05)">
          <div>
            <div style="font-size:15px;font-weight:700;color:#fff">${l.business_name||'—'}</div>
            <div style="font-size:12px;color:rgba(255,255,255,.45)">${l.loan_ref||l.id} · ${l.contact_name||''} ${l.contact_phone ? '· '+l.contact_phone : ''}</div>
          </div>
          <div class="stl-overdue-pill" style="font-size:12px;padding:4px 12px">
            <i class="fa-solid fa-clock"></i> ${n.daysOverdue} day${n.daysOverdue!==1?'s':''} overdue
          </div>
        </div>
        <div class="stl-card-body">
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:16px">
            <div>
              <div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;margin-bottom:4px">Amount Disbursed</div>
              <div style="font-size:16px;font-weight:700;color:#fff">${stlfmt.zar(n.principal)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;margin-bottom:4px">Total Repayable</div>
              <div style="font-size:16px;font-weight:700;color:#fff">${stlfmt.zar(n.totalRepayable)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;margin-bottom:4px">Partial Paid</div>
              <div style="font-size:16px;font-weight:700;color:#fbbf24">${stlfmt.zar(n.partialPaid)}</div>
            </div>
            <div>
              <div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;margin-bottom:4px">Outstanding</div>
              <div style="font-size:16px;font-weight:700;color:#f87171">${stlfmt.zar(n.nav)}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <div style="flex:1;background:rgba(255,255,255,.04);border-radius:8px;padding:10px 14px;font-size:12px">
              <span style="color:rgba(255,255,255,.4)">Due Date: </span>
              <span style="color:#f87171;font-weight:600">${stlfmt.date(l.repayment_date)}</span>
            </div>
            <div style="flex:1;background:rgba(255,255,255,.04);border-radius:8px;padding:10px 14px;font-size:12px">
              <span style="color:rgba(255,255,255,.4)">Disbursed: </span>
              <span style="color:#fff">${stlfmt.date(l.disbursement_date)}</span>
            </div>
          </div>
          ${l.notes ? `<div style="margin-top:12px;font-size:12px;color:rgba(255,255,255,.4);background:rgba(255,255,255,.03);border-radius:8px;padding:10px 14px"><i class="fa-solid fa-sticky-note" style="margin-right:6px"></i>${l.notes}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="stl-btn stl-btn-secondary stl-btn-sm" onclick="openEditLoanModal('${l.id}')">
              <i class="fa-solid fa-pen"></i> Update Status
            </button>
          </div>
        </div>
      </div>`;
    }).join('')}
  `;
}

/* ══════════════════════════════════════════════════════════════
   VIEW: NAV & FUND RETURNS
══════════════════════════════════════════════════════════════ */
function renderReturnsView() {
  const el   = document.getElementById('stl-view-returns');
  const pNav = LoanNAV.portfolioNAV(STL.loans);

  // Per-loan data for the returns table
  const loanRows = STL.loans.map(l => {
    const n = LoanNAV.loanNAV(l);
    const returnPct = n.principal > 0 ? ((n.isFullyRepaid ? n.realisedReturn : n.accruedInterest) / n.principal) * 100 : 0;
    return { l, n, returnPct };
  }).sort((a, b) => b.returnPct - a.returnPct);

  el.innerHTML = `
    <!-- Fund Return Panel -->
    <div class="stl-return-panel">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--stl-blue);margin-bottom:18px;font-weight:700">
        <i class="fa-solid fa-calculator"></i> &nbsp;Short-Term Portfolio — NAV &amp; Fund Return
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-bottom:24px">
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">PORTFOLIO NAV</div>
          <div class="stl-return-value">${stlfmt.zarM(pNav.portfolioNAV)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">Outstanding principal + accrued interest</div>
        </div>
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">FUND RETURN (REALISED)</div>
          <div style="font-size:32px;font-weight:900;color:#4ade80">${pNav.fundReturn >= 0 ? '+' : ''}${pNav.fundReturn.toFixed(2)}%</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">Return on fully repaid loans</div>
        </div>
        <div>
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:4px">TOTAL INTEREST EARNED</div>
          <div style="font-size:32px;font-weight:900;color:#fff">${stlfmt.zarM(pNav.totalInterestEarned)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:4px">Accrued + realised interest</div>
        </div>
      </div>
      <div class="stl-return-row">
        <span class="stl-return-row-label">Total Capital Disbursed</span>
        <span class="stl-return-row-val">${stlfmt.zar(pNav.totalDisbursed)}</span>
      </div>
      <div class="stl-return-row">
        <span class="stl-return-row-label">Total Outstanding (Active Loans NAV)</span>
        <span class="stl-return-row-val" style="color:#656565">${stlfmt.zar(pNav.totalOutstanding)}</span>
      </div>
      <div class="stl-return-row">
        <span class="stl-return-row-label">Total Interest Earned (Accrued + Realised)</span>
        <span class="stl-return-row-val" style="color:#4ade80">+ ${stlfmt.zar(pNav.totalInterestEarned)}</span>
      </div>
      <div class="stl-return-row">
        <span class="stl-return-row-label">Total Repaid (Fully Repaid Loans)</span>
        <span class="stl-return-row-val" style="color:#4ade80">${stlfmt.zar(pNav.totalRepaid)}</span>
      </div>
      <div class="stl-return-row" style="border-top:1px solid rgba(59,130,246,.3);padding-top:12px;margin-top:8px">
        <span style="color:#fff;font-weight:700">Fund Return on Repaid Capital</span>
        <span style="color:#4ade80;font-weight:900;font-size:17px">${pNav.fundReturn >= 0 ? '+' : ''}${pNav.fundReturn.toFixed(2)}%</span>
      </div>
    </div>

    <!-- Formula -->
    <div class="stl-card" style="margin-bottom:20px">
      <div class="stl-card-hd"><span class="stl-card-title"><i class="fa-solid fa-info-circle" style="color:var(--stl-blue)"></i> &nbsp;Calculation Method</span></div>
      <div class="stl-card-body" style="font-size:13px;line-height:1.9;color:rgba(255,255,255,.6)">
        <p><strong style="color:#fff">Accrued Interest (rate-based)</strong> = Principal × Annual Rate × (Days Elapsed ÷ 365)</p>
        <p><strong style="color:#fff">Loan NAV</strong> = Outstanding Balance (Total Repayable − Partial Repayments)</p>
        <p><strong style="color:#fff">Portfolio NAV</strong> = Σ Outstanding Balances across active &amp; partial loans</p>
        <p><strong style="color:#fff">Fund Return</strong> = (Total Repaid − Total Disbursed on Repaid Loans) ÷ Total Disbursed × 100</p>
      </div>
    </div>

    <!-- Per-loan return table -->
    <div class="stl-card">
      <div class="stl-card-hd"><span class="stl-card-title"><i class="fa-solid fa-table" style="color:var(--stl-blue)"></i> &nbsp;Per-Loan NAV Breakdown</span></div>
      <div style="overflow-x:auto">
        <table class="stl-table">
          <thead><tr>
            <th>Business</th><th>Status</th>
            <th class="num">Disbursed</th><th class="num">Rate / Interest</th>
            <th class="num">Days</th><th class="num">Accrued Interest</th>
            <th class="num">Outstanding NAV</th><th class="num">Return %</th>
          </tr></thead>
          <tbody>
            ${loanRows.map(({ l, n, returnPct }) => `
              <tr class="${l.status === 'overdue' ? 'row-overdue' : ''}">
                <td>
                  <div style="font-weight:600">${l.business_name||'—'}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,.4)">${l.loan_ref||l.id}</div>
                </td>
                <td><span class="stl-badge stl-badge-${l.status||'active'}">${(l.status||'active').replace('_',' ')}</span></td>
                <td class="num">${stlfmt.zar(n.principal)}</td>
                <td class="num">${n.annualRate > 0 ? stlfmt.pct(n.annualRate * 100) : stlfmt.zar(n.fixedInterest)}</td>
                <td class="num">${n.daysElapsed}</td>
                <td class="num" style="color:#656565">+ ${stlfmt.zar(n.accruedInterest)}</td>
                <td class="num" style="color:${n.isFullyRepaid ? '#4ade80' : n.isOverdue ? '#f87171' : '#656565'};font-weight:700">
                  ${n.isFullyRepaid ? '<span style="color:#4ade80">Repaid ✓</span>' : stlfmt.zar(n.nav)}
                </td>
                <td class="num" style="color:${returnPct > 0 ? '#4ade80' : 'rgba(255,255,255,.4)'}">
                  ${returnPct > 0 ? '+' : ''}${returnPct.toFixed(2)}%
                </td>
              </tr>`).join('')}
            ${loanRows.length === 0 ? `<tr><td colspan="8" style="text-align:center;padding:24px;color:rgba(255,255,255,.3)">No loan data</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ══════════════════════════════════════════════════════════════
   LOAN CRUD
══════════════════════════════════════════════════════════════ */
function openAddLoanModal() {
  STL.editingId = null;
  document.getElementById('stlModalTitle').textContent = 'Add Loan';
  document.getElementById('stl_form_id').value = '';
  document.getElementById('stlLoanForm').reset();
  document.getElementById('stlLoanModal').classList.add('open');
}

function openEditLoanModal(id) {
  const l = STL.loans.find(x => x.id === id);
  if (!l) return;
  STL.editingId = id;
  document.getElementById('stlModalTitle').textContent = 'Edit Loan';
  document.getElementById('stl_form_id').value = id;

  const setVal = (fid, val) => { const el = document.getElementById(fid); if (el) el.value = val ?? ''; };
  setVal('sl_business_name',        l.business_name);
  setVal('sl_business_reg',         l.business_reg);
  setVal('sl_contact_name',         l.contact_name);
  setVal('sl_contact_phone',        l.contact_phone);
  setVal('sl_loan_ref',             l.loan_ref);
  setVal('sl_amount',               l.amount_disbursed);
  setVal('sl_rate_pct',             l.interest_rate ? (parseFloat(l.interest_rate) * 100).toFixed(4) : '');
  setVal('sl_interest_amount',      l.interest_amount);
  setVal('sl_total_repayable',      l.total_repayable);
  setVal('sl_status',               l.status || 'active');
  setVal('sl_disbursement_date',    l.disbursement_date ? l.disbursement_date.split('T')[0] : '');
  setVal('sl_repayment_date',       l.repayment_date    ? l.repayment_date.split('T')[0]    : '');
  setVal('sl_actual_repayment_date',l.actual_repayment_date ? l.actual_repayment_date.split('T')[0] : '');
  setVal('sl_partial',              l.partial_repayments);
  setVal('sl_notes',                l.notes);

  document.getElementById('stlLoanModal').classList.add('open');
}

function closeLoanModal() {
  document.getElementById('stlLoanModal').classList.remove('open');
  STL.editingId = null;
}

async function saveLoanForm() {
  const getVal = fid => { const el = document.getElementById(fid); return el ? el.value.trim() : ''; };

  const businessName = getVal('sl_business_name');
  const amount       = parseFloat(getVal('sl_amount'));
  if (!businessName) { STLToast.show('Business name is required', 'error'); return; }
  if (!amount || amount <= 0) { STLToast.show('Amount disbursed is required', 'error'); return; }

  const ratePct        = parseFloat(getVal('sl_rate_pct')) || 0;
  const interestAmount = parseFloat(getVal('sl_interest_amount')) || 0;

  const data = {
    business_name:          businessName,
    business_reg:           getVal('sl_business_reg') || null,
    contact_name:           getVal('sl_contact_name') || null,
    contact_phone:          getVal('sl_contact_phone') || null,
    loan_ref:               getVal('sl_loan_ref') || null,
    amount_disbursed:       amount,
    interest_rate:          ratePct / 100,
    interest_amount:        interestAmount || null,
    total_repayable:        parseFloat(getVal('sl_total_repayable')) || (amount + interestAmount) || null,
    status:                 getVal('sl_status') || 'active',
    disbursement_date:      getVal('sl_disbursement_date')         ? new Date(getVal('sl_disbursement_date')).toISOString()         : null,
    repayment_date:         getVal('sl_repayment_date')            ? new Date(getVal('sl_repayment_date')).toISOString()            : null,
    actual_repayment_date:  getVal('sl_actual_repayment_date')     ? new Date(getVal('sl_actual_repayment_date')).toISOString()     : null,
    partial_repayments:     parseFloat(getVal('sl_partial')) || 0,
    notes:                  getVal('sl_notes') || null,
  };

  const btn = document.getElementById('stlSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

  try {
    if (STL.editingId) {
      const updated = await stlPatch(`tables/shortterm_loans/${STL.editingId}`, data);
      const idx = STL.loans.findIndex(x => x.id === STL.editingId);
      if (idx !== -1) STL.loans[idx] = { ...STL.loans[idx], ...updated };
      STLToast.show('Loan updated', 'success');
    } else {
      data.id = `STL-${Date.now()}`;
      const created = await stlPost('tables/shortterm_loans', data);
      STL.loans.unshift(created);
      STLToast.show('Loan added', 'success');
    }
    closeLoanModal();
    const view = STL.currentView;
    if (view === 'dashboard') renderSTLDashboard();
    else if (view === 'loans') renderLoansView();
    else if (view === 'overdue') renderOverdueView();
    else if (view === 'returns') renderReturnsView();
  } catch(e) {
    STLToast.show('Error saving loan: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Loan';
  }
}

async function deleteLoan(id) {
  const l = STL.loans.find(x => x.id === id);
  if (!confirm(`Delete loan for "${l?.business_name || id}"? This cannot be undone.`)) return;
  try {
    await stlDelete(`tables/shortterm_loans/${id}`);
    STL.loans = STL.loans.filter(x => x.id !== id);
    const view = STL.currentView;
    if (view === 'dashboard') renderSTLDashboard();
    else if (view === 'loans') renderLoansView();
    else if (view === 'overdue') renderOverdueView();
    else if (view === 'returns') renderReturnsView();
    STLToast.show('Loan deleted', 'success');
  } catch(e) {
    STLToast.show('Error deleting loan', 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   DOCUMENT MANAGEMENT — Loan Supporting Documents
══════════════════════════════════════════════════════════════ */
const DOC_TYPES_LOAN = {
  loan_agreement:       'Loan Agreement',
  id_document:          'ID Document',
  bank_statement:       'Bank Statement',
  business_registration:'Business Registration',
  collateral_deed:      'Collateral / Deed',
  invoice:              'Invoice',
  bank_confirmation:    'Bank Confirmation Letter',
  board_resolution:     'Board Resolution',
  financial_statements: 'Financial Statements',
  other:                'Other'
};

const DOC_ICONS = {
  'application/pdf':  'fa-file-pdf',
  'image/jpeg':       'fa-file-image',
  'image/png':        'fa-file-image',
  'image/webp':       'fa-file-image',
  default:            'fa-file-alt'
};

function fmtBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

/* Open the documents drawer for a loan */
async function openLoanDocs(loanId) {
  const l = STL.loans.find(x => x.id === loanId);
  if (!l) return;
  STL.docsLoanId = loanId;

  const overlay = document.getElementById('stlDocsOverlay');
  const title   = document.getElementById('stlDocsTitle');
  title.textContent = `Documents — ${l.business_name}`;
  overlay.classList.add('open');

  await refreshLoanDocsList(loanId);
}

function closeLoanDocs() {
  document.getElementById('stlDocsOverlay').classList.remove('open');
  STL.docsLoanId = null;
}

async function refreshLoanDocsList(loanId) {
  const body = document.getElementById('stlDocsBody');
  body.innerHTML = `<div class="stl-loading" style="padding:30px"><div class="stl-spinner" style="width:24px;height:24px"></div></div>`;
  try {
    const res  = await stlFetchAll('loan_documents');
    const docs = res.filter(d => d.loan_id === loanId);
    STL.currentDocs = docs;
    body.innerHTML = renderDocsPanel(docs, 'loan');
  } catch(e) {
    body.innerHTML = `<div style="color:#f87171;padding:20px;font-size:13px">Error loading documents: ${e.message}</div>`;
  }
}

function renderDocsPanel(docs, mode) {
  const docTypes = mode === 'loan' ? DOC_TYPES_LOAN : DOC_TYPES_SOLAR;
  const uploadFn = mode === 'loan' ? 'uploadLoanDoc' : 'uploadSolarDoc';
  const deleteFn = mode === 'loan' ? 'deleteLoanDoc' : 'deleteSolarDoc';

  return `
    <!-- Upload area -->
    <div style="border:2px dashed rgba(255,255,255,.12);border-radius:12px;padding:20px;margin-bottom:20px;text-align:center;cursor:pointer;transition:border-color .2s"
         onclick="document.getElementById('stlDocFileInput').click()"
         ondragover="event.preventDefault();this.style.borderColor='rgba(59,130,246,.6)'"
         ondragleave="this.style.borderColor='rgba(255,255,255,.12)'"
         ondrop="event.preventDefault();this.style.borderColor='rgba(255,255,255,.12)';handleDocFileDrop(event,'${mode}')">
      <i class="fa-solid fa-cloud-arrow-up" style="font-size:28px;color:rgba(255,255,255,.3);margin-bottom:10px;display:block"></i>
      <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,.6)">Drop files here or click to upload</div>
      <div style="font-size:11px;color:rgba(255,255,255,.3);margin-top:4px">PDF, JPG, PNG — max 10 MB per file</div>
      <input type="file" id="stlDocFileInput" style="display:none" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple onchange="handleDocFileSelect(this,'${mode}')">
    </div>

    <!-- Type + uploader name -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div class="stl-form-group">
        <label>Document Type</label>
        <select id="stlDocType" class="stl-select" style="width:100%">
          ${Object.entries(docTypes).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
      <div class="stl-form-group">
        <label>Uploaded By</label>
        <input type="text" id="stlDocUploader" placeholder="Your name" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:9px 12px;color:#fff;font-size:13px;outline:none;font-family:inherit;width:100%;box-sizing:border-box">
      </div>
    </div>

    <!-- Document list -->
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.4);font-weight:700;margin-bottom:10px">
      Uploaded Documents (${docs.length})
    </div>
    ${docs.length === 0
      ? `<div style="text-align:center;padding:24px;color:rgba(255,255,255,.3);font-size:13px"><i class="fa-solid fa-folder-open" style="font-size:28px;display:block;margin-bottom:8px;opacity:.4"></i>No documents uploaded yet</div>`
      : docs.map(d => {
          const icon  = DOC_ICONS[d.mime_type] || DOC_ICONS.default;
          const isImg = (d.mime_type||'').startsWith('image/');
          const isPdf = d.mime_type === 'application/pdf';
          return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:rgba(255,255,255,.04);border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,.07)">
            <div style="width:36px;height:36px;background:rgba(59,130,246,.1);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <i class="fa-solid ${icon}" style="color:#656565;font-size:16px"></i>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.doc_name||'Document'}</div>
              <div style="font-size:11px;color:rgba(255,255,255,.4);display:flex;gap:10px;margin-top:2px">
                <span>${DOC_TYPES_LOAN[d.doc_type]||DOC_TYPES_SOLAR[d.doc_type]||d.doc_type||'Document'}</span>
                ${d.file_size ? `<span>· ${d.file_size}</span>` : ''}
                ${d.uploaded_by ? `<span>· ${d.uploaded_by}</span>` : ''}
                <span>· ${stlfmt.date(d.uploaded_at||d.created_at)}</span>
              </div>
              ${d.notes ? `<div style="font-size:11px;color:rgba(255,255,255,.35);margin-top:2px">${d.notes}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              ${d.doc_url ? `
                ${isImg ? `<button class="stl-btn stl-btn-secondary stl-btn-sm" onclick="previewDocImage('${d.doc_url}','${(d.doc_name||'').replace(/'/g,'')}')" title="Preview"><i class="fa-solid fa-eye"></i></button>` : ''}
                <a href="${d.doc_url}" download="${d.doc_name||'document'}" target="_blank" class="stl-btn stl-btn-secondary stl-btn-sm" title="Download" style="text-decoration:none"><i class="fa-solid fa-download"></i></a>
              ` : ''}
              <button class="stl-btn stl-btn-danger stl-btn-sm" onclick="${deleteFn}('${d.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>`;
        }).join('')
    }
  `;
}

/* Handle file drop */
function handleDocFileDrop(event, mode) {
  const files = Array.from(event.dataTransfer.files);
  processDocFiles(files, mode);
}

/* Handle file input select */
function handleDocFileSelect(input, mode) {
  const files = Array.from(input.files);
  processDocFiles(files, mode);
  input.value = '';
}

function processDocFiles(files, mode) {
  if (!files.length) return;
  const validTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  const maxSize = 10 * 1024 * 1024;
  files.forEach(file => {
    if (!validTypes.includes(file.type)) {
      STLToast.show(`${file.name}: unsupported file type`, 'error');
      return;
    }
    if (file.size > maxSize) {
      STLToast.show(`${file.name}: exceeds 10 MB limit`, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = async e => {
      if (mode === 'loan') await uploadLoanDocData(file, e.target.result);
      else await uploadSolarDocData(file, e.target.result);
    };
    reader.readAsDataURL(file);
  });
}

async function uploadLoanDocData(file, dataUrl) {
  if (!STL.docsLoanId) return;
  const docType  = document.getElementById('stlDocType')?.value   || 'other';
  const uploader = document.getElementById('stlDocUploader')?.value || '';
  const data = {
    id:          `LDOC-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    loan_id:     STL.docsLoanId,
    doc_type:    docType,
    doc_name:    file.name,
    doc_url:     dataUrl,
    file_size:   fmtBytes(file.size),
    mime_type:   file.type,
    uploaded_by: uploader,
    uploaded_at: new Date().toISOString(),
    notes:       ''
  };
  try {
    await stlPost('tables/loan_documents', data);
    STLToast.show(`${file.name} uploaded`, 'success');
    await refreshLoanDocsList(STL.docsLoanId);
  } catch(e) {
    STLToast.show('Upload failed: ' + e.message, 'error');
  }
}

async function deleteLoanDoc(docId) {
  if (!confirm('Remove this document?')) return;
  try {
    await stlDelete(`tables/loan_documents/${docId}`);
    STLToast.show('Document removed', 'success');
    await refreshLoanDocsList(STL.docsLoanId);
  } catch(e) {
    STLToast.show('Delete failed', 'error');
  }
}

/* Image preview lightbox */
function previewDocImage(url, name) {
  const existing = document.getElementById('stlImgLightbox');
  if (existing) existing.remove();
  const lb = document.createElement('div');
  lb.id = 'stlImgLightbox';
  lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;cursor:zoom-out';
  lb.onclick = () => lb.remove();
  lb.innerHTML = `
    <div style="font-size:13px;color:rgba(255,255,255,.6);margin-bottom:12px">${name}</div>
    <img src="${url}" style="max-width:100%;max-height:80vh;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6)" alt="${name}">
    <div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:10px">Click anywhere to close</div>`;
  document.body.appendChild(lb);
}

// Expose these for solar module reuse
window.renderDocsPanel       = renderDocsPanel;
window.handleDocFileDrop     = handleDocFileDrop;
window.handleDocFileSelect   = handleDocFileSelect;
window.processDocFiles       = processDocFiles;
window.fmtBytes              = fmtBytes;
window.previewDocImage       = previewDocImage;
window.DOC_TYPES_LOAN        = DOC_TYPES_LOAN;
window.DOC_ICONS             = DOC_ICONS;
