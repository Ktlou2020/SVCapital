/* ═══════════════════════════════════════════════════════════════════════
   SV Capital — Team Dashboard (EVA)
   team/js/team.js  |  Pure-JS SPA
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ─── API Helpers ─────────────────────────────────────────────────────── */
const API_BASE = '/api/';

async function apiGet(path) {
  try {
    const res = await fetch(API_BASE + path);
    if (!res.ok) return { data: [], total: 0 };
    return await res.json();
  } catch { return { data: [], total: 0 }; }
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function apiPut(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function apiDelete(path) {
  await fetch(API_BASE + path, { method: 'DELETE' });
}

async function fetchAll(table) {
  const PAGE = 100;
  let page = 1, all = [];
  while (true) {
    const res = await apiGet(`tables/${table}?limit=${PAGE}&page=${page}`);
    const rows = res.data || [];
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    if (res.total > 0 && all.length >= res.total) break;
    page++;
  }
  return all;
}

/* ─── Formatters ─────────────────────────────────────────────────────── */
const zarM = v => {
  if (!v && v !== 0) return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  return n >= 1e6 ? 'R' + (n/1e6).toFixed(2) + 'M'
       : n >= 1e3 ? 'R' + (n/1e3).toFixed(1) + 'k'
       : 'R' + n.toFixed(0);
};

const zarFull = v => {
  if (!v && v !== 0) return '—';
  return 'R' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const pct = (v, digits = 1) => {
  if (!v && v !== 0) return '—';
  return Number(v).toFixed(digits) + '%';
};

const score = v => Math.round(Number(v) || 0);

const monthName = m => {
  if (!m) return '—';
  const [y, mo] = m.split('-');
  const d = new Date(+y, +mo - 1, 1);
  return d.toLocaleString('en', { month: 'long', year: 'numeric' });
};

const dateStr = d => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
};

/* ─── Level System ───────────────────────────────────────────────────── */
const LEVELS = [
  { level: 1, title: 'Analyst',     minXP: 0,    color: '#adb5bd' },
  { level: 2, title: 'Associate',   minXP: 500,  color: '#5cb85c' },
  { level: 3, title: 'Senior',      minXP: 1200, color: '#00d4aa' },
  { level: 4, title: 'Lead',        minXP: 2500, color: '#4fc3f7' },
  { level: 5, title: 'Director',    minXP: 4500, color: '#7c5cfc' },
  { level: 6, title: 'MVP',         minXP: 7000, color: '#f9c846' },
];

function getLevel(xp) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.minXP) lvl = l; }
  return lvl;
}

function getXpProgress(xp) {
  const lvl = getLevel(xp);
  const idx = LEVELS.indexOf(lvl);
  const nextLvl = LEVELS[idx + 1];
  if (!nextLvl) return { pct: 100, current: xp - lvl.minXP, needed: 0, nextTitle: 'MAX' };
  const current = xp - lvl.minXP;
  const needed   = nextLvl.minXP - lvl.minXP;
  return { pct: Math.round((current / needed) * 100), current, needed, nextTitle: nextLvl.title };
}

/* ─── KPI Colour Utility ─────────────────────────────────────────────── */
function kpiColor(v) {
  if (v >= 90) return '#00d4aa';
  if (v >= 75) return '#4fc3f7';
  if (v >= 60) return '#f9c846';
  if (v >= 40) return '#ffb347';
  return '#ff5b5b';
}

/* ─── EVA Calculation Engine ─────────────────────────────────────────── */
// Revenue Formula: gross_revenue = total_aum × 2.5%
// EVA Pool        = (gross_revenue − operational_costs) × (1 − company_retention_pct/100)
// Team Pool       = EVA Pool × team_pool_pct/100
// Individual Pool = Team Pool × individual_split_pct/100
// Collective Pool = Team Pool × collective_split_pct/100
// Employee Share  = IndivPool × (w/ΣW) + CollectPool/headcount
//   where w = eva_weight × (kpi_score/100)

const AUM_REVENUE_RATE = 0.025; // 2.5% of AUM = gross revenue

function deriveEVAPeriod(period) {
  // Auto-calculate all derived values from AUM whenever used
  const aum         = Number(period.total_aum) || 0;
  const grossRev    = aum * AUM_REVENUE_RATE;
  const opCosts     = Number(period.operational_costs) || (grossRev * 0.4);
  const retPct      = (Number(period.company_retention_pct) || 50) / 100;
  const teamPct     = (Number(period.team_pool_pct) || 50) / 100;
  const evaPool     = (grossRev - opCosts) * (1 - retPct) * 2; // ×2 because retPct=50% means split 50/50
  // Correct formula: EVA pool = (revenue - costs); company keeps retPct, team gets (1-retPct)
  const evaPoolCorr = Math.max(0, (grossRev - opCosts));
  const teamPool    = evaPoolCorr * teamPct;
  return {
    ...period,
    gross_revenue:   period.gross_revenue || grossRev,   // use stored if exists
    eva_pool_total:  period.eva_pool_total || evaPoolCorr,
    team_pool_amount:period.team_pool_amount || teamPool,
    _derived_gross:  grossRev,   // always show formula result for transparency
    _aum_rate_label: `${(AUM_REVENUE_RATE*100)}% × ${zarM(aum)} AUM`
  };
}

function calcEVA(period, employees, kpiScores) {
  if (!period) return [];
  const p           = deriveEVAPeriod(period);
  const teamPool    = Number(p.team_pool_amount) || 0;
  const indivPct    = (Number(p.individual_split_pct) || 60) / 100;
  const collectPct  = (Number(p.collective_split_pct) || 40) / 100;
  const indivPool   = teamPool * indivPct;
  const collectPool = teamPool * collectPct;

  // Collective pool: divide equally among active employees
  const active = employees.filter(e => e.status !== 'inactive');
  const collectShare = active.length > 0 ? collectPool / active.length : 0;

  // Individual pool: weighted by eva_weight × overall_score
  const periodScores = kpiScores.filter(k => k.period_month === p.period_month);
  let totalWeight = 0;
  const scoreMap = {};
  for (const emp of active) {
    const kpi     = periodScores.find(k => k.employee_id === emp.id);
    const overall = kpi ? Number(kpi.overall_score) || 0 : 0;
    const weight  = Number(emp.eva_weight) || 1;
    const w       = weight * (overall / 100);
    scoreMap[emp.id] = { overall, weight, w, kpi };
    totalWeight += w;
  }

  return active.map(emp => {
    const { overall, weight, w, kpi } = scoreMap[emp.id] || { overall: 0, weight: 1, w: 0, kpi: null };
    const indivShare = totalWeight > 0 ? (w / totalWeight) * indivPool : 0;
    const totalShare = indivShare + collectShare;
    return { emp, kpi, overall, weight, w, indivShare, collectShare, totalShare };
  });
}

/* ─── Global State ───────────────────────────────────────────────────── */
let _employees = [];
let _kpiScores  = [];
let _leaveReqs  = [];
let _evaPeriods = [];
let _achievements = [];
let _challenges = [];
let _activePeriod = null;
let _charts = {};

/* ─── Navigation ─────────────────────────────────────────────────────── */
let _currentView = 'dashboard';

function navigate(view, btn) {
  _currentView = view;
  document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const section = document.getElementById('view-' + view);
  if (section) section.classList.add('active');
  if (btn) btn.classList.add('active');
  const titles = {
    dashboard:   'Team Dashboard',
    leaderboard: 'Leaderboard',
    kpis:        'KPI Management',
    leave:       'Leave Management',
    eva:         'EVA Pool',
    achievements:'Achievements & Badges',
    settings:    'Settings'
  };
  document.getElementById('topbarTitle').textContent = titles[view] || view;
  renderView(view);
}

function renderView(view) {
  switch (view) {
    case 'dashboard':   renderDashboard();   break;
    case 'leaderboard': renderLeaderboard(); break;
    case 'kpis':        renderKpis();        break;
    case 'leave':       renderLeave();       break;
    case 'eva':         renderEva();         break;
    case 'achievements':renderAchievements();break;
    case 'settings':    renderSettings();    break;
  }
}

/* ─── INIT ───────────────────────────────────────────────────────────── */
async function init() {
  showGlobalLoader(true);
  try {
    const [emps, kpis, leaves, periods, achs, challenges] = await Promise.all([
      fetchAll('employees'),
      fetchAll('kpi_scores'),
      fetchAll('leave_requests'),
      fetchAll('eva_periods'),
      fetchAll('achievements'),
      fetchAll('team_challenges')
    ]);
    _employees    = emps;
    _kpiScores    = kpis;
    _leaveReqs    = leaves;
    _evaPeriods   = periods.sort((a,b) => b.period_month.localeCompare(a.period_month));
    _achievements = achs;
    _challenges   = challenges;
    _activePeriod = _evaPeriods[0] || null;

    // Populate period dropdown
    const sel = document.getElementById('periodSelect');
    if (sel) {
      sel.innerHTML = _evaPeriods.map(p =>
        `<option value="${p.period_month}">${monthName(p.period_month)}</option>`
      ).join('');
      sel.value = _activePeriod?.period_month || '';
      sel.addEventListener('change', () => {
        _activePeriod = _evaPeriods.find(p => p.period_month === sel.value) || null;
        renderView(_currentView);
      });
    }

    renderView('dashboard');
  } catch(e) {
    console.error('Init error', e);
  } finally {
    showGlobalLoader(false);
  }
}

function showGlobalLoader(v) {
  const el = document.getElementById('globalLoader');
  if (el) el.style.display = v ? 'flex' : 'none';
}

/* ─── VIEW: Dashboard ────────────────────────────────────────────────── */
function renderDashboard() {
  const period = _activePeriod;
  const evaCalc = period ? calcEVA(period, _employees, _kpiScores) : [];
  const latestKpis = _employees.map(emp => {
    const kpis = _kpiScores.filter(k => k.employee_id === emp.id);
    return kpis.sort((a,b) => b.period_month.localeCompare(a.period_month))[0] || null;
  });
  const avgScore = latestKpis.length > 0
    ? Math.round(latestKpis.filter(k=>k).reduce((s,k) => s + (Number(k.overall_score)||0), 0) / latestKpis.filter(k=>k).length)
    : 0;
  const topEarner = evaCalc.sort((a,b) => b.totalShare - a.totalShare)[0];
  const pendingLeave = _leaveReqs.filter(l => l.status === 'pending').length;
  const activeChallenges = _challenges.filter(c => c.status === 'active').length;

  document.getElementById('db-avg-score').textContent = avgScore;
  document.getElementById('db-team-pool').textContent = period ? zarM(period.team_pool_amount) : '—';
  document.getElementById('db-pending-leave').textContent = pendingLeave;
  document.getElementById('db-active-challenges').textContent = activeChallenges;
  document.getElementById('db-aum').textContent = period ? zarM(period.total_aum) : '—';
  document.getElementById('db-eva-pool').textContent = period ? zarM(period.eva_pool_total) : '—';
  document.getElementById('db-period-label').textContent = period ? monthName(period.period_month) : 'No data';

  if (period) {
    document.getElementById('db-aum-growth').textContent = '+' + pct(period.aum_growth_pct);
    document.getElementById('db-revenue').textContent    = zarM(period.gross_revenue);
    document.getElementById('db-op-costs').textContent   = zarM(period.operational_costs);
  }

  // Employee score cards
  const grid = document.getElementById('db-emp-grid');
  if (grid) {
    grid.innerHTML = _employees.map(emp => {
      const kpi = latestKpis[_employees.indexOf(emp)];
      const overall = kpi ? Number(kpi.overall_score) || 0 : 0;
      const xp = Number(emp.xp_points) || 0;
      const lvl = getLevel(xp);
      const xpProg = getXpProgress(xp);
      const col = emp.avatar_color || '#7c5cfc';
      const eva = evaCalc.find(e => e.emp.id === emp.id);
      return `
        <div class="emp-card">
          <div class="emp-card__top">
            <div class="emp-avatar" style="background:${col}">${emp.avatar_initials||'?'}</div>
            <div class="emp-card__info">
              <div class="emp-name">${emp.first_name} ${emp.last_name}</div>
              <div class="emp-role">${emp.role||'—'}</div>
              <div class="emp-dept">${emp.department||'—'}</div>
            </div>
            <div class="emp-card__score">
              ${scoreRingSVG(overall)}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
            <span class="level-badge level-${lvl.level}"><i class="fa-solid fa-bolt"></i>${lvl.title}</span>
            ${Number(emp.streak_days) > 0 ? `<span class="streak"><i class="fa-solid fa-fire"></i>${emp.streak_days}d</span>` : ''}
          </div>
          <div class="xp-bar-wrap">
            <div class="xp-bar-track"><div class="xp-bar-fill" style="width:${xpProg.pct}%"></div></div>
            <span class="xp-bar-label">${xp.toLocaleString()} XP</span>
          </div>
          <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:0.68rem;color:var(--text-muted)">EVA Share</div>
            <div style="font-size:0.85rem;font-weight:800;color:var(--accent)">${eva ? zarM(eva.totalShare) : '—'}</div>
          </div>
          <a href="employee.html?id=${emp.id}" class="btn btn--secondary btn--sm" style="width:100%;justify-content:center;margin-top:8px">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> Employee View
          </a>
        </div>`;
    }).join('');
  }

  // Active challenges widget
  const chWrap = document.getElementById('db-challenges');
  if (chWrap) {
    const active = _challenges.filter(c => c.status === 'active').slice(0, 3);
    chWrap.innerHTML = active.length === 0
      ? `<div class="empty-state"><i class="fa-solid fa-trophy"></i><p>No active challenges</p></div>`
      : active.map(ch => `
        <div class="challenge-card active-challenge" style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px">
            <div class="challenge-title">${ch.title}</div>
            <span class="status-badge status--active">active</span>
          </div>
          <div class="challenge-desc">${ch.description}</div>
          <div class="challenge-rewards">
            <span class="reward-tag xp"><i class="fa-solid fa-bolt"></i>${ch.reward_xp} XP</span>
            ${ch.reward_zar ? `<span class="reward-tag zar"><i class="fa-solid fa-coins"></i>${zarM(ch.reward_zar)}</span>` : ''}
            ${ch.reward_badge ? `<span class="reward-tag badge"><i class="fa-solid fa-medal"></i>${ch.reward_badge}</span>` : ''}
          </div>
        </div>`).join('');
  }

  // Render bar chart (team KPI scores)
  renderDashboardChart();
}

function scoreRingSVG(val) {
  const c = 22, r = 18, circ = 2 * Math.PI * r;
  const progress = circ - (val / 100) * circ;
  const col = kpiColor(val);
  return `<div class="score-ring">
    <svg viewBox="0 0 44 44" width="52" height="52">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="3.5"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="3.5"
        stroke-dasharray="${circ}" stroke-dashoffset="${progress}" stroke-linecap="round"/>
    </svg>
    <div style="text-align:center">
      <div class="score-ring__val" style="color:${col}">${Math.round(val)}</div>
      <div class="score-ring__lbl">score</div>
    </div>
  </div>`;
}

function renderDashboardChart() {
  const ctx = document.getElementById('dashboardChart');
  if (!ctx) return;
  if (_charts.dashboard) { _charts.dashboard.destroy(); }
  const labels = _employees.map(e => e.first_name || e.id);
  const periods = _activePeriod ? [_activePeriod.period_month] : [];
  const datasets = [];
  const dims = ['revenue_contribution','client_satisfaction','compliance_score','task_completion_rate','team_collaboration'];
  const dimLabels = ['Revenue','Client','Compliance','Tasks','Team'];
  const colors = ['#7c5cfc','#00d4aa','#4fc3f7','#f9c846','#fd79a8'];
  dims.forEach((d, i) => {
    datasets.push({
      label: dimLabels[i],
      data: _employees.map(emp => {
        const kpi = _kpiScores.filter(k => k.employee_id === emp.id)
          .sort((a,b) => b.period_month.localeCompare(a.period_month))[0];
        return kpi ? Number(kpi[d]) || 0 : 0;
      }),
      backgroundColor: colors[i] + '99',
      borderColor: colors[i],
      borderWidth: 1.5,
      borderRadius: 4,
    });
  });
  _charts.dashboard = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8b91a8', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#8b91a8' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { min: 0, max: 100, ticks: { color: '#8b91a8' }, grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  });
}

/* ─── VIEW: Leaderboard ──────────────────────────────────────────────── */
function renderLeaderboard() {
  const evaCalc = _activePeriod ? calcEVA(_activePeriod, _employees, _kpiScores) : [];
  const ranked = [..._employees]
    .map(emp => {
      const kpiList = _kpiScores.filter(k => k.employee_id === emp.id);
      const kpi = kpiList.sort((a,b) => b.period_month.localeCompare(a.period_month))[0] || null;
      const eva = evaCalc.find(e => e.emp.id === emp.id);
      const xp  = Number(emp.xp_points) || 0;
      const overall = kpi ? Number(kpi.overall_score) || 0 : 0;
      return { emp, kpi, eva, xp, overall };
    })
    .sort((a,b) => b.xp - a.xp);

  const list = document.getElementById('lb-list');
  if (!list) return;

  list.innerHTML = ranked.map((item, idx) => {
    const rank = idx + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : 'rank-n';
    const lvl = getLevel(item.xp);
    const col = item.emp.avatar_color || '#7c5cfc';
    const xpProg = getXpProgress(item.xp);
    return `
      <div class="leaderboard-item rank-${rank <= 3 ? rank : 'n'}" style="cursor:pointer" onclick="openKpiDetail('${item.emp.id}')">
        <div class="lb-rank ${rankClass}">${rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}</div>
        <div class="lb-avatar" style="background:${col}">${item.emp.avatar_initials||'?'}</div>
        <div class="lb-info">
          <div class="lb-name">${item.emp.first_name} ${item.emp.last_name}</div>
          <div class="lb-role">${item.emp.role||'—'} · ${item.emp.department||'—'}</div>
          <div class="xp-bar-wrap" style="margin-top:5px">
            <div class="xp-bar-track"><div class="xp-bar-fill" style="width:${xpProg.pct}%"></div></div>
            <span class="xp-bar-label">${item.xp.toLocaleString()} XP · Next: ${xpProg.nextTitle}</span>
          </div>
        </div>
        <div class="lb-stats">
          <div class="lb-stat">
            <span class="lb-stat__val" style="color:${kpiColor(item.overall)}">${item.overall}</span>
            <span class="lb-stat__lbl">KPI</span>
          </div>
          <div class="lb-stat">
            <span class="lb-stat__val" style="color:var(--accent)">${item.eva ? zarM(item.eva.totalShare) : '—'}</span>
            <span class="lb-stat__lbl">EVA</span>
          </div>
        </div>
        <span class="level-badge level-${lvl.level}"><i class="fa-solid fa-bolt"></i>${lvl.title}</span>
        ${Number(item.emp.streak_days) > 0 ? `<span class="streak"><i class="fa-solid fa-fire"></i>${item.emp.streak_days}d</span>` : ''}
      </div>`;
  }).join('');

  // Period breakdown table
  renderLbPeriodTable();
}

function renderLbPeriodTable() {
  const tbody = document.getElementById('lb-table-body');
  if (!tbody) return;
  const evaCalc = _activePeriod ? calcEVA(_activePeriod, _employees, _kpiScores) : [];
  const rows = evaCalc.sort((a,b) => b.totalShare - a.totalShare);
  tbody.innerHTML = rows.map(row => {
    const col = row.emp.avatar_color || '#7c5cfc';
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px">
        <div class="lb-avatar" style="width:32px;height:32px;font-size:0.72rem;background:${col}">${row.emp.avatar_initials||'?'}</div>
        <div>
          <div style="font-weight:700;color:var(--text-primary)">${row.emp.first_name} ${row.emp.last_name}</div>
          <div style="font-size:0.65rem;color:var(--text-muted)">${row.emp.department||'—'}</div>
        </div>
      </div></td>
      <td style="font-weight:700;color:${kpiColor(row.overall)}">${row.overall}</td>
      <td>${row.weight}</td>
      <td style="color:var(--accent)">${zarM(row.indivShare)}</td>
      <td style="color:var(--accent2)">${zarM(row.collectShare)}</td>
      <td style="font-weight:800;color:var(--gold)">${zarM(row.totalShare)}</td>
    </tr>`;
  }).join('');
}

/* ─── VIEW: KPIs ─────────────────────────────────────────────────────── */
function renderKpis() {
  const emp = document.getElementById('kpi-emp-select');
  if (!emp) return;

  // Populate employee filter
  if (emp.options.length <= 1) {
    emp.innerHTML = `<option value="">All Employees</option>` +
      _employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('');
  }

  const selectedEmpId = emp.value;
  const selectedPeriod = _activePeriod?.period_month;

  // Filter
  let scores = _kpiScores;
  if (selectedEmpId) scores = scores.filter(k => k.employee_id === selectedEmpId);
  if (selectedPeriod) scores = scores.filter(k => k.period_month === selectedPeriod);

  const tbody = document.getElementById('kpi-table-body');
  if (!tbody) return;

  tbody.innerHTML = scores.map(k => {
    const emp = _employees.find(e => e.id === k.employee_id);
    const name = emp ? `${emp.first_name} ${emp.last_name}` : k.employee_id;
    const col  = emp?.avatar_color || '#7c5cfc';
    const init = emp?.avatar_initials || '?';
    const dims = ['revenue_contribution','client_satisfaction','task_completion_rate','response_time_score','compliance_score','innovation_score','team_collaboration','attendance_score'];
    const dimBars = dims.map(d => {
      const v = Number(k[d]) || 0;
      return `<div class="mini-kpi">
        <div class="mini-kpi__bar"><div class="mini-kpi__fill" style="width:${v}%;background:${kpiColor(v)}"></div></div>
      </div>`;
    }).join('');
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px">
        <div class="lb-avatar" style="width:30px;height:30px;font-size:0.68rem;background:${col}">${init}</div>
        <span style="font-weight:700;color:var(--text-primary)">${name}</span>
      </div></td>
      <td style="font-size:0.72rem;color:var(--text-muted)">${monthName(k.period_month)}</td>
      <td><div style="display:grid;grid-template-columns:repeat(8,1fr);gap:3px;width:200px">${dimBars}</div></td>
      <td><span style="font-size:1rem;font-weight:900;color:${kpiColor(Number(k.overall_score)||0)}">${score(k.overall_score)}</span></td>
      <td style="color:var(--accent);font-weight:700">${zarM(k.eva_pool_share)}</td>
      <td>
        <button class="btn btn--xs btn--secondary" onclick="openKpiModal('${k.id}')">
          <i class="fa-solid fa-pen"></i> Edit
        </button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="6"><div class="empty-state"><i class="fa-solid fa-chart-bar"></i><p>No KPI scores found</p></div></td></tr>`;

  // Radar chart for selected employee
  renderKpiRadar(selectedEmpId);
}

function renderKpiRadar(empId) {
  const ctx = document.getElementById('kpiRadarChart');
  if (!ctx) return;
  if (_charts.radar) { _charts.radar.destroy(); }

  const dims = ['revenue_contribution','client_satisfaction','task_completion_rate','response_time_score','compliance_score','innovation_score','team_collaboration','attendance_score'];
  const labels = ['Revenue','Client Sat.','Tasks','Response','Compliance','Innovation','Team','Attendance'];

  let datasets = [];
  const colors = ['#7c5cfc','#00d4aa','#f9c846','#fd79a8','#4fc3f7','#ff5b5b'];

  if (empId) {
    const emp = _employees.find(e => e.id === empId);
    const kpi = _kpiScores.filter(k => k.employee_id === empId)
      .sort((a,b) => b.period_month.localeCompare(a.period_month))[0];
    if (kpi) {
      datasets.push({
        label: emp ? `${emp.first_name} ${emp.last_name}` : empId,
        data: dims.map(d => Number(kpi[d]) || 0),
        backgroundColor: 'rgba(124,92,252,0.15)',
        borderColor: '#7c5cfc',
        borderWidth: 2,
        pointBackgroundColor: '#7c5cfc',
      });
    }
  } else {
    _employees.slice(0,4).forEach((emp, i) => {
      const kpi = _kpiScores.filter(k => k.employee_id === emp.id)
        .sort((a,b) => b.period_month.localeCompare(a.period_month))[0];
      if (!kpi) return;
      datasets.push({
        label: emp.first_name,
        data: dims.map(d => Number(kpi[d]) || 0),
        backgroundColor: colors[i] + '25',
        borderColor: colors[i],
        borderWidth: 2,
        pointBackgroundColor: colors[i],
      });
    });
  }

  _charts.radar = new Chart(ctx, {
    type: 'radar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#8b91a8', font: { size: 11 } } } },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { color: '#555c72', stepSize: 25, backdropColor: 'transparent' },
          grid: { color: 'rgba(255,255,255,0.06)' },
          pointLabels: { color: '#8b91a8', font: { size: 11 } },
          angleLines: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });
}

/* ─── VIEW: Leave ─────────────────────────────────────────────────────── */
function renderLeave() {
  const pending  = _leaveReqs.filter(l => l.status === 'pending');
  const approved = _leaveReqs.filter(l => l.status === 'approved');
  const all      = _leaveReqs;

  document.getElementById('leave-pending-count').textContent  = pending.length;
  document.getElementById('leave-approved-count').textContent = approved.length;
  document.getElementById('leave-total-count').textContent    = all.length;

  const list = document.getElementById('leave-list');
  if (!list) return;

  list.innerHTML = _leaveReqs.sort((a,b) =>
    (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1)
  ).map(lr => {
    const emp  = _employees.find(e => e.id === lr.employee_id);
    const name = emp ? `${emp.first_name} ${emp.last_name}` : lr.employee_id;
    const col  = emp?.avatar_color || '#7c5cfc';
    const init = emp?.avatar_initials || '?';
    const typeColors = { annual: '#4fc3f7', sick: '#ff5b5b', study: '#f9c846', family: '#fd79a8', unpaid: '#8b91a8' };
    const dotCol = typeColors[lr.leave_type] || '#8b91a8';
    return `
      <div class="leave-card">
        <div class="leave-type-dot" style="background:${dotCol}" title="${lr.leave_type}"></div>
        <div class="lb-avatar" style="width:36px;height:36px;font-size:0.72rem;background:${col}">${init}</div>
        <div class="leave-info">
          <div class="leave-emp">${name} <span style="font-size:0.65rem;font-weight:600;color:${dotCol};text-transform:uppercase">${lr.leave_type}</span></div>
          <div class="leave-dates">${dateStr(lr.start_date)} → ${dateStr(lr.end_date)} &nbsp;·&nbsp; ${lr.days_requested} day(s)</div>
          <div class="leave-reason">${lr.reason || '—'}</div>
          ${lr.eva_impact_pct > 0 ? `<div style="font-size:0.65rem;color:var(--warning);margin-top:4px"><i class="fa-solid fa-triangle-exclamation"></i> EVA impact: −${lr.eva_impact_pct}%</div>` : ''}
        </div>
        <div class="leave-actions">
          <span class="status-badge status--${lr.status}">${lr.status}</span>
          ${lr.status === 'pending' ? `
            <button class="btn btn--xs btn--success" onclick="approveLeave('${lr.id}')"><i class="fa-solid fa-check"></i></button>
            <button class="btn btn--xs btn--danger" onclick="rejectLeave('${lr.id}')"><i class="fa-solid fa-xmark"></i></button>
          ` : ''}
        </div>
      </div>`;
  }).join('') || `<div class="empty-state"><i class="fa-solid fa-calendar"></i><p>No leave requests</p></div>`;
}

async function approveLeave(id) {
  const lr = _leaveReqs.find(l => l.id === id);
  if (!lr) return;
  await apiPatch(`tables/leave_requests/${id}`, { status: 'approved', approved_by: 'Admin', approved_at: new Date().toISOString() });
  lr.status = 'approved'; lr.approved_by = 'Admin';
  renderLeave();
  showToast('Leave request approved', 'success');
}

async function rejectLeave(id) {
  const lr = _leaveReqs.find(l => l.id === id);
  if (!lr) return;
  await apiPatch(`tables/leave_requests/${id}`, { status: 'rejected', approved_by: 'Admin' });
  lr.status = 'rejected';
  renderLeave();
  showToast('Leave request rejected', 'error');
}

/* ─── VIEW: EVA Pool ─────────────────────────────────────────────────── */
function renderEva() {
  const period = _activePeriod;
  if (!period) {
    document.getElementById('eva-content').innerHTML = `<div class="empty-state"><i class="fa-solid fa-chart-pie"></i><p>No EVA period selected</p></div>`;
    return;
  }

  // Derive computed values using AUM formula
  const dp = deriveEVAPeriod(period);
  const derivedRevenue = Number(dp.total_aum) * AUM_REVENUE_RATE;

  // Header metrics
  document.getElementById('eva-gross-revenue').textContent  = zarFull(dp.gross_revenue);
  document.getElementById('eva-op-costs').textContent       = zarFull(dp.operational_costs);
  document.getElementById('eva-pool-total').textContent     = zarFull(dp.eva_pool_total);
  document.getElementById('eva-team-pool').textContent      = zarFull(dp.team_pool_amount);
  document.getElementById('eva-status').innerHTML           = `<span class="status-badge status--${dp.status}">${dp.status}</span>`;
  document.getElementById('eva-aum-growth').textContent     = '+' + pct(dp.aum_growth_pct);

  // Show revenue formula
  const formulaEl = document.getElementById('eva-revenue-formula');
  if (formulaEl) formulaEl.innerHTML =
    `<i class="fa-solid fa-calculator" style="color:var(--accent2)"></i>
     &nbsp;<b>Revenue = 2.5% × AUM</b> &nbsp;→&nbsp;
     2.5% × ${zarM(dp.total_aum)} = <b style="color:var(--accent2)">${zarFull(derivedRevenue)}</b>`;

  // Breakdown
  const indivPool   = Number(dp.team_pool_amount) * ((Number(dp.individual_split_pct) || 60) / 100);
  const collectPool = Number(dp.team_pool_amount) * ((Number(dp.collective_split_pct) || 40) / 100);
  document.getElementById('eva-indiv-pool').textContent    = zarFull(indivPool);
  document.getElementById('eva-collect-pool').textContent  = zarFull(collectPool);

  // Employee breakdown table
  const evaCalc = calcEVA(dp, _employees, _kpiScores);
  const tbody = document.getElementById('eva-breakdown-body');
  if (tbody) {
    tbody.innerHTML = evaCalc.sort((a,b) => b.totalShare - a.totalShare).map(row => {
      const col = row.emp.avatar_color || '#7c5cfc';
      return `<tr>
        <td><div style="display:flex;align-items:center;gap:10px">
          <div class="lb-avatar" style="width:30px;height:30px;font-size:0.68rem;background:${col}">${row.emp.avatar_initials||'?'}</div>
          <div>
            <div style="font-weight:700;color:var(--text-primary)">${row.emp.first_name} ${row.emp.last_name}</div>
            <div style="font-size:0.65rem;color:var(--text-muted)">${row.emp.department||'—'}</div>
          </div>
        </div></td>
        <td style="font-weight:700;color:${kpiColor(row.overall)}">${row.overall}</td>
        <td>${row.weight}×</td>
        <td style="font-size:0.72rem;color:var(--text-muted)">${(row.w * 100 / Math.max(evaCalc.reduce((s,r)=>s+r.w,0),1)).toFixed(1)}%</td>
        <td style="color:var(--accent)">${zarFull(row.indivShare)}</td>
        <td style="color:var(--accent2)">${zarFull(row.collectShare)}</td>
        <td style="font-weight:800;color:var(--gold)">${zarFull(row.totalShare)}</td>
      </tr>`;
    }).join('');
  }

  // Doughnut chart
  renderEvaChart(evaCalc);
}

function renderEvaChart(evaCalc) {
  const ctx = document.getElementById('evaDonut');
  if (!ctx) return;
  if (_charts.evaDonut) { _charts.evaDonut.destroy(); }
  const colors = ['#7c5cfc','#00d4aa','#f9c846','#fd79a8','#4fc3f7','#ff5b5b'];
  _charts.evaDonut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: evaCalc.map(r => r.emp.first_name),
      datasets: [{
        data: evaCalc.map(r => Math.round(r.totalShare)),
        backgroundColor: colors,
        borderColor: '#13161e',
        borderWidth: 3,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8b91a8', padding: 16, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${zarFull(ctx.parsed)}`
          }
        }
      }
    }
  });
}

/* ─── VIEW: Achievements ─────────────────────────────────────────────── */
function renderAchievements() {
  // Challenges
  const chWrap = document.getElementById('challenges-list');
  if (chWrap) {
    chWrap.innerHTML = _challenges.map(ch => {
      const winner = ch.winner_id ? _employees.find(e => e.id === ch.winner_id) : null;
      return `
        <div class="challenge-card ${ch.status === 'active' ? 'active-challenge' : 'completed-challenge'}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px">
            <div class="challenge-title">${ch.title}</div>
            <span class="status-badge status--${ch.status === 'active' ? 'active' : 'approved'}">${ch.status}</span>
          </div>
          <div class="challenge-desc">${ch.description}</div>
          <div style="font-size:0.65rem;color:var(--text-muted);margin-bottom:8px">${dateStr(ch.start_date)} → ${dateStr(ch.end_date)} &nbsp;·&nbsp; ${ch.challenge_type}</div>
          <div class="challenge-rewards">
            <span class="reward-tag xp"><i class="fa-solid fa-bolt"></i> +${ch.reward_xp} XP</span>
            ${ch.reward_zar ? `<span class="reward-tag zar"><i class="fa-solid fa-coins"></i>${zarM(ch.reward_zar)}</span>` : ''}
            ${ch.reward_badge ? `<span class="reward-tag badge"><i class="fa-solid fa-medal"></i>${ch.reward_badge}</span>` : ''}
          </div>
          ${winner ? `<div style="margin-top:10px;font-size:0.72rem;color:var(--success)"><i class="fa-solid fa-trophy"></i> Winner: ${winner.first_name} ${winner.last_name}</div>` : ''}
        </div>`;
    }).join('');
  }

  // Achievement wall
  const achGrid = document.getElementById('achievements-grid');
  if (achGrid) {
    achGrid.innerHTML = _achievements.map(ach => {
      const emp = _employees.find(e => e.id === ach.employee_id);
      const col = ach.badge_color || '#7c5cfc';
      return `
        <div class="achievement-card">
          <div class="ach-icon" style="background:${col}22;color:${col}">
            <i class="fa-solid ${ach.badge_icon || 'fa-medal'}"></i>
          </div>
          <div class="ach-info">
            <div class="ach-name">${ach.badge_name}</div>
            <div class="ach-emp">${emp ? `${emp.first_name} ${emp.last_name}` : '—'}</div>
            <div class="ach-desc">${ach.description}</div>
            <div class="ach-xp"><i class="fa-solid fa-bolt"></i>+${ach.xp_awarded} XP &nbsp;·&nbsp; ${dateStr(ach.awarded_at)}</div>
          </div>
        </div>`;
    }).join('') || `<div class="empty-state"><i class="fa-solid fa-medal"></i><p>No achievements yet</p></div>`;
  }
}

/* ─── VIEW: Settings ─────────────────────────────────────────────────── */
function renderSettings() {
  const grid = document.getElementById('settings-emp-grid');
  if (!grid) return;
  grid.innerHTML = _employees.map(emp => {
    const col = emp.avatar_color || '#7c5cfc';
    const xp  = Number(emp.xp_points) || 0;
    const lvl = getLevel(xp);
    return `
      <div class="emp-card">
        <div class="emp-card__top" style="margin-bottom:10px">
          <div class="emp-avatar" style="background:${col}">${emp.avatar_initials||'?'}</div>
          <div class="emp-card__info">
            <div class="emp-name">${emp.first_name} ${emp.last_name}</div>
            <div class="emp-role">${emp.role||'—'}</div>
            <div style="margin-top:4px"><span class="level-badge level-${lvl.level}"><i class="fa-solid fa-bolt"></i>${lvl.title}</span></div>
          </div>
          <button class="btn btn--xs btn--secondary" onclick="openEmpModal('${emp.id}')">
            <i class="fa-solid fa-pen"></i>
          </button>
        </div>
        <div style="display:flex;gap:12px;font-size:0.7rem;color:var(--text-muted)">
          <div><b style="color:var(--text-secondary)">${xp.toLocaleString()}</b> XP</div>
          <div><b style="color:var(--text-secondary)">${emp.streak_days||0}</b> Streak</div>
          <div><b style="color:var(--text-secondary)">${emp.eva_weight||1}×</b> EVA wt</div>
        </div>
        <div style="margin-top:8px">
          <span class="status-badge status--${emp.status === 'active' ? 'active' : 'pending'}">${emp.status||'active'}</span>
        </div>
      </div>`;
  }).join('');
}

/* ─── MODAL: KPI Entry ───────────────────────────────────────────────── */
function openKpiModal(kpiId = null) {
  const modal = document.getElementById('kpiModal');
  const form  = document.getElementById('kpiForm');
  if (!modal || !form) return;

  // Populate employee select
  const empSel = form.querySelector('#km-employee');
  if (empSel) {
    empSel.innerHTML = `<option value="">Select Employee</option>` +
      _employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('');
  }

  if (kpiId) {
    const kpi = _kpiScores.find(k => k.id === kpiId);
    if (kpi) {
      form.querySelector('#km-employee').value = kpi.employee_id;
      form.querySelector('#km-period').value   = kpi.period_month;
      const dims = ['revenue_contribution','client_satisfaction','task_completion_rate','response_time_score','compliance_score','innovation_score','team_collaboration','attendance_score'];
      dims.forEach(d => {
        const el = form.querySelector(`#km-${d}`);
        const vl = form.querySelector(`#km-${d}-val`);
        if (el) { el.value = kpi[d] || 0; if (vl) vl.textContent = kpi[d] || 0; }
      });
      form.querySelector('#km-notes').value = kpi.notes || '';
      form.dataset.editId = kpiId;
    }
  } else {
    form.reset();
    delete form.dataset.editId;
    form.querySelector('#km-period').value = _activePeriod?.period_month || '';
  }
  modal.classList.add('open');
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}

async function submitKpi() {
  const form = document.getElementById('kpiForm');
  if (!form) return;
  const dims = ['revenue_contribution','client_satisfaction','task_completion_rate','response_time_score','compliance_score','innovation_score','team_collaboration','attendance_score'];
  const vals = dims.map(d => Number(form.querySelector(`#km-${d}`)?.value) || 0);
  const overall = Math.round(vals.reduce((s,v) => s+v, 0) / vals.length);

  const data = {
    employee_id: form.querySelector('#km-employee').value,
    period_month: form.querySelector('#km-period').value,
    overall_score: overall,
    notes: form.querySelector('#km-notes').value,
    submitted_by: 'Admin',
    submitted_at: new Date().toISOString()
  };
  dims.forEach((d,i) => data[d] = vals[i]);

  if (form.dataset.editId) {
    const updated = await apiPut(`tables/kpi_scores/${form.dataset.editId}`, data);
    const idx = _kpiScores.findIndex(k => k.id === form.dataset.editId);
    if (idx >= 0) _kpiScores[idx] = updated;
  } else {
    const created = await apiPost('tables/kpi_scores', data);
    _kpiScores.push(created);
  }
  closeModal('kpiModal');
  renderKpis();
  showToast('KPI scores saved', 'success');
}

/* ─── MODAL: Leave Request ───────────────────────────────────────────── */
function openLeaveModal() {
  const modal = document.getElementById('leaveModal');
  if (!modal) return;
  const empSel = document.getElementById('lm-employee');
  if (empSel) {
    empSel.innerHTML = `<option value="">Select Employee</option>` +
      _employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('');
  }
  document.getElementById('leaveForm').reset();
  modal.classList.add('open');
}

async function submitLeave() {
  const form = document.getElementById('leaveForm');
  if (!form) return;
  const empId = form.querySelector('#lm-employee').value;
  const start = form.querySelector('#lm-start').value;
  const end   = form.querySelector('#lm-end').value;
  const days  = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
  const data = {
    employee_id: empId,
    leave_type:  form.querySelector('#lm-type').value,
    start_date:  start,
    end_date:    end,
    days_requested: days,
    reason: form.querySelector('#lm-reason').value,
    status: 'pending',
    eva_impact_pct: 0
  };
  const created = await apiPost('tables/leave_requests', data);
  _leaveReqs.push(created);
  closeModal('leaveModal');
  renderLeave();
  showToast('Leave request submitted', 'success');
}

/* ─── MODAL: Award Badge ─────────────────────────────────────────────── */
function openBadgeModal() {
  const modal = document.getElementById('badgeModal');
  if (!modal) return;
  const empSel = document.getElementById('bm-employee');
  if (empSel) {
    empSel.innerHTML = `<option value="">Select Employee</option>` +
      _employees.map(e => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('');
  }
  document.getElementById('badgeForm').reset();
  modal.classList.add('open');
}

async function submitBadge() {
  const form = document.getElementById('badgeForm');
  if (!form) return;
  const empId = form.querySelector('#bm-employee').value;
  const xpAward = Number(form.querySelector('#bm-xp').value) || 100;
  const data = {
    employee_id: empId,
    badge_id:    'BADGE-' + Date.now(),
    badge_name:  form.querySelector('#bm-name').value,
    badge_icon:  form.querySelector('#bm-icon').value || 'fa-medal',
    badge_color: form.querySelector('#bm-color').value || '#7c5cfc',
    category:    form.querySelector('#bm-category').value,
    description: form.querySelector('#bm-desc').value,
    xp_awarded:  xpAward,
    awarded_at:  new Date().toISOString().split('T')[0],
    awarded_by:  'Admin'
  };
  const created = await apiPost('tables/achievements', data);
  _achievements.push(created);

  // Award XP to employee
  const emp = _employees.find(e => e.id === empId);
  if (emp) {
    const newXp = (Number(emp.xp_points) || 0) + xpAward;
    await apiPatch(`tables/employees/${empId}`, { xp_points: newXp });
    emp.xp_points = newXp;
  }

  closeModal('badgeModal');
  renderAchievements();
  showToast(`Badge "${data.badge_name}" awarded! +${xpAward} XP`, 'success');
}

/* ─── MODAL: Employee Edit ───────────────────────────────────────────── */
function openEmpModal(empId) {
  const emp = _employees.find(e => e.id === empId);
  if (!emp) return;
  const modal = document.getElementById('empModal');
  if (!modal) return;
  modal.querySelector('#em-name').textContent    = `${emp.first_name} ${emp.last_name}`;
  modal.querySelector('#em-xp').value            = emp.xp_points || 0;
  modal.querySelector('#em-streak').value        = emp.streak_days || 0;
  modal.querySelector('#em-weight').value        = emp.eva_weight || 1;
  modal.querySelector('#em-status').value        = emp.status || 'active';
  modal.querySelector('#em-bio').value           = emp.bio || '';
  modal.dataset.empId = empId;
  modal.classList.add('open');
}

async function submitEmpEdit() {
  const modal = document.getElementById('empModal');
  if (!modal) return;
  const empId = modal.dataset.empId;
  const data = {
    xp_points:   Number(modal.querySelector('#em-xp').value) || 0,
    streak_days: Number(modal.querySelector('#em-streak').value) || 0,
    eva_weight:  Number(modal.querySelector('#em-weight').value) || 1,
    status:      modal.querySelector('#em-status').value,
    bio:         modal.querySelector('#em-bio').value
  };
  const updated = await apiPatch(`tables/employees/${empId}`, data);
  const idx = _employees.findIndex(e => e.id === empId);
  if (idx >= 0) Object.assign(_employees[idx], data);
  closeModal('empModal');
  renderSettings();
  showToast('Employee updated', 'success');
}

/* ─── MODAL: KPI Detail (from leaderboard click) ─────────────────────── */
function openKpiDetail(empId) {
  const emp = _employees.find(e => e.id === empId);
  if (!emp) return;
  const modal = document.getElementById('kpiDetailModal');
  if (!modal) return;

  const kpi = _kpiScores.filter(k => k.employee_id === empId)
    .sort((a,b) => b.period_month.localeCompare(a.period_month))[0];
  const col = emp.avatar_color || '#7c5cfc';
  const xp  = Number(emp.xp_points) || 0;
  const lvl = getLevel(xp);
  const xpProg = getXpProgress(xp);
  const evaCalc = _activePeriod ? calcEVA(_activePeriod, _employees, _kpiScores) : [];
  const evaRow  = evaCalc.find(r => r.emp.id === empId);

  const dims = [
    { key: 'revenue_contribution', label: 'Revenue Contribution', icon: 'fa-chart-line', color: '#7c5cfc' },
    { key: 'client_satisfaction',  label: 'Client Satisfaction',  icon: 'fa-star',       color: '#f9c846' },
    { key: 'task_completion_rate', label: 'Task Completion',       icon: 'fa-check-circle',color: '#00d4aa' },
    { key: 'response_time_score',  label: 'Response Time',         icon: 'fa-bolt',       color: '#4fc3f7' },
    { key: 'compliance_score',     label: 'Compliance',            icon: 'fa-shield',     color: '#0984e3' },
    { key: 'innovation_score',     label: 'Innovation',            icon: 'fa-lightbulb',  color: '#a29bfe' },
    { key: 'team_collaboration',   label: 'Team Collaboration',    icon: 'fa-people-group',color: '#fd79a8' },
    { key: 'attendance_score',     label: 'Attendance',            icon: 'fa-calendar-check',color: '#55efc4' },
  ];

  const achList = _achievements.filter(a => a.employee_id === empId);

  modal.querySelector('#kdm-header').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
      <div class="emp-avatar" style="width:52px;height:52px;font-size:1.1rem;background:${col}">${emp.avatar_initials||'?'}</div>
      <div>
        <div style="font-size:1.1rem;font-weight:800;color:var(--text-primary)">${emp.first_name} ${emp.last_name}</div>
        <div style="font-size:0.75rem;color:var(--text-secondary)">${emp.role||'—'} · ${emp.department||'—'}</div>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
          <span class="level-badge level-${lvl.level}"><i class="fa-solid fa-bolt"></i>${lvl.title}</span>
          ${Number(emp.streak_days)>0 ? `<span class="streak"><i class="fa-solid fa-fire"></i>${emp.streak_days}d</span>` : ''}
        </div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div style="font-size:1.4rem;font-weight:900;color:${kpiColor(kpi?.overall_score||0)}">${score(kpi?.overall_score||0)}</div>
        <div style="font-size:0.65rem;color:var(--text-muted)">Overall KPI</div>
        <div style="font-size:1rem;font-weight:800;color:var(--gold);margin-top:4px">${evaRow ? zarM(evaRow.totalShare) : '—'}</div>
        <div style="font-size:0.65rem;color:var(--text-muted)">EVA Share</div>
      </div>
    </div>
    <div class="xp-bar-wrap">
      <div class="xp-bar-track"><div class="xp-bar-fill" style="width:${xpProg.pct}%"></div></div>
      <span class="xp-bar-label">${xp.toLocaleString()} XP · ${xpProg.pct}% to ${xpProg.nextTitle}</span>
    </div>`;

  modal.querySelector('#kdm-kpis').innerHTML = kpi
    ? dims.map(d => {
        const v = Number(kpi[d.key]) || 0;
        return `<div class="kpi-dimension">
          <div class="kpi-dim__icon" style="background:${d.color}22;color:${d.color}"><i class="fa-solid ${d.icon}"></i></div>
          <div class="kpi-dim__info">
            <div class="kpi-dim__name">${d.label}</div>
          </div>
          <div class="kpi-dim__score" style="color:${kpiColor(v)}">${v}</div>
          <div class="kpi-dim__bar-wrap">
            <div class="kpi-dim__bar"><div class="kpi-dim__fill" style="width:${v}%;background:${kpiColor(v)}"></div></div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty-state"><p>No KPI data</p></div>`;

  modal.querySelector('#kdm-badges').innerHTML = achList.length > 0
    ? `<div class="badge-grid">${achList.map(a =>
        `<div class="badge-pill" style="color:${a.badge_color||'#7c5cfc'};border-color:${a.badge_color||'#7c5cfc'}44">
          <i class="fa-solid ${a.badge_icon||'fa-medal'}"></i> ${a.badge_name}
        </div>`).join('')}</div>`
    : `<div style="font-size:0.75rem;color:var(--text-muted)">No badges yet</div>`;

  modal.classList.add('open');
}

/* ─── Toast ──────────────────────────────────────────────────────────── */
function showToast(msg, type = 'info') {
  const icons = { success: 'fa-check-circle', error: 'fa-xmark-circle', info: 'fa-circle-info' };
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<i class="fa-solid ${icons[type]}" style="color:var(--${type === 'success' ? 'success' : type === 'error' ? 'danger' : 'accent'})"></i>${msg}`;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

/* ─── Slider Live Feedback ───────────────────────────────────────────── */
function sliderUpdate(id) {
  const el  = document.getElementById(id);
  const val = document.getElementById(id + '-val');
  if (el && val) val.textContent = el.value;
}

/* ─── Export ─────────────────────────────────────────────────────────── */
function exportEvaCSV() {
  if (!_activePeriod) return;
  const evaCalc = calcEVA(_activePeriod, _employees, _kpiScores);
  const rows = [['Name','Department','Overall KPI','EVA Weight','Individual Share','Collective Share','Total Share']];
  evaCalc.forEach(r => {
    rows.push([
      `${r.emp.first_name} ${r.emp.last_name}`,
      r.emp.department || '—',
      r.overall,
      r.weight,
      r.indivShare.toFixed(2),
      r.collectShare.toFixed(2),
      r.totalShare.toFixed(2)
    ]);
  });
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `eva-${_activePeriod.period_month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── Boot ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
