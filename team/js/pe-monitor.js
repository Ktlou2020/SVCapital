/* PE Monitor — Private Equity SPA */

const API_BASE = '/api/tables';
const SECTOR_COLORS = [
  '#3b82f6','#00d4aa','#fec24f','#eda5ff','#f87171',
  '#fb923c','#4ade80','#818cf8','#e879f9','#38bdf8',
];

const STAGE_ORDER = ['sourcing','screening','due_diligence','ic_review','approved','closed','declined','exited'];
const STAGE_LABELS = {
  sourcing:       'Sourcing',
  screening:      'Screening',
  due_diligence:  'Due Diligence',
  ic_review:      'IC Review',
  approved:       'Approved',
  closed:         'Closed',
  declined:       'Declined',
  exited:         'Exited',
};
const STAGE_COLOR = {
  sourcing:       'badge-gray',
  screening:      'badge-blue',
  due_diligence:  'badge-gold',
  ic_review:      'badge-orange',
  approved:       'badge-teal',
  closed:         'badge-teal',
  declined:       'badge-red',
  exited:         'badge-purple',
};

const STATUS_COLOR = {
  prospect:      'badge-gray',
  deal_flow:     'badge-blue',
  due_diligence: 'badge-gold',
  approved:      'badge-orange',
  portfolio:     'badge-teal',
  exited:        'badge-purple',
  declined:      'badge-red',
};

const FEE_STATUS_COLOR = {
  projected: 'badge-gray',
  invoiced:  'badge-blue',
  paid:      'badge-teal',
  overdue:   'badge-red',
  waived:    'badge-orange',
};

/* ── Data cache ── */
let _companies  = [];
let _deals      = [];
let _financials = [];
let _fees       = [];
let _updates    = [];
let _activeView = 'dashboard';
let _openCompanyId = null;
let _openDealId    = null;

/* ── Helpers ── */
function fmtR(n) {
  if (n == null || n === '') return '—';
  return 'R' + parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtPct(n) {
  if (n == null || n === '') return '—';
  return (parseFloat(n) * 100).toFixed(1) + '%';
}
function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-ZA', { year:'numeric', month:'short', day:'numeric' });
}
function fmtYear(s) {
  if (!s) return '—';
  return new Date(s).getFullYear();
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function badge(cls, text) {
  return `<span class="badge ${cls}">${esc(text || '—')}</span>`;
}
function sectorColor(sector) {
  if (!sector) return SECTOR_COLORS[0];
  const sectors = [...new Set(_companies.map(c => c.sector).filter(Boolean))].sort();
  const i = sectors.indexOf(sector);
  return SECTOR_COLORS[i % SECTOR_COLORS.length];
}

/* ── Clean up raw API error messages ── */
function _cleanErr(msg = '') {
  try {
    const m = msg.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      if (o?.error?.type === 'overloaded_error') return 'The AI service is temporarily overloaded — please try again in a moment.';
      if (o?.error?.message) return o.error.message;
    }
  } catch (_) {}
  return msg;
}

/* ── API ── */
function _authHeaders(extra = {}) {
  const token = localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token');
  return token ? { 'Authorization': `Bearer ${token}`, ...extra } : extra;
}
async function apiFetch(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/${table}${qs ? '?' + qs : ''}`, {
    credentials: 'include',
    headers: _authHeaders(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function apiCreate(table, data) {
  const res = await fetch(`${API_BASE}/${table}`, {
    method: 'POST',
    credentials: 'include',
    headers: _authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json();
}
async function apiUpdate(table, id, data) {
  const res = await fetch(`${API_BASE}/${table}/${id}`, {
    method: 'PUT',
    credentials: 'include',
    headers: _authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json();
}
async function apiDelete(table, id) {
  const res = await fetch(`${API_BASE}/${table}/${id}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: _authHeaders(),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(t); }
  return res.json();
}

/* ── Load all data ── */
async function safeFetch(table) {
  try {
    const r = await apiFetch(table);
    return r.data || r.rows || [];
  } catch (e) {
    console.warn(`[PE Monitor] table '${table}' unavailable:`, e.message);
    return [];
  }
}

async function loadAll() {
  [_companies, _deals, _financials, _fees, _updates] = await Promise.all([
    safeFetch('pe_companies'),
    safeFetch('pe_deals'),
    safeFetch('pe_financials'),
    safeFetch('pe_fees'),
    safeFetch('pe_updates'),
  ]);
}

/* ── Navigation ── */
function navigate(view) {
  _activeView = view;
  document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const section = document.getElementById('view-' + view);
  if (section) section.classList.add('active');
  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');
  renderView(view);
}

function renderView(view) {
  if (view === 'dashboard')  renderDashboard();
  if (view === 'pipeline')   renderPipeline();
  if (view === 'portfolio')  renderPortfolio();
  if (view === 'financials') renderFinancialsView();
  if (view === 'fees')       renderFeesView();
}

/* ═══════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════ */
function renderDashboard() {
  const portfolio = _companies.filter(c => c.status === 'portfolio');
  const totalAum  = portfolio.reduce((s, c) => s + (parseFloat(c.aum_amount) || 0), 0);
  const paidFees  = _fees.filter(f => f.status === 'paid').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
  const overdueFees = _fees.filter(f => f.status === 'overdue').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
  const activePipeline = _deals.filter(d => !['closed','declined','exited'].includes(d.stage)).length;

  document.getElementById('dash-aum').textContent  = fmtR(totalAum);
  document.getElementById('dash-cos').textContent  = portfolio.length;
  document.getElementById('dash-pipe').textContent = activePipeline;
  document.getElementById('dash-fees').textContent = fmtR(paidFees);
  document.getElementById('dash-overdue').textContent = overdueFees > 0
    ? `R${parseFloat(overdueFees).toLocaleString('en-ZA')} overdue`
    : 'None overdue';
  document.getElementById('dash-overdue').className = 'change ' + (overdueFees > 0 ? 'neg' : 'pos');

  renderSectorDonut(portfolio, totalAum);
  renderPipelineMini();
  renderUpcomingFees();
}

function renderSectorDonut(portfolio, totalAum) {
  const sectors = {};
  portfolio.forEach(c => {
    const s = c.sector || 'Other';
    sectors[s] = (sectors[s] || 0) + (parseFloat(c.aum_amount) || 0);
  });
  const entries = Object.entries(sectors).sort((a, b) => b[1] - a[1]);
  const colors  = SECTOR_COLORS;

  // SVG donut
  const size = 140; const cx = 70; const cy = 70; const r = 55; const stroke = 22;
  let html = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const total = entries.reduce((s,[,v]) => s + v, 0) || 1;
  entries.forEach(([sector, val], i) => {
    const pct = val / total;
    const dash = pct * circ;
    html += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${colors[i % colors.length]}" stroke-width="${stroke}"
      stroke-dasharray="${dash} ${circ - dash}"
      stroke-dashoffset="${-offset * circ / total + circ * 0.25}"
      style="transform-origin:${cx}px ${cy}px;transform:rotate(-90deg)"/>`;
    offset += val;
  });
  html += `<text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="11" fill="#8892a4">AUM</text>`;
  html += `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="13" font-weight="700" fill="#e2e8f0">${fmtR(totalAum)}</text>`;
  html += '</svg>';

  let legend = '';
  entries.slice(0, 6).forEach(([sector, val], i) => {
    legend += `<div class="donut-legend-item">
      <div class="donut-legend-dot" style="background:${colors[i % colors.length]}"></div>
      <span class="donut-legend-label">${esc(sector)}</span>
      <span class="donut-legend-val">${fmtR(val)}</span>
    </div>`;
  });

  document.getElementById('sector-donut').innerHTML =
    `<div class="donut-wrap">${html}<div class="donut-legend">${legend}</div></div>`;
}

function renderPipelineMini() {
  const stages = ['sourcing','screening','due_diligence','ic_review'];
  let html = '';
  stages.forEach(stage => {
    const count = _deals.filter(d => d.stage === stage).length;
    const total = _deals.length || 1;
    html += `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
        <span style="color:var(--text-muted)">${STAGE_LABELS[stage]}</span>
        <span style="font-weight:600">${count}</span>
      </div>
      <div class="mini-bar"><div class="mini-bar-fill" style="width:${Math.min(100,(count/total)*100)}%"></div></div>
    </div>`;
  });
  document.getElementById('pipeline-mini').innerHTML = html || '<p style="color:var(--text-muted);font-size:13px">No active deals</p>';
}

function renderUpcomingFees() {
  const upcoming = _fees
    .filter(f => ['projected','invoiced','overdue'].includes(f.status))
    .sort((a, b) => new Date(a.due_date || '9999') - new Date(b.due_date || '9999'))
    .slice(0, 5);
  const wrap = document.getElementById('upcoming-fees');
  if (!upcoming.length) {
    wrap.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px">No upcoming fees</p>';
    return;
  }
  wrap.innerHTML = upcoming.map(f => {
    const co = _companies.find(c => c.id === f.company_id);
    return `<div class="fee-row">
      <div class="fee-co">${esc(co?.name || f.company_id)}</div>
      <div class="fee-period">${fmtDate(f.due_date)}</div>
      ${badge(FEE_STATUS_COLOR[f.status] || 'badge-gray', f.status)}
      <div class="fee-amt">${fmtR(f.amount)}</div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════
   PIPELINE
   ═══════════════════════════════════════════════════ */
function renderPipeline() {
  const board = document.getElementById('pipeline-board');
  const search = document.getElementById('pipeline-search').value.toLowerCase();
  const filtered = _deals.filter(d =>
    !search || d.company_name?.toLowerCase().includes(search) || d.sector?.toLowerCase().includes(search)
  );

  const activeCols = ['sourcing','screening','due_diligence','ic_review','approved'];
  board.innerHTML = activeCols.map(stage => {
    const cards = filtered.filter(d => d.stage === stage);
    const cardsHtml = cards.length
      ? cards.map(d => `
          <div class="pipeline-card" onclick="openDealPanel('${esc(d.id)}')">
            <div class="co-name">${esc(d.company_name)}</div>
            <div class="co-meta">
              <span>${esc(d.sector || '—')}</span>
              <span>${esc(d.deal_type || 'equity')}</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
              <span class="co-amount">${d.target_amount ? fmtR(d.target_amount) : '—'}</span>
              <span class="badge ${d.priority === 'urgent' ? 'badge-red' : d.priority === 'high' ? 'badge-orange' : 'badge-gray'}" style="font-size:10px">${esc(d.priority)}</span>
            </div>
          </div>`)
        .join('')
      : `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">Empty</div>`;

    return `<div class="pipeline-col">
      <div class="pipeline-col-header">
        <span>${STAGE_LABELS[stage]}</span>
        <span class="col-count">${cards.length}</span>
      </div>
      <div class="pipeline-cards">${cardsHtml}</div>
    </div>`;
  }).join('');

  // Closed / declined / exited table
  const closed = _deals.filter(d => ['closed','declined','exited'].includes(d.stage));
  const closedTbody = document.getElementById('pipeline-closed');
  if (closedTbody) {
    closedTbody.innerHTML = closed.length ? closed.map(d => `
      <tr onclick="openDealPanel('${esc(d.id)}')">
        <td><strong>${esc(d.company_name)}</strong></td>
        <td>${badge(STAGE_COLOR[d.stage] || 'badge-gray', STAGE_LABELS[d.stage] || d.stage)}</td>
        <td style="text-transform:capitalize">${esc(d.deal_type || '—')}</td>
        <td class="num">${fmtR(d.target_amount)}</td>
        <td>${fmtDate(d.decision_date)}</td>
        <td style="color:var(--text-muted);font-size:12px">${esc((d.decision_notes || '').slice(0, 60))}${d.decision_notes?.length > 60 ? '…' : ''}</td>
      </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">No closed deals</td></tr>';
  }
}

/* ═══════════════════════════════════════════════════
   PORTFOLIO
   ═══════════════════════════════════════════════════ */
function renderPortfolio() {
  const search = (document.getElementById('portfolio-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('portfolio-status')?.value || '';
  let companies = _companies;
  if (search)       companies = companies.filter(c => c.name?.toLowerCase().includes(search) || c.sector?.toLowerCase().includes(search));
  if (statusFilter) companies = companies.filter(c => c.status === statusFilter);

  const bySector = {};
  companies.forEach(c => {
    const s = c.sector || 'Uncategorised';
    if (!bySector[s]) bySector[s] = [];
    bySector[s].push(c);
  });

  const wrap = document.getElementById('portfolio-list');
  if (!companies.length) {
    wrap.innerHTML = `<div class="empty-state"><i class="fa-solid fa-briefcase"></i><p>No companies found</p></div>`;
    return;
  }

  wrap.innerHTML = Object.entries(bySector).sort().map(([sector, cos]) => `
    <div class="sector-group">
      <div class="sector-label" style="color:${sectorColor(sector)}">
        <i class="fa-solid fa-circle-small" style="font-size:8px"></i>
        ${esc(sector)} &nbsp;<span style="color:var(--text-muted);font-weight:400">(${cos.length})</span>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Company</th><th>Status</th><th>AUM</th><th>Fee Rate</th><th>Entry</th><th>City</th><th>Contact</th>
            </tr></thead>
            <tbody>
              ${cos.map(c => `<tr onclick="openCompanyPanel('${esc(c.id)}')">
                <td><strong>${esc(c.name)}</strong>${c.sub_sector ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(c.sub_sector)}</span>` : ''}</td>
                <td>${badge(STATUS_COLOR[c.status] || 'badge-gray', c.status)}</td>
                <td class="num">${fmtR(c.aum_amount)}</td>
                <td class="num">${c.fee_rate ? fmtPct(c.fee_rate) : '—'}</td>
                <td>${fmtDate(c.entry_date)}</td>
                <td>${esc(c.city || '—')}</td>
                <td>${esc(c.contact_name || '—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`).join('');
}

/* ═══════════════════════════════════════════════════
   FINANCIALS VIEW
   ═══════════════════════════════════════════════════ */
function renderFinancialsView() {
  const sel = document.getElementById('fin-company-select');
  const currentVal = sel?.value || '';

  // Populate selector
  if (sel) {
    sel.innerHTML = '<option value="">— Select company —</option>' +
      _companies.filter(c => c.status === 'portfolio').map(c =>
        `<option value="${esc(c.id)}" ${c.id === currentVal ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('');
  }

  const companyId = sel?.value || '';
  const wrap = document.getElementById('fin-table-wrap');
  if (!companyId) {
    wrap.innerHTML = '<div class="empty-state"><i class="fa-solid fa-chart-bar"></i><p>Select a company to view financials</p></div>';
    return;
  }

  const fins = _financials
    .filter(f => f.company_id === companyId)
    .sort((a, b) => b.financial_year - a.financial_year);

  if (!fins.length) {
    wrap.innerHTML = '<div class="empty-state"><i class="fa-solid fa-chart-bar"></i><p>No financials recorded yet</p></div>';
    return;
  }

  const years = fins.map(f => f.financial_year);

  const rows = [
    { label: 'Revenue',             key: 'revenue',            fmt: fmtR,   section: 'Income Statement' },
    { label: 'Gross Profit',        key: 'gross_profit',       fmt: fmtR },
    { label: 'EBITDA',              key: 'ebitda',             fmt: fmtR },
    { label: 'EBIT',                key: 'ebit',               fmt: fmtR },
    { label: 'Net Profit',          key: 'net_profit',         fmt: fmtR },
    { label: 'EBITDA Margin',       key: 'ebitda_margin',      fmt: fmtPct, section: 'Margins' },
    { label: 'Net Margin',          key: 'net_margin',         fmt: fmtPct },
    { label: 'Revenue Growth',      key: 'revenue_growth',     fmt: fmtPct },
    { label: 'Total Assets',        key: 'total_assets',       fmt: fmtR,   section: 'Balance Sheet' },
    { label: 'Total Liabilities',   key: 'total_liabilities',  fmt: fmtR },
    { label: 'Equity',              key: 'equity',             fmt: fmtR },
    { label: 'Cash',                key: 'cash',               fmt: fmtR },
    { label: 'Total Debt',          key: 'total_debt',         fmt: fmtR },
    { label: 'Operating Cashflow',  key: 'operating_cashflow', fmt: fmtR,   section: 'Cashflows' },
    { label: 'Free Cashflow',       key: 'free_cashflow',      fmt: fmtR },
    { label: 'Capex',               key: 'capex',              fmt: fmtR },
    { label: 'Audited',             key: 'audited',            fmt: v => v ? '<span style="color:var(--success)">Yes</span>' : '<span style="color:var(--text-muted)">No</span>', section: 'Notes' },
  ];

  let lastSection = null;
  let tableRows = rows.map(r => {
    let sectionHeader = '';
    if (r.section && r.section !== lastSection) {
      lastSection = r.section;
      sectionHeader = `<tr><td colspan="${years.length + 1}" style="padding:14px 14px 6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);background:var(--bg)">${esc(r.section)}</td></tr>`;
    }
    const cells = fins.map(f => `<td class="num">${r.fmt(f[r.key])}</td>`).join('');
    return sectionHeader + `<tr><td style="padding:10px 14px;color:var(--text-muted);white-space:nowrap">${esc(r.label)}</td>${cells}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="financials-table">
        <thead><tr>
          <th>Metric</th>
          ${years.map(y => `<th class="num">FY ${y}</th>`).join('')}
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;

  loadFinViewDocs(companyId);
}

async function loadFinViewDocs(companyId) {
  const wrap = document.getElementById('fin-docs-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  try {
    const res  = await fetch(`/api/pe/documents/list?company_id=${encodeURIComponent(companyId)}`, {
      credentials: 'include', headers: _authHeaders(),
    });
    const json = await res.json();
    const docs = (json.docs || []).filter(d => d.doc_type === 'AFS' || d.label?.includes('AFS'));
    if (!docs.length) return;

    wrap.innerHTML = `
      <div class="fin-docs-section">
        <div class="fin-docs-header">
          <i class="fa-solid fa-file-pdf" style="color:var(--danger)"></i>
          AFS Documents
          <span class="fin-docs-count">${docs.length}</span>
        </div>
        <div class="fin-docs-grid">
          ${docs.map(d => `
            <div class="fin-doc-card">
              <div class="fin-doc-icon"><i class="fa-solid fa-file-pdf"></i></div>
              <div class="fin-doc-info">
                <div class="fin-doc-label">${esc(d.label || d.filename)}</div>
                <div class="fin-doc-meta">${fmtDate(d.uploaded_at)}</div>
              </div>
              <div class="fin-doc-actions">
                <a href="/api/pe/documents/${esc(d.id)}/download" target="_blank"
                   class="btn btn-primary btn-sm" title="Download">
                  <i class="fa-solid fa-download"></i> Download
                </a>
                <button class="btn btn-ghost btn-sm" title="Delete"
                  onclick="deleteDoc('${esc(d.id)}', () => loadFinViewDocs('${esc(companyId)}'))">
                  <i class="fa-solid fa-trash" style="color:var(--danger)"></i>
                </button>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  } catch (_) { /* silent */ }
}

/* ═══════════════════════════════════════════════════
   FEES VIEW
   ═══════════════════════════════════════════════════ */
function renderFeesView() {
  const statusFilter = document.getElementById('fee-status-filter')?.value || '';
  const fees = statusFilter ? _fees.filter(f => f.status === statusFilter) : _fees;
  const sorted = [...fees].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Summary stats
  const projected = fees.filter(f => f.status === 'projected').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
  const paid      = fees.filter(f => f.status === 'paid').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
  const overdue   = fees.filter(f => f.status === 'overdue').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);

  document.getElementById('fee-projected').textContent = fmtR(projected);
  document.getElementById('fee-paid').textContent      = fmtR(paid);
  document.getElementById('fee-overdue').textContent   = fmtR(overdue);

  // Table
  const wrap = document.getElementById('fees-table-wrap');
  if (!sorted.length) {
    wrap.innerHTML = '<div class="empty-state"><i class="fa-solid fa-receipt"></i><p>No fee records</p></div>';
    return;
  }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Company</th><th>Period</th><th>Type</th><th>Status</th>
      <th class="num">Amount</th><th>Due</th><th>Invoice #</th><th></th>
    </tr></thead>
    <tbody>
      ${sorted.map(f => {
        const co = _companies.find(c => c.id === f.company_id);
        return `<tr onclick="openFeeEdit('${esc(f.id)}')">
          <td><strong>${esc(co?.name || '—')}</strong></td>
          <td style="color:var(--text-muted);font-size:12px">${fmtDate(f.period_start)} – ${fmtDate(f.period_end)}</td>
          <td>${badge('badge-gray', f.fee_type)}</td>
          <td>${badge(FEE_STATUS_COLOR[f.status] || 'badge-gray', f.status)}</td>
          <td class="num">${fmtR(f.amount)}</td>
          <td style="font-size:12px">${fmtDate(f.due_date)}</td>
          <td style="font-size:12px;color:var(--text-muted)">${esc(f.invoice_number || '—')}</td>
          <td><button class="icon-btn" onclick="event.stopPropagation();confirmDeleteFee('${esc(f.id)}')">
            <i class="fa-solid fa-trash" style="font-size:12px"></i></button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;

  renderCashflowChart();
}

function renderCashflowChart() {
  // Group fees by quarter
  const quarters = {};
  _fees.forEach(f => {
    if (!f.period_end) return;
    const d = new Date(f.period_end);
    const q = `${d.getFullYear()} Q${Math.ceil((d.getMonth() + 1) / 3)}`;
    if (!quarters[q]) quarters[q] = { paid: 0, projected: 0, overdue: 0 };
    quarters[q][f.status === 'paid' ? 'paid' : f.status === 'overdue' ? 'overdue' : 'projected'] += parseFloat(f.amount) || 0;
  });

  const entries = Object.entries(quarters).sort(([a],[b]) => a.localeCompare(b)).slice(-8);
  if (!entries.length) return;

  const maxVal = Math.max(...entries.flatMap(([, v]) => [v.paid, v.projected, v.overdue]), 1);
  const maxH = 100;

  document.getElementById('cashflow-chart').innerHTML = entries.map(([q, v]) => {
    const paidH   = Math.round((v.paid / maxVal) * maxH);
    const projH   = Math.round((v.projected / maxVal) * maxH);
    const overdueH = Math.round((v.overdue / maxVal) * maxH);
    const total   = v.paid + v.projected + v.overdue;
    return `<div class="cf-bar-wrap" title="${q}: ${fmtR(total)}">
      ${v.overdue  ? `<div class="cf-bar overdue"   style="height:${overdueH}px"  title="Overdue: ${fmtR(v.overdue)}"></div>` : ''}
      ${v.projected? `<div class="cf-bar projected" style="height:${projH}px"    title="Projected: ${fmtR(v.projected)}"></div>` : ''}
      ${v.paid     ? `<div class="cf-bar paid"      style="height:${paidH}px"    title="Paid: ${fmtR(v.paid)}"></div>` : ''}
      <div class="cf-bar-label">${q}</div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════
   COMPANY DETAIL PANEL
   ═══════════════════════════════════════════════════ */
function openCompanyPanel(id) {
  const co = _companies.find(c => c.id === id);
  if (!co) return;
  _openCompanyId = id;

  const panel = document.getElementById('company-panel');
  document.getElementById('panel-backdrop').classList.add('open');

  document.getElementById('cp-name').textContent = co.name;
  document.getElementById('cp-status').innerHTML = badge(STATUS_COLOR[co.status] || 'badge-gray', co.status);

  // Overview tab
  document.getElementById('cp-overview').innerHTML = `
    <div class="kv-grid">
      <div class="kv-item"><div class="kv-label">Sector</div><div class="kv-val">${esc(co.sector)}</div></div>
      <div class="kv-item"><div class="kv-label">Sub-Sector</div><div class="kv-val">${esc(co.sub_sector || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">AUM</div><div class="kv-val" style="color:var(--accent);font-weight:700">${fmtR(co.aum_amount)}</div></div>
      <div class="kv-item"><div class="kv-label">Fee Rate</div><div class="kv-val">${co.fee_rate ? fmtPct(co.fee_rate) : '—'} ${co.fee_billing_period ? `(${co.fee_billing_period})` : ''}</div></div>
      <div class="kv-item"><div class="kv-label">Country</div><div class="kv-val">${esc(co.country || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">City</div><div class="kv-val">${esc(co.city || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Entry Date</div><div class="kv-val">${fmtDate(co.entry_date)}</div></div>
      <div class="kv-item"><div class="kv-label">Founded</div><div class="kv-val">${esc(co.founded_year || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Employees</div><div class="kv-val">${co.employee_count ? parseInt(co.employee_count).toLocaleString() : '—'}</div></div>
      <div class="kv-item"><div class="kv-label">Registration</div><div class="kv-val">${esc(co.registration_number || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Contact</div><div class="kv-val">${esc(co.contact_name || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Email</div><div class="kv-val">${co.contact_email ? `<a href="mailto:${esc(co.contact_email)}" style="color:var(--accent)">${esc(co.contact_email)}</a>` : '—'}</div></div>
      ${co.website ? `<div class="kv-item full"><div class="kv-label">Website</div><div class="kv-val"><a href="${esc(co.website)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(co.website)}</a></div></div>` : ''}
      ${co.description ? `<div class="kv-item full"><div class="kv-label">Description</div><div class="kv-val" style="color:var(--text-muted);line-height:1.6">${esc(co.description)}</div></div>` : ''}
      ${co.notes ? `<div class="kv-item full"><div class="kv-label">Notes</div><div class="kv-val" style="color:var(--text-muted);line-height:1.6">${esc(co.notes)}</div></div>` : ''}
    </div>`;

  // Financials tab — latest year
  const fins = _financials.filter(f => f.company_id === id).sort((a, b) => b.financial_year - a.financial_year);
  const latest = fins[0];
  if (latest) {
    document.getElementById('cp-financials').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:13px;font-weight:600">FY ${latest.financial_year}</span>
        ${badge(latest.audited ? 'badge-teal' : 'badge-gray', latest.audited ? 'Audited' : 'Unaudited')}
      </div>
      <div class="kv-grid">
        <div class="kv-item"><div class="kv-label">Revenue</div><div class="kv-val">${fmtR(latest.revenue)}</div></div>
        <div class="kv-item"><div class="kv-label">EBITDA</div><div class="kv-val">${fmtR(latest.ebitda)}</div></div>
        <div class="kv-item"><div class="kv-label">Net Profit</div><div class="kv-val">${fmtR(latest.net_profit)}</div></div>
        <div class="kv-item"><div class="kv-label">EBITDA Margin</div><div class="kv-val">${fmtPct(latest.ebitda_margin)}</div></div>
        <div class="kv-item"><div class="kv-label">Revenue Growth</div><div class="kv-val">${fmtPct(latest.revenue_growth)}</div></div>
        <div class="kv-item"><div class="kv-label">Free Cashflow</div><div class="kv-val">${fmtR(latest.free_cashflow)}</div></div>
        <div class="kv-item"><div class="kv-label">Total Assets</div><div class="kv-val">${fmtR(latest.total_assets)}</div></div>
        <div class="kv-item"><div class="kv-label">Total Debt</div><div class="kv-val">${fmtR(latest.total_debt)}</div></div>
      </div>
      ${fins.length > 1 ? `<p style="font-size:12px;color:var(--text-muted);margin-top:14px">${fins.length} years available — view in Financials tab</p>` : ''}`;
  } else {
    document.getElementById('cp-financials').innerHTML =
      '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-chart-bar"></i><p>No financials yet — <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="openAddFinancials(\''+esc(id)+'\')">Add FY Financials</button></p></div>';
  }

  // Updates tab
  const updates = _updates.filter(u => u.company_id === id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  document.getElementById('cp-updates').innerHTML = `
    <div style="margin-bottom:14px">
      <button class="btn btn-primary btn-sm" onclick="openAddUpdate('${esc(id)}')"><i class="fa-solid fa-plus"></i> Add Update</button>
    </div>
    ${updates.length ? updates.map(u => `
      <div class="update-item type-${esc(u.update_type)}">
        <div class="u-header">
          ${badge('badge-gray', u.update_type)}
          <span class="u-title">${esc(u.title)}</span>
        </div>
        <div class="u-meta">${fmtDate(u.created_at)}${u.author ? ' · ' + esc(u.author) : ''}</div>
        <div class="u-body" style="margin-top:6px">${esc(u.body)}</div>
      </div>`).join('') : '<p style="color:var(--text-muted);font-size:13px">No updates yet.</p>'}`;

  // Fees tab
  const coFees = _fees.filter(f => f.company_id === id).sort((a, b) => new Date(b.period_end) - new Date(a.period_end));
  document.getElementById('cp-fees').innerHTML = `
    <div style="margin-bottom:14px">
      <button class="btn btn-primary btn-sm" onclick="openAddFee('${esc(id)}')"><i class="fa-solid fa-plus"></i> Add Fee</button>
    </div>
    ${coFees.length ? coFees.map(f => `
      <div class="fee-row" style="margin-bottom:8px">
        <div>
          <div style="font-size:12px;color:var(--text-muted)">${fmtDate(f.period_start)} – ${fmtDate(f.period_end)}</div>
          ${badge('badge-gray', f.fee_type)}
        </div>
        ${badge(FEE_STATUS_COLOR[f.status] || 'badge-gray', f.status)}
        <div class="fee-amt">${fmtR(f.amount)}</div>
      </div>`).join('') : '<p style="color:var(--text-muted);font-size:13px">No fees recorded.</p>'}`;

  // Open to overview tab
  switchPanelTab('overview');
  panel.classList.add('open');
  // Load documents tab in background
  loadCompanyDocs(id);
}

function switchPanelTab(tab) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel-tab-body').forEach(t => t.classList.toggle('active', t.id === 'cp-' + tab));
}

function closePanelOnBackdrop() {
  document.getElementById('company-panel').classList.remove('open');
  document.getElementById('deal-panel').classList.remove('open');
  document.getElementById('panel-backdrop').classList.remove('open');
  _openCompanyId = null;
  _openDealId = null;
}

/* ═══════════════════════════════════════════════════
   DEAL DETAIL PANEL
   ═══════════════════════════════════════════════════ */
function openDealPanel(id) {
  const deal = _deals.find(d => d.id === id);
  if (!deal) return;
  _openDealId = id;

  document.getElementById('panel-backdrop').classList.add('open');
  document.getElementById('dp-name').textContent  = deal.company_name;
  document.getElementById('dp-stage').innerHTML   = badge(STAGE_COLOR[deal.stage] || 'badge-gray', STAGE_LABELS[deal.stage] || deal.stage);

  document.getElementById('dp-body').innerHTML = `
    <div class="kv-grid" style="margin-bottom:16px">
      <div class="kv-item"><div class="kv-label">Deal Type</div><div class="kv-val" style="text-transform:capitalize">${esc(deal.deal_type || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Sector</div><div class="kv-val">${esc(deal.sector || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Target Amount</div><div class="kv-val" style="color:var(--accent);font-weight:700">${fmtR(deal.target_amount)}</div></div>
      <div class="kv-item"><div class="kv-label">Committed</div><div class="kv-val">${fmtR(deal.committed_amount)}</div></div>
      <div class="kv-item"><div class="kv-label">Priority</div><div class="kv-val"><span class="priority-${deal.priority || 'medium'}"><span class="priority-dot"></span>${esc(deal.priority || 'medium')}</span></div></div>
      <div class="kv-item"><div class="kv-label">Analyst</div><div class="kv-val">${esc(deal.assigned_analyst || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Sourced</div><div class="kv-val">${fmtDate(deal.sourced_date)}</div></div>
      <div class="kv-item"><div class="kv-label">Originator</div><div class="kv-val">${esc(deal.originator || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">IC Date</div><div class="kv-val">${fmtDate(deal.ic_date)}</div></div>
      <div class="kv-item"><div class="kv-label">Decision</div><div class="kv-val">${fmtDate(deal.decision_date)}</div></div>
    </div>
    ${deal.deal_description ? `<div style="margin-bottom:14px"><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:6px">Description</div><div style="font-size:13px;line-height:1.6">${esc(deal.deal_description)}</div></div>` : ''}
    ${deal.investment_thesis ? `<div style="margin-bottom:14px"><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:6px">Investment Thesis</div><div style="font-size:13px;line-height:1.6;color:var(--text-muted)">${esc(deal.investment_thesis)}</div></div>` : ''}
    ${deal.key_risks ? `<div style="margin-bottom:14px"><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--danger);margin-bottom:6px">Key Risks</div><div style="font-size:13px;line-height:1.6;color:var(--text-muted)">${esc(deal.key_risks)}</div></div>` : ''}
    ${deal.decision_notes ? `<div><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:6px">Decision Notes</div><div style="font-size:13px;line-height:1.6;color:var(--text-muted)">${esc(deal.decision_notes)}</div></div>` : ''}
    <hr class="divider">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="openEditDeal('${esc(deal.id)}')"><i class="fa-solid fa-pen"></i> Edit</button>
      <select class="btn btn-ghost btn-sm" style="cursor:pointer" onchange="updateDealStage('${esc(deal.id)}', this.value)">
        ${STAGE_ORDER.map(s => `<option value="${s}" ${s === deal.stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}
      </select>
      <button class="btn btn-danger btn-sm" onclick="confirmDeleteDeal('${esc(deal.id)}')"><i class="fa-solid fa-trash"></i> Delete</button>
    </div>`;

  document.getElementById('deal-panel').classList.add('open');
  loadDealDocs(id);
}

async function updateDealStage(id, stage) {
  try {
    await apiUpdate('pe_deals', id, { stage, updated_at: new Date().toISOString() });
    await loadAll();
    renderPipeline();
    openDealPanel(id);
  } catch(e) { alert('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════
   AI DOCUMENT EXTRACTION
   ═══════════════════════════════════════════════════ */

async function extractFromDocument(file) {
  if (!file) return;

  const idle    = document.getElementById('ai-upload-idle');
  const loading = document.getElementById('ai-upload-loading');
  const status  = document.getElementById('ai-upload-status');
  const zone    = document.getElementById('ai-upload-zone');

  idle.style.display    = 'none';
  loading.style.display = 'flex';
  zone.style.pointerEvents = 'none';
  status.textContent = 'Reading document…';

  try {
    const fd = new FormData();
    fd.append('document', file);

    const res = await fetch('/api/pe/extract-company', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Extraction failed');

    const f      = document.getElementById('company-form');
    const fields = json.fields || {};
    const FILLABLE = [
      'name','sector','sub_sector','country','city','description','website',
      'registration_number','vat_number','founded_year','employee_count',
      'contact_name','contact_email','contact_phone',
    ];
    let filled = 0;
    FILLABLE.forEach(k => {
      if (fields[k] == null) return;
      const el = f.elements[k];
      if (!el) return;
      el.value = fields[k];
      filled++;
    });

    status.textContent = `Done — ${filled} field${filled !== 1 ? 's' : ''} filled`;
    loading.style.display = 'none';
    idle.style.display    = 'flex';
    idle.querySelector('span').textContent = `✓ ${filled} fields pre-filled from document`;

    // Store financial data for potential use, but don't auto-fill (separate table)
    if (fields.revenue || fields.ebitda || fields.net_profit || fields.total_assets || fields.total_equity) {
      document.getElementById('company-form').dataset.extractedFinancials = JSON.stringify({
        revenue:       fields.revenue,
        ebitda:        fields.ebitda,
        net_profit:    fields.net_profit,
        total_assets:  fields.total_assets,
        total_equity:  fields.total_equity,
        fy_end:        fields.financial_year_end,
      });
    }
  } catch (err) {
    status.textContent = 'Extraction failed';
    loading.style.display = 'none';
    idle.style.display    = 'flex';
    idle.querySelector('span').textContent = 'Upload AFS or company doc — AI will pre-fill the form';
    alert('AI extraction error: ' + _cleanErr(err.message));
  } finally {
    zone.style.pointerEvents = '';
    document.getElementById('ai-doc-input').value = '';
  }
}

async function extractFromDealDocument(file) {
  if (!file) return;

  const idle    = document.getElementById('deal-ai-upload-idle');
  const loading = document.getElementById('deal-ai-upload-loading');
  const status  = document.getElementById('deal-ai-upload-status');
  const zone    = document.getElementById('deal-ai-upload-zone');

  idle.style.display    = 'none';
  loading.style.display = 'flex';
  zone.style.pointerEvents = 'none';
  status.textContent = 'Reading document…';

  try {
    const fd = new FormData();
    fd.append('document', file);

    const res = await fetch('/api/pe/extract-deal', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Extraction failed');

    const f      = document.getElementById('deal-form');
    const fields = json.fields || {};
    const FILLABLE = [
      'company_name','sector','deal_type','target_amount','committed_amount',
      'deal_description','investment_thesis','key_risks','originator','source',
    ];
    let filled = 0;
    FILLABLE.forEach(k => {
      if (fields[k] == null) return;
      const el = f.elements[k];
      if (!el) return;
      el.value = fields[k];
      filled++;
    });

    loading.style.display = 'none';
    idle.style.display    = 'flex';
    idle.querySelector('span').textContent = `✓ ${filled} fields pre-filled from document`;
  } catch (err) {
    loading.style.display = 'none';
    idle.style.display    = 'flex';
    idle.querySelector('span').textContent = 'Upload pitch deck, IM or term sheet — AI will pre-fill the form';
    alert('AI extraction error: ' + _cleanErr(err.message));
  } finally {
    zone.style.pointerEvents = '';
    document.getElementById('deal-ai-doc-input').value = '';
  }
}

/* ── Financials AFS extraction ── */
let _finDocQueue = null; // single file queued for storage

async function extractFromFinancialsDocument(file) {
  if (!file) return;

  const idle    = document.getElementById('fin-ai-upload-idle');
  const loading = document.getElementById('fin-ai-upload-loading');
  const status  = document.getElementById('fin-ai-upload-status');
  const zone    = document.getElementById('fin-ai-upload-zone');

  idle.style.display    = 'none';
  loading.style.display = 'flex';
  zone.style.pointerEvents = 'none';
  status.textContent = 'Reading AFS…';

  // Queue the file for storage regardless of extraction outcome
  _finDocQueue = file;

  try {
    const fd = new FormData();
    fd.append('document', file);

    const res  = await fetch('/api/pe/extract-financials', {
      method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || 'Extraction failed');

    const f      = document.getElementById('fin-form');
    const fields = json.fields || {};
    const FILLABLE = [
      'financial_year','revenue','gross_profit','ebitda','ebit','net_profit',
      'ebitda_margin','net_margin','revenue_growth',
      'total_assets','total_liabilities','equity','cash','total_debt',
      'operating_cashflow','free_cashflow','capex',
    ];
    let filled = 0;
    FILLABLE.forEach(k => {
      if (fields[k] == null) return;
      const el = f.elements[k];
      if (!el) return;
      el.value = fields[k];
      filled++;
    });
    if (fields.audited != null && f.elements['audited']) {
      f.elements['audited'].checked = !!fields.audited;
      filled++;
    }

    status.textContent = `Done — ${filled} fields filled`;
    loading.style.display = 'none';
    idle.style.display    = 'flex';
    idle.querySelector('span').textContent = `✓ ${file.name} · ${filled} fields filled — will be stored on save`;
  } catch (err) {
    loading.style.display = 'none';
    idle.style.display    = 'flex';
    idle.querySelector('span').textContent = `⚠ Extraction failed — ${file.name} will still be stored on save`;
    console.error('[PE fin extract]', err.message);
  } finally {
    zone.style.pointerEvents = '';
    document.getElementById('fin-ai-doc-input').value = '';
  }
}

/* ═══════════════════════════════════════════════════
   DOCUMENT ATTACHMENTS (AFS / Supporting Docs)
   ═══════════════════════════════════════════════════ */

let _companyDocQueue = [];
let _dealDocQueue    = [];

function _docIcon(mimetype) {
  if (mimetype === 'application/pdf') return '<i class="fa-solid fa-file-pdf" style="color:var(--danger)"></i>';
  if (mimetype.startsWith('image/'))  return '<i class="fa-solid fa-file-image" style="color:var(--accent)"></i>';
  return '<i class="fa-solid fa-file-lines" style="color:var(--text-muted)"></i>';
}

function renderDocQueue(queue, queueListId, queueName) {
  const el = document.getElementById(queueListId);
  if (!el) return;
  if (!queue.length) { el.innerHTML = ''; return; }
  el.innerHTML = queue.map((item, i) => `
    <div class="doc-queue-item">
      ${_docIcon(item.file.type)}
      <input class="doc-label-input" value="${esc(item.label)}"
        onchange="updateDocLabel('${queueName}',${i},this.value)"
        placeholder="Label (e.g. AFS 2024)">
      <span class="doc-filename" title="${esc(item.file.name)}">${esc(item.file.name)}</span>
      <button class="icon-btn" onclick="removeDocFromQueue('${queueName}',${i})" title="Remove">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>`).join('');
}

function queueCompanyDoc(files) {
  Array.from(files).forEach(f => _companyDocQueue.push({ file: f, label: f.name }));
  renderDocQueue(_companyDocQueue, 'company-doc-queue', 'company');
  document.getElementById('company-doc-input').value = '';
}

function queueDealDoc(files) {
  Array.from(files).forEach(f => _dealDocQueue.push({ file: f, label: f.name }));
  renderDocQueue(_dealDocQueue, 'deal-doc-queue', 'deal');
  document.getElementById('deal-doc-input').value = '';
}

function updateDocLabel(queueName, i, val) {
  if (queueName === 'company') _companyDocQueue[i].label = val;
  else _dealDocQueue[i].label = val;
}

function removeDocFromQueue(queueName, i) {
  if (queueName === 'company') {
    _companyDocQueue.splice(i, 1);
    renderDocQueue(_companyDocQueue, 'company-doc-queue', 'company');
  } else {
    _dealDocQueue.splice(i, 1);
    renderDocQueue(_dealDocQueue, 'deal-doc-queue', 'deal');
  }
}

async function uploadDocQueue(queue, companyId, dealId) {
  for (const item of queue) {
    const fd = new FormData();
    fd.append('document', item.file);
    fd.append('label', item.label || item.file.name);
    fd.append('doc_type', 'AFS');
    if (companyId) fd.append('company_id', companyId);
    if (dealId)    fd.append('deal_id', dealId);
    const res = await fetch('/api/pe/documents/upload', {
      method: 'POST',
      credentials: 'include',
      headers: _authHeaders(),
      body: fd,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Upload failed'); }
  }
}

async function deleteDoc(docId, afterFn) {
  if (!confirm('Delete this document?')) return;
  await fetch(`/api/pe/documents/${docId}`, {
    method: 'DELETE', credentials: 'include', headers: _authHeaders(),
  });
  if (afterFn) afterFn();
}

async function loadCompanyDocs(companyId) {
  const el = document.getElementById('cp-documents');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Loading…</p>';
  try {
    const res  = await fetch(`/api/pe/documents/list?company_id=${encodeURIComponent(companyId)}`, {
      credentials: 'include', headers: _authHeaders(),
    });
    const json = await res.json();
    const docs = json.docs || [];
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-size:13px;font-weight:600">Documents (${docs.length})</span>
        <label class="btn btn-primary btn-sm doc-attach-btn" style="cursor:pointer">
          <i class="fa-solid fa-upload"></i> Upload
          <input type="file" multiple accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
            style="display:none"
            onchange="uploadAndRefreshCompanyDocs(event.target.files,'${esc(companyId)}')">
        </label>
      </div>
      ${docs.length ? docs.map(d => `
        <div class="doc-existing-item">
          ${_docIcon(d.mimetype)}
          <div class="doc-existing-info">
            <div class="doc-existing-label">${esc(d.label || d.filename)}</div>
            <div class="doc-existing-meta">${d.doc_type} · ${fmtDate(d.uploaded_at)}</div>
          </div>
          <a href="/api/pe/documents/${esc(d.id)}/download" target="_blank"
            class="btn btn-ghost btn-sm" title="Download"
            onclick="event.stopPropagation()">
            <i class="fa-solid fa-download"></i>
          </a>
          <button class="btn btn-ghost btn-sm" title="Delete"
            onclick="deleteDoc('${esc(d.id)}', () => loadCompanyDocs('${esc(companyId)}'))">
            <i class="fa-solid fa-trash" style="color:var(--danger)"></i>
          </button>
        </div>`).join('')
      : '<p style="color:var(--text-muted);font-size:13px">No documents attached yet.</p>'}`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger);font-size:13px">Could not load documents.</p>`;
  }
}

async function uploadAndRefreshCompanyDocs(files, companyId) {
  try {
    for (const f of files) {
      const fd = new FormData();
      fd.append('document', f);
      fd.append('label', f.name);
      fd.append('doc_type', 'AFS');
      fd.append('company_id', companyId);
      const r = await fetch('/api/pe/documents/upload', {
        method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
    }
    loadCompanyDocs(companyId);
  } catch (e) { alert('Upload error: ' + e.message); }
}

async function loadDealDocs(dealId) {
  const el = document.getElementById('dp-docs');
  if (!el) return;
  try {
    const res  = await fetch(`/api/pe/documents/list?deal_id=${encodeURIComponent(dealId)}`, {
      credentials: 'include', headers: _authHeaders(),
    });
    const json = await res.json();
    const docs = json.docs || [];
    el.innerHTML = `
      <div style="border-top:1px solid var(--border);padding:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <span style="font-size:13px;font-weight:600">Documents (${docs.length})</span>
          <label class="btn btn-primary btn-sm doc-attach-btn" style="cursor:pointer">
            <i class="fa-solid fa-upload"></i> Upload
            <input type="file" multiple accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
              style="display:none"
              onchange="uploadAndRefreshDealDocs(event.target.files,'${esc(dealId)}')">
          </label>
        </div>
        ${docs.length ? docs.map(d => `
          <div class="doc-existing-item">
            ${_docIcon(d.mimetype)}
            <div class="doc-existing-info">
              <div class="doc-existing-label">${esc(d.label || d.filename)}</div>
              <div class="doc-existing-meta">${d.doc_type} · ${fmtDate(d.uploaded_at)}</div>
            </div>
            <a href="/api/pe/documents/${esc(d.id)}/download" target="_blank"
              class="btn btn-ghost btn-sm" title="Download"
              onclick="event.stopPropagation()">
              <i class="fa-solid fa-download"></i>
            </a>
            <button class="btn btn-ghost btn-sm" title="Delete"
              onclick="deleteDoc('${esc(d.id)}', () => loadDealDocs('${esc(dealId)}'))">
              <i class="fa-solid fa-trash" style="color:var(--danger)"></i>
            </button>
          </div>`).join('')
        : '<p style="color:var(--text-muted);font-size:13px">No documents attached yet.</p>'}
      </div>`;
  } catch (_) { /* silent */ }
}

async function uploadAndRefreshDealDocs(files, dealId) {
  try {
    for (const f of files) {
      const fd = new FormData();
      fd.append('document', f);
      fd.append('label', f.name);
      fd.append('doc_type', 'AFS');
      fd.append('deal_id', dealId);
      const r = await fetch('/api/pe/documents/upload', {
        method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
    }
    loadDealDocs(dealId);
  } catch (e) { alert('Upload error: ' + e.message); }
}

async function _loadExistingDocsIntoModal(recordId, containerId, type) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const param = type === 'company' ? `company_id=${encodeURIComponent(recordId)}` : `deal_id=${encodeURIComponent(recordId)}`;
  try {
    const res  = await fetch(`/api/pe/documents/list?${param}`, { credentials: 'include', headers: _authHeaders() });
    const json = await res.json();
    const docs = json.docs || [];
    if (!docs.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);font-weight:600">ATTACHED</div>` +
      docs.map(d => `
        <div class="doc-existing-item">
          ${_docIcon(d.mimetype)}
          <div class="doc-existing-info">
            <div class="doc-existing-label">${esc(d.label || d.filename)}</div>
            <div class="doc-existing-meta">${d.doc_type} · ${fmtDate(d.uploaded_at)}</div>
          </div>
          <a href="/api/pe/documents/${esc(d.id)}/download" target="_blank" class="btn btn-ghost btn-sm" title="Download">
            <i class="fa-solid fa-download"></i>
          </a>
          <button class="btn btn-ghost btn-sm" title="Delete"
            onclick="deleteDoc('${esc(d.id)}', () => _loadExistingDocsIntoModal('${esc(recordId)}','${containerId}','${type}'))">
            <i class="fa-solid fa-trash" style="color:var(--danger)"></i>
          </button>
        </div>`).join('');
  } catch (_) { /* silent */ }
}

/* ═══════════════════════════════════════════════════
   ADD / EDIT MODALS
   ═══════════════════════════════════════════════════ */

// ── Company ──
function openAddCompany() {
  document.getElementById('company-modal-title').textContent = 'Add Company';
  const f = document.getElementById('company-form');
  f.reset();
  f.dataset.editId = '';
  f.dataset.extractedFinancials = '';
  _companyDocQueue = [];
  renderDocQueue(_companyDocQueue, 'company-doc-queue', 'company');
  document.getElementById('company-doc-existing').innerHTML = '';
  const idle = document.getElementById('ai-upload-idle');
  if (idle) idle.querySelector('span').textContent = 'Upload AFS or company doc — AI will pre-fill the form';
  document.getElementById('company-modal').classList.add('open');
}

function openEditCompany(id) {
  const co = _companies.find(c => c.id === id);
  if (!co) return;
  document.getElementById('company-modal-title').textContent = 'Edit Company';
  const f = document.getElementById('company-form');
  f.dataset.editId = id;
  ['name','sector','sub_sector','country','city','description','website',
   'registration_number','vat_number','founded_year','employee_count',
   'status','aum_amount','fee_rate','fee_billing_period','entry_date',
   'contact_name','contact_email','contact_phone','notes'].forEach(k => {
    const el = f.elements[k];
    if (el) el.value = co[k] != null ? co[k] : '';
  });
  _companyDocQueue = [];
  renderDocQueue(_companyDocQueue, 'company-doc-queue', 'company');
  // Load existing docs into modal
  _loadExistingDocsIntoModal(id, 'company-doc-existing', 'company');
  document.getElementById('company-modal').classList.add('open');
}

async function saveCompany() {
  const f = document.getElementById('company-form');
  const editId = f.dataset.editId;
  const data = {};
  ['name','sector','sub_sector','country','city','description','website',
   'registration_number','vat_number','founded_year','employee_count',
   'status','aum_amount','fee_rate','fee_billing_period','entry_date',
   'contact_name','contact_email','contact_phone','notes'].forEach(k => {
    data[k] = f.elements[k]?.value || null;
  });
  if (!data.name || !data.sector) { alert('Name and sector are required'); return; }
  try {
    let savedId = editId;
    if (editId) {
      await apiUpdate('pe_companies', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      data.id = 'peco-' + uid();
      await apiCreate('pe_companies', data);
      savedId = data.id;
    }
    if (_companyDocQueue.length) await uploadDocQueue(_companyDocQueue, savedId, null);
    _companyDocQueue = [];
    closeModal('company-modal');
    await loadAll();
    renderView(_activeView);
    if (editId) openCompanyPanel(editId);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Deal ──
function openAddDeal() {
  document.getElementById('deal-modal-title').textContent = 'Add Deal';
  document.getElementById('deal-form').reset();
  document.getElementById('deal-form').dataset.editId = '';
  document.getElementById('company-modal').classList.remove('open');
  _dealDocQueue = [];
  renderDocQueue(_dealDocQueue, 'deal-doc-queue', 'deal');
  document.getElementById('deal-doc-existing').innerHTML = '';
  const idle = document.getElementById('deal-ai-upload-idle');
  if (idle) idle.querySelector('span').textContent = 'Upload pitch deck, IM or term sheet — AI will pre-fill the form';
  document.getElementById('deal-modal').classList.add('open');
}

function openEditDeal(id) {
  const deal = _deals.find(d => d.id === id);
  if (!deal) return;
  document.getElementById('deal-modal-title').textContent = 'Edit Deal';
  const f = document.getElementById('deal-form');
  f.dataset.editId = id;
  ['company_name','company_id','stage','deal_type','sector','target_amount',
   'committed_amount','deal_description','investment_thesis','key_risks',
   'source','originator','assigned_analyst','sourced_date','screening_date',
   'dd_start_date','ic_date','decision_date','decision_notes','priority'].forEach(k => {
    const el = f.elements[k];
    if (el) el.value = deal[k] != null ? deal[k] : '';
  });
  _dealDocQueue = [];
  renderDocQueue(_dealDocQueue, 'deal-doc-queue', 'deal');
  _loadExistingDocsIntoModal(id, 'deal-doc-existing', 'deal');
  document.getElementById('deal-modal').classList.add('open');
}

async function saveDeal() {
  const f = document.getElementById('deal-form');
  const editId = f.dataset.editId;
  const data = {};
  ['company_name','company_id','stage','deal_type','sector','target_amount',
   'committed_amount','deal_description','investment_thesis','key_risks',
   'source','originator','assigned_analyst','sourced_date','screening_date',
   'dd_start_date','ic_date','decision_date','decision_notes','priority'].forEach(k => {
    data[k] = f.elements[k]?.value || null;
  });
  if (!data.company_name) { alert('Company name is required'); return; }
  try {
    let savedId = editId;
    if (editId) {
      await apiUpdate('pe_deals', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      data.id = 'pede-' + uid();
      await apiCreate('pe_deals', data);
      savedId = data.id;
    }
    if (_dealDocQueue.length) await uploadDocQueue(_dealDocQueue, null, savedId);
    _dealDocQueue = [];
    closeModal('deal-modal');
    await loadAll();
    renderView(_activeView);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Financials ──
function openAddFinancials(companyId) {
  document.getElementById('fin-modal-title').textContent = 'Add Financials';
  document.getElementById('fin-form').reset();
  document.getElementById('fin-form').dataset.editId = '';
  document.getElementById('fin-form').elements['company_id'].value = companyId || '';
  _finDocQueue = null;
  const idle = document.getElementById('fin-ai-upload-idle');
  if (idle) idle.querySelector('span').textContent = 'Upload AFS — AI will read and fill all financial fields';
  const loading = document.getElementById('fin-ai-upload-loading');
  if (loading) loading.style.display = 'none';
  if (idle) idle.style.display = 'flex';
  document.getElementById('fin-modal').classList.add('open');
}

async function saveFinancials() {
  const f = document.getElementById('fin-form');
  const editId = f.dataset.editId;
  const data = {};
  ['company_id','financial_year','revenue','gross_profit','ebitda','ebit','net_profit',
   'total_assets','total_liabilities','equity','cash','total_debt','capex',
   'operating_cashflow','free_cashflow','revenue_growth','ebitda_margin','net_margin',
   'notes','audited'].forEach(k => {
    const el = f.elements[k];
    if (!el) return;
    data[k] = k === 'audited' ? el.checked : (el.value || null);
  });
  if (!data.company_id || !data.financial_year) { alert('Company and financial year are required'); return; }
  try {
    if (editId) {
      await apiUpdate('pe_financials', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      data.id = 'pefin-' + uid();
      await apiCreate('pe_financials', data);
    }
    // Upload queued AFS PDF and link it to the company
    if (_finDocQueue) {
      const fd = new FormData();
      fd.append('document', _finDocQueue);
      fd.append('company_id', data.company_id);
      fd.append('doc_type', 'AFS');
      fd.append('label', `AFS ${data.financial_year || ''} — ${_finDocQueue.name}`);
      await fetch('/api/pe/documents/upload', {
        method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
      });
      _finDocQueue = null;
    }
    closeModal('fin-modal');
    await loadAll();
    renderView(_activeView);
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Fee ──
function openAddFee(companyId) {
  document.getElementById('fee-modal-title').textContent = 'Add Fee';
  document.getElementById('fee-form').reset();
  document.getElementById('fee-form').dataset.editId = '';
  document.getElementById('fee-form').elements['company_id'].value = companyId || '';
  // Default company fee rate
  if (companyId) {
    const co = _companies.find(c => c.id === companyId);
    if (co?.aum_amount && co?.fee_rate) {
      const annual = parseFloat(co.aum_amount) * parseFloat(co.fee_rate);
      document.getElementById('fee-form').elements['amount'].value = annual.toFixed(2);
    }
  }
  document.getElementById('fee-modal').classList.add('open');
}

function openFeeEdit(id) {
  const fee = _fees.find(f => f.id === id);
  if (!fee) return;
  document.getElementById('fee-modal-title').textContent = 'Edit Fee';
  const f = document.getElementById('fee-form');
  f.dataset.editId = id;
  ['company_id','period_start','period_end','fee_type','amount','status',
   'invoice_date','due_date','paid_date','invoice_number','notes'].forEach(k => {
    const el = f.elements[k];
    if (el) el.value = fee[k] != null ? fee[k] : '';
  });
  document.getElementById('fee-modal').classList.add('open');
}

async function saveFee() {
  const f = document.getElementById('fee-form');
  const editId = f.dataset.editId;
  const data = {};
  ['company_id','period_start','period_end','fee_type','amount','status',
   'invoice_date','due_date','paid_date','invoice_number','notes'].forEach(k => {
    data[k] = f.elements[k]?.value || null;
  });
  if (!data.company_id || !data.amount) { alert('Company and amount are required'); return; }
  try {
    if (editId) {
      await apiUpdate('pe_fees', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      data.id = 'pefee-' + uid();
      await apiCreate('pe_fees', data);
    }
    closeModal('fee-modal');
    await loadAll();
    renderView(_activeView);
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Update note ──
function openAddUpdate(companyId) {
  document.getElementById('update-form').reset();
  document.getElementById('update-form').elements['company_id'].value = companyId || '';
  document.getElementById('update-modal').classList.add('open');
}

async function saveUpdate() {
  const f = document.getElementById('update-form');
  const data = {
    company_id:  f.elements['company_id'].value,
    update_type: f.elements['update_type'].value,
    title:       f.elements['title'].value,
    body:        f.elements['body'].value,
    author:      f.elements['author'].value || null,
  };
  if (!data.company_id || !data.title || !data.body) { alert('Company, title and body are required'); return; }
  try {
    data.id = 'peupd-' + uid();
    await apiCreate('pe_updates', data);
    closeModal('update-modal');
    await loadAll();
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Deletes ──
async function confirmDeleteDeal(id) {
  if (!confirm('Delete this deal?')) return;
  try {
    await apiDelete('pe_deals', id);
    document.getElementById('deal-panel').classList.remove('open');
    document.getElementById('panel-backdrop').classList.remove('open');
    await loadAll();
    renderPipeline();
  } catch(e) { alert('Error: ' + e.message); }
}

async function confirmDeleteFee(id) {
  if (!confirm('Delete this fee record?')) return;
  try {
    await apiDelete('pe_fees', id);
    await loadAll();
    renderFeesView();
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
  } catch(e) { alert('Error: ' + e.message); }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

/* ── Modal company selectors ── */
function populateCompanySelects() {
  const opts = '<option value="">— None —</option>' +
    _companies.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  ['deal-company-select','fin-company-select-modal','fee-company-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
  // Fin view selector
  const finSel = document.getElementById('fin-company-select');
  if (finSel) {
    finSel.innerHTML = '<option value="">— Select company —</option>' +
      _companies.filter(c => c.status === 'portfolio').map(c =>
        `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  }
}

/* ── Init ── */
window.addEventListener('DOMContentLoaded', async () => {
  // Auth guard
  if (typeof StaffAuth !== 'undefined') {
    const session = StaffAuth.getSession();
    if (!session) { window.location.replace('/team/login.html'); return; }
    const allowed = StaffAuth.getAllowedApps(session);
    if (!allowed.includes('pe_monitor')) { window.location.replace('/team/hub.html'); return; }
  }

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });

  // Panel tabs
  document.querySelectorAll('.panel-tab').forEach(el => {
    el.addEventListener('click', () => switchPanelTab(el.dataset.tab));
  });

  // Backdrop
  document.getElementById('panel-backdrop').addEventListener('click', closePanelOnBackdrop);

  // Search boxes
  ['pipeline-search','portfolio-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      if (id === 'pipeline-search') renderPipeline();
      if (id === 'portfolio-search') renderPortfolio();
    });
  });

  // Filters
  document.getElementById('portfolio-status')?.addEventListener('change', renderPortfolio);
  document.getElementById('fee-status-filter')?.addEventListener('change', () => renderFeesView());
  document.getElementById('fin-company-select')?.addEventListener('change', () => renderFinancialsView());

  // Load and render
  try { await loadAll(); } catch(e) { console.error('[PE Monitor] load failed', e); }
  populateCompanySelects();
  navigate('dashboard');
});
