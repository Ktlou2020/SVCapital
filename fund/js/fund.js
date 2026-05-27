/* ═══════════════════════════════════════════════
   SV CAPITAL — Fund Management Tool JS
   ═══════════════════════════════════════════════ */
'use strict';

/* ─── BASE URL for API (fund/ subdir needs ../) ─── */
const BASE = '/api/';

/* ─── STATE ─── */
const S = {
  runs:         [],
  schedules:    [],
  investments:  [],
  investors:    [],
  pools:        [],
  allocations:  [],
  auditEvents:  [],
  currentView:  'dashboard',
  charts:       {},
  activeRunId:  null
};

/* ─── TOAST ─── */
const T = {
  _c: null,
  _init() { if (!this._c) { this._c = document.getElementById('toastBox') || document.body; } },
  show(msg, type='info') {
    this._init();
    const icons = { success:'fa-circle-check', error:'fa-circle-xmark', info:'fa-circle-info', warning:'fa-triangle-exclamation' };
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `<i class="fa-solid ${icons[type]||icons.info}"></i><span>${msg}</span>`;
    this._c.appendChild(el);
    setTimeout(() => { el.style.transition='0.3s'; el.style.opacity='0'; setTimeout(()=>el.remove(),300); }, 3600);
  },
  success(m){ this.show(m,'success'); },
  error(m)  { this.show(m,'error');   },
  info(m)   { this.show(m,'info');    },
  warn(m)   { this.show(m,'warning'); }
};

/* ─── MODAL ─── */
const M = {
  open(id)  { const e=document.getElementById(id); if(e){ e.classList.add('open'); document.body.style.overflow='hidden'; } },
  close(id) { const e=document.getElementById(id); if(e){ e.classList.remove('open'); document.body.style.overflow=''; } },
  closeAll(){ document.querySelectorAll('.overlay.open').forEach(e=>{ e.classList.remove('open'); }); document.body.style.overflow=''; }
};
document.addEventListener('keydown', e => { if(e.key==='Escape') M.closeAll(); });

/* ─── FORMATTERS ─── */
const fmt = {
  rand(v, d=0)  { if(v==null||isNaN(v))return'R 0'; return 'R '+Number(v).toLocaleString('en-ZA',{minimumFractionDigits:d,maximumFractionDigits:d}); },
  pct(v, d=2)   { if(v==null||isNaN(v))return'0%'; return (Number(v)*100).toFixed(d)+'%'; },
  date(v)       { if(!v) return '—'; try{ return new Date(v).toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'}); }catch{return v;} },
  days(d)       { return d+' day'+(d!==1?'s':''); },
  bps(v)        { return Math.round((v||0)*10000)+' bps'; },
  num(v)        { return Number(v||0).toLocaleString('en-ZA'); },
  initials(n)   { return (n||'?').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase(); }
};

/* ─── CALC ENGINE — core return math ─── */
const Calc = {
  /**
   * Simple interest: R = P × r × (days / 365)
   * Returns { grossReturn, netReturn, managementFee, performanceFee, totalPayout }
   */
  simpleReturn({ principal, annualRate, termDays, mgmtFeePct = 0.02, perfFeePct = 0.0 }) {
    const grossReturn     = principal * annualRate * (termDays / 365);
    const managementFee   = principal * mgmtFeePct * (termDays / 365);
    const performanceFee  = perfFeePct > 0 ? grossReturn * perfFeePct : 0;
    const totalFees       = managementFee + performanceFee;
    const netReturn       = Math.max(0, grossReturn - totalFees);
    const totalPayout     = principal + netReturn;
    return { grossReturn, managementFee, performanceFee, totalFees, netReturn, totalPayout };
  },

  /**
   * Compound interest: A = P(1 + r/n)^(n*t)
   * n = compounding frequency per year
   */
  compoundReturn({ principal, annualRate, termDays, compounds = 1, mgmtFeePct = 0.02, perfFeePct = 0.0 }) {
    const t = termDays / 365;
    const grossAmount  = principal * Math.pow(1 + annualRate / compounds, compounds * t);
    const grossReturn  = grossAmount - principal;
    const managementFee  = principal * mgmtFeePct * t;
    const performanceFee = perfFeePct > 0 ? grossReturn * perfFeePct : 0;
    const totalFees      = managementFee + performanceFee;
    const netReturn      = Math.max(0, grossReturn - totalFees);
    const totalPayout    = principal + netReturn;
    return { grossReturn, managementFee, performanceFee, totalFees, netReturn, totalPayout };
  },

  /** Effective annual rate from simple rate over term */
  effectiveAnnualRate(simpleRate, termDays) {
    return Math.pow(1 + simpleRate * (termDays / 365), 365 / termDays) - 1;
  },

  /** Days between two date strings */
  daysBetween(startStr, endStr) {
    const s = new Date(startStr), e = new Date(endStr);
    return Math.max(0, Math.round((e - s) / 86400000));
  },

  /** Pro-rate a partial term (for partial-period payouts) */
  proRate(annualRate, actualDays, contractDays) {
    return annualRate * (actualDays / contractDays);
  },

  /** Run-level: allocate returns to multiple investors */
  allocateRunReturns({ investors, actualRate, termDays, mgmtFeePct = 0.02, perfFeePct = 0.20 }) {
    return investors.map(inv => {
      const res = this.simpleReturn({
        principal: inv.capital,
        annualRate: actualRate,
        termDays,
        mgmtFeePct,
        perfFeePct
      });
      return {
        investor_id:   inv.investor_id,
        investor_name: inv.investor_name,
        capital:       inv.capital,
        rate:          actualRate,
        days:          termDays,
        gross_return:  res.grossReturn,
        management_fee:res.managementFee,
        performance_fee:res.performanceFee,
        net_return:    res.netReturn,
        payout_amount: res.totalPayout
      };
    });
  }
};

/* ═══════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════ */
function navigate(view, btnEl) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const viewEl = document.getElementById('view-'+view);
  if (viewEl) viewEl.classList.add('active');
  if (btnEl)  btnEl.classList.add('active');
  const titles = {
    dashboard:    'Dashboard',
    calculator:   'Return Calculator',
    runs:         'Fund Runs',
    schedules:    'Payout Schedules',
    pools:        'Pool Overview',
    reports:      'Reports & Analytics',
    intelligence: 'Fund Intelligence',
    forecast:     '12-Month Cash Flow Forecast',
    allocations:  'Investor Allocations',
    audit:        'Audit Trail',
    fees:         'Fee Ledger & Revenue',
    risk:         'Risk Dashboard',
    notifications:'Notification Centre'
  };
  const el = document.getElementById('topTitle');
  if (el) el.textContent = titles[view] || view;
  S.currentView = view;
  const loaders = {
    dashboard:    loadDashboard,
    calculator:   initCalculator,
    runs:         loadRuns,
    schedules:    loadSchedules,
    pools:        loadPools,
    reports:      loadReports,
    intelligence: loadIntelligence,
    forecast:     loadForecast,
    allocations:  loadAllocations,
    audit:        loadAuditTrail,
    fees:         loadFees,
    risk:         loadRiskDashboard,
    notifications:loadNotifications
  };
  if (loaders[view]) loaders[view]();
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  /* Check if a start-view was passed from test.html or a direct link */
  const startView = sessionStorage.getItem('fundStartView');
  if (startView) {
    sessionStorage.removeItem('fundStartView');
    navigate(startView);
  } else {
    await loadDashboard();
  }
  initCalculator();
  updateNotifBadges();
});

/* ═══════════════════════════════════════════════
   API HELPERS
═══════════════════════════════════════════════ */
/* Return the best available auth token — svc_token (JWT) first,
   then fall back to staffSession so PIN-login employees work too. */
function _getAuthToken() {
  const jwt = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token');
  if (jwt) return jwt;
  // staffSession doesn't carry a real JWT, but the svc_user SSO bridge has
  // the email so we can't issue a token client-side. Return null — the server
  // will see the cookie (httpOnly) set at JWT login time, which also works.
  return null;
}

async function apiFetch(path, opts={}) {
  const token = _getAuthToken();
  // Merge auth header with any caller-supplied headers
  opts.headers = Object.assign(
    token ? { Authorization: `Bearer ${token}` } : {},
    opts.headers || {}
  );
  opts.credentials = 'include'; // also send httpOnly cookie as fallback
  const r = await fetch(BASE + path, opts);
  if (r.status === 401) {
    // Session expired — send back to the correct login page
    let loginTarget = '/login.html';
    try { const s = JSON.parse(localStorage.getItem('staffSession') || 'null'); if (s && s.empId && s.expiresAt > Date.now()) loginTarget = '/team/login.html'; } catch (_) {}
    window.location.replace(loginTarget);
    throw new Error('Session expired');
  }
  if (!r.ok) throw new Error(`${opts.method||'GET'} ${path} → ${r.status}`);
  if (r.status === 204) return null;
  return r.json();
}
const apiGet    = (t,qs='') => apiFetch(`tables/${t}?limit=200${qs?'&'+qs:''}`).then(d=>d.data||[]);
const apiPost   = (t,b)     => apiFetch(`tables/${t}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b) });
const apiPatch  = (t,id,b)  => apiFetch(`tables/${t}/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b) });
const apiDelete = (t,id)    => apiFetch(`tables/${t}/${id}`, { method:'DELETE' });

/* ═══════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    const [runs, scheds, pools, investments] = await Promise.all([
      apiGet('fund_runs'),
      apiGet('return_schedules'),
      apiGet('investment_pools'),
      apiGet('investments')
    ]);
    S.runs        = runs;
    S.schedules   = scheds;
    S.pools       = pools;
    S.investments = investments;
    renderDashboard();
  } catch(e) {
    console.error('Dashboard error:', e);
    T.error('Failed to load dashboard');
  }
}

function renderDashboard() {
  const runs      = S.runs;
  const scheds    = S.schedules;
  const pools     = S.pools;
  const invests   = S.investments;

  const totalAUM         = invests.filter(i=>i.status==='active').reduce((s,i)=>s+(i.amount||0),0);
  const totalDeployed    = runs.filter(r=>r.status==='completed'||r.status==='in_progress').reduce((s,r)=>s+(r.capital_deployed||0),0);
  const totalGrossReturn = runs.filter(r=>r.status==='completed').reduce((s,r)=>s+(r.total_return_gross||0),0);
  const totalNetReturn   = runs.filter(r=>r.status==='completed').reduce((s,r)=>s+(r.total_return_net||0),0);
  const pendingPayouts   = scheds.filter(s=>s.status==='scheduled'||s.status==='processing').length;
  const completedRuns    = runs.filter(r=>r.status==='completed').length;
  const activeRuns       = runs.filter(r=>r.status==='in_progress').length;

  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('ds-aum',         fmt.rand(totalAUM));
  set('ds-deployed',    fmt.rand(totalDeployed));
  set('ds-gross-ret',   fmt.rand(totalGrossReturn));
  set('ds-net-ret',     fmt.rand(totalNetReturn));
  set('ds-pending',     pendingPayouts);
  set('ds-runs',        completedRuns);
  set('ds-active-runs', activeRuns);
  set('ds-pools',       pools.filter(p=>p.status==='open'||p.status==='active'||p.status==='filling').length);

  renderDashboardRunsTable();
  renderUpcomingPayoutsWidget();
  renderRunTypeChart();
  renderReturnsChart();
}

function renderDashboardRunsTable() {
  const el = document.getElementById('dashRunsBody');
  if (!el) return;
  const recent = S.runs.slice(0, 6);
  if (!recent.length) { el.innerHTML = `<tr><td colspan="6"><div class="empty"><i class="fa-solid fa-folder-open"></i><p>No fund runs yet</p></div></td></tr>`; return; }
  el.innerHTML = recent.map(r => `
    <tr class="row--clickable" onclick="viewRun('${r.id}')">
      <td><div class="td-h">${r.run_name}</div><div class="td-m">${r.id}</div></td>
      <td>${productBadge(r.product_type)}</td>
      <td class="td-gold">${fmt.rand(r.capital_deployed)}</td>
      <td>${r.actual_rate ? `<span class="td-green">${fmt.pct(r.actual_rate)}</span>` : `<span class="td-m">${fmt.pct(r.benchmark_rate)} bench</span>`}</td>
      <td class="td-green">${fmt.rand(r.total_return_net)}</td>
      <td>${runStatusBadge(r.status)}</td>
    </tr>
  `).join('');
}

function renderUpcomingPayoutsWidget() {
  const el = document.getElementById('upcomingPayoutsWidget');
  if (!el) return;
  const pending = S.schedules.filter(s=>s.status==='scheduled'||s.status==='processing').slice(0,5);
  if (!pending.length) {
    el.innerHTML = `<div class="empty" style="padding:24px"><i class="fa-solid fa-calendar-check"></i><p>No pending payouts</p></div>`;
    return;
  }
  el.innerHTML = pending.map(s=>`
    <div class="flex-b" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:0.82rem;font-weight:600;color:var(--text-h)">${s.investor_name}</div>
        <div style="font-size:0.72rem;color:var(--text-muted)">${s.pool_name} · ${fmt.date(s.scheduled_payout_date)}</div>
      </div>
      <div style="text-align:right">
        <div class="td-gold fw7" style="font-size:0.88rem">${fmt.rand(s.total_payout)}</div>
        <div style="font-size:0.68rem;color:var(--text-muted)">incl. ${fmt.rand(s.net_return)} return</div>
      </div>
    </div>
  `).join('');
}

function renderRunTypeChart() {
  const ctx = document.getElementById('runTypeChart');
  if (!ctx) return;
  const types = {};
  S.runs.forEach(r => { const t=r.product_type||'other'; types[t]=(types[t]||0)+1; });
  if (!Object.keys(types).length) return;
  const colors = { cattle:'#D4AF37', solar_7yr:'#22c55e', solar_6yr:'#16a34a', solar_5yr:'#15803d', short_term:'#3b82f6', delivery_bike:'#a855f7', other:'#94a3b8' };
  if (S.charts.runType) S.charts.runType.destroy();
  S.charts.runType = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(types).map(k=>k.replace(/_/g,' ')),
      datasets: [{ data: Object.values(types), backgroundColor: Object.keys(types).map(k=>colors[k]||'#94a3b8'), borderColor:'#fff', borderWidth:3 }]
    },
    options: { responsive:true, maintainAspectRatio:false, cutout:'68%', plugins:{ legend:{ position:'right', labels:{ color:'#64748b', font:{size:10}, boxWidth:10, padding:8 } } } }
  });
}

function renderReturnsChart() {
  const ctx = document.getElementById('returnsChart');
  if (!ctx) return;
  const completed = S.runs.filter(r=>r.status==='completed' && r.completed_date).sort((a,b)=>new Date(a.completed_date)-new Date(b.completed_date));
  if (completed.length < 2) return;
  const labels  = completed.map(r => r.run_name.split('—')[0].trim().slice(0,20)+'…');
  const gross   = completed.map(r => +(r.total_return_gross||0).toFixed(0));
  const net     = completed.map(r => +(r.total_return_net||0).toFixed(0));
  if (S.charts.returns) S.charts.returns.destroy();
  S.charts.returns = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Gross Return', data:gross, backgroundColor:'rgba(212,175,55,0.5)', borderColor:'#D4AF37', borderWidth:1.5, borderRadius:4 },
        { label:'Net Return',   data:net,   backgroundColor:'rgba(34,197,94,0.5)',  borderColor:'#22c55e', borderWidth:1.5, borderRadius:4 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'bottom', labels:{ color:'#64748b', font:{size:11}, boxWidth:10 } } },
      scales:{
        x:{ ticks:{ color:'#64748b', font:{size:10} }, grid:{ display:false } },
        y:{ ticks:{ color:'#64748b', font:{size:10}, callback:v=>'R'+Number(v).toLocaleString('en-ZA',{notation:'compact'}) }, grid:{ color:'rgba(0,0,0,0.05)' } }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   RETURN CALCULATOR
═══════════════════════════════════════════════ */
function initCalculator() {
  calcUpdate(); // run initial calculation with default values
}

function calcUpdate() {
  const principal  = parseFloat(document.getElementById('calcPrincipal')?.value)  || 100000;
  const annualRate = parseFloat(document.getElementById('calcRate')?.value)        / 100 || 0.1483;
  const termDays   = parseInt(document.getElementById('calcDays')?.value)          || 183;
  const mgmtFee    = parseFloat(document.getElementById('calcMgmtFee')?.value)     / 100 || 0.02;
  const perfFee    = parseFloat(document.getElementById('calcPerfFee')?.value)     / 100 || 0.0;
  const mode       = document.getElementById('calcMode')?.value                   || 'simple';

  let res;
  if (mode === 'compound') {
    const compounds = parseInt(document.getElementById('calcCompounds')?.value) || 1;
    res = Calc.compoundReturn({ principal, annualRate, termDays, compounds, mgmtFeePct: mgmtFee, perfFeePct: perfFee });
  } else {
    res = Calc.simpleReturn({ principal, annualRate, termDays, mgmtFeePct: mgmtFee, perfFeePct: perfFee });
  }

  const effRate = Calc.effectiveAnnualRate(annualRate, termDays);

  // Update result display
  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('calcGross',    fmt.rand(res.grossReturn, 2));
  set('calcNet',      fmt.rand(res.netReturn, 2));
  set('calcPayout',   fmt.rand(res.totalPayout, 2));
  set('calcMgmtFeeAmt',fmt.rand(res.managementFee, 2));
  set('calcPerfFeeAmt',fmt.rand(res.performanceFee, 2));
  set('calcTotalFees', fmt.rand(res.totalFees, 2));
  set('calcEffRate',   fmt.pct(effRate));
  set('calcNetRate',   fmt.pct(res.netReturn / principal * (365 / termDays)));
  set('calcDaysLabel', fmt.days(termDays));

  // Comparison to benchmark
  const benchRate = parseFloat(document.getElementById('calcBenchmark')?.value) / 100 || 0.1483;
  const benchRes  = Calc.simpleReturn({ principal, annualRate: benchRate, termDays, mgmtFeePct: mgmtFee, perfFeePct: perfFee });
  const outperform = res.netReturn - benchRes.netReturn;
  const cmpEl = document.getElementById('calcBenchComp');
  if (cmpEl) {
    if (Math.abs(outperform) < 1) {
      cmpEl.textContent = 'Return matches benchmark exactly';
      cmpEl.style.color = 'var(--text-muted)';
    } else if (outperform > 0) {
      cmpEl.innerHTML = `<i class="fa-solid fa-arrow-trend-up" style="color:var(--green)"></i> Outperforms benchmark by <strong style="color:var(--green)">${fmt.rand(outperform,2)}</strong> net (${fmt.bps(annualRate - benchRate)} above)`;
    } else {
      cmpEl.innerHTML = `<i class="fa-solid fa-arrow-trend-down" style="color:var(--red)"></i> Underperforms benchmark by <strong style="color:var(--red)">${fmt.rand(Math.abs(outperform),2)}</strong> net`;
    }
  }

  // Update schedule preview
  renderCalcSchedule(principal, annualRate, termDays, mgmtFee, perfFee);
}

function renderCalcSchedule(principal, rate, days, mgmtFee, perfFee) {
  const el = document.getElementById('calcScheduleBody');
  if (!el) return;

  // Build monthly schedule
  const rows = [];
  let d = 0;
  const step = Math.min(30, days);
  while (d < days) {
    const periodDays = Math.min(step, days - d);
    d += periodDays;
    const accrued = Calc.simpleReturn({ principal, annualRate: rate, termDays: d, mgmtFeePct: mgmtFee, perfFeePct: perfFee });
    rows.push({ period: `Day ${d}`, gross: accrued.grossReturn, net: accrued.netReturn, cumPayout: principal + accrued.netReturn });
  }

  el.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="td-m">${r.period}</td>
      <td class="td-gold">${fmt.rand(r.gross, 2)}</td>
      <td class="td-m">${fmt.rand(Calc.simpleReturn({principal,annualRate:rate,termDays:Math.min(30,days),mgmtFeePct:mgmtFee,perfFeePct:perfFee}).grossReturn * (i+1)/rows.length * 0 || (r.gross - (rows[i-1]?.gross||0)), 2)}</td>
      <td class="td-green">${fmt.rand(r.net, 2)}</td>
      <td class="td-h fw7">${fmt.rand(r.cumPayout, 2)}</td>
    </tr>
  `).join('');
}

function calcToggleCompounds(show) {
  const el = document.getElementById('calcCompoundsRow');
  if (el) el.style.display = show ? 'grid' : 'none';
}

/* ═══════════════════════════════════════════════
   FUND RUNS
═══════════════════════════════════════════════ */
async function loadRuns() {
  try {
    const [runs, pools] = await Promise.all([ apiGet('fund_runs'), apiGet('investment_pools') ]);
    S.runs  = runs;
    S.pools = pools;
    renderRunsView();
  } catch(e) { T.error('Failed to load fund runs'); }
}

function renderRunsView() {
  const el = document.getElementById('runsList');
  if (!el) return;

  const filter = document.getElementById('runStatusFilter')?.value || '';
  const search = document.getElementById('runSearch')?.value.toLowerCase() || '';

  let data = S.runs.slice();
  if (filter) data = data.filter(r => r.status === filter);
  if (search) data = data.filter(r => (r.run_name||'').toLowerCase().includes(search) || (r.pool_name||'').toLowerCase().includes(search));

  const footer = document.getElementById('runsCount');
  if (footer) footer.textContent = `${data.length} run${data.length!==1?'s':''}`;

  if (!data.length) {
    el.innerHTML = `<div class="empty"><i class="fa-solid fa-chart-bar"></i><p>No fund runs found</p><p class="hint">Create a new run to get started</p></div>`;
    return;
  }

  el.innerHTML = data.map(r => `
    <div class="run-card" onclick="viewRun('${r.id}')">
      <div class="run-card__top">
        <div>
          <div class="run-card__name">${r.run_name}</div>
          <div class="run-card__meta">${r.id} · ${fmt.date(r.start_date)} → ${fmt.date(r.end_date)} · ${fmt.days(r.term_days)}</div>
        </div>
        <div class="flex-c gap-8">
          ${productBadge(r.product_type)}
          ${runStatusBadge(r.status)}
          ${runTypeBadge(r.run_type)}
        </div>
      </div>
      <div class="run-card__metrics">
        <div class="run-metric">
          <div class="run-metric__label">Capital</div>
          <div class="run-metric__value" style="color:var(--gold)">${fmt.rand(r.capital_deployed)}</div>
        </div>
        <div class="run-metric">
          <div class="run-metric__label">Benchmark</div>
          <div class="run-metric__value">${fmt.pct(r.benchmark_rate)}</div>
        </div>
        <div class="run-metric">
          <div class="run-metric__label">Actual Rate</div>
          <div class="run-metric__value" style="color:${r.actual_rate>=r.benchmark_rate?'var(--green)':'var(--red)'}">${r.actual_rate ? fmt.pct(r.actual_rate) : '—'}</div>
        </div>
        <div class="run-metric">
          <div class="run-metric__label">Net Return</div>
          <div class="run-metric__value" style="color:var(--green)">${fmt.rand(r.total_return_net)}</div>
        </div>
        <div class="run-metric">
          <div class="run-metric__label">Investors</div>
          <div class="run-metric__value">${r.total_investors||0}</div>
        </div>
      </div>
    </div>
  `).join('');
}

function openNewRunModal() {
  // Pre-populate pool dropdown
  const sel = document.getElementById('newRunPool');
  if (sel) {
    sel.innerHTML = '<option value="">— Select pool —</option>' +
      S.pools.map(p => `<option value="${p.id}" data-rate="${p.benchmark_rate}" data-name="${p.pool_name}" data-type="${p.product_type}" data-investors="${p.investor_count||0}">${p.pool_name} (${fmt.pct(p.benchmark_rate)})</option>`).join('');
    sel.onchange = () => {
      const opt = sel.options[sel.selectedIndex];
      if (opt.dataset.rate) document.getElementById('newRunBenchmark').value = (parseFloat(opt.dataset.rate)*100).toFixed(4);
      if (opt.dataset.name) document.getElementById('newRunPoolName').value = opt.dataset.name;
      if (opt.dataset.type) document.getElementById('newRunType2').value = opt.dataset.type;
      if (opt.dataset.investors) document.getElementById('newRunInvestors').value = opt.dataset.investors;
    };
  }

  // Default dates
  const today = new Date().toISOString().split('T')[0];
  const sixM  = new Date(Date.now() + 183*86400000).toISOString().split('T')[0];
  document.getElementById('newRunStart').value = today;
  document.getElementById('newRunEnd').value   = sixM;
  calcNewRunDays();

  M.open('newRunModal');
}

function calcNewRunDays() {
  const s = document.getElementById('newRunStart')?.value;
  const e = document.getElementById('newRunEnd')?.value;
  if (s && e) {
    const d = Calc.daysBetween(s, e);
    const el = document.getElementById('newRunDaysDisplay');
    if (el) el.textContent = d + ' days';
  }
}

async function saveNewRun() {
  const poolId     = document.getElementById('newRunPool')?.value;
  const poolName   = document.getElementById('newRunPoolName')?.value.trim();
  const runName    = document.getElementById('newRunName')?.value.trim();
  const startDate  = document.getElementById('newRunStart')?.value;
  const endDate    = document.getElementById('newRunEnd')?.value;
  const capital    = parseFloat(document.getElementById('newRunCapital')?.value);
  const benchmark  = parseFloat(document.getElementById('newRunBenchmark')?.value) / 100;
  const runType    = document.getElementById('newRunRunType')?.value;
  const productType= document.getElementById('newRunType2')?.value;
  const investors  = parseInt(document.getElementById('newRunInvestors')?.value) || 0;
  const mgmtFee    = parseFloat(document.getElementById('newRunMgmtFee')?.value) / 100 || 0.02;
  const perfFee    = parseFloat(document.getElementById('newRunPerfFee')?.value) / 100 || 0.20;
  const notes      = document.getElementById('newRunNotes')?.value.trim();

  if (!runName || !startDate || !endDate || !capital || !benchmark) {
    T.error('Please fill in all required fields'); return;
  }

  const termDays = Calc.daysBetween(startDate, endDate);
  const payload = {
    id:                `RUN-${Date.now()}`,
    run_name:          runName,
    pool_id:           poolId || '',
    pool_name:         poolName || runName,
    product_type:      productType || 'other',
    run_type:          runType,
    status:            'draft',
    capital_deployed:  capital,
    benchmark_rate:    benchmark,
    actual_rate:       0,
    term_days:         termDays,
    start_date:        new Date(startDate).toISOString(),
    end_date:          new Date(endDate).toISOString(),
    total_return_gross:0, total_return_net:0,
    management_fee_pct: mgmtFee, management_fee_amount: 0,
    performance_fee_pct: perfFee, performance_fee_amount: 0,
    total_investors:   investors,
    investor_allocations: [],
    notes,
    created_by: 'Admin',
    completed_date: null
  };

  try {
    await apiPost('fund_runs', payload);
    await auditLog({
      eventType: 'fund_run', action: 'create',
      entityId: payload.id, entityName: payload.run_name,
      changeSummary: `New fund run created: ${payload.run_name} — ${fmt.rand(capital)} at ${(benchmark*100).toFixed(2)}% benchmark, ${termDays} days`,
      afterState: { status:'draft', capital_deployed: capital, benchmark_rate: benchmark },
      severity: 'info'
    });
    T.success('Fund run created successfully');
    M.close('newRunModal');
    await loadRuns();
  } catch(e) { T.error('Failed to create fund run'); }
}

function viewRun(runId) {
  const run = S.runs.find(r => r.id === runId);
  if (!run) return;
  S.activeRunId = runId;

  const isComplete = run.status === 'completed';
  const res = run.actual_rate > 0 ? Calc.simpleReturn({
    principal: run.capital_deployed, annualRate: run.actual_rate,
    termDays: run.term_days, mgmtFeePct: run.management_fee_pct || 0.02,
    perfFeePct: run.performance_fee_pct || 0.20
  }) : null;

  document.getElementById('runModalTitle').textContent = run.run_name;
  document.getElementById('runModalBody').innerHTML = `
    <div class="grid-2 mb-16">
      <div>
        <div class="info-list">
          <div class="info-row"><span class="info-row__k">Run ID</span><span class="info-row__v mono">${run.id}</span></div>
          <div class="info-row"><span class="info-row__k">Pool</span><span class="info-row__v">${run.pool_name||'—'}</span></div>
          <div class="info-row"><span class="info-row__k">Product</span><span class="info-row__v">${productBadge(run.product_type)}</span></div>
          <div class="info-row"><span class="info-row__k">Run Type</span><span class="info-row__v">${runTypeBadge(run.run_type)}</span></div>
          <div class="info-row"><span class="info-row__k">Status</span><span class="info-row__v">${runStatusBadge(run.status)}</span></div>
          <div class="info-row"><span class="info-row__k">Period</span><span class="info-row__v">${fmt.date(run.start_date)} → ${fmt.date(run.end_date)}</span></div>
          <div class="info-row"><span class="info-row__k">Term</span><span class="info-row__v">${fmt.days(run.term_days)}</span></div>
          <div class="info-row"><span class="info-row__k">Investors</span><span class="info-row__v">${run.total_investors||0}</span></div>
        </div>
      </div>
      <div>
        <div class="payout-summary">
          <div class="payout-summary__title">Financial Summary</div>
          <div class="payout-row"><span class="payout-row__k">Capital Deployed</span><span class="payout-row__v">${fmt.rand(run.capital_deployed)}</span></div>
          <div class="payout-row"><span class="payout-row__k">Benchmark Rate</span><span class="payout-row__v">${fmt.pct(run.benchmark_rate)}</span></div>
          <div class="payout-row"><span class="payout-row__k">Actual Rate</span><span class="payout-row__v" style="color:${run.actual_rate>0?(run.actual_rate>=run.benchmark_rate?'var(--green)':'var(--red)'):'rgba(255,255,255,0.4)'}">${run.actual_rate > 0 ? fmt.pct(run.actual_rate) : 'Not set'}</span></div>
          <div class="payout-row"><span class="payout-row__k">Gross Return</span><span class="payout-row__v">${fmt.rand(run.total_return_gross)}</span></div>
          <div class="payout-row"><span class="payout-row__k">Mgmt Fee (${fmt.pct(run.management_fee_pct||0.02)})</span><span class="payout-row__v">${fmt.rand(run.management_fee_amount)}</span></div>
          <div class="payout-row"><span class="payout-row__k">Perf Fee (${fmt.pct(run.performance_fee_pct||0.20)})</span><span class="payout-row__v">${fmt.rand(run.performance_fee_amount)}</span></div>
          <div class="payout-row payout-row--total"><span class="payout-row__k">Net Return to Investors</span><span class="payout-row__v">${fmt.rand(run.total_return_net)}</span></div>
        </div>
      </div>
    </div>

    ${run.notes ? `<div style="background:#f8fafc;border-radius:var(--radius);padding:14px;margin-bottom:16px;font-size:0.8rem;color:var(--text-muted)"><strong style="color:var(--text-h)">Notes:</strong> ${run.notes}</div>` : ''}

    <div class="flex-b mb-12">
      <div style="font-size:0.82rem;font-weight:700;color:var(--text-h)">Actions</div>
    </div>
    <div class="flex-c gap-8" style="flex-wrap:wrap">
      ${run.status === 'draft' ? `<button class="btn btn--teal btn--sm" onclick="startRun('${run.id}')"><i class="fa-solid fa-play"></i> Start Run</button>` : ''}
      ${run.status === 'in_progress' ? `
        <button class="btn btn--primary btn--sm" onclick="openCalculateReturnsModal('${run.id}')"><i class="fa-solid fa-calculator"></i> Calculate Returns</button>
        <button class="btn btn--success btn--sm" onclick="completeRun('${run.id}')"><i class="fa-solid fa-check"></i> Mark Complete</button>
      ` : ''}
      ${run.status === 'draft' || run.status === 'in_progress' ? `<button class="btn btn--secondary btn--sm" onclick="editRun('${run.id}')"><i class="fa-solid fa-pen"></i> Edit Run</button>` : ''}
      ${isComplete ? `<button class="btn btn--secondary btn--sm" onclick="exportRunReport('${run.id}')"><i class="fa-solid fa-file-arrow-down"></i> Export Report</button>` : ''}
      <button class="btn btn--danger btn--sm" onclick="deleteRun('${run.id}')"><i class="fa-solid fa-trash"></i> Delete</button>
    </div>
  `;

  M.open('runModal');
}

async function startRun(id) {
  if (!confirm('Start this fund run? Status will change to In Progress.')) return;
  try {
    await apiPatch('fund_runs', id, { status: 'in_progress' });
    T.success('Fund run started');
    M.closeAll();
    await loadRuns();
  } catch(e) { T.error('Failed to start run'); }
}

async function completeRun(id) {
  if (!confirm('Mark this fund run as completed? Make sure returns have been calculated first.')) return;
  try {
    await apiPatch('fund_runs', id, { status: 'completed', completed_date: new Date().toISOString() });
    T.success('Fund run marked as completed');
    M.closeAll();
    await loadRuns();
  } catch(e) { T.error('Failed to complete run'); }
}

async function deleteRun(id) {
  if (!confirm('Permanently delete this fund run? This cannot be undone.')) return;
  try {
    await apiDelete('fund_runs', id);
    T.success('Fund run deleted');
    M.closeAll();
    await loadRuns();
  } catch(e) { T.error('Failed to delete run'); }
}

/* ─── Calculate Returns Modal ─── */
function openCalculateReturnsModal(runId) {
  const run = S.runs.find(r => r.id === runId);
  if (!run) return;
  M.close('runModal');

  document.getElementById('calcRunTitle').textContent = `Calculate Returns — ${run.run_name}`;

  // Pre-fill
  const set = (id, v) => { const e=document.getElementById(id); if(e) e.value=v; };
  set('crCapital',   run.capital_deployed);
  set('crBenchmark', (run.benchmark_rate * 100).toFixed(4));
  set('crActualRate',(run.actual_rate > 0 ? run.actual_rate * 100 : run.benchmark_rate * 100).toFixed(4));
  set('crDays',      run.term_days);
  set('crMgmtFee',   ((run.management_fee_pct||0.02)*100).toFixed(2));
  set('crPerfFee',   ((run.performance_fee_pct||0.20)*100).toFixed(2));
  document.getElementById('crRunId').value = run.id;

  crUpdate();
  M.open('calcReturnsModal');
}

function crUpdate() {
  const principal   = parseFloat(document.getElementById('crCapital')?.value)    || 0;
  const actualRate  = parseFloat(document.getElementById('crActualRate')?.value) / 100 || 0;
  const benchRate   = parseFloat(document.getElementById('crBenchmark')?.value)  / 100 || 0;
  const termDays    = parseInt(document.getElementById('crDays')?.value)          || 0;
  const mgmtFee     = parseFloat(document.getElementById('crMgmtFee')?.value)    / 100 || 0.02;
  const perfFee     = parseFloat(document.getElementById('crPerfFee')?.value)    / 100 || 0.20;

  if (!principal || !actualRate || !termDays) return;

  const res   = Calc.simpleReturn({ principal, annualRate: actualRate, termDays, mgmtFeePct: mgmtFee, perfFeePct: perfFee });
  const bench = Calc.simpleReturn({ principal, annualRate: benchRate,  termDays, mgmtFeePct: mgmtFee, perfFeePct: perfFee });
  const alpha = res.netReturn - bench.netReturn;

  const set = (id, v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('crGross',    fmt.rand(res.grossReturn,2));
  set('crMgmtAmt',  fmt.rand(res.managementFee,2));
  set('crPerfAmt',  fmt.rand(res.performanceFee,2));
  set('crTotalFees',fmt.rand(res.totalFees,2));
  set('crNet',      fmt.rand(res.netReturn,2));
  set('crTotal',    fmt.rand(res.totalPayout,2));
  set('crAlpha',    (alpha >= 0 ? '+' : '') + fmt.rand(alpha,2) + ' vs benchmark');
  const alphaEl = document.getElementById('crAlpha');
  if (alphaEl) alphaEl.style.color = alpha >= 0 ? 'var(--green)' : 'var(--red)';
}

async function saveCalculatedReturns() {
  const runId     = document.getElementById('crRunId')?.value;
  const actualRate= parseFloat(document.getElementById('crActualRate')?.value) / 100;
  const capital   = parseFloat(document.getElementById('crCapital')?.value);
  const termDays  = parseInt(document.getElementById('crDays')?.value);
  const mgmtFee   = parseFloat(document.getElementById('crMgmtFee')?.value) / 100;
  const perfFee   = parseFloat(document.getElementById('crPerfFee')?.value) / 100;

  const res = Calc.simpleReturn({ principal: capital, annualRate: actualRate, termDays, mgmtFeePct: mgmtFee, perfFeePct: perfFee });

  const run = S.runs.find(r => r.id === runId);
  try {
    await apiPatch('fund_runs', runId, {
      actual_rate:           actualRate,
      total_return_gross:    +res.grossReturn.toFixed(2),
      total_return_net:      +res.netReturn.toFixed(2),
      management_fee_amount: +res.managementFee.toFixed(2),
      performance_fee_amount:+res.performanceFee.toFixed(2),
      management_fee_pct:    mgmtFee,
      performance_fee_pct:   perfFee
    });
    await auditLog({
      eventType: 'fund_run', action: 'calculate_returns',
      entityId: runId, entityName: run?.run_name || runId,
      changeSummary: `Returns calculated: ${run?.run_name||runId} — ${(actualRate*100).toFixed(2)}% actual rate, gross ${fmt.rand(res.grossReturn)}, net ${fmt.rand(res.netReturn)}`,
      beforeState: { actual_rate: run?.actual_rate||0, total_return_net: run?.total_return_net||0 },
      afterState:  { actual_rate: actualRate, total_return_gross: res.grossReturn, total_return_net: res.netReturn },
      severity: 'info'
    });
    T.success('Returns calculated and saved to fund run');
    M.close('calcReturnsModal');
    await loadRuns();
  } catch(e) { T.error('Failed to save returns'); }
}

function editRun(runId) {
  const run = S.runs.find(r => r.id === runId);
  if (!run) return;
  M.close('runModal');

  const set = (id, v) => { const e=document.getElementById(id); if(e) e.value=v||''; };
  set('editRunId',       run.id);
  set('editRunName',     run.run_name);
  set('editRunCapital',  run.capital_deployed);
  set('editRunBenchmark',(run.benchmark_rate*100).toFixed(4));
  set('editRunDays',     run.term_days);
  set('editRunMgmt',     ((run.management_fee_pct||0.02)*100).toFixed(2));
  set('editRunPerf',     ((run.performance_fee_pct||0.20)*100).toFixed(2));
  set('editRunInvestors',run.total_investors||0);
  set('editRunNotes',    run.notes||'');
  const sEl = document.getElementById('editRunStatus');
  if (sEl) sEl.value = run.status;

  M.open('editRunModal');
}

async function saveEditRun() {
  const id = document.getElementById('editRunId')?.value;
  if (!id) return;
  const before = S.runs.find(r => r.id === id);
  const updates = {
    run_name:            document.getElementById('editRunName')?.value.trim(),
    capital_deployed:    parseFloat(document.getElementById('editRunCapital')?.value)||0,
    benchmark_rate:      parseFloat(document.getElementById('editRunBenchmark')?.value)/100||0,
    term_days:           parseInt(document.getElementById('editRunDays')?.value)||0,
    management_fee_pct:  parseFloat(document.getElementById('editRunMgmt')?.value)/100||0.02,
    performance_fee_pct: parseFloat(document.getElementById('editRunPerf')?.value)/100||0.20,
    total_investors:     parseInt(document.getElementById('editRunInvestors')?.value)||0,
    status:              document.getElementById('editRunStatus')?.value,
    notes:               document.getElementById('editRunNotes')?.value.trim()
  };
  if (!updates.run_name) { T.error('Run name is required'); return; }
  try {
    await apiPatch('fund_runs', id, updates);
    const statusChanged = before && before.status !== updates.status;
    await auditLog({
      eventType: 'fund_run',
      action: statusChanged ? 'status_change' : 'update',
      entityId: id, entityName: updates.run_name,
      changeSummary: statusChanged
        ? `Fund run status changed: ${before.status} → ${updates.status} — ${updates.run_name}`
        : `Fund run updated: ${updates.run_name} — capital ${fmt.rand(updates.capital_deployed)}, ${(updates.benchmark_rate*100).toFixed(2)}% benchmark`,
      beforeState: before ? { status: before.status, capital_deployed: before.capital_deployed } : null,
      afterState:  { status: updates.status, capital_deployed: updates.capital_deployed },
      severity: statusChanged ? 'warning' : 'info'
    });
    T.success('Fund run updated');
    M.close('editRunModal');
    await loadRuns();
  } catch(e) { T.error('Failed to update run'); }
}

function exportRunReport(runId) {
  const run = S.runs.find(r => r.id === runId);
  if (!run) return;
  const content = [
    `SV CAPITAL — FUND RUN REPORT`,
    `Generated: ${new Date().toLocaleString('en-ZA')}`,
    `=`.repeat(60),
    `Run: ${run.run_name}`,
    `ID: ${run.id}`,
    `Pool: ${run.pool_name}`,
    `Product: ${run.product_type}`,
    `Type: ${run.run_type}`,
    `Status: ${run.status}`,
    `Period: ${fmt.date(run.start_date)} to ${fmt.date(run.end_date)} (${run.term_days} days)`,
    ``,
    `FINANCIAL SUMMARY`,
    `-`.repeat(40),
    `Capital Deployed:       ${fmt.rand(run.capital_deployed)}`,
    `Benchmark Rate:         ${fmt.pct(run.benchmark_rate)} p.a.`,
    `Actual Rate:            ${run.actual_rate > 0 ? fmt.pct(run.actual_rate) + ' p.a.' : 'N/A'}`,
    `Gross Return:           ${fmt.rand(run.total_return_gross)}`,
    `Management Fee (${fmt.pct(run.management_fee_pct||0.02)}): ${fmt.rand(run.management_fee_amount)}`,
    `Performance Fee (${fmt.pct(run.performance_fee_pct||0.20)}):${fmt.rand(run.performance_fee_amount)}`,
    `Net Return to Investors:${fmt.rand(run.total_return_net)}`,
    `Total Investors:        ${run.total_investors}`,
    ``,
    `NOTES`,
    `-`.repeat(40),
    run.notes || 'None',
    ``,
    `=`.repeat(60),
    `SV Capital · FSP #52449 · FSCA Regulated`
  ].join('\n');

  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `SVC-FundRun-${run.id}.txt`; a.click();
  URL.revokeObjectURL(url);
  T.success('Report exported');
}

/* ═══════════════════════════════════════════════
   PAYOUT SCHEDULES
═══════════════════════════════════════════════ */
async function loadSchedules() {
  try {
    const scheds = await apiGet('return_schedules');
    S.schedules = scheds;
    renderScheduleStats();
    renderSchedulesTable();
    setupScheduleFilters();
  } catch(e) { T.error('Failed to load schedules'); }
}

function renderScheduleStats() {
  const s = S.schedules;
  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('sched-total',      s.length);
  set('sched-scheduled',  s.filter(x=>x.status==='scheduled').length);
  set('sched-processing', s.filter(x=>x.status==='processing').length);
  set('sched-paid',       s.filter(x=>x.status==='paid').length);
  set('sched-total-payout', fmt.rand(s.filter(x=>x.status==='scheduled'||x.status==='processing').reduce((t,x)=>t+(x.total_payout||0),0)));
}

function renderSchedulesTable(filterStatus='', searchQ='') {
  const el = document.getElementById('schedsBody');
  if (!el) return;

  let data = S.schedules.slice().sort((a,b) => new Date(a.scheduled_payout_date||0) - new Date(b.scheduled_payout_date||0));
  if (filterStatus) data = data.filter(s => s.status === filterStatus);
  if (searchQ) { const q=searchQ.toLowerCase(); data=data.filter(s=>(s.investor_name||'').toLowerCase().includes(q)||(s.pool_name||'').toLowerCase().includes(q)); }

  if (!data.length) {
    el.innerHTML = `<tr><td colspan="9"><div class="empty"><i class="fa-solid fa-calendar"></i><p>No payout schedules found</p></div></td></tr>`;
    return;
  }
  el.innerHTML = data.map(s => `
    <tr>
      <td><div class="td-h">${s.investor_name}</div></td>
      <td class="td-m">${s.pool_name}</td>
      <td>${productBadge(s.product_type)}</td>
      <td class="td-gold">${fmt.rand(s.capital_amount)}</td>
      <td class="td-orange">${fmt.pct(s.annual_rate)}</td>
      <td class="td-green">${fmt.rand(s.net_return)}</td>
      <td class="td-h fw7" style="color:var(--teal)">${fmt.rand(s.total_payout)}</td>
      <td class="td-m">${fmt.date(s.scheduled_payout_date)}</td>
      <td>
        <div class="flex-c gap-6">
          ${schedStatusBadge(s.status)}
          ${s.status==='scheduled' ? `<button class="btn btn--xs btn--teal" onclick="markSchedPaid('${s.id}')"><i class="fa-solid fa-check"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function setupScheduleFilters() {
  const searchEl = document.getElementById('schedSearch');
  const filterEl = document.getElementById('schedFilter');
  if (searchEl && !searchEl._wired) {
    searchEl.addEventListener('input', () => setTimeout(()=>renderSchedulesTable(filterEl?.value||'', searchEl.value.trim()), 180));
    searchEl._wired = true;
  }
  if (filterEl && !filterEl._wired) {
    filterEl.addEventListener('change', () => renderSchedulesTable(filterEl.value, searchEl?.value.trim()||''));
    filterEl._wired = true;
  }
}

async function markSchedPaid(schedId) {
  if (!confirm('Mark this payout schedule as paid?')) return;
  const sched = S.schedules.find(s => s.id === schedId);
  try {
    await apiPatch('return_schedules', schedId, { status:'paid', actual_payout_date: new Date().toISOString() });
    await auditLog({
      eventType: 'schedule', action: 'mark_paid',
      entityId: schedId, entityName: sched ? `${sched.investor_name} — ${sched.pool_name}` : schedId,
      changeSummary: sched ? `Payout marked as paid: ${sched.investor_name} — ${fmt.rand(sched.total_payout)} disbursed from ${sched.pool_name}` : `Payout schedule ${schedId} marked as paid`,
      beforeState: { status: 'scheduled' }, afterState: { status: 'paid', actual_payout_date: new Date().toISOString() },
      severity: 'info'
    });
    T.success('Payout marked as paid');
    await loadSchedules();
  } catch(e) { T.error('Failed to update schedule'); }
}

/* ═══════════════════════════════════════════════
   POOLS OVERVIEW
═══════════════════════════════════════════════ */
async function loadPools() {
  try {
    const pools = await apiGet('investment_pools');
    S.pools = pools;
    renderPoolsOverview();
  } catch(e) { T.error('Failed to load pools'); }
}

function renderPoolsOverview() {
  const el = document.getElementById('poolsOverviewBody');
  if (!el) return;

  if (!S.pools.length) {
    el.innerHTML = `<tr><td colspan="8"><div class="empty"><i class="fa-solid fa-layer-group"></i><p>No pools found</p></div></td></tr>`;
    return;
  }

  el.innerHTML = S.pools.map(p => {
    const fillPct = p.target_amount > 0 ? Math.min(100, Math.round((p.raised_amount||0)/p.target_amount*100)) : 0;
    return `<tr>
      <td><div class="td-h">${p.pool_name}</div><div class="td-m mono">${p.id}</div></td>
      <td>${productBadge(p.product_type)}</td>
      <td class="td-gold">${fmt.rand(p.raised_amount||0)}</td>
      <td class="td-m">${fmt.rand(p.target_amount||0)}</td>
      <td>
        <div style="min-width:80px">
          <div class="progress-bar"><div class="progress-fill" style="width:${fillPct}%"></div></div>
          <div style="font-size:0.68rem;color:var(--text-muted);text-align:right">${fillPct}%</div>
        </div>
      </td>
      <td><span class="td-orange">${fmt.pct(p.benchmark_rate)}</span></td>
      <td class="td-m">${p.investor_count||0} investors</td>
      <td>
        <div class="flex-c gap-6">
          ${poolStatusBadge(p.status)}
          <button class="btn btn--xs btn--primary" onclick="openNewRunFromPool('${p.id}')"><i class="fa-solid fa-plus"></i> New Run</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openNewRunFromPool(poolId) {
  const pool = S.pools.find(p => p.id === poolId);
  navigate('runs', document.querySelector('[data-view=runs]'));
  setTimeout(() => {
    openNewRunModal();
    const sel = document.getElementById('newRunPool');
    if (sel && pool) {
      sel.value = pool.id;
      sel.dispatchEvent(new Event('change'));
    }
  }, 100);
}

/* ═══════════════════════════════════════════════
   REPORTS & ANALYTICS
═══════════════════════════════════════════════ */
async function loadReports() {
  try {
    if (!S.runs.length) await loadDashboard();
    renderReportsSummary();
    renderProductPerformanceChart();
    renderRateComparisonTable();
  } catch(e) { T.error('Failed to load reports'); }
}

function renderReportsSummary() {
  const completed = S.runs.filter(r => r.status === 'completed');
  const totalCap  = completed.reduce((s,r) => s+(r.capital_deployed||0), 0);
  const totalGross= completed.reduce((s,r) => s+(r.total_return_gross||0), 0);
  const totalNet  = completed.reduce((s,r) => s+(r.total_return_net||0), 0);
  const avgRate   = completed.length ? completed.reduce((s,r)=>s+(r.actual_rate||0),0)/completed.length : 0;
  const avgAlpha  = completed.filter(r=>r.actual_rate>0).map(r=>r.actual_rate-r.benchmark_rate);
  const meanAlpha = avgAlpha.length ? avgAlpha.reduce((s,v)=>s+v,0)/avgAlpha.length : 0;

  const set=(id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('rpt-runs',        completed.length);
  set('rpt-capital',     fmt.rand(totalCap));
  set('rpt-gross',       fmt.rand(totalGross));
  set('rpt-net',         fmt.rand(totalNet));
  set('rpt-avg-rate',    fmt.pct(avgRate));
  set('rpt-avg-alpha',   (meanAlpha>=0?'+':'')+fmt.bps(meanAlpha)+' avg');
  set('rpt-fee-income',  fmt.rand(completed.reduce((s,r)=>s+(r.management_fee_amount||0)+(r.performance_fee_amount||0),0)));
}

function renderProductPerformanceChart() {
  const ctx = document.getElementById('productPerfChart');
  if (!ctx) return;
  const byProduct = {};
  S.runs.filter(r=>r.status==='completed'&&r.actual_rate>0).forEach(r => {
    const t = r.product_type||'other';
    if (!byProduct[t]) byProduct[t] = { bench:[], actual:[], net:[] };
    byProduct[t].bench.push(r.benchmark_rate);
    byProduct[t].actual.push(r.actual_rate);
    byProduct[t].net.push(r.total_return_net||0);
  });
  const labels  = Object.keys(byProduct).map(k=>k.replace(/_/g,' '));
  const avgBench = Object.values(byProduct).map(v => v.bench.reduce((s,x)=>s+x,0)/v.bench.length);
  const avgActual= Object.values(byProduct).map(v => v.actual.reduce((s,x)=>s+x,0)/v.actual.length);
  if (!labels.length) return;
  if (S.charts.prodPerf) S.charts.prodPerf.destroy();
  S.charts.prodPerf = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Avg Benchmark', data: avgBench.map(v=>+(v*100).toFixed(4)), backgroundColor:'rgba(100,116,139,0.3)', borderColor:'#64748b', borderWidth:1.5, borderRadius:4 },
        { label:'Avg Actual',    data: avgActual.map(v=>+(v*100).toFixed(4)), backgroundColor:'rgba(34,197,94,0.4)', borderColor:'#22c55e', borderWidth:1.5, borderRadius:4 }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'bottom', labels:{ color:'#64748b', font:{size:11}, boxWidth:10 } } },
      scales:{
        x:{ ticks:{ color:'#64748b' }, grid:{ display:false } },
        y:{ ticks:{ color:'#64748b', callback:v=>v.toFixed(2)+'%' }, grid:{ color:'rgba(0,0,0,0.05)' } }
      }
    }
  });
}

function renderRateComparisonTable() {
  const el = document.getElementById('rateCompBody');
  if (!el) return;
  const rows = S.runs.filter(r=>r.status==='completed').map(r => ({
    name: r.run_name,
    product: r.product_type,
    bench: r.benchmark_rate,
    actual: r.actual_rate,
    alpha: (r.actual_rate||0) - (r.benchmark_rate||0),
    netRet: r.total_return_net,
    cap: r.capital_deployed,
    days: r.term_days
  }));
  if (!rows.length) { el.innerHTML=`<tr><td colspan="7" class="text-center td-m" style="padding:24px">No completed runs yet</td></tr>`; return; }
  el.innerHTML = rows.map(r => `
    <tr>
      <td><div class="td-h" style="font-size:0.79rem">${r.name}</div></td>
      <td>${productBadge(r.product)}</td>
      <td class="td-m">${fmt.pct(r.bench)}</td>
      <td class="${r.actual>=r.bench?'td-green':'td-red'}">${fmt.pct(r.actual)}</td>
      <td class="${r.alpha>=0?'td-green':'td-red'} fw7">${r.alpha>=0?'+':''}${fmt.bps(r.alpha)}</td>
      <td class="td-teal">${fmt.rand(r.netRet)}</td>
      <td class="td-m">${fmt.days(r.days)}</td>
    </tr>
  `).join('');
}

/* ═══════════════════════════════════════════════
   BADGE HELPERS
═══════════════════════════════════════════════ */
function productBadge(type) {
  const map = {
    cattle:       ['badge--gold',   'fa-cow',         'Cattle'],
    solar_7yr:    ['badge--green',  'fa-solar-panel', 'Solar 7yr'],
    solar_6yr:    ['badge--green',  'fa-solar-panel', 'Solar 6yr'],
    solar_5yr:    ['badge--green',  'fa-solar-panel', 'Solar 5yr'],
    short_term:   ['badge--blue',   'fa-bolt',        'Short-Term'],
    delivery_bike:['badge--purple', 'fa-bicycle',     'Delivery Bike'],
  };
  const [cls, icon, label] = map[type] || ['badge--gray', 'fa-circle', type||'Unknown'];
  return `<span class="badge ${cls}"><i class="fa-solid ${icon}"></i> ${label}</span>`;
}

function runStatusBadge(status) {
  const map = { draft:'badge--gray', scheduled:'badge--blue', in_progress:'badge--orange', completed:'badge--green', cancelled:'badge--red' };
  return `<span class="badge ${map[status]||'badge--gray'}">${(status||'').replace(/_/g,' ')}</span>`;
}

function runTypeBadge(type) {
  const map = { return_calculation:'badge--teal', payout_processing:'badge--gold', reinvestment:'badge--purple', partial_payout:'badge--orange' };
  return `<span class="badge ${map[type]||'badge--gray'}">${(type||'').replace(/_/g,' ')}</span>`;
}

function poolStatusBadge(status) {
  const map = { open:'badge--teal', filling:'badge--blue', active:'badge--gold', matured:'badge--purple', paid_out:'badge--gray', closed:'badge--gray' };
  return `<span class="badge ${map[status]||'badge--gray'}">${status||''}</span>`;
}

function schedStatusBadge(status) {
  const map = { scheduled:'badge--blue', processing:'badge--orange', paid:'badge--green', cancelled:'badge--red' };
  return `<span class="badge ${map[status]||'badge--gray'}">${status||''}</span>`;
}

/* ─── Search wiring for runs ─── */
function setupRunFilters() {
  const searchEl = document.getElementById('runSearch');
  const filterEl = document.getElementById('runStatusFilter');
  if (searchEl && !searchEl._wired) { searchEl.addEventListener('input', ()=>setTimeout(renderRunsView,180)); searchEl._wired=true; }
  if (filterEl && !filterEl._wired) { filterEl.addEventListener('change', renderRunsView); filterEl._wired=true; }
}

/* ═══════════════════════════════════════════════════════════════
   P1.1 — AUDIT TRAIL ENGINE
   Immutable compliance log for all state-changing operations
═══════════════════════════════════════════════════════════════ */

/** Write an audit event — call after every state-changing API call */
async function auditLog({ eventType, action, entityId, entityName, changeSummary, beforeState = null, afterState = null, severity = 'info' }) {
  try {
    await apiPost('audit_events', {
      id:             `AUD-${Date.now()}`,
      event_type:     eventType,
      action,
      entity_id:      entityId || '',
      entity_name:    entityName || '',
      actor:          'Fund Manager',
      actor_role:     'director',
      before_state:   beforeState ? JSON.stringify(beforeState) : null,
      after_state:    afterState  ? JSON.stringify(afterState)  : null,
      change_summary: changeSummary,
      ip_address:     '127.0.0.1',
      severity,
      event_at:       new Date().toISOString()
    });
  } catch(e) {
    console.warn('Audit log write failed (non-blocking):', e.message);
  }
}

async function loadAuditTrail() {
  const el = document.getElementById('auditBody');
  if (el) el.innerHTML = `<tr><td colspan="8"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading audit events…</p></div></td></tr>`;
  try {
    const all = await intFetchAll('audit_events');
    // Sort newest first
    S.auditEvents = all.sort((a, b) => new Date(b.event_at || b.created_at) - new Date(a.event_at || a.created_at));
    renderAuditStats();
    renderAuditTable();
    // Show critical badge
    const critCount = S.auditEvents.filter(e => e.severity === 'critical').length;
    const badge = document.getElementById('criticalAuditBadge');
    if (badge) { badge.style.display = critCount > 0 ? 'inline-flex' : 'none'; badge.textContent = critCount; }
  } catch(e) {
    T.error('Failed to load audit trail');
    if (el) el.innerHTML = `<tr><td colspan="8"><div class="empty" style="color:#f87171"><i class="fa-solid fa-circle-exclamation"></i><p>Failed to load</p></div></td></tr>`;
  }
}

function renderAuditStats() {
  const evts  = S.auditEvents || [];
  const today = new Date().toDateString();
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('aud-total',    evts.length);
  set('aud-today',    evts.filter(e => new Date(e.event_at || e.created_at).toDateString() === today).length);
  set('aud-warnings', evts.filter(e => e.severity === 'warning').length);
  set('aud-critical', evts.filter(e => e.severity === 'critical').length);
}

function renderAuditTable() {
  const el = document.getElementById('auditBody');
  if (!el) return;
  const search   = document.getElementById('audSearch')?.value.toLowerCase() || '';
  const typeF    = document.getElementById('audTypeFilter')?.value || '';
  const sevF     = document.getElementById('audSeverityFilter')?.value || '';

  let data = (S.auditEvents || []).slice();
  if (typeF)   data = data.filter(e => e.event_type === typeF);
  if (sevF)    data = data.filter(e => e.severity === sevF);
  if (search)  data = data.filter(e =>
    (e.change_summary||'').toLowerCase().includes(search) ||
    (e.entity_name||'').toLowerCase().includes(search) ||
    (e.actor||'').toLowerCase().includes(search) ||
    (e.entity_id||'').toLowerCase().includes(search)
  );

  if (!data.length) {
    el.innerHTML = `<tr><td colspan="8"><div class="empty"><i class="fa-solid fa-shield-check"></i><p>No matching audit events</p></div></td></tr>`;
    return;
  }

  const sevColors = { info:'#2dd4bf', warning:'#fb923c', critical:'#f87171' };
  const sevIcons  = { info:'fa-circle-info', warning:'fa-triangle-exclamation', critical:'fa-circle-xmark' };
  const typeIcons = { fund_run:'fa-play-circle', solar_project:'fa-solar-panel', loan:'fa-hand-holding-dollar', cattle:'fa-cow', pool:'fa-layer-group', schedule:'fa-calendar-days', auth:'fa-key', system:'fa-robot' };
  const actionColors = { create:'#74c69d', update:'#fbbf24', delete:'#f87171', status_change:'#60a5fa', approve:'#74c69d', reject:'#f87171', export:'#a78bfa', login:'#2dd4bf', logout:'rgba(255,255,255,.4)', mark_paid:'#74c69d', calculate_returns:'#fbbf24' };

  el.innerHTML = data.map(e => {
    const ts   = e.event_at || e.created_at;
    const dtStr = ts ? new Date(ts).toLocaleString('en-ZA', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const sev  = e.severity || 'info';
    const col  = sevColors[sev] || '#2dd4bf';
    const aCol = actionColors[e.action] || 'rgba(255,255,255,.6)';
    const hasDetail = e.before_state || e.after_state;
    return `
    <tr>
      <td><span class="td-m" style="font-size:11px;white-space:nowrap">${dtStr}</span></td>
      <td><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:${col}"><i class="fa-solid ${sevIcons[sev]||'fa-circle-info'}"></i>${sev.toUpperCase()}</span></td>
      <td><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:rgba(255,255,255,.6)"><i class="fa-solid ${typeIcons[e.event_type]||'fa-circle'}" style="width:12px"></i>${(e.event_type||'').replace(/_/g,' ')}</span></td>
      <td><span style="font-size:11px;font-weight:700;color:${aCol};text-transform:uppercase;letter-spacing:.4px">${(e.action||'').replace(/_/g,' ')}</span></td>
      <td><div class="td-h" style="font-size:12px">${e.entity_name||'—'}</div><div class="td-m" style="font-size:10px">${e.entity_id||''}</div></td>
      <td><span style="font-size:12px;color:rgba(255,255,255,.75)">${e.actor||'—'}</span><br><span style="font-size:10px;color:rgba(255,255,255,.3)">${e.actor_role||''}</span></td>
      <td style="max-width:300px"><span style="font-size:12px;color:rgba(255,255,255,.7);line-height:1.4">${e.change_summary||'—'}</span></td>
      <td>${hasDetail ? `<button class="btn btn--xs btn--secondary" onclick="viewAuditDetail('${e.id}')"><i class="fa-solid fa-eye"></i></button>` : '<span style="color:rgba(255,255,255,.2);font-size:11px">—</span>'}</td>
    </tr>`;
  }).join('');
}

function viewAuditDetail(eventId) {
  const e = (S.auditEvents || []).find(x => x.id === eventId);
  if (!e) return;
  const before = e.before_state ? JSON.parse(e.before_state) : null;
  const after  = e.after_state  ? JSON.parse(e.after_state)  : null;
  const fmt2 = obj => obj ? `<pre style="background:rgba(255,255,255,.05);border-radius:8px;padding:12px;font-size:11px;color:#e2e8f0;white-space:pre-wrap;margin:0;max-height:200px;overflow-y:auto">${JSON.stringify(obj, null, 2)}</pre>` : '<span style="color:rgba(255,255,255,.3);font-size:12px">No state snapshot</span>';

  // Inject a lightbox-style modal
  let modal = document.getElementById('auditDetailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'auditDetailModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.addEventListener('click', ev => { if (ev.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
  <div style="background:#131720;border:1px solid rgba(255,255,255,.12);border-radius:16px;width:100%;max-width:640px;max-height:85vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.6)">
    <div style="padding:18px 22px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:15px;font-weight:800;color:#fff"><i class="fa-solid fa-shield-check" style="color:var(--teal);margin-right:8px"></i>Audit Event Detail</div>
      <button onclick="document.getElementById('auditDetailModal').remove()" style="background:rgba(255,255,255,.08);border:none;color:rgba(255,255,255,.6);width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:13px"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div style="padding:22px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">
        <div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Event ID</div><div style="font-size:13px;font-weight:700;color:#fff;font-family:monospace">${e.id}</div></div>
        <div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Timestamp</div><div style="font-size:13px;color:#fff">${new Date(e.event_at||e.created_at).toLocaleString('en-ZA')}</div></div>
        <div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">Actor</div><div style="font-size:13px;color:#fff">${e.actor} <span style="color:rgba(255,255,255,.35);font-size:11px">(${e.actor_role})</span></div></div>
        <div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px">IP Address</div><div style="font-size:13px;color:#fff;font-family:monospace">${e.ip_address||'—'}</div></div>
      </div>
      <div style="margin-bottom:14px"><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Change Summary</div><div style="font-size:13px;color:rgba(255,255,255,.8);line-height:1.5;background:rgba(255,255,255,.04);padding:10px 12px;border-radius:8px">${e.change_summary}</div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Before State</div>${fmt2(before)}</div>
        <div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">After State</div>${fmt2(after)}</div>
      </div>
    </div>
  </div>`;
}

function exportAuditLog() {
  const evts = S.auditEvents || [];
  const header = ['ID','Timestamp','Severity','Type','Action','Entity ID','Entity Name','Actor','Role','Summary','IP'];
  const rows = evts.map(e => [
    e.id, e.event_at||'', e.severity||'', e.event_type||'', e.action||'',
    e.entity_id||'', (e.entity_name||'').replace(/,/g,';'),
    e.actor||'', e.actor_role||'',
    (e.change_summary||'').replace(/,/g,';'), e.ip_address||''
  ].join(','));
  const csv  = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url; a.download = `SVC-AuditLog-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
  T.success('Audit log exported');
  auditLog({ eventType:'system', action:'export', entityId:'audit_log', entityName:'Audit Trail', changeSummary:`Audit log exported to CSV (${evts.length} events)`, severity:'info' });
}

/* ═══════════════════════════════════════════════════════════════
   P1.2 — INVESTOR ↔ FUND ALLOCATIONS ENGINE
═══════════════════════════════════════════════════════════════ */
async function loadAllocations() {
  const el = document.getElementById('allocBody');
  if (el) el.innerHTML = `<tr><td colspan="9"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading allocations…</p></div></td></tr>`;
  try {
    S.allocations = await intFetchAll('investor_allocations');
    renderAllocationsKPIs();
    renderAllocationsView();
    renderAllocByInvestor();
  } catch(e) {
    T.error('Failed to load allocations');
  }
}

function renderAllocationsKPIs() {
  const a = S.allocations || [];
  const uniqueInvestors = new Set(a.map(x => x.investor_id)).size;
  const totalCapital    = a.reduce((s, x) => s + (parseFloat(x.capital_paid)||0), 0);
  const totalExpected   = a.reduce((s, x) => s + (parseFloat(x.expected_payout)||0), 0);
  const maturedCount    = a.filter(x => x.status === 'matured').length;
  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('alloc-investors', uniqueInvestors);
  set('alloc-capital',   fmt.rand(totalCapital));
  set('alloc-expected',  fmt.rand(totalExpected));
  set('alloc-matured',   maturedCount);
}

function renderAllocationsView() {
  const el = document.getElementById('allocBody');
  if (!el) return;
  const search  = document.getElementById('allocSearch')?.value.toLowerCase() || '';
  const prodF   = document.getElementById('allocProductFilter')?.value || '';
  const statF   = document.getElementById('allocStatusFilter')?.value || '';

  let data = (S.allocations || []).slice().sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0));
  if (prodF)  data = data.filter(x => x.product_type === prodF);
  if (statF)  data = data.filter(x => x.status === statF);
  if (search) data = data.filter(x =>
    (x.investor_name||'').toLowerCase().includes(search) ||
    (x.entity_name||'').toLowerCase().includes(search) ||
    (x.product_type||'').toLowerCase().includes(search) ||
    (x.investor_email||'').toLowerCase().includes(search)
  );

  const sub = document.getElementById('allocSubtitle');
  if (sub) sub.textContent = `${data.length} allocation${data.length!==1?'s':''} · ${new Set(data.map(x=>x.investor_id)).size} investor${new Set(data.map(x=>x.investor_id)).size!==1?'s':''}`;

  if (!data.length) {
    el.innerHTML = `<tr><td colspan="9"><div class="empty"><i class="fa-solid fa-users-between-lines"></i><p>No allocations found</p></div></td></tr>`;
    return;
  }

  const statusColors  = { active:'badge--green', committed:'badge--blue', matured:'badge--purple', defaulted:'badge--red', cancelled:'badge--gray' };
  const productColors = { cattle:'#74c69d', solar_7yr:'#f59e0b', solar_6yr:'#fbbf24', solar_5yr:'#fcd34d', short_term:'#60a5fa', fund_run:'#a78bfa' };
  const productIcons  = { cattle:'fa-cow', solar_7yr:'fa-solar-panel', solar_6yr:'fa-solar-panel', solar_5yr:'fa-solar-panel', short_term:'fa-hand-holding-dollar', fund_run:'fa-play-circle' };

  el.innerHTML = data.map(a => {
    const pColor = productColors[a.product_type] || '#94a3b8';
    const pIcon  = productIcons[a.product_type]  || 'fa-circle';
    const daysLeft = a.maturity_date ? Math.max(0, Math.round((new Date(a.maturity_date) - new Date()) / 86400000)) : null;
    const navShare = (parseFloat(a.capital_paid)||0) * (1 + (parseFloat(a.annual_rate)||0) * (Math.max(0, Math.round((new Date() - new Date(a.start_date||0)) / 86400000)) / 365));
    const returnPct = parseFloat(a.annual_rate)||0;
    return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:9px">
          <div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--orange),var(--teal));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0">${fmt.initials(a.investor_name)}</div>
          <div>
            <div class="td-h" style="font-size:12px">${a.investor_name||'—'}</div>
            <div class="td-m" style="font-size:10px">${a.investor_email||''}</div>
          </div>
        </div>
      </td>
      <td><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:${pColor}"><i class="fa-solid ${pIcon}"></i>${(a.product_type||'').replace(/_/g,' ')}</span></td>
      <td><div class="td-h" style="font-size:12px">${a.entity_name||'—'}</div><div class="td-m" style="font-size:10px">${a.entity_id||''}</div></td>
      <td class="num td-gold">${fmt.rand(a.capital_paid||0)}</td>
      <td class="num"><span style="font-size:13px;font-weight:700;color:rgba(255,255,255,.8)">${(parseFloat(a.allocation_pct)||0).toFixed(1)}%</span></td>
      <td class="num">
        <div style="font-size:13px;font-weight:700;color:#74c69d">${fmt.rand(a.expected_payout||0)}</div>
        <div style="font-size:10px;color:rgba(255,255,255,.35)">+${fmt.rand((parseFloat(a.expected_payout)||0) - (parseFloat(a.capital_paid)||0))} return</div>
      </td>
      <td>
        <div style="font-size:12px;color:#fff">${fmt.date(a.maturity_date)}</div>
        ${daysLeft !== null && a.status === 'active' ? `<div style="font-size:10px;color:${daysLeft<=30?'#f87171':daysLeft<=90?'#fb923c':'rgba(255,255,255,.3)'}">${daysLeft}d remaining</div>` : ''}
      </td>
      <td><span class="badge ${statusColors[a.status]||'badge--gray'}">${a.status||'—'}</span></td>
      <td>
        <div style="display:flex;gap:5px">
          <button class="btn btn--xs btn--secondary" onclick="viewAllocDetail('${a.id}')" title="View detail"><i class="fa-solid fa-eye"></i></button>
          ${a.status==='active' ? `<button class="btn btn--xs btn--teal" onclick="matureAllocation('${a.id}')" title="Mark matured"><i class="fa-solid fa-check"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderAllocByInvestor() {
  const el = document.getElementById('allocByInvestor');
  if (!el) return;
  const allocs = S.allocations || [];
  const byInv = {};
  allocs.forEach(a => {
    const key = a.investor_id || a.investor_name;
    if (!byInv[key]) byInv[key] = { name: a.investor_name, email: a.investor_email, items: [] };
    byInv[key].items.push(a);
  });
  const cards = Object.values(byInv).map(inv => {
    const totalCap  = inv.items.reduce((s,x) => s+(parseFloat(x.capital_paid)||0), 0);
    const totalExp  = inv.items.reduce((s,x) => s+(parseFloat(x.expected_payout)||0), 0);
    const activeCount = inv.items.filter(x => x.status==='active').length;
    const products = [...new Set(inv.items.map(x => x.product_type))];
    const productColors = { cattle:'#74c69d', solar_7yr:'#f59e0b', solar_6yr:'#fbbf24', solar_5yr:'#fcd34d', short_term:'#60a5fa', fund_run:'#a78bfa' };
    return `
    <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--orange),var(--teal));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:#fff;flex-shrink:0">${fmt.initials(inv.name)}</div>
      <div style="flex:1;min-width:120px">
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:2px">${inv.name}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.4)">${inv.email||''}</div>
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          ${products.map(p => `<span style="font-size:10px;font-weight:700;color:${productColors[p]||'#94a3b8'};background:${productColors[p]||'#94a3b8'}22;border-radius:10px;padding:2px 7px">${p.replace(/_/g,' ')}</span>`).join('')}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:3px">${activeCount} active · ${inv.items.length} total</div>
        <div style="font-size:18px;font-weight:800;color:#D4AF37">${fmt.rand(totalCap)}</div>
        <div style="font-size:11px;color:#74c69d">→ ${fmt.rand(totalExp)} expected</div>
      </div>
    </div>`;
  }).join('');
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">${cards || '<div class="empty" style="padding:30px"><i class="fa-solid fa-users"></i><p>No investor data</p></div>'}</div>`;
}

function viewAllocDetail(allocId) {
  const a = (S.allocations || []).find(x => x.id === allocId);
  if (!a) return;
  const navNow = (parseFloat(a.capital_paid)||0) * (1 + (parseFloat(a.annual_rate)||0) * (Math.max(0, Math.round((new Date() - new Date(a.start_date||0)) / 86400000)) / 365));
  const gain = navNow - (parseFloat(a.capital_paid)||0);
  let modal = document.getElementById('allocDetailModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'allocDetailModal'; modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(6px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px'; modal.addEventListener('click',ev=>{if(ev.target===modal)modal.remove();}); document.body.appendChild(modal); }
  modal.innerHTML = `
  <div style="background:#131720;border:1px solid rgba(255,255,255,.12);border-radius:16px;width:100%;max-width:580px;max-height:85vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.6)">
    <div style="padding:18px 22px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:15px;font-weight:800;color:#fff"><i class="fa-solid fa-users-between-lines" style="color:var(--teal);margin-right:8px"></i>Allocation Detail</div>
      <button onclick="document.getElementById('allocDetailModal').remove()" style="background:rgba(255,255,255,.08);border:none;color:rgba(255,255,255,.6);width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:13px"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div style="padding:22px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px">
        ${[['Investor',a.investor_name],['Email',a.investor_email||'—'],['Product',(a.product_type||'').replace(/_/g,' ')],['Deployment',a.entity_name],['Status',a.status],['Annual Rate',((parseFloat(a.annual_rate)||0)*100).toFixed(2)+'% p.a.'],['Start Date',fmt.date(a.start_date)],['Maturity',fmt.date(a.maturity_date)],['Term',`${a.term_days||'—'} days`],['Allocation',`${(parseFloat(a.allocation_pct)||0).toFixed(2)}%`]].map(([k,v])=>`<div><div style="font-size:10px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px">${k}</div><div style="font-size:13px;font-weight:600;color:#fff">${v}</div></div>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
        <div style="background:rgba(212,175,55,.08);border:1px solid rgba(212,175,55,.2);border-radius:10px;padding:12px;text-align:center"><div style="font-size:10px;color:rgba(255,255,255,.4);margin-bottom:4px">CAPITAL</div><div style="font-size:18px;font-weight:800;color:#D4AF37">${fmt.rand(a.capital_paid||0)}</div></div>
        <div style="background:rgba(116,198,157,.08);border:1px solid rgba(116,198,157,.2);border-radius:10px;padding:12px;text-align:center"><div style="font-size:10px;color:rgba(255,255,255,.4);margin-bottom:4px">LIVE NAV</div><div style="font-size:18px;font-weight:800;color:#74c69d">${fmt.rand(navNow)}</div><div style="font-size:10px;color:#74c69d">+${fmt.rand(gain)}</div></div>
        <div style="background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.2);border-radius:10px;padding:12px;text-align:center"><div style="font-size:10px;color:rgba(255,255,255,.4);margin-bottom:4px">EXPECTED</div><div style="font-size:18px;font-weight:800;color:#60a5fa">${fmt.rand(a.expected_payout||0)}</div></div>
      </div>
      ${a.notes ? `<div style="background:rgba(255,255,255,.04);border-radius:8px;padding:10px 12px;font-size:12px;color:rgba(255,255,255,.6);line-height:1.5;margin-bottom:14px"><strong style="color:rgba(255,255,255,.7)">Notes:</strong> ${a.notes}</div>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)">
        <button onclick="printInvestorStatement('${a.id}')"
                style="background:rgba(212,175,55,.15);border:1px solid rgba(212,175,55,.3);color:#D4AF37;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700">
          <i class="fa-solid fa-file-invoice"></i> Investor Statement
        </button>
        <button onclick="printTaxCertificate('${a.id}')"
                style="background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.25);color:#60a5fa;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700">
          <i class="fa-solid fa-certificate"></i> IT3(b) Tax Cert
        </button>
      </div>
    </div>
  </div>`;
}

async function matureAllocation(allocId) {
  const a = (S.allocations || []).find(x => x.id === allocId);
  if (!a || !confirm(`Mark allocation for ${a.investor_name} as matured and paid out?`)) return;
  try {
    await apiFetch(`tables/investor_allocations/${allocId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status:'matured', actual_payout: a.expected_payout }) });
    await auditLog({ eventType:'fund_run', action:'status_change', entityId: allocId, entityName: `${a.investor_name} → ${a.entity_name}`, changeSummary: `Allocation matured: ${a.investor_name} — ${fmt.rand(a.expected_payout)} paid out from ${a.entity_name}`, beforeState:{ status:'active' }, afterState:{ status:'matured', actual_payout: a.expected_payout }, severity:'info' });
    T.success('Allocation marked as matured');
    await loadAllocations();
  } catch(e) { T.error('Failed to update allocation'); }
}

async function openNewAllocationModal() {
  // Inline prompt-based quick add
  const name    = prompt('Investor full name:');
  if (!name) return;
  const email   = prompt('Investor email:');
  const product = prompt('Product (cattle/solar_7yr/solar_6yr/solar_5yr/short_term):') || 'cattle';
  const entity  = prompt('Deployment name (e.g. SVC-Q1-2026 Cattle Run):');
  const capital = parseFloat(prompt('Capital committed (ZAR):') || '0');
  const rate    = parseFloat(prompt('Annual rate % (e.g. 14.83):') || '14.83') / 100;
  const termStr = prompt('Start date (YYYY-MM-DD):') || new Date().toISOString().slice(0,10);
  const matStr  = prompt('Maturity date (YYYY-MM-DD):') || '';
  const termDays= matStr ? Math.round((new Date(matStr)-new Date(termStr))/86400000) : 183;
  const expected = capital * (1 + rate * termDays/365);
  try {
    const rec = await apiFetch('tables/investor_allocations', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      id:`ALLOC-${Date.now()}`, investor_id:`INV-${Date.now()}`, investor_name:name, investor_email:email||'', product_type:product, entity_id:'', entity_name:entity||'', capital_committed:capital, capital_paid:capital, allocation_pct:0, annual_rate:rate, term_days:termDays, start_date:new Date(termStr).toISOString(), maturity_date:matStr?new Date(matStr).toISOString():null, expected_payout:+expected.toFixed(2), actual_payout:null, status:'active', notes:null
    })});
    await auditLog({ eventType:'fund_run', action:'create', entityId:rec.id, entityName:`${name} → ${entity||''}`, changeSummary:`New investor allocation: ${name} — ${fmt.rand(capital)} into ${entity||product}`, afterState:{status:'active',capital_paid:capital,expected_payout:expected}, severity:'info' });
    T.success('Allocation added');
    await loadAllocations();
  } catch(e) { T.error('Failed to add allocation'); }
}

/* ═══════════════════════════════════════════════════════════════
   P1.3 — 12-MONTH CASH FLOW FORECAST ENGINE
═══════════════════════════════════════════════════════════════ */
async function loadForecast() {
  const el = document.getElementById('forecastBody');
  if (el) el.innerHTML = `<tr><td colspan="7"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Building forecast…</p></div></td></tr>`;
  try {
    const [schedules, solar, loans, cattle, runs, pools, allocs] = await Promise.all([
      intFetchAll('return_schedules'),
      intFetchAll('solar_projects').catch(()=>[]),
      intFetchAll('shortterm_loans').catch(()=>[]),
      intFetchAll('cattle_cycles').catch(()=>[]),
      intFetchAll('fund_runs'),
      intFetchAll('investment_pools'),
      intFetchAll('investor_allocations').catch(()=>[])
    ]);
    const forecast = buildForecast({ schedules, solar, loans, cattle, runs, pools, allocs });
    renderForecastView(forecast);
  } catch(e) {
    T.error('Failed to build forecast');
    console.error(e);
  }
}

function buildForecast({ schedules, solar, loans, cattle, runs, pools, allocs }) {
  const now      = new Date();
  const months   = [];
  const events   = []; // flat list of all forecast events

  // Build 12 monthly buckets
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push({
      key:      `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,
      label:    d.toLocaleDateString('en-ZA', { month:'short', year:'numeric' }),
      date:     d,
      inflows:  0,
      outflows: 0,
      items:    []
    });
  }

  const getBucket = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    return months.find(m => m.key === key) || null;
  };

  // ── OUTFLOWS: payout schedules ──
  schedules.filter(s => s.status === 'scheduled' || s.status === 'processing').forEach(s => {
    const b = getBucket(s.scheduled_payout_date);
    if (!b) return;
    const amount = parseFloat(s.total_payout) || 0;
    b.outflows += amount;
    b.items.push({ type:'outflow', label:`Payout: ${s.investor_name}`, amount, product: s.product_type||'fund_run', date: s.scheduled_payout_date, icon:'fa-calendar-check', color:'#f87171' });
    events.push({ bucket: b.key, direction:'outflow', label:`Payout: ${s.investor_name} (${s.pool_name||'—'})`, amount, product:'schedule', date: s.scheduled_payout_date });
  });

  // ── OUTFLOWS: investor allocations maturing ──
  allocs.filter(a => a.status === 'active' && a.maturity_date).forEach(a => {
    const b = getBucket(a.maturity_date);
    if (!b) return;
    const amount = parseFloat(a.expected_payout) || 0;
    b.outflows += amount;
    b.items.push({ type:'outflow', label:`Allocation Payout: ${a.investor_name}`, amount, product: a.product_type, date: a.maturity_date, icon:'fa-users-between-lines', color:'#fb923c' });
    events.push({ bucket: b.key, direction:'outflow', label:`Allocation: ${a.investor_name} — ${a.entity_name}`, amount, product: a.product_type, date: a.maturity_date });
  });

  // ── INFLOWS: short-term loans maturing (repayment due) ──
  loans.filter(l => (l.status==='active'||l.status==='partial') && l.repayment_date).forEach(l => {
    const b = getBucket(l.repayment_date);
    if (!b) return;
    const amount = parseFloat(l.total_repayable) || 0;
    b.inflows += amount;
    b.items.push({ type:'inflow', label:`Loan Repayment: ${l.business_name}`, amount, product:'short_term', date: l.repayment_date, icon:'fa-hand-holding-dollar', color:'#60a5fa' });
    events.push({ bucket: b.key, direction:'inflow', label:`Loan Repayment: ${l.business_name||l.loan_ref}`, amount, product:'short_term', date: l.repayment_date });
  });

  // ── INFLOWS: solar projects maturing ──
  solar.filter(p => (p.status==='active') && p.maturity_date).forEach(p => {
    const b = getBucket(p.maturity_date);
    if (!b) return;
    const nav = (parseFloat(p.capital_deployed)||0) + (parseFloat(p.capital_deployed)||0) * (parseFloat(p.annual_rate)||0) * (Math.max(0,Math.round((new Date(p.maturity_date)-new Date(p.start_date||0))/86400000))/365);
    b.inflows += nav;
    b.items.push({ type:'inflow', label:`Solar Maturity: ${p.project_name}`, amount: nav, product:'solar', date: p.maturity_date, icon:'fa-solar-panel', color:'#f59e0b' });
    events.push({ bucket: b.key, direction:'inflow', label:`Solar Maturity: ${p.project_name}`, amount: nav, product:'solar', date: p.maturity_date });
  });

  // ── INFLOWS: cattle cycles maturing ──
  cattle.filter(c => (c.status==='active'||c.status==='in_progress') && c.expected_sale_date).forEach(c => {
    const b = getBucket(c.expected_sale_date);
    if (!b) return;
    const amount = parseFloat(c.expected_sale_value)||parseFloat(c.purchase_price)||0;
    b.inflows += amount;
    b.items.push({ type:'inflow', label:`Cattle Exit: ${c.cycle_name||c.id}`, amount, product:'cattle', date: c.expected_sale_date, icon:'fa-cow', color:'#74c69d' });
    events.push({ bucket: b.key, direction:'inflow', label:`Cattle Exit: ${c.cycle_name||c.id}`, amount, product:'cattle', date: c.expected_sale_date });
  });

  // ── INFLOWS: fund runs completing ──
  runs.filter(r => r.status==='in_progress' && r.end_date).forEach(r => {
    const b = getBucket(r.end_date);
    if (!b) return;
    const amount = parseFloat(r.capital_deployed)||0;
    b.inflows += amount;
    b.items.push({ type:'inflow', label:`Fund Run Return: ${r.run_name}`, amount, product:'fund_run', date: r.end_date, icon:'fa-play-circle', color:'#a78bfa' });
    events.push({ bucket: b.key, direction:'inflow', label:`Run Return: ${r.run_name}`, amount, product:'fund_run', date: r.end_date });
  });

  // Compute cumulative net
  let cumNet = 0;
  months.forEach(m => {
    m.net = m.inflows - m.outflows;
    cumNet += m.net;
    m.cumNet = cumNet;
  });

  const totalInflows  = months.reduce((s,m)=>s+m.inflows,  0);
  const totalOutflows = months.reduce((s,m)=>s+m.outflows, 0);
  const peakMonth     = [...months].sort((a,b)=>b.outflows-a.outflows)[0];

  return { months, events, totalInflows, totalOutflows, totalNet: totalInflows - totalOutflows, peakMonth };
}

function renderForecastView({ months, events, totalInflows, totalOutflows, totalNet, peakMonth }) {
  // KPIs
  const set = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  set('fcst-inflow',     fmt.rand(totalInflows));
  set('fcst-outflow',    fmt.rand(totalOutflows));
  set('fcst-net',        (totalNet >= 0 ? '+' : '') + fmt.rand(totalNet));
  set('fcst-peak-month', peakMonth?.label || '—');
  const netEl = document.getElementById('fcst-net');
  if (netEl) netEl.style.color = totalNet >= 0 ? 'var(--green)' : 'var(--red)';

  // Chart
  const ctx = document.getElementById('forecastChart');
  if (ctx) {
    if (S.charts.forecast) S.charts.forecast.destroy();
    S.charts.forecast = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          { label: 'Inflows', data: months.map(m => m.inflows), backgroundColor: 'rgba(45,212,191,.7)', borderColor:'#2dd4bf', borderWidth:1, borderRadius:4 },
          { label: 'Outflows', data: months.map(m => m.outflows), backgroundColor: 'rgba(248,113,113,.7)', borderColor:'#f87171', borderWidth:1, borderRadius:4 },
          { label: 'Net', data: months.map(m => m.net), type:'line', borderColor:'#fbbf24', backgroundColor:'rgba(251,191,36,.1)', borderWidth:2, pointRadius:4, pointBackgroundColor:'#fbbf24', fill:false, tension:0.3, yAxisID:'y' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend:{ labels:{ color:'rgba(255,255,255,.6)', font:{size:11} } } },
        scales: {
          x: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:10} }, grid:{ color:'rgba(255,255,255,.05)' } },
          y: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:10}, callback:v=>'R'+Number(v/1000).toFixed(0)+'k' }, grid:{ color:'rgba(255,255,255,.05)' } }
        }
      }
    });
  }

  // Monthly table
  const tbody = document.getElementById('forecastBody');
  if (tbody) {
    tbody.innerHTML = months.map(m => {
      const netColor = m.net > 0 ? '#74c69d' : m.net < 0 ? '#f87171' : 'rgba(255,255,255,.4)';
      const cumColor = m.cumNet >= 0 ? '#74c69d' : '#f87171';
      const statusIcon = m.net > 0 ? '✅' : m.net < 0 ? '⚠️' : '➖';
      const hasEvents  = m.items.length;
      return `<tr>
        <td><strong style="color:#fff">${m.label}</strong></td>
        <td class="num td-teal">${m.inflows > 0 ? fmt.rand(m.inflows) : '<span style="color:rgba(255,255,255,.25)">—</span>'}</td>
        <td class="num" style="color:#f87171">${m.outflows > 0 ? fmt.rand(m.outflows) : '<span style="color:rgba(255,255,255,.25)">—</span>'}</td>
        <td class="num" style="color:${netColor};font-weight:700">${m.net !== 0 ? (m.net>0?'+':'')+fmt.rand(m.net) : '—'}</td>
        <td class="num" style="color:${cumColor};font-weight:700">${(m.cumNet>0?'+':'')+fmt.rand(m.cumNet)}</td>
        <td><span style="font-size:11px;color:rgba(255,255,255,.5)">${hasEvents} event${hasEvents!==1?'s':''}</span></td>
        <td>${statusIcon}</td>
      </tr>`;
    }).join('');
  }

  // Timeline
  const timelineEl = document.getElementById('forecastTimeline');
  if (timelineEl) {
    const allEvts = [];
    months.forEach(m => m.items.forEach(item => allEvts.push({ ...item, monthLabel: m.label })));
    allEvts.sort((a,b) => new Date(a.date) - new Date(b.date));

    if (!allEvts.length) {
      timelineEl.innerHTML = `<div class="empty" style="padding:30px"><i class="fa-solid fa-calendar"></i><p>No scheduled events found in the next 12 months</p></div>`;
    } else {
      let lastMonth = '';
      timelineEl.innerHTML = allEvts.map(ev => {
        const monthHeader = ev.monthLabel !== lastMonth
          ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.3);padding:14px 0 8px;${lastMonth?'border-top:1px solid rgba(255,255,255,.06);margin-top:6px':''}">${(lastMonth = ev.monthLabel, ev.monthLabel)}</div>`
          : (lastMonth = ev.monthLabel, '');
        return `${monthHeader}
        <div style="display:flex;align-items:center;gap:12px;padding:9px 12px;background:rgba(255,255,255,.03);border-radius:8px;margin-bottom:5px;border-left:3px solid ${ev.color}">
          <i class="fa-solid ${ev.icon}" style="color:${ev.color};width:16px;text-align:center"></i>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:600;color:#fff">${ev.label}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.4)">${fmt.date(ev.date)}</div>
          </div>
          <div style="font-size:13px;font-weight:800;color:${ev.color}">${ev.type==='inflow'?'+':'-'}${fmt.rand(ev.amount)}</div>
          <span style="font-size:9px;font-weight:700;background:${ev.color}22;color:${ev.color};padding:2px 7px;border-radius:10px">${ev.type.toUpperCase()}</span>
        </div>`;
      }).join('');
    }
  }
}

/* ═══════════════════════════════════════════════
   FUND INTELLIGENCE — AI DEPLOYMENT ENGINE
═══════════════════════════════════════════════ */

/**
 * Paginated fetch helper for intelligence engine
 */
async function intFetchAll(table) {
  const PAGE = 100; let page = 1, all = [];
  while (true) {
    try {
      const r = await apiFetch(`tables/${table}?limit=${PAGE}&page=${page}`);
      const rows = r.data || [];
      all = all.concat(rows);
      if (rows.length < PAGE) break;
      if (r.total > 0 && all.length >= r.total) break;
      page++;
    } catch(e) { break; }
  }
  return all;
}

async function loadIntelligence() {
  const el = document.getElementById('intelligenceContent');
  if (!el) return;
  el.innerHTML = `<div class="panel"><div class="panel__bd" style="padding:60px;text-align:center;color:rgba(255,255,255,.4)">
    <i class="fa-solid fa-spinner fa-spin" style="font-size:32px;margin-bottom:14px;color:#c084fc"></i>
    <p style="margin:0;font-size:13px">Analysing fund data…</p></div></div>`;

  try {
    const [pools, schedules, runs, investments, solar, loans, cattle] = await Promise.all([
      intFetchAll('investment_pools'),
      intFetchAll('return_schedules'),
      intFetchAll('fund_runs'),
      intFetchAll('investments'),
      intFetchAll('solar_projects').catch(() => []),
      intFetchAll('shortterm_loans').catch(() => []),
      intFetchAll('cattle_cycles').catch(() => [])
    ]);

    const ctx = AIAdvisor.buildContext({ pools, schedules, runs, investments, solar, loans, cattle });
    renderIntelligenceView(ctx);
  } catch(e) {
    el.innerHTML = `<div class="panel"><div class="panel__bd" style="padding:40px;text-align:center;color:#f87171">
      <i class="fa-solid fa-circle-exclamation" style="font-size:28px;margin-bottom:10px"></i>
      <p style="margin:0">Failed to load intelligence data: ${e.message}</p></div></div>`;
  }
}

/* ═══════════════════════════════════════════════
   AI ADVISOR OBJECT
═══════════════════════════════════════════════ */
const AIAdvisor = {

  /* ── Build context object from all data sources ── */
  buildContext({ pools, schedules, runs, investments, solar, loans, cattle }) {
    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 86400000);
    const in30 = new Date(now.getTime() + 30 * 86400000);

    /* ── Capital raised (from investment_pools) ── */
    const activePools = pools.filter(p => ['open','filling','active'].includes(p.status));
    const totalRaised  = pools.reduce((s,p) => s + (parseFloat(p.raised_amount)||0), 0);
    const targetTotal  = pools.reduce((s,p) => s + (parseFloat(p.target_amount)||0), 0);

    /* ── Capital deployed (from fund_runs) ── */
    const activeRuns   = runs.filter(r => r.status === 'in_progress');
    const totalDeployedRuns = activeRuns.reduce((s,r) => s + (parseFloat(r.capital_deployed)||0), 0);

    /* ── Solar deployed ── */
    const activeSolar  = solar.filter(p => p.status === 'active');
    const solarDeployed = activeSolar.reduce((s,p) => s + (parseFloat(p.capital_deployed)||0), 0);

    /* ── Short-term loans deployed ── */
    const activeLoans  = loans.filter(l => l.status === 'active' || l.status === 'overdue');
    const loansDeployed = activeLoans.reduce((s,l) => s + (parseFloat(l.disbursement_amount)||0), 0);

    /* ── Cattle deployed ── */
    const activeCattle = cattle.filter(c => c.status === 'active' || c.status === 'in_progress');
    const cattleDeployed = activeCattle.reduce((s,c) => s + (parseFloat(c.purchase_price)||0), 0);

    /* ── Total deployed across all products ── */
    const totalDeployed = totalDeployedRuns + solarDeployed + loansDeployed + cattleDeployed;

    /* ── Upcoming payout obligations (next 90 days) ── */
    const upcomingPayouts = schedules.filter(s => {
      if (s.status === 'paid' || s.status === 'cancelled') return false;
      const d = new Date(s.scheduled_payout_date);
      return d >= now && d <= in90;
    });
    const totalObligations90 = upcomingPayouts.reduce((s,p) => s + (parseFloat(p.total_payout)||0), 0);

    const upcomingPayouts30 = upcomingPayouts.filter(s => new Date(s.scheduled_payout_date) <= in30);
    const totalObligations30 = upcomingPayouts30.reduce((s,p) => s + (parseFloat(p.total_payout)||0), 0);

    /* ── Maturing pools (next 90 days) ── */
    const maturingPools = pools.filter(p => {
      if (!p.maturity_date) return false;
      const d = new Date(p.maturity_date);
      return d >= now && d <= in90;
    }).sort((a,b) => new Date(a.maturity_date) - new Date(b.maturity_date));

    const maturingValue = maturingPools.reduce((s,p) => s + (parseFloat(p.raised_amount)||0), 0);

    /* ── Next single pool maturing ── */
    const nextPool = [...pools]
      .filter(p => p.maturity_date && new Date(p.maturity_date) > now)
      .sort((a,b) => new Date(a.maturity_date) - new Date(b.maturity_date))[0] || null;

    /* ── Available balance = raised − deployed − 90-day obligations buffer ── */
    const liquidityBuffer  = totalObligations90 * 1.1; // 10% safety margin
    const availableBalance = Math.max(0, totalRaised - totalDeployed - liquidityBuffer);
    const availablePct     = totalRaised > 0 ? (availableBalance / totalRaised) * 100 : 0;
    const deployedPct      = totalRaised > 0 ? (totalDeployed / totalRaised) * 100 : 0;

    /* ── Liquidity health ── */
    const liquidityRatio = totalObligations90 > 0
      ? (totalRaised - totalDeployed) / totalObligations90
      : 999;
    const liquidityStatus = liquidityRatio >= 2 ? 'healthy' : liquidityRatio >= 1.2 ? 'watch' : 'critical';

    /* ── Product performance metrics ── */
    const completedLoans = loans.filter(l => l.status === 'repaid');
    const loanReturnPct  = completedLoans.length
      ? completedLoans.reduce((s,l) => {
          const d = parseFloat(l.disbursement_amount)||0;
          const r = parseFloat(l.total_repayable)||0;
          return s + (d > 0 ? ((r-d)/d)*100 : 0);
        }, 0) / completedLoans.length
      : 14.5; // fallback benchmark

    const avgSolarRate = activeSolar.length
      ? activeSolar.reduce((s,p) => s + (parseFloat(p.annual_rate)||0)*100, 0) / activeSolar.length
      : 15.0;

    /* ── Overdue loans risk ── */
    const overdueLoans = loans.filter(l => l.status === 'overdue');
    const overdueExposure = overdueLoans.reduce((s,l) => s + (parseFloat(l.disbursement_amount)||0), 0);

    /* ── Cattle utilisation ── */
    const totalCattleAnimals = activeCattle.reduce((s,c) => s + (parseInt(c.total_animals)||0), 0);

    return {
      /* Balances */
      totalRaised, totalDeployed, availableBalance, availablePct, deployedPct,
      liquidityBuffer, liquidityRatio, liquidityStatus,
      /* Obligations */
      totalObligations30, totalObligations90,
      upcomingPayouts30, upcomingPayouts,
      /* Pools */
      maturingPools, maturingValue, nextPool, activePools,
      totalPools: pools.length, targetTotal,
      /* Products */
      solarDeployed, loansDeployed, cattleDeployed, totalDeployedRuns,
      activeSolar, activeLoans, activeCattle, overdueLoans, overdueExposure,
      avgSolarRate, loanReturnPct, totalCattleAnimals,
      /* Counts */
      solar, loans, cattle, runs,
      /* Timestamp */
      asOf: new Date().toLocaleString('en-ZA')
    };
  },

  /* ── Score an opportunity (0-100) ── */
  scoreOpportunity(type, ctx) {
    let score = 50;
    switch(type) {
      case 'solar':
        score += (ctx.avgSolarRate - 14) * 3;         // reward higher rates
        score += ctx.activeSolar.length < 3 ? 12 : 0; // reward pipeline gaps
        score -= ctx.solarDeployed / (ctx.totalRaised || 1) * 20; // penalise over-concentration
        break;
      case 'loans':
        score += (ctx.loanReturnPct - 13) * 2;
        score += ctx.overdueExposure > 0 ? -15 : 8;  // penalise existing overdue
        score += ctx.activeLoans.length < 4 ? 10 : 0;
        score -= ctx.loansDeployed / (ctx.totalRaised || 1) * 15;
        break;
      case 'cattle':
        score += 8;                                   // stable physical asset
        score += ctx.activeCattle.length < 2 ? 10 : 0;
        score -= ctx.cattleDeployed / (ctx.totalRaised || 1) * 18;
        score += ctx.totalCattleAnimals < 500 ? 5 : 0;
        break;
    }
    return Math.min(100, Math.max(0, Math.round(score)));
  },

  /* ── Generate ranked AI suggestions ── */
  generateSuggestions(ctx) {
    if (ctx.availableBalance <= 0) {
      return [{
        product: 'all',
        icon: 'fa-lock',
        color: '#f87171',
        title: 'No Free Capital to Deploy',
        amount: 0,
        score: 0,
        reasoning: `All raised capital is fully deployed or reserved for upcoming obligation payments of ${fmt.rand(ctx.totalObligations90)} (next 90 days). Consider new capital raises or waiting for existing deployments to mature.`,
        actions: ['Review payout schedule', 'Launch new pool', 'Extend existing investments']
      }];
    }

    const suggestions = [];
    const avail = ctx.availableBalance;

    /* ── Solar suggestion ── */
    const solarScore = this.scoreOpportunity('solar', ctx);
    const solarAlloc = Math.min(avail * 0.45, avail);
    const solarReturn = solarAlloc * (ctx.avgSolarRate / 100);
    suggestions.push({
      product: 'solar',
      icon: 'fa-solar-panel',
      color: '#f59e0b',
      title: 'Allocate to Solar Finance',
      amount: solarAlloc,
      score: solarScore,
      returnEstimate: solarReturn,
      rate: ctx.avgSolarRate,
      reasoning: `Solar projects are currently returning ~${ctx.avgSolarRate.toFixed(1)}% p.a. With ${ctx.activeSolar.length} active project${ctx.activeSolar.length!==1?'s':''}, the solar portfolio ${ ctx.activeSolar.length < 3 ? 'has capacity for new allocations' : 'is well-populated but returns remain strong' }. Solar assets are long-duration and low-turnover, making them ideal for capital that is not needed for near-term payouts.`,
      actions: ['Open new solar project', 'Increase capital on existing project', 'Review 7yr vs 5yr product mix']
    });

    /* ── Short-Term Loans suggestion ── */
    const loanScore = this.scoreOpportunity('loans', ctx);
    const loanAlloc = Math.min(avail * 0.35, avail);
    const loanReturn = loanAlloc * (ctx.loanReturnPct / 100) * (150 / 365);
    suggestions.push({
      product: 'loans',
      icon: 'fa-hand-holding-dollar',
      color: '#60a5fa',
      title: 'Short-Term Business Loans',
      amount: loanAlloc,
      score: loanScore,
      returnEstimate: loanReturn,
      rate: ctx.loanReturnPct,
      overdue: ctx.overdueLoans.length,
      reasoning: `Short-term loans offer rapid capital turnover (~150 days) with ${ ctx.loanReturnPct.toFixed(1) }% effective return. Currently ${ctx.activeLoans.length} active loan${ctx.activeLoans.length!==1?'s':''} ${ ctx.overdueLoans.length > 0 ? `and ⚠️ ${ctx.overdueLoans.length} overdue loan${ctx.overdueLoans.length>1?'s':''} (R${fmt.rand(ctx.overdueExposure)} at risk)` : 'with no overdue accounts' }. Ideal for short capital windows before upcoming payout obligations.`,
      actions: ['Disburse new loan', 'Review overdue accounts', 'Update repayment tracking']
    });

    /* ── Cattle Finance suggestion ── */
    const cattleScore = this.scoreOpportunity('cattle', ctx);
    const cattleAlloc = Math.min(avail * 0.20, avail);
    const cattleReturn = cattleAlloc * 0.1483 * (183 / 365);
    suggestions.push({
      product: 'cattle',
      icon: 'fa-cow',
      color: '#74c69d',
      title: 'Cattle Finance — Backgrounding Cycle',
      amount: cattleAlloc,
      score: cattleScore,
      returnEstimate: cattleReturn,
      rate: 14.83,
      reasoning: `Cattle backgrounding offers physical asset backing with ~14.83% p.a. target return over ~183-day cycles. ${ctx.activeCattle.length > 0 ? `Currently ${ctx.activeCattle.length} active cycle${ctx.activeCattle.length!==1?'s':''} with ${ctx.totalCattleAnimals} animals` : 'No active cattle cycles — significant opportunity to deploy capital into this product line' }. Physical cattle provide tangible collateral and are uncorrelated to financial markets.`,
      actions: ['Start new cattle cycle', 'Purchase additional animals', 'Review feedlot costs']
    });

    /* ── Liquidity Reserve suggestion (if obligations are high) ── */
    if (ctx.liquidityStatus !== 'healthy') {
      suggestions.unshift({
        product: 'reserve',
        icon: 'fa-shield-halved',
        color: ctx.liquidityStatus === 'critical' ? '#f87171' : '#fb923c',
        title: ctx.liquidityStatus === 'critical' ? '🚨 Liquidity Warning — Hold Reserves' : '⚠️ Liquidity Watch — Partial Hold',
        amount: ctx.totalObligations90,
        score: 0,
        reasoning: `Liquidity ratio is ${ctx.liquidityRatio.toFixed(2)}x (${ctx.liquidityStatus.toUpperCase()}). You have ${fmt.rand(ctx.totalObligations90)} in payout obligations due within 90 days vs ${fmt.rand(ctx.totalRaised - ctx.totalDeployed)} in liquid capital. ${ ctx.liquidityStatus === 'critical' ? 'HALT all new deployments until obligations are covered.' : 'Deploy conservatively and retain sufficient cash buffer.' }`,
        actions: ['Review payout schedule', 'Prioritise short-duration products', 'Expedite loan repayments']
      });
    }

    /* Sort by score descending */
    return suggestions.sort((a,b) => b.score - a.score);
  }
};

/* ── Render the full Intelligence view ── */
function renderIntelligenceView(ctx) {
  const el = document.getElementById('intelligenceContent');
  if (!el) return;

  const liquidityColor = ctx.liquidityStatus === 'healthy' ? '#74c69d'
    : ctx.liquidityStatus === 'watch' ? '#fb923c' : '#f87171';
  const liquidityIcon  = ctx.liquidityStatus === 'healthy' ? 'fa-circle-check'
    : ctx.liquidityStatus === 'watch' ? 'fa-triangle-exclamation' : 'fa-circle-xmark';

  const suggestions    = AIAdvisor.generateSuggestions(ctx);
  const nextPoolDays   = ctx.nextPool
    ? Math.max(0, Math.round((new Date(ctx.nextPool.maturity_date) - new Date()) / 86400000))
    : null;

  /* ── KPI row ── */
  const kpiRow = `
  <div class="stats-grid stats-grid--4 mb-20">
    <div class="kpi" style="background:linear-gradient(135deg,#0d1832,#1a2040);border-color:rgba(168,85,247,.2)">
      <div class="kpi__head"><div class="kpi__icon" style="background:rgba(168,85,247,.15)"><i class="fa-solid fa-wallet" style="color:#c084fc"></i></div><span class="kpi__trend" style="color:#c084fc">${ctx.availablePct.toFixed(1)}% of AUM</span></div>
      <div class="kpi__value" style="color:#c084fc">${fmt.rand(ctx.availableBalance)}</div>
      <div class="kpi__label">Available to Deploy</div>
    </div>
    <div class="kpi" style="border-color:rgba(${ctx.liquidityStatus==='healthy'?'116,198,157':ctx.liquidityStatus==='watch'?'251,146,60':'248,113,113'},.2)">
      <div class="kpi__head"><div class="kpi__icon"><i class="fa-solid ${liquidityIcon}" style="color:${liquidityColor}"></i></div><span class="kpi__trend" style="color:${liquidityColor}">${ctx.liquidityStatus.toUpperCase()}</span></div>
      <div class="kpi__value" style="color:${liquidityColor}">${ctx.liquidityRatio > 99 ? '∞' : ctx.liquidityRatio.toFixed(1) + 'x'}</div>
      <div class="kpi__label">Liquidity Coverage Ratio</div>
    </div>
    <div class="kpi kpi--orange">
      <div class="kpi__head"><div class="kpi__icon"><i class="fa-solid fa-calendar-exclamation"></i></div><span class="kpi__trend trend--down">Next 90d</span></div>
      <div class="kpi__value">${fmt.rand(ctx.totalObligations90)}</div>
      <div class="kpi__label">Upcoming Payout Obligations</div>
    </div>
    <div class="kpi kpi--gold">
      <div class="kpi__head"><div class="kpi__icon"><i class="fa-solid fa-layer-group"></i></div></div>
      <div class="kpi__value">${ctx.deployedPct.toFixed(1)}%</div>
      <div class="kpi__label">Capital Deployment Rate</div>
    </div>
  </div>`;

  /* ── Balance breakdown panel ── */
  const balancePanel = `
  <div class="panel mb-20">
    <div class="panel__hd">
      <div><div class="panel__title"><i class="fa-solid fa-scale-balanced" style="color:#c084fc;margin-right:8px"></i>Capital Balance Breakdown</div>
      <div class="panel__sub">As of ${ctx.asOf}</div></div>
    </div>
    <div class="panel__bd">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px">
        <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:14px 16px;border:1px solid rgba(255,255,255,.07)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.4);margin-bottom:6px">Total Raised (Pools)</div>
          <div style="font-size:20px;font-weight:800;color:#D4AF37">${fmt.rand(ctx.totalRaised)}</div>
        </div>
        <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:14px 16px;border:1px solid rgba(255,255,255,.07)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.4);margin-bottom:6px">Total Deployed</div>
          <div style="font-size:20px;font-weight:800;color:#f87171">${fmt.rand(ctx.totalDeployed)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.35);margin-top:4px">
            Solar ${fmt.rand(ctx.solarDeployed)} · Loans ${fmt.rand(ctx.loansDeployed)} · Cattle ${fmt.rand(ctx.cattleDeployed)}
          </div>
        </div>
        <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:14px 16px;border:1px solid rgba(255,255,255,.07)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:rgba(255,255,255,.4);margin-bottom:6px">Obligations Reserve (90d + 10%)</div>
          <div style="font-size:20px;font-weight:800;color:#fb923c">${fmt.rand(ctx.liquidityBuffer)}</div>
        </div>
        <div style="background:linear-gradient(135deg,#1a0d2e,#160b25);border-radius:10px;padding:14px 16px;border:1px solid rgba(168,85,247,.3)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#c084fc;margin-bottom:6px">Available to Deploy</div>
          <div style="font-size:24px;font-weight:900;color:#c084fc">${fmt.rand(ctx.availableBalance)}</div>
        </div>
      </div>

      <!-- Deployment bar chart -->
      <div style="margin-top:4px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,.4);margin-bottom:5px">
          <span>Deployment utilisation</span><span>${ctx.deployedPct.toFixed(1)}% deployed</span>
        </div>
        <div style="background:rgba(255,255,255,.07);border-radius:8px;height:12px;overflow:hidden;display:flex">
          <div style="width:${Math.min(ctx.solarDeployed/ctx.totalRaised*100,100).toFixed(1)}%;background:#f59e0b;transition:width .5s" title="Solar"></div>
          <div style="width:${Math.min(ctx.loansDeployed/ctx.totalRaised*100,100).toFixed(1)}%;background:#60a5fa;transition:width .5s" title="Loans"></div>
          <div style="width:${Math.min(ctx.cattleDeployed/ctx.totalRaised*100,100).toFixed(1)}%;background:#74c69d;transition:width .5s" title="Cattle"></div>
        </div>
        <div style="display:flex;gap:16px;font-size:11px;color:rgba(255,255,255,.4);margin-top:6px">
          <span><span style="display:inline-block;width:10px;height:10px;background:#f59e0b;border-radius:2px;margin-right:4px"></span>Solar</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#60a5fa;border-radius:2px;margin-right:4px"></span>Loans</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#74c69d;border-radius:2px;margin-right:4px"></span>Cattle</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:rgba(255,255,255,.1);border-radius:2px;margin-right:4px"></span>Available</span>
        </div>
      </div>
    </div>
  </div>`;

  /* ── Next Maturity panel ── */
  const nextMaturityPanel = ctx.nextPool ? `
  <div class="panel mb-20">
    <div class="panel__hd">
      <div><div class="panel__title"><i class="fa-solid fa-hourglass-half" style="color:#fb923c;margin-right:8px"></i>Next Pool Maturity</div></div>
    </div>
    <div class="panel__bd">
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
        <div style="background:linear-gradient(135deg,#1a1000,#2a1800);border:1px solid rgba(251,146,60,.2);border-radius:12px;padding:16px 20px;flex:1;min-width:220px">
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:5px">Pool Name</div>
          <div style="font-size:16px;font-weight:700;color:#fff">${ctx.nextPool.pool_name || ctx.nextPool.id}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4);margin-top:3px">${fmt.date(ctx.nextPool.maturity_date)}</div>
        </div>
        <div style="text-align:center;padding:0 8px">
          <div style="font-size:42px;font-weight:900;color:#fb923c;line-height:1">${nextPoolDays}</div>
          <div style="font-size:12px;color:rgba(255,255,255,.4)">days remaining</div>
        </div>
        <div style="background:rgba(255,255,255,.04);border-radius:12px;padding:16px 20px;flex:1;min-width:180px">
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:5px">Pool Value (Raised)</div>
          <div style="font-size:18px;font-weight:800;color:#D4AF37">${fmt.rand(parseFloat(ctx.nextPool.raised_amount)||0)}</div>
        </div>
        ${ctx.maturingPools.length > 1 ? `
        <div style="background:rgba(255,255,255,.04);border-radius:12px;padding:16px 20px;flex:1;min-width:180px">
          <div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:5px">Total Maturing in 90d</div>
          <div style="font-size:18px;font-weight:800;color:#f87171">${fmt.rand(ctx.maturingValue)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,.35);margin-top:3px">${ctx.maturingPools.length} pools</div>
        </div>` : ''}
      </div>
      ${ctx.maturingPools.length > 1 ? `
      <div style="margin-top:16px">
        <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,.5);margin-bottom:10px;text-transform:uppercase;letter-spacing:.6px">All maturing pools — next 90 days</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${ctx.maturingPools.map(p => {
            const d = Math.max(0, Math.round((new Date(p.maturity_date) - new Date()) / 86400000));
            const urgency = d <= 14 ? '#f87171' : d <= 30 ? '#fb923c' : '#fbbf24';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(255,255,255,.04);border-radius:8px;font-size:12px">
              <span style="color:#fff;font-weight:600">${p.pool_name || p.id}</span>
              <span style="color:rgba(255,255,255,.4)">${fmt.date(p.maturity_date)}</span>
              <span style="color:${urgency};font-weight:700">${d}d</span>
              <span style="color:#D4AF37;font-weight:600">${fmt.rand(parseFloat(p.raised_amount)||0)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}
    </div>
  </div>` : `
  <div class="panel mb-20">
    <div class="panel__hd"><div><div class="panel__title"><i class="fa-solid fa-hourglass-half" style="color:#fb923c;margin-right:8px"></i>Next Pool Maturity</div></div></div>
    <div class="panel__bd" style="text-align:center;padding:30px;color:rgba(255,255,255,.3)">
      <i class="fa-solid fa-layer-group" style="font-size:28px;margin-bottom:10px;opacity:.4"></i>
      <p style="margin:0;font-size:13px">No pools with maturity dates found</p>
    </div>
  </div>`;

  /* ── AI Suggestions panel ── */
  const suggestionsPanel = `
  <div class="panel">
    <div class="panel__hd">
      <div>
        <div class="panel__title"><i class="fa-solid fa-brain" style="color:#c084fc;margin-right:8px"></i>AI Deployment Recommendations</div>
        <div class="panel__sub">Rule-based heuristic engine · scored by return, risk, and concentration</div>
      </div>
    </div>
    <div class="panel__bd">
      <div style="display:flex;flex-direction:column;gap:14px">
        ${suggestions.map((s, i) => {
          const scoreColor = s.score >= 70 ? '#74c69d' : s.score >= 45 ? '#fbbf24' : s.score > 0 ? '#fb923c' : '#f87171';
          const scoreBg    = s.score >= 70 ? 'rgba(116,198,157,.1)' : s.score >= 45 ? 'rgba(251,191,36,.1)' : s.score > 0 ? 'rgba(251,146,60,.1)' : 'rgba(248,113,113,.1)';
          const rankBadge  = i === 0 && s.score > 0 ? `<span style="font-size:9px;background:rgba(168,85,247,.2);color:#c084fc;padding:2px 7px;border-radius:10px;font-weight:700;margin-left:8px">TOP PICK</span>` : '';
          return `
          <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:18px 20px;border-left:3px solid ${s.color}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:${s.color}22;flex-shrink:0">
                  <i class="fa-solid ${s.icon}" style="color:${s.color};font-size:15px"></i>
                </div>
                <div>
                  <div style="font-size:14px;font-weight:800;color:#fff">${s.title}${rankBadge}</div>
                  ${s.amount > 0 ? `<div style="font-size:12px;color:rgba(255,255,255,.4)">Suggested allocation: <strong style="color:${s.color}">${fmt.rand(s.amount)}</strong></div>` : ''}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
                ${s.returnEstimate != null ? `<div style="text-align:right">
                  <div style="font-size:10px;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.5px">Est. Return</div>
                  <div style="font-size:16px;font-weight:800;color:#74c69d">+${fmt.rand(s.returnEstimate)}</div>
                </div>` : ''}
                ${s.score > 0 ? `<div style="width:50px;height:50px;border-radius:50%;background:${scoreBg};border:2px solid ${scoreColor};display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0">
                  <div style="font-size:14px;font-weight:900;color:${scoreColor};line-height:1">${s.score}</div>
                  <div style="font-size:8px;color:rgba(255,255,255,.3);line-height:1">score</div>
                </div>` : ''}
              </div>
            </div>

            <p style="font-size:12px;color:rgba(255,255,255,.55);line-height:1.6;margin:0 0 12px">${s.reasoning}</p>

            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${s.actions.map(a => `<span style="font-size:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:3px 10px;color:rgba(255,255,255,.5)">${a}</span>`).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>

      <!-- AI disclaimer -->
      <div style="margin-top:20px;padding:12px 16px;background:rgba(168,85,247,.06);border:1px solid rgba(168,85,247,.15);border-radius:8px;display:flex;gap:10px;align-items:flex-start">
        <i class="fa-solid fa-circle-info" style="color:#c084fc;margin-top:1px;flex-shrink:0"></i>
        <p style="font-size:11px;color:rgba(255,255,255,.4);margin:0;line-height:1.5">
          <strong style="color:#c084fc">AI Disclaimer:</strong> Recommendations are generated by a rule-based heuristic engine using live platform data. Scores are indicative only and do not constitute financial advice. All deployment decisions require director approval and compliance review.
        </p>
      </div>
    </div>
  </div>`;

  /* ── Upcoming obligations table ── */
  const obligationsPanel = ctx.upcomingPayouts.length > 0 ? `
  <div class="panel mb-20">
    <div class="panel__hd">
      <div><div class="panel__title"><i class="fa-solid fa-calendar-days" style="color:#fb923c;margin-right:8px"></i>Upcoming Payout Obligations (90 days)</div>
      <div class="panel__sub">${ctx.upcomingPayouts.length} scheduled · ${fmt.rand(ctx.totalObligations90)} total</div></div>
    </div>
    <div class="tbl-wrap">
      <table class="data-table">
        <thead><tr><th>Investor</th><th>Pool</th><th>Payout Date</th><th class="text-right">Amount</th><th>Status</th><th>Urgency</th></tr></thead>
        <tbody>
          ${ctx.upcomingPayouts.slice(0,8).map(p => {
            const daysLeft = Math.max(0,Math.round((new Date(p.scheduled_payout_date)-new Date())/86400000));
            const urgColor = daysLeft <= 14 ? '#f87171' : daysLeft <= 30 ? '#fb923c' : '#fbbf24';
            return `<tr>
              <td><div class="td-h">${p.investor_name||'—'}</div></td>
              <td class="td-m">${p.pool_name||'—'}</td>
              <td class="td-m">${fmt.date(p.scheduled_payout_date)}</td>
              <td class="td-gold" style="text-align:right;font-weight:700">${fmt.rand(p.total_payout)}</td>
              <td>${schedStatusBadge(p.status)}</td>
              <td><span style="font-size:12px;font-weight:700;color:${urgColor}">${daysLeft}d</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>` : '';

  el.innerHTML = kpiRow + balancePanel + nextMaturityPanel + obligationsPanel + suggestionsPanel;
}

/* ═══════════════════════════════════════════════════════════════
   P2.1 — FEE LEDGER & REVENUE TRACKING
═══════════════════════════════════════════════════════════════ */
async function loadFees() {
  /* Show spinner in the ledger table body while data loads */
  const tbody = document.getElementById('feeLedgerBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:20px;color:rgba(255,255,255,.4)"><i class="fa-solid fa-spinner fa-spin"></i> Loading fee data…</td></tr>`;
  try {
    const fees = await intFetchAll('fee_ledger');
    S._feeCache = fees;
    renderFeeLedgerView(fees);
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:20px;color:#f87171"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load fee data: ${e.message}</td></tr>`;
  }
}

function renderFeeLedgerView(fees) {
  /* ── KPI Calculations ── */
  const totalEarned  = fees.reduce((s, f) => s + (parseFloat(f.fee_amount)||0), 0);
  const received     = fees.filter(f => f.status === 'received').reduce((s, f) => s + (parseFloat(f.fee_amount)||0), 0);
  const accrued      = fees.filter(f => f.status === 'accrued').reduce((s, f) => s + (parseFloat(f.fee_amount)||0), 0);
  const margin       = totalEarned > 0 ? ((received / totalEarned) * 100).toFixed(1) : '0.0';
  const totalCapBase = fees.reduce((s, f) => s + (parseFloat(f.capital_base)||0), 0);

  /* ── KPI cards ── */
  const kpiEl = document.getElementById('fee-total-earned');
  if (kpiEl) { kpiEl.textContent = fmt.rand(totalEarned); }
  const recvEl = document.getElementById('fee-received');
  if (recvEl) { recvEl.textContent = fmt.rand(received); }
  const accEl = document.getElementById('fee-accrued');
  if (accEl) { accEl.textContent = fmt.rand(accrued); }
  const margEl = document.getElementById('fee-margin');
  if (margEl) { margEl.textContent = margin + '%'; }
  /* fee-cap-base element removed from HTML — totalCapBase used in charts only */

  /* ── Charts ── */
  _renderFeeTypeChart(fees);
  _renderFeeProductChart(fees);
  _renderFeeTimelineChart(fees);

  /* ── Ledger table ── */
  renderFeeLedgerTable(fees);
}

function _renderFeeTypeChart(fees) {
  const canvas = document.getElementById('feeTypeChart');
  if (!canvas) return;
  if (S.charts.feeType) { S.charts.feeType.destroy(); }

  const types = {};
  fees.forEach(f => { const t = f.fee_type || 'Other'; types[t] = (types[t]||0) + (parseFloat(f.fee_amount)||0); });
  const labels = Object.keys(types);
  const data   = labels.map(k => types[k]);
  const COLORS  = ['#D4AF37','#74c69d','#60a5fa','#fb923c','#c084fc','#f472b6'];

  S.charts.feeType = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 2, borderColor: '#1a1a2e' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color:'rgba(255,255,255,.7)', padding:12, font:{ size:11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt.rand(ctx.raw)}` } }
      }
    }
  });
}

function _renderFeeProductChart(fees) {
  const canvas = document.getElementById('feeProductChart');
  if (!canvas) return;
  if (S.charts.feeProd) { S.charts.feeProd.destroy(); }

  const prods = {};
  fees.forEach(f => { const p = f.product_type || 'Unknown'; prods[p] = (prods[p]||0) + (parseFloat(f.fee_amount)||0); });
  const labels = Object.keys(prods);
  const data   = labels.map(k => prods[k]);
  const COLORS  = ['#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa'];

  S.charts.feeProd = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 2, borderColor: '#1a1a2e' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color:'rgba(255,255,255,.7)', padding:12, font:{ size:11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt.rand(ctx.raw)}` } }
      }
    }
  });
}

function _renderFeeTimelineChart(fees) {
  const canvas = document.getElementById('feeTimelineChart');
  if (!canvas) return;
  if (S.charts.feeTL) { S.charts.feeTL.destroy(); }

  /* Build monthly buckets for last 12 months */
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ label: d.toLocaleString('en-ZA', { month:'short', year:'2-digit' }), key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, total:0, received:0, accrued:0 });
  }

  fees.forEach(f => {
    if (!f.fee_date) return;
    const key = f.fee_date.slice(0,7);
    const bkt = months.find(m => m.key === key);
    if (!bkt) return;
    const amt = parseFloat(f.fee_amount)||0;
    bkt.total += amt;
    if (f.status === 'received') bkt.received += amt;
    else bkt.accrued += amt;
  });

  S.charts.feeTL = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        { label: 'Received', data: months.map(m => m.received), backgroundColor: 'rgba(116,198,157,.8)', borderRadius: 4 },
        { label: 'Accrued',  data: months.map(m => m.accrued),  backgroundColor: 'rgba(212,175,55,.5)',  borderRadius: 4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color:'rgba(255,255,255,.7)', font:{ size:11 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt.rand(ctx.raw)}` } }
      },
      scales: {
        x: { stacked: true, ticks: { color:'rgba(255,255,255,.5)', font:{ size:11 } }, grid: { color:'rgba(255,255,255,.04)' } },
        y: { stacked: true, ticks: { color:'rgba(255,255,255,.5)', font:{ size:11 }, callback: v => 'R'+Math.round(v/1000)+'k' }, grid: { color:'rgba(255,255,255,.06)' } }
      }
    }
  });
}

function renderFeeLedgerTable(fees, typeFilter, statusFilter) {
  const tbody = document.getElementById('feeLedgerBody');
  const sub   = document.getElementById('feeLedgerSub');
  if (!tbody) return;

  let rows = [...fees];
  if (typeFilter   && typeFilter !== 'all')   rows = rows.filter(f => f.fee_type === typeFilter);
  if (statusFilter && statusFilter !== 'all') rows = rows.filter(f => f.status === statusFilter);

  rows.sort((a,b) => (b.fee_date||'').localeCompare(a.fee_date||''));

  if (sub) sub.textContent = `${rows.length} entries · Total: ${fmt.rand(rows.reduce((s,f)=>s+(parseFloat(f.fee_amount)||0),0))}`;

  const statusBadge = s => {
    const cfg = { received: ['#74c69d','#052e16'], accrued: ['#fbbf24','#1c1400'], invoiced: ['#60a5fa','#0c1a2e'], waived: ['rgba(255,255,255,.3)','rgba(0,0,0,.4)'] };
    const [bg, fg] = cfg[s] || ['rgba(255,255,255,.15)','rgba(255,255,255,.6)'];
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${(s||'').toUpperCase()}</span>`;
  };

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:rgba(255,255,255,.3)">No fee entries match filters</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(f => `
    <tr>
      <td class="td-m" style="color:rgba(255,255,255,.5);font-size:11px">${fmt.date(f.fee_date)}</td>
      <td class="td-m" style="font-weight:600;color:#fff">${f.run_name || f.run_id || '—'}</td>
      <td class="td-m"><span style="background:rgba(212,175,55,.15);color:#D4AF37;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${f.product_type||'—'}</span></td>
      <td class="td-m"><span style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);padding:2px 8px;border-radius:10px;font-size:11px">${f.fee_type||'—'}</span></td>
      <td class="td-m" style="text-align:right;color:rgba(255,255,255,.5)">${fmt.rand(parseFloat(f.capital_base)||0)}</td>
      <td class="td-m" style="text-align:right;color:rgba(255,255,255,.5);font-size:12px">${f.fee_rate ? (parseFloat(f.fee_rate)*100).toFixed(2)+'%' : '—'}</td>
      <td class="td-gold" style="text-align:right;font-weight:700">${fmt.rand(parseFloat(f.fee_amount)||0)}</td>
      <td>${statusBadge(f.status)}</td>
      <td class="td-m" style="color:rgba(255,255,255,.35);font-size:11px">${f.invoice_ref||'—'}</td>
    </tr>`).join('');
}

function applyFeeFilters() {
  const typeF   = document.getElementById('feeTypeFilter')?.value   || 'all';
  const statusF = document.getElementById('feeStatusFilter')?.value || 'all';
  if (S._feeCache) renderFeeLedgerTable(S._feeCache, typeF, statusF);
}

function exportFeeLedger() {
  const fees = S._feeCache || [];
  if (!fees.length) { T.warn('No fee data to export.'); return; }
  const headers = ['Date','Run','Product','Fee Type','Rate %','Capital Base','Fee Amount','Status','Invoice Ref'];
  const rows = fees.map(f => [
    f.fee_date||'', f.run_name||'', f.product_type||'', f.fee_type||'',
    f.fee_rate ? (parseFloat(f.fee_rate)*100).toFixed(2) : '',
    parseFloat(f.capital_base)||0, parseFloat(f.fee_amount)||0,
    f.status||'', f.invoice_ref||''
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `fee_ledger_${new Date().toISOString().slice(0,10)}.csv` });
  a.click();
  T.success('Fee ledger exported');
}

/* ═══════════════════════════════════════════════════════════════
   P2.2 — RISK DASHBOARD
═══════════════════════════════════════════════════════════════ */
async function loadRiskDashboard() {
  /* Show spinners in the data panels while loading */
  const riskConc = document.getElementById('riskConcentrationBody');
  if (riskConc) riskConc.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:rgba(255,255,255,.4)"><i class="fa-solid fa-spinner fa-spin"></i></td></tr>`;
  const riskLP = document.getElementById('riskLoanPanel');
  if (riskLP) riskLP.innerHTML = `<div style="text-align:center;padding:20px;color:rgba(255,255,255,.3)"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
  const riskSP = document.getElementById('riskSolarPanel');
  if (riskSP) riskSP.innerHTML = `<div style="text-align:center;padding:20px;color:rgba(255,255,255,.3)"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>`;
  try {
    const [solar, loans, cattle, runs, pools, allocations] = await Promise.all([
      intFetchAll('solar_projects').catch(()=>[]),
      intFetchAll('shortterm_loans').catch(()=>[]),
      intFetchAll('cattle_cycles').catch(()=>[]),
      intFetchAll('fund_runs').catch(()=>[]),
      intFetchAll('fund_pools').catch(()=>[]),
      intFetchAll('investor_allocations').catch(()=>[])
    ]);
    renderRiskDashboard({ solar, loans, cattle, runs, pools, allocations });
  } catch(e) {
    T.error('Risk analysis failed: ' + e.message);
  }
}

function renderRiskDashboard({ solar, loans, cattle, runs, pools, allocations }) {
  /* ── Compute total AUM by product ── */
  const solarAUM  = solar.reduce((s,p) => s + (parseFloat(p.capital_invested)||parseFloat(p.capital)||0), 0);
  const loansAUM  = loans.reduce((s,l) => s + (parseFloat(l.loan_amount)||parseFloat(l.principal)||0), 0);
  const cattleAUM = cattle.reduce((s,c) => s + (parseFloat(c.total_purchase_cost)||parseFloat(c.purchase_value)||0), 0);
  const totalAUM  = solarAUM + loansAUM + cattleAUM || 1;

  /* ── HHI Calculation ── */
  const shares = [solarAUM/totalAUM, loansAUM/totalAUM, cattleAUM/totalAUM].map(s => s*100);
  const hhi    = Math.round(shares.reduce((sum, s) => sum + s*s, 0));

  /* ── Default / Overdue metrics ── */
  const overdueLoans   = loans.filter(l => l.status === 'overdue' || l.status === 'defaulted');
  const defaultRate    = loans.length > 0 ? ((overdueLoans.length / loans.length)*100).toFixed(1) : '0.0';
  const overdueExp     = overdueLoans.reduce((s,l) => s + (parseFloat(l.loan_amount)||0), 0);

  /* ── Top concentration ── */
  const topShare = Math.max(...shares).toFixed(1);

  /* ── Update KPI cards ── */
  const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  setTxt('risk-default-rate',     defaultRate + '%');
  setTxt('risk-overdue-exposure', fmt.rand(overdueExp));
  setTxt('risk-top-concentration', topShare + '%');
  setTxt('risk-hhi', hhi.toString());

  /* ── HHI colouring ── */
  const hhiEl = document.getElementById('risk-hhi');
  if (hhiEl) {
    hhiEl.style.color = hhi < 1500 ? '#74c69d' : hhi < 2500 ? '#fbbf24' : '#f87171';
  }
  const hhiBadge = document.getElementById('risk-hhi-badge');
  if (hhiBadge) {
    hhiBadge.textContent = hhi < 1500 ? 'DIVERSIFIED' : hhi < 2500 ? 'MODERATE' : 'CONCENTRATED';
    hhiBadge.style.color = hhi < 1500 ? '#74c69d' : hhi < 2500 ? '#fbbf24' : '#f87171';
  }

  /* ── Risk alert badge ── */
  const riskAlerts = (hhi >= 2500 ? 1 : 0) + (parseFloat(defaultRate) >= 10 ? 1 : 0);
  const rBadge = document.getElementById('riskAlertBadge');
  if (rBadge) {
    rBadge.style.display = riskAlerts > 0 ? '' : 'none';
    rBadge.textContent = riskAlerts > 0 ? '!' : '';
  }

  /* ── Charts ── */
  _renderConcentrationChart({ solarAUM, loansAUM, cattleAUM, totalAUM });
  _renderVintageChart(allocations);

  /* ── Concentration table ── */
  renderConcentrationTable({ solarAUM, loansAUM, cattleAUM, totalAUM, shares });

  /* ── Product risk panels ── */
  renderLoanStressPanel(loans);
  renderSolarRiskPanel(solar);
}

function _renderConcentrationChart({ solarAUM, loansAUM, cattleAUM }) {
  const canvas = document.getElementById('riskConcentrationChart');
  if (!canvas) return;
  if (S.charts.riskConc) S.charts.riskConc.destroy();

  S.charts.riskConc = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Solar', 'Short-Term Loans', 'Cattle'],
      datasets: [{
        data: [solarAUM, loansAUM, cattleAUM],
        backgroundColor: ['#D4AF37','#60a5fa','#34d399'],
        borderWidth: 2, borderColor: '#1a1a2e'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color:'rgba(255,255,255,.7)', padding:12, font:{size:11} } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt.rand(ctx.raw)}` } }
      }
    }
  });
}

function _renderVintageChart(allocations) {
  const canvas = document.getElementById('riskVintageChart');
  if (!canvas) return;
  if (S.charts.riskVintage) S.charts.riskVintage.destroy();

  /* Group capital by start year */
  const byYear = {};
  allocations.forEach(a => {
    const yr = a.start_date ? new Date(a.start_date).getFullYear() : 0;
    if (!yr) return;
    byYear[yr] = (byYear[yr]||0) + (parseFloat(a.capital_paid)||parseFloat(a.capital_committed)||0);
  });
  const years = Object.keys(byYear).sort();
  const data  = years.map(y => byYear[y]);

  S.charts.riskVintage = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'Capital Deployed',
        data,
        backgroundColor: years.map((_,i) => i === years.length-1 ? '#D4AF37' : 'rgba(212,175,55,.35)'),
        borderRadius: 6, borderSkipped: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display:false },
        tooltip: { callbacks: { label: ctx => ` Capital: ${fmt.rand(ctx.raw)}` } }
      },
      scales: {
        x: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:11} }, grid:{ color:'rgba(255,255,255,.04)' } },
        y: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:11}, callback: v => 'R'+Math.round(v/1e6)+'M' }, grid:{ color:'rgba(255,255,255,.06)' } }
      }
    }
  });
}

function renderConcentrationTable({ solarAUM, loansAUM, cattleAUM, totalAUM }) {
  const tbody = document.getElementById('riskConcentrationBody');
  if (!tbody) return;
  const rows = [
    { product:'Solar Projects',     aum: solarAUM,  color:'#D4AF37' },
    { product:'Short-Term Loans',   aum: loansAUM,  color:'#60a5fa' },
    { product:'Cattle / Livestock', aum: cattleAUM, color:'#34d399' }
  ];
  tbody.innerHTML = rows.map(r => {
    const pct      = totalAUM > 0 ? ((r.aum/totalAUM)*100).toFixed(1) : '0.0';
    const pctN     = parseFloat(pct);
    const hhiComp  = Math.round(pctN * pctN);  /* HHI contribution = share%² */
    const riskColor= pctN < 25 ? '#74c69d' : pctN < 40 ? '#fbbf24' : '#f87171';
    const riskLabel= pctN < 25 ? 'LOW' : pctN < 40 ? 'MODERATE' : 'HIGH';
    const alertIcon= pctN >= 40 ? `<i class="fa-solid fa-triangle-exclamation" style="color:#f87171"></i>` :
                     pctN >= 25 ? `<i class="fa-solid fa-circle-exclamation" style="color:#fbbf24"></i>` :
                                  `<i class="fa-solid fa-circle-check" style="color:#74c69d"></i>`;
    const barWidth = Math.min(100, pctN);
    return `
    <tr>
      <td class="td-m"><span style="display:inline-flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:50%;background:${r.color};flex-shrink:0"></span>${r.product}</span></td>
      <td class="td-m" style="text-align:right;font-weight:700;color:#fff">${fmt.rand(r.aum)}</td>
      <td class="td-m" style="text-align:right;font-weight:700;color:${riskColor}">${pct}%</td>
      <td class="td-m" style="text-align:right;color:rgba(255,255,255,.5)">${hhiComp}</td>
      <td class="td-m" style="min-width:120px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;background:rgba(255,255,255,.06);border-radius:4px;height:6px;overflow:hidden">
            <div style="width:${barWidth}%;height:100%;background:${r.color};border-radius:4px;transition:.4s"></div>
          </div>
          <span style="background:${riskColor}22;color:${riskColor};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap">${riskLabel}</span>
        </div>
      </td>
      <td class="td-m" style="text-align:center">${alertIcon}</td>
    </tr>`;
  }).join('');
}

function renderLoanStressPanel(loans) {
  const el = document.getElementById('riskLoanPanel');
  if (!el) return;
  if (!loans.length) { el.innerHTML = `<p style="color:rgba(255,255,255,.3);text-align:center;padding:20px">No loan data available</p>`; return; }

  const active   = loans.filter(l => l.status === 'active'||l.status === 'approved');
  const overdue  = loans.filter(l => l.status === 'overdue');
  const defaultd = loans.filter(l => l.status === 'defaulted');
  const paid     = loans.filter(l => l.status === 'paid'||l.status === 'settled');
  const totalAmt = loans.reduce((s,l) => s+(parseFloat(l.loan_amount)||0), 0);
  const overAmt  = overdue.reduce((s,l) => s+(parseFloat(l.loan_amount)||0), 0);

  el.innerHTML = `
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
    ${[
      ['Active',   active.length,   '#74c69d'],
      ['Overdue',  overdue.length,  '#fbbf24'],
      ['Defaulted',defaultd.length, '#f87171'],
      ['Paid',     paid.length,     'rgba(255,255,255,.3)']
    ].map(([l,v,c]) => `<div style="background:rgba(255,255,255,.04);border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:${c}">${v}</div>
      <div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:2px">${l}</div>
    </div>`).join('')}
  </div>
  <div style="margin-bottom:14px;font-size:12px;color:rgba(255,255,255,.5)">
    Total exposure: <strong style="color:#fff">${fmt.rand(totalAmt)}</strong> · Overdue exposure: <strong style="color:#fbbf24">${fmt.rand(overAmt)}</strong>
  </div>
  ${loans.length > 0 ? `
  <div style="overflow-x:auto">
    <table class="data-table" style="font-size:12px">
      <thead><tr>
        <th>Borrower</th><th>Amount</th><th>Rate</th><th>Status</th><th>Maturity</th>
      </tr></thead>
      <tbody>
        ${loans.slice(0,8).map(l => {
          const s = l.status||'unknown';
          const sc = s==='overdue'?'#fbbf24':s==='defaulted'?'#f87171':s==='paid'||s==='settled'?'#74c69d':'rgba(255,255,255,.5)';
          const daysLeft = l.end_date ? Math.round((new Date(l.end_date)-new Date())/86400000) : null;
          return `<tr>
            <td class="td-m" style="font-weight:600">${l.borrower_name||l.borrower||'—'}</td>
            <td class="td-m" style="text-align:right">${fmt.rand(parseFloat(l.loan_amount)||0)}</td>
            <td class="td-m" style="text-align:right">${l.interest_rate ? (parseFloat(l.interest_rate)*100).toFixed(1)+'%' : '—'}</td>
            <td class="td-m"><span style="color:${sc};font-weight:700;font-size:11px">${s.toUpperCase()}</span></td>
            <td class="td-m" style="color:${daysLeft!=null&&daysLeft<14?'#f87171':daysLeft!=null&&daysLeft<30?'#fbbf24':'rgba(255,255,255,.4)'}">${daysLeft!=null ? daysLeft+'d' : (l.end_date ? fmt.date(l.end_date) : '—')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>` : ''}`;
}

function renderSolarRiskPanel(solar) {
  const el = document.getElementById('riskSolarPanel');
  if (!el) return;
  if (!solar.length) { el.innerHTML = `<p style="color:rgba(255,255,255,.3);text-align:center;padding:20px">No solar data available</p>`; return; }

  const now       = new Date();
  const active    = solar.filter(p => p.status === 'active');
  const maturing  = solar.filter(p => p.maturity_date && Math.round((new Date(p.maturity_date)-now)/86400000) <= 90 && Math.round((new Date(p.maturity_date)-now)/86400000) > 0);
  const rates     = solar.map(p => parseFloat(p.annual_rate||p.interest_rate)||0).filter(r => r > 0);
  const avgRate   = rates.length ? (rates.reduce((s,r)=>s+r,0)/rates.length*100).toFixed(1) : '—';
  const minRate   = rates.length ? (Math.min(...rates)*100).toFixed(1) : '—';
  const maxRate   = rates.length ? (Math.max(...rates)*100).toFixed(1) : '—';
  const totalCap  = solar.reduce((s,p)=>s+(parseFloat(p.capital_invested)||parseFloat(p.capital)||0),0);

  el.innerHTML = `
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
    ${[
      ['Total Projects', solar.length, '#D4AF37'],
      ['Active', active.length, '#74c69d'],
      ['Maturing <90d', maturing.length, '#fbbf24']
    ].map(([l,v,c]) => `<div style="background:rgba(255,255,255,.04);border-radius:10px;padding:12px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:${c}">${v}</div>
      <div style="font-size:11px;color:rgba(255,255,255,.4);margin-top:2px">${l}</div>
    </div>`).join('')}
  </div>
  <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:rgba(255,255,255,.5)">
    <span>Total capital: <strong style="color:#D4AF37">${fmt.rand(totalCap)}</strong></span>
    <span>Rate range: <strong style="color:#fff">${minRate}% — ${maxRate}%</strong></span>
    <span>Avg rate: <strong style="color:#74c69d">${avgRate}%</strong></span>
  </div>
  <div style="overflow-x:auto">
    <table class="data-table" style="font-size:12px">
      <thead><tr><th>Project</th><th>Capital</th><th>Rate</th><th>Maturity</th><th>Status</th></tr></thead>
      <tbody>
        ${solar.slice(0,6).map(p => {
          const daysLeft = p.maturity_date ? Math.round((new Date(p.maturity_date)-now)/86400000) : null;
          const urgColor = daysLeft!=null && daysLeft < 30 ? '#fbbf24' : daysLeft!=null && daysLeft < 0 ? '#f87171' : 'rgba(255,255,255,.4)';
          return `<tr>
            <td class="td-m" style="font-weight:600">${p.project_name||p.name||'—'}</td>
            <td class="td-m" style="text-align:right">${fmt.rand(parseFloat(p.capital_invested||p.capital)||0)}</td>
            <td class="td-m" style="text-align:right">${p.annual_rate ? (parseFloat(p.annual_rate)*100).toFixed(1)+'%' : '—'}</td>
            <td class="td-m" style="color:${urgColor}">${daysLeft!=null ? daysLeft+'d' : (p.maturity_date ? fmt.date(p.maturity_date) : '—')}</td>
            <td class="td-m"><span style="font-size:11px;font-weight:700;color:${p.status==='active'?'#74c69d':'rgba(255,255,255,.4)'}">${(p.status||'—').toUpperCase()}</span></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   P2.4 — NOTIFICATION CENTRE
═══════════════════════════════════════════════════════════════ */
async function loadNotifications() {
  const list = document.getElementById('notifList');
  if (list) list.innerHTML = `<div style="text-align:center;padding:40px;color:rgba(255,255,255,.4)"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px"></i></div>`;
  try {
    const notifs = await intFetchAll('fund_notifications');
    notifs.sort((a,b) => {
      const ta = parseInt(b.notified_at||b.created_at||0);
      const tb = parseInt(a.notified_at||a.created_at||0);
      return ta - tb;
    });
    S._notifCache = notifs;
    renderNotifications(notifs);
    updateNotifBadges();
  } catch(e) {
    if (list) list.innerHTML = `<div class="panel"><div class="panel__bd" style="color:#f87171;padding:30px;text-align:center"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load notifications: ${e.message}</div></div>`;
  }
}

function renderNotifications(notifs, catFilter, sevFilter) {
  const list = document.getElementById('notifList');
  if (!list) return;

  let rows = [...(notifs || S._notifCache || [])].filter(n => !n.is_dismissed);
  if (catFilter && catFilter !== 'all') rows = rows.filter(n => n.category === catFilter);
  if (sevFilter && sevFilter !== 'all') rows = rows.filter(n => n.severity === sevFilter);

  const sub = document.getElementById('notifSubtitle');
  const unread = rows.filter(n => !n.is_read).length;
  if (sub) sub.textContent = `${rows.length} alerts · ${unread} unread`;

  if (!rows.length) {
    list.innerHTML = `<div class="panel"><div class="panel__bd" style="text-align:center;padding:40px;color:rgba(255,255,255,.3)">
      <i class="fa-solid fa-bell-slash" style="font-size:32px;opacity:.4;margin-bottom:12px;display:block"></i>
      <p style="margin:0;font-size:13px">No notifications match the selected filters</p>
    </div></div>`;
    return;
  }

  const sevConfig = {
    critical: { color:'#f87171', bg:'rgba(248,113,113,.1)', border:'rgba(248,113,113,.3)', icon:'fa-circle-xmark' },
    warning:  { color:'#fbbf24', bg:'rgba(251,191,36,.1)',  border:'rgba(251,191,36,.3)',  icon:'fa-triangle-exclamation' },
    info:     { color:'#60a5fa', bg:'rgba(96,165,250,.1)',  border:'rgba(96,165,250,.25)', icon:'fa-circle-info' },
    success:  { color:'#74c69d', bg:'rgba(116,198,157,.1)', border:'rgba(116,198,157,.25)',icon:'fa-circle-check' }
  };

  list.innerHTML = rows.map(n => {
    const cfg = sevConfig[n.severity] || sevConfig.info;
    const isUnread = !n.is_read;
    const ts = n.notified_at ? new Date(n.notified_at) : new Date(parseInt(n.created_at||0));
    const timeStr = isNaN(ts) ? '' : ts.toLocaleString('en-ZA', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    return `
    <div class="notif-card ${isUnread ? 'notif-card--unread' : ''}" id="notif-${n.id}"
         style="background:${cfg.bg};border:1px solid ${isUnread ? cfg.border : 'rgba(255,255,255,.06)'};border-left:3px solid ${cfg.color};
                border-radius:12px;padding:16px 18px;margin-bottom:10px;cursor:pointer;transition:opacity .2s"
         onclick="markNotifRead('${n.id}')">
      <div style="display:flex;align-items:flex-start;gap:14px">
        <div style="width:36px;height:36px;border-radius:9px;background:${cfg.bg};border:1px solid ${cfg.border};display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="fa-solid ${cfg.icon}" style="color:${cfg.color};font-size:15px"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
            <div>
              <div style="font-size:13px;font-weight:${isUnread?'700':'600'};color:${isUnread?'#fff':'rgba(255,255,255,.75)'}">
                ${isUnread ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${cfg.color};margin-right:7px;vertical-align:middle"></span>` : ''}
                ${n.title||'Notification'}
              </div>
              <div style="font-size:12px;color:rgba(255,255,255,.5);margin-top:3px;line-height:1.5">${n.message||''}</div>
              ${n.entity_name ? `<div style="font-size:11px;color:rgba(255,255,255,.3);margin-top:5px"><i class="fa-solid fa-link" style="margin-right:4px;opacity:.6"></i>${n.entity_type||''}: <strong style="color:rgba(255,255,255,.5)">${n.entity_name}</strong></div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
              <span style="font-size:10px;color:rgba(255,255,255,.3);white-space:nowrap">${timeStr}</span>
              <div style="display:flex;gap:6px">
                <span style="background:${cfg.color}22;color:${cfg.color};padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;text-transform:uppercase">${n.severity||'info'}</span>
                <span style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.4);padding:1px 7px;border-radius:8px;font-size:10px;text-transform:uppercase">${n.category||'general'}</span>
              </div>
              <button onclick="event.stopPropagation();dismissNotif('${n.id}')"
                      style="background:none;border:none;color:rgba(255,255,255,.25);cursor:pointer;font-size:11px;padding:2px 6px;border-radius:4px;transition:.2s"
                      title="Dismiss" onmouseover="this.style.color='rgba(248,113,113,.7)'" onmouseout="this.style.color='rgba(255,255,255,.25)'">
                <i class="fa-solid fa-xmark"></i> Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function markNotifRead(id) {
  const notif = (S._notifCache||[]).find(n => n.id === id);
  if (!notif || notif.is_read) return;
  try {
    await apiFetch(`tables/fund_notifications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ is_read: true })
    });
    notif.is_read = true;
    /* Visually update card */
    const card = document.getElementById('notif-'+id);
    if (card) {
      card.classList.remove('notif-card--unread');
      card.querySelector('[style*="font-weight:700"]')?.style && (card.querySelector('[style*="font-weight:700"]').style.fontWeight = '600');
      const dot = card.querySelector('[style*="border-radius:50%"]');
      if (dot) dot.remove();
    }
    updateNotifBadges();
  } catch(e) { /* non-blocking */ }
}

async function markAllNotifsRead() {
  const unread = (S._notifCache||[]).filter(n => !n.is_read && !n.is_dismissed);
  if (!unread.length) { T.info('All notifications already read.'); return; }
  try {
    await Promise.all(unread.map(n => apiFetch(`tables/fund_notifications/${n.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ is_read: true })
    })));
    unread.forEach(n => { n.is_read = true; });
    renderNotifications();
    updateNotifBadges();
    T.success(`${unread.length} notifications marked as read`);
  } catch(e) {
    T.error('Failed to mark all read: ' + e.message);
  }
}

async function dismissNotif(id) {
  try {
    await apiFetch(`tables/fund_notifications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ is_dismissed: true })
    });
    if (S._notifCache) S._notifCache = S._notifCache.filter(n => n.id !== id);
    const card = document.getElementById('notif-'+id);
    if (card) { card.style.opacity = '0'; setTimeout(()=>card.remove(), 200); }
    updateNotifBadges();
  } catch(e) {
    T.error('Could not dismiss notification');
  }
}

async function updateNotifBadges() {
  try {
    /* Use cached data if available to avoid extra API calls */
    const notifs = S._notifCache || await intFetchAll('fund_notifications').catch(()=>[]);
    if (!S._notifCache) S._notifCache = notifs;

    const unread    = notifs.filter(n => !n.is_read && !n.is_dismissed).length;
    const riskCount = notifs.filter(n => !n.is_read && !n.is_dismissed && n.severity==='critical').length;

    const badge1 = document.getElementById('unreadNotifBadge');
    if (badge1) {
      badge1.style.display = unread > 0 ? '' : 'none';
      badge1.textContent   = unread > 9 ? '9+' : String(unread);
    }
    const badge2 = document.getElementById('topbarNotifCount');
    if (badge2) {
      badge2.style.display = unread > 0 ? '' : 'none';
      badge2.textContent   = unread > 9 ? '9+' : String(unread);
    }
    const badge3 = document.getElementById('riskAlertBadge');
    if (badge3 && riskCount > 0) {
      badge3.style.display = '';
      badge3.textContent   = '!';
    }
  } catch(e) { /* silent */ }
}

function applyNotifFilters() {
  const cat = document.getElementById('notifCategoryFilter')?.value || 'all';
  const sev = document.getElementById('notifSeverityFilter')?.value || 'all';
  renderNotifications(S._notifCache, cat !== 'all' ? cat : null, sev !== 'all' ? sev : null);
}

/* ═══════════════════════════════════════════════════════════════
   P3.2 — INVESTOR RETURN STATEMENT (Print Window)
═══════════════════════════════════════════════════════════════ */
async function printInvestorStatement(allocId) {
  /* Find allocation — prefer live S.allocations, fall back to API */
  let a = (S.allocations || []).find(x => x.id === allocId);
  if (!a) {
    try {
      const res = await apiFetch(`tables/investor_allocations/${allocId}`);
      a = await res.json();
    } catch(e) { T.error('Could not load allocation data'); return; }
  }
  if (!a) { T.error('Allocation not found'); return; }

  /* ── Derived values ── */
  const capitalPaid    = parseFloat(a.capital_paid)    || 0;
  const annualRate     = parseFloat(a.annual_rate)     || 0;
  const expectedPayout = parseFloat(a.expected_payout) || 0;
  const termDays       = parseInt(a.term_days)         || 0;
  const grossReturn    = expectedPayout - capitalPaid;
  const returnPct      = capitalPaid > 0 ? ((grossReturn / capitalPaid) * 100).toFixed(2) : '0.00';

  /* Accrued return to today */
  const startMs   = a.start_date ? new Date(a.start_date).getTime() : 0;
  const todayMs   = Date.now();
  const elapsedDays = Math.max(0, Math.round((todayMs - startMs) / 86400000));
  const dailyRate   = annualRate / 365;
  const accruedReturn = capitalPaid * dailyRate * elapsedDays;
  const currentNAV    = capitalPaid + accruedReturn;

  /* Payment schedule */
  const payDate = a.maturity_date ? fmt.date(a.maturity_date) : '—';
  const today   = new Date().toLocaleDateString('en-ZA', { day:'2-digit', month:'long', year:'numeric' });
  const refNum  = `SVC-INV-${allocId.slice(-8).toUpperCase()}`;
  const productLabel = (a.product_type || 'Investment').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());

  /* ── Build print HTML ── */
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Investor Return Statement — ${a.investor_name || 'Investor'}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; padding: 0; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 18mm 18mm 14mm 18mm; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5px solid #1a3a4a; padding-bottom: 14px; margin-bottom: 22px; }
  .logo-block .company { font-size: 18pt; font-weight: 900; color: #1a3a4a; letter-spacing: .04em; }
  .logo-block .tagline { font-size: 8pt; color: #6b7280; letter-spacing: .08em; text-transform: uppercase; margin-top: 2px; }
  .logo-block .fsp    { font-size: 8pt; color: #9ca3af; margin-top: 3px; }
  .doc-info { text-align: right; }
  .doc-info .doc-title { font-size: 14pt; font-weight: 800; color: #1a3a4a; }
  .doc-info .doc-ref   { font-size: 8.5pt; color: #6b7280; margin-top: 3px; }
  .doc-info .doc-date  { font-size: 8.5pt; color: #6b7280; }

  /* Section headings */
  .section-head { font-size: 9pt; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: #fff; background: #1a3a4a; padding: 6px 10px; border-radius: 4px; margin: 22px 0 10px; }

  /* Data grid */
  .data-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 30px; margin-bottom: 6px; }
  .data-row { display: flex; flex-direction: column; }
  .data-label { font-size: 7.5pt; color: #9ca3af; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 2px; }
  .data-value { font-size: 10.5pt; font-weight: 700; color: #1a1a1a; }

  /* Return summary box */
  .return-box { background: #f8fafc; border: 1.5px solid #e5e7eb; border-radius: 8px; padding: 16px 20px; margin: 18px 0; }
  .return-box table { width: 100%; border-collapse: collapse; }
  .return-box th { text-align: left; font-size: 8.5pt; color: #6b7280; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid #e5e7eb; }
  .return-box td { font-size: 10pt; padding: 7px 6px; border-bottom: 1px solid #f3f4f6; }
  .return-box td.amt { text-align: right; font-weight: 700; font-size: 11pt; }
  .return-box td.highlight { color: #059669; font-weight: 800; }
  .return-box tr.total td { border-top: 2px solid #1a3a4a; font-weight: 800; font-size: 12pt; background: #f0f9f5; }
  .return-box tr.total td.amt { color: #059669; }

  /* NAV pill */
  .nav-row { display: flex; gap: 16px; margin: 14px 0; }
  .nav-pill { flex: 1; background: #fffbeb; border: 1.5px solid #fde68a; border-radius: 8px; padding: 12px 14px; text-align: center; }
  .nav-pill.green { background: #f0fdf4; border-color: #86efac; }
  .nav-pill.blue  { background: #eff6ff; border-color: #bfdbfe; }
  .nav-pill-label { font-size: 7.5pt; color: #9ca3af; text-transform: uppercase; margin-bottom: 4px; }
  .nav-pill-value { font-size: 14pt; font-weight: 800; }
  .nav-pill-value.gold  { color: #d97706; }
  .nav-pill-value.green { color: #059669; }
  .nav-pill-value.blue  { color: #2563eb; }

  /* Disclaimer */
  .disclaimer { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; margin-top: 28px; }
  .disclaimer p { font-size: 7.5pt; color: #9ca3af; line-height: 1.6; margin-bottom: 4px; }
  .disclaimer p:last-child { margin: 0; }
  .disclaimer strong { color: #6b7280; }

  /* Footer */
  .footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; font-size: 7.5pt; color: #9ca3af; }

  /* Print overrides */
  @page { size: A4; margin: 0; }
  @media print {
    body { background: #fff; }
    .page { padding: 14mm 16mm 12mm 16mm; width: 100%; }
    .no-print { display: none !important; }
  }

  /* Action bar — screen only */
  .action-bar { background: #1a3a4a; color: #fff; padding: 12px 20px; display: flex; gap: 12px; align-items: center; justify-content: flex-end; }
  .action-bar button { background: #FF8215; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-size: 11pt; font-weight: 700; cursor: pointer; }
  .action-bar .close-btn { background: rgba(255,255,255,.12); }
</style>
</head>
<body>
<div class="action-bar no-print">
  <button onclick="window.print()"><i style="margin-right:6px">&#128424;</i> Print / Save PDF</button>
  <button class="close-btn" onclick="window.close()">Close</button>
</div>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="logo-block">
      <div class="company">SV CAPITAL</div>
      <div class="tagline">SmartVest Financial Services (Pty) Ltd</div>
      <div class="fsp">Authorised FSP #52449 · FSCA Regulated</div>
    </div>
    <div class="doc-info">
      <div class="doc-title">Investor Return Statement</div>
      <div class="doc-ref">Ref: ${refNum}</div>
      <div class="doc-date">Issued: ${today}</div>
    </div>
  </div>

  <!-- Investor Details -->
  <div class="section-head">Investor Details</div>
  <div class="data-grid">
    <div class="data-row"><div class="data-label">Full Name</div><div class="data-value">${a.investor_name || '—'}</div></div>
    <div class="data-row"><div class="data-label">Email Address</div><div class="data-value">${a.investor_email || '—'}</div></div>
    <div class="data-row"><div class="data-label">ID / Entity Ref</div><div class="data-value">${a.investor_id || '—'}</div></div>
    <div class="data-row"><div class="data-label">Account Status</div><div class="data-value">${(a.status || '—').toUpperCase()}</div></div>
  </div>

  <!-- Investment Details -->
  <div class="section-head">Investment Details</div>
  <div class="data-grid">
    <div class="data-row"><div class="data-label">Product</div><div class="data-value">${productLabel}</div></div>
    <div class="data-row"><div class="data-label">Deployment</div><div class="data-value">${a.entity_name || '—'}</div></div>
    <div class="data-row"><div class="data-label">Start Date</div><div class="data-value">${fmt.date(a.start_date)}</div></div>
    <div class="data-row"><div class="data-label">Maturity Date</div><div class="data-value">${payDate}</div></div>
    <div class="data-row"><div class="data-label">Term</div><div class="data-value">${termDays ? termDays + ' days' : '—'}</div></div>
    <div class="data-row"><div class="data-label">Annual Rate</div><div class="data-value">${(annualRate * 100).toFixed(2)}% p.a.</div></div>
    <div class="data-row"><div class="data-label">Allocation %</div><div class="data-value">${(parseFloat(a.allocation_pct)||0).toFixed(2)}%</div></div>
    <div class="data-row"><div class="data-label">Days Elapsed</div><div class="data-value">${elapsedDays} days (as at ${today})</div></div>
  </div>

  <!-- Live NAV Snapshot -->
  <div class="section-head">Current Value Snapshot</div>
  <div class="nav-row">
    <div class="nav-pill">
      <div class="nav-pill-label">Capital Invested</div>
      <div class="nav-pill-value gold">R ${capitalPaid.toLocaleString('en-ZA', {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
    </div>
    <div class="nav-pill green">
      <div class="nav-pill-label">Accrued Return (today)</div>
      <div class="nav-pill-value green">+ R ${accruedReturn.toLocaleString('en-ZA', {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
    </div>
    <div class="nav-pill blue">
      <div class="nav-pill-label">Current NAV</div>
      <div class="nav-pill-value blue">R ${currentNAV.toLocaleString('en-ZA', {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
    </div>
  </div>

  <!-- Return Summary -->
  <div class="section-head">Return Summary at Maturity</div>
  <div class="return-box">
    <table>
      <thead><tr><th>Description</th><th style="text-align:right">Amount (ZAR)</th></tr></thead>
      <tbody>
        <tr><td>Capital Invested</td><td class="amt">R ${capitalPaid.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>
        <tr><td>Gross Return (${(annualRate*100).toFixed(2)}% p.a. × ${termDays} days)</td><td class="amt highlight">+ R ${grossReturn.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>
        <tr class="total"><td>Expected Total Payout on ${payDate}</td><td class="amt">R ${expectedPayout.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</td></tr>
      </tbody>
    </table>
  </div>
  ${a.notes ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:9pt;color:#78350f"><strong>Notes:</strong> ${a.notes}</div>` : ''}

  <!-- Disclaimer -->
  <div class="disclaimer">
    <p><strong>Important Notice:</strong> This statement is issued by SmartVest Financial Services (Pty) Ltd (FSP #52449), an Authorised Financial Services Provider regulated by the Financial Sector Conduct Authority (FSCA) of South Africa.</p>
    <p>Returns shown are based on the contractual rate agreed at inception. Actual returns may vary subject to the terms and conditions of the investment product. Past performance is not a guarantee of future returns.</p>
    <p>This document is for informational purposes only and does not constitute financial advice. Investors are advised to consult their financial adviser regarding their investment portfolio.</p>
    <p><strong>For queries:</strong> invest@svcapital.co.za · +27 (0)11 000 0000 · www.svcapital.co.za</p>
  </div>

  <!-- Footer -->
  <div class="footer">
    <span>SmartVest Financial Services (Pty) Ltd · Reg No. 2018/000000/07 · FSP #52449</span>
    <span>Generated: ${today} · Ref: ${refNum}</span>
  </div>

</div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { T.warn('Pop-up blocked — please allow pop-ups for this site'); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
}

/* ═══════════════════════════════════════════════════════════════
   P3.3 — IT3(b) TAX CERTIFICATE (Print Window)
═══════════════════════════════════════════════════════════════ */
async function printTaxCertificate(allocId) {
  /* Find allocation */
  let a = (S.allocations || []).find(x => x.id === allocId);
  if (!a) {
    try {
      const res = await apiFetch(`tables/investor_allocations/${allocId}`);
      a = await res.json();
    } catch(e) { T.error('Could not load allocation data'); return; }
  }
  if (!a) { T.error('Allocation not found'); return; }

  /* ── IT3(b) specific fields ── */
  const capitalPaid    = parseFloat(a.capital_paid)    || 0;
  const annualRate     = parseFloat(a.annual_rate)     || 0;
  const expectedPayout = parseFloat(a.expected_payout) || 0;
  const grossInterest  = expectedPayout - capitalPaid;
  const termDays       = parseInt(a.term_days)         || 0;

  /* For IT3(b): withholding tax on interest (15% for non-resident; 0 if SA resident) */
  /* We flag the gross interest income — SARS code 4201 (Local Interest) */
  const taxYear = (() => {
    const mDate = a.maturity_date ? new Date(a.maturity_date) : new Date();
    /* SA tax year ends 28/29 Feb — March 1 start */
    return mDate.getMonth() >= 2 ? mDate.getFullYear() : mDate.getFullYear() - 1;
  })();
  const taxYearLabel = `${taxYear}/${taxYear + 1}`;

  const today   = new Date().toLocaleDateString('en-ZA', { day:'2-digit', month:'long', year:'numeric' });
  const certNum = `IT3B-SVC-${taxYear}-${allocId.slice(-8).toUpperCase()}`;
  const productLabel = (a.product_type || 'Investment').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());

  /* ── Build IT3(b) HTML ── */
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>IT3(b) Tax Certificate — ${a.investor_name || 'Investor'}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; color: #1a1a1a; background: #fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 16mm 18mm 14mm 18mm; }

  /* Certificate border */
  .cert-border { border: 2.5px solid #1a3a4a; border-radius: 4px; padding: 0 0 0 0; }

  /* Top banner */
  .cert-banner { background: #1a3a4a; color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
  .cert-banner .sars-ref { font-size: 8pt; color: rgba(255,255,255,.6); margin-top: 2px; }
  .cert-banner .title { font-size: 16pt; font-weight: 900; letter-spacing: .04em; }
  .cert-banner .subtitle { font-size: 8pt; color: rgba(255,255,255,.7); margin-top: 3px; }
  .cert-body { padding: 18px 20px; }

  /* Tax year badge */
  .year-badge { display: inline-block; background: #fffbeb; border: 1.5px solid #fde68a; border-radius: 4px; padding: 5px 14px; font-size: 10pt; font-weight: 800; color: #d97706; margin-bottom: 16px; }

  /* Section heading */
  .s-head { font-size: 8pt; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; color: #6b7280; border-bottom: 1.5px solid #e5e7eb; padding-bottom: 4px; margin: 16px 0 8px; }

  /* Data grid */
  .dgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; }
  .drow { }
  .dlabel { font-size: 7.5pt; color: #9ca3af; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 2px; }
  .dvalue { font-size: 10pt; font-weight: 700; color: #1a1a1a; }

  /* IT3(b) income table */
  .cert-table { width: 100%; border-collapse: collapse; margin: 14px 0; }
  .cert-table th { background: #f8fafc; text-align: left; font-size: 8.5pt; font-weight: 700; color: #374151; padding: 8px 10px; border: 1px solid #e5e7eb; }
  .cert-table td { padding: 9px 10px; border: 1px solid #e5e7eb; font-size: 10pt; vertical-align: top; }
  .cert-table td.code { font-family: monospace; font-weight: 800; font-size: 11pt; color: #1a3a4a; background: #f0f9ff; text-align: center; width: 70px; }
  .cert-table td.amt  { text-align: right; font-weight: 800; font-size: 12pt; color: #059669; }
  .cert-table td.nil  { text-align: right; font-weight: 600; color: #9ca3af; }
  .cert-table tr.total td { background: #f0fdf4; border-top: 2px solid #1a3a4a; font-weight: 900; }
  .cert-table tr.total td.amt { font-size: 13pt; }

  /* Signature block */
  .sig-block { display: flex; justify-content: space-between; margin-top: 28px; padding-top: 14px; border-top: 1.5px solid #e5e7eb; }
  .sig-box { width: 45%; }
  .sig-line { border-bottom: 1px solid #374151; height: 28px; margin-bottom: 4px; }
  .sig-label { font-size: 7.5pt; color: #9ca3af; }

  /* Official stamp area */
  .stamp-area { width: 45%; display: flex; align-items: center; justify-content: center; border: 1.5px dashed #d1d5db; border-radius: 6px; min-height: 60px; }
  .stamp-area span { font-size: 8pt; color: #d1d5db; letter-spacing: .06em; text-transform: uppercase; }

  /* Disclaimer */
  .cert-disc { background: #fafafa; border: 1px solid #e5e7eb; border-radius: 4px; padding: 10px 14px; margin-top: 20px; font-size: 7.5pt; color: #9ca3af; line-height: 1.6; }

  /* Footer */
  .cert-footer { margin-top: 18px; display: flex; justify-content: space-between; font-size: 7pt; color: #d1d5db; }

  /* Print overrides */
  @page { size: A4; margin: 0; }
  @media print {
    body { background: #fff; }
    .page { padding: 10mm 14mm 10mm 14mm; width: 100%; }
    .no-print { display: none !important; }
  }

  .action-bar { background: #1a3a4a; color: #fff; padding: 12px 20px; display: flex; gap: 12px; align-items: center; justify-content: flex-end; }
  .action-bar button { background: #FF8215; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-size: 11pt; font-weight: 700; cursor: pointer; }
  .action-bar .close-btn { background: rgba(255,255,255,.12); }
</style>
</head>
<body>
<div class="action-bar no-print">
  <button onclick="window.print()">&#128424; Print / Save PDF</button>
  <button class="close-btn" onclick="window.close()">Close</button>
</div>
<div class="page">
<div class="cert-border">

  <!-- Banner -->
  <div class="cert-banner">
    <div>
      <div class="title">IT3(b) Tax Certificate</div>
      <div class="subtitle">Certificate of Interest Received / Accrued</div>
      <div class="sars-ref">Issued in terms of Section 89 of the Tax Administration Act, No. 28 of 2011</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:9pt;font-weight:800">SmartVest Financial Services (Pty) Ltd</div>
      <div style="font-size:8pt;color:rgba(255,255,255,.65)">FSP #52449 · FSCA Regulated</div>
      <div style="font-size:8pt;color:rgba(255,255,255,.65)">Tax Ref: SVC/IT3/${taxYear}</div>
    </div>
  </div>

  <div class="cert-body">

    <!-- Tax year -->
    <div class="year-badge">Tax Year of Assessment: ${taxYearLabel} (1 March ${taxYear} – 28 February ${taxYear + 1})</div>

    <!-- Certificate reference -->
    <div style="font-size:8.5pt;color:#6b7280;margin-bottom:16px">Certificate Number: <strong style="color:#1a1a1a">${certNum}</strong> &nbsp;|&nbsp; Issue Date: ${today}</div>

    <!-- Withholding institution -->
    <div class="s-head">Withholding / Paying Institution</div>
    <div class="dgrid">
      <div class="drow"><div class="dlabel">Company Name</div><div class="dvalue">SmartVest Financial Services (Pty) Ltd</div></div>
      <div class="drow"><div class="dlabel">Registration Number</div><div class="dvalue">2018/000000/07</div></div>
      <div class="drow"><div class="dlabel">Tax Reference Number</div><div class="dvalue">9876543210</div></div>
      <div class="drow"><div class="dlabel">FSP Number</div><div class="dvalue">#52449</div></div>
      <div class="drow"><div class="dlabel">Postal Address</div><div class="dvalue">PO Box 1234, Sandton, 2146</div></div>
      <div class="drow"><div class="dlabel">Contact</div><div class="dvalue">invest@svcapital.co.za</div></div>
    </div>

    <!-- Investor / Recipient -->
    <div class="s-head">Investor / Recipient Details</div>
    <div class="dgrid">
      <div class="drow"><div class="dlabel">Full Name / Entity</div><div class="dvalue">${a.investor_name || '—'}</div></div>
      <div class="drow"><div class="dlabel">Email Address</div><div class="dvalue">${a.investor_email || '—'}</div></div>
      <div class="drow"><div class="dlabel">Investor Reference</div><div class="dvalue">${a.investor_id || allocId.slice(-10).toUpperCase()}</div></div>
      <div class="drow"><div class="dlabel">Investment Product</div><div class="dvalue">${productLabel}</div></div>
      <div class="drow"><div class="dlabel">Period Invested</div><div class="dvalue">${fmt.date(a.start_date)} — ${fmt.date(a.maturity_date)}</div></div>
      <div class="drow"><div class="dlabel">Term (Days)</div><div class="dvalue">${termDays}</div></div>
    </div>

    <!-- IT3(b) Income table -->
    <div class="s-head">Interest Income — IT3(b) Schedule</div>
    <table class="cert-table">
      <thead>
        <tr>
          <th>SARS Code</th>
          <th>Description</th>
          <th style="text-align:right">Amount (ZAR)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="code">4201</td>
          <td>
            <strong>Local Interest Income</strong><br>
            <span style="font-size:8.5pt;color:#6b7280">Interest earned on ${productLabel} investment<br>
            Rate: ${(annualRate*100).toFixed(2)}% p.a. · Capital: R ${capitalPaid.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})} · Term: ${termDays} days</span>
          </td>
          <td class="amt">R ${grossInterest.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        </tr>
        <tr>
          <td class="code" style="color:#9ca3af">4238</td>
          <td style="color:#9ca3af">Withholding Tax on Interest (if applicable)<br><span style="font-size:8pt">Deducted at source if investor is non-resident or elect opt-in</span></td>
          <td class="nil">NIL</td>
        </tr>
        <tr>
          <td class="code">4210</td>
          <td><strong>Capital Invested (Return of Capital)</strong><br><span style="font-size:8.5pt;color:#6b7280">Not subject to income tax — capital amount</span></td>
          <td class="amt" style="color:#1a3a4a">R ${capitalPaid.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        </tr>
        <tr class="total">
          <td colspan="2"><strong>Total Gross Amount Payable on Maturity (${fmt.date(a.maturity_date)})</strong></td>
          <td class="amt">R ${expectedPayout.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        </tr>
      </tbody>
    </table>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:10px 14px;margin:10px 0;font-size:8.5pt;color:#1e40af">
      <strong>Note for taxpayers:</strong> The interest amount of <strong>R ${grossInterest.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong> (SARS Code 4201) must be declared in your annual income tax return (ITR12 / ITR14). 
      South African residents are entitled to an annual interest income exemption (R23,800 for persons under 65; R34,500 for persons 65 and older) in terms of Section 10(1)(i) of the Income Tax Act.
    </div>

    <!-- Signature block -->
    <div class="sig-block">
      <div class="sig-box">
        <div class="sig-line"></div>
        <div class="sig-label">Authorised Signatory — SmartVest Financial Services (Pty) Ltd</div>
        <div style="font-size:8.5pt;color:#374151;margin-top:4px"><strong>Alexandra van der Berg</strong> · Fund Director</div>
        <div style="font-size:7.5pt;color:#9ca3af">Date: ${today}</div>
      </div>
      <div class="stamp-area">
        <span>Official Company Stamp</span>
      </div>
    </div>

    <!-- Disclaimer -->
    <div class="cert-disc">
      <strong>SARS Disclosure:</strong> This certificate is issued in compliance with the Tax Administration Act, No. 28 of 2011 and the Income Tax Act, No. 58 of 1962. 
      SmartVest Financial Services (Pty) Ltd is an Authorised Financial Services Provider (FSP #52449) regulated by the Financial Sector Conduct Authority.
      This certificate must be retained by the investor for tax purposes. For queries contact: invest@svcapital.co.za.
      <br><strong>Disclaimer:</strong> This certificate constitutes a summary of interest amounts paid/accrued during the stated period. 
      It does not constitute financial or tax advice. Investors should consult a registered tax practitioner.
    </div>

    <!-- Footer -->
    <div class="cert-footer">
      <span>SmartVest Financial Services (Pty) Ltd · Reg No. 2018/000000/07 · FSP #52449</span>
      <span>Certificate: ${certNum} · Generated: ${today}</span>
    </div>

  </div>
</div>
</div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { T.warn('Pop-up blocked — please allow pop-ups for this site'); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
}
