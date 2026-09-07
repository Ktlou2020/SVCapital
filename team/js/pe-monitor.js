/* PE Monitor — Private Equity SPA */

const API_BASE = '/api/tables';
const SECTOR_COLORS = [
  '#3b82f6','#00d4aa','#fec24f','#eda5ff','#f87171',
  '#fb923c','#4ade80','#818cf8','#e879f9','#38bdf8',
];

/* The funnel a deal actually walks. Three stages were added between the ones
   that were here — an introductory meeting while terms are negotiated, the
   drafting and review of agreements, and active, meaning signed and billing.
   Order matters: this array is what draws the pipeline columns left to right,
   so a stage inserted in the wrong place puts a later step before an earlier
   one on screen while the data stays correct and nobody can see why. */
const STAGE_ORDER = ['sourcing','intro_meeting','screening','due_diligence','drafting','ic_review','approved','active','closed','declined','exited'];
const STAGE_LABELS = {
  sourcing:       'Sourcing',
  intro_meeting:  'Introductory Meeting',
  screening:      'Screening',
  due_diligence:  'Due Diligence',
  drafting:       'Drafting Agreements',
  ic_review:      'IC Review',
  approved:       'Approved',
  active:         'Active',
  closed:         'Closed',
  declined:       'Declined',
  exited:         'Exited',
};
/* The one-line explanation under each pipeline column heading — the stage
   names on their own did not say where the boundary between two of them is. */
const STAGE_HINT = {
  sourcing:       'Identified, not yet met',
  intro_meeting:  'Initial meeting and deal negotiating',
  screening:      'Initial assessment',
  due_diligence:  'Detailed review',
  drafting:       'Draft agreements and reviewing',
  ic_review:      'Investment committee',
  approved:       'Approved, awaiting signature',
  active:         'Agreements signed — billing',
  closed:         'Concluded',
  declined:       'Not proceeding',
  exited:         'Exited',
};
const STAGE_COLOR = {
  sourcing:       'badge-gray',
  intro_meeting:  'badge-blue',
  screening:      'badge-blue',
  due_diligence:  'badge-gold',
  drafting:       'badge-orange',
  ic_review:      'badge-orange',
  approved:       'badge-teal',
  active:         'badge-teal',
  closed:         'badge-teal',
  declined:       'badge-red',
  exited:         'badge-purple',
};
/* Stages that are still live work. 'active' is a live client, not a finished
   deal, so it counts here — the pipeline tile was only ever excluding the
   three terminal stages and would otherwise have dropped it silently. */
const STAGE_TERMINAL = ['closed','declined','exited'];

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
let _reviews    = [];
let _meetings   = [];
let _bee        = [];
let _afsReq     = [];
let _activeView = 'dashboard';
let _openCompanyId = null;
let _openDealId    = null;
/* Archived clients stay in _companies — every fee, financial and document
   still points at them and the panel must still open — but they are filtered
   out of every list and every total unless the operator asks to see them. */
let _showArchived = false;
let _summaryCache  = {};   // company id → /summary payload
let _xeroPending   = null; // { file, companyId, preview }

/* ── Helpers ── */
function fmtR(n) {
  if (n == null || n === '') return '—';
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return '—';
  /* Sign outside the symbol. Negative equity rendered as R-2 000 000 reads as
     a typo at a glance; -R2 000 000 reads as a number, which is what it is —
     and it is the shape the server formats these in. */
  const body = Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (v < 0 ? '-R' : 'R') + body;
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
  const sectors = [...new Set(activeCompanies().map(c => c.sector).filter(Boolean))].sort();
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
  [_companies, _deals, _financials, _fees, _updates, _reviews, _meetings, _bee, _afsReq] = await Promise.all([
    safeFetch('pe_companies'),
    safeFetch('pe_deals'),
    safeFetch('pe_financials'),
    safeFetch('pe_fees'),
    safeFetch('pe_updates'),
    safeFetch('pe_reviews'),
    safeFetch('pe_meeting_notes'),
    safeFetch('pe_bee_verifications'),
    safeFetch('pe_afs_requests'),
  ]);
  /* A stale summary outlives the data it summarised — reloading has to drop
     it or the panel shows last load's red flags against this load's figures. */
  _summaryCache = {};
}

/* The clients on the book. Everything that lists, counts or totals companies
   goes through here, so archiving a duplicate removes it from all of them at
   once rather than from whichever lists somebody remembered to change. */
function activeCompanies() {
  return _showArchived ? _companies : _companies.filter(c => !isArchived(c));
}
function isArchived(c) {
  return c && (c.archived === true || c.archived === 't' || c.archived === 'true');
}
function companyById(id) {
  return _companies.find(c => c.id === id) || null;
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
  const portfolio = activeCompanies().filter(c => c.status === 'portfolio');
  const totalAum  = portfolio.reduce((s, c) => s + (parseFloat(c.aum_amount) || 0), 0);
  const paidFees  = _fees.filter(f => f.status === 'paid').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
  const overdueFees = _fees.filter(f => f.status === 'overdue').reduce((s, f) => s + (parseFloat(f.amount) || 0), 0);
  const activePipeline = _deals.filter(d => !STAGE_TERMINAL.includes(d.stage)).length;

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
  loadAfsReminders();
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
  /* Every live stage, so the two new ones in the middle of the funnel are not
     silently missing from the dashboard's read of where the deals are. */
  const stages = STAGE_ORDER.filter(st => !STAGE_TERMINAL.includes(st));
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
    const co = companyById(f.company_id);
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

  /* Every non-terminal stage, in STAGE_ORDER, rather than a second
     hand-written list. The two lists had already drifted once — the board's
     copy is what draws the columns, so a stage missing from it makes deals on
     that stage invisible while the counts elsewhere still include them. */
  const activeCols = STAGE_ORDER.filter(st => !STAGE_TERMINAL.includes(st));
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
      ${STAGE_HINT[stage] ? `<div class="pipeline-col-hint">${esc(STAGE_HINT[stage])}</div>` : ''}
      <div class="pipeline-cards">${cardsHtml}</div>
    </div>`;
  }).join('');

  // Closed / declined / exited table
  const closed = _deals.filter(d => STAGE_TERMINAL.includes(d.stage));
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
  let companies = activeCompanies();
  if (search)       companies = companies.filter(c => c.name?.toLowerCase().includes(search) || c.sector?.toLowerCase().includes(search));
  if (statusFilter) companies = companies.filter(c => c.status === statusFilter);

  const bySector = {};
  companies.forEach(c => {
    const s = c.sector || 'Uncategorised';
    if (!bySector[s]) bySector[s] = [];
    bySector[s].push(c);
  });

  const wrap = document.getElementById('portfolio-list');
  const archivedCount = _companies.filter(isArchived).length;
  /* The archive toggle lives above the list rather than in a settings menu:
     the reason a client is missing has to be visible from where you noticed
     it was missing. */
  const bar = archivedCount || _showArchived ? `
    <div class="archive-bar">
      <label class="archive-toggle">
        <input type="checkbox" ${_showArchived ? 'checked' : ''} onchange="toggleArchived(this.checked)" />
        <span>Show archived (${archivedCount})</span>
      </label>
    </div>` : '';

  if (!companies.length) {
    wrap.innerHTML = bar + `<div class="empty-state"><i class="fa-solid fa-briefcase"></i><p>No companies found</p></div>`;
    return;
  }

  wrap.innerHTML = bar + Object.entries(bySector).sort().map(([sector, cos]) => `
    <div class="sector-group">
      <div class="sector-label" style="color:${sectorColor(sector)}">
        <i class="fa-solid fa-circle-small" style="font-size:8px"></i>
        ${esc(sector)} &nbsp;<span style="color:var(--text-muted);font-weight:400">(${cos.length})</span>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Company</th><th>Status</th><th>Annual Fee</th><th>SVC Share</th><th>Holding</th>
              <th>Contract Start</th><th>City</th><th>Contact</th><th></th>
            </tr></thead>
            <tbody>
              ${cos.map(c => `<tr onclick="openCompanyPanel('${esc(c.id)}')" class="${isArchived(c) ? 'row-archived' : ''}">
                <td><strong>${esc(c.name)}</strong>${isArchived(c) ? ' <span class="pill-archived">Archived</span>' : ''}${c.sub_sector ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(c.sub_sector)}</span>` : ''}</td>
                <td>${badge(STATUS_COLOR[c.status] || 'badge-gray', c.status)}</td>
                <td class="num">${feeCellHtml(c)}</td>
                <td class="num">${fmtR(annualSvcShare(c))}</td>
                <td class="num">${c.holding_pct ? fmtPct(c.holding_pct) : '—'}</td>
                <td>${fmtDate(contractStart(c))}</td>
                <td>${esc(c.city || '—')}</td>
                <td>${esc(c.contact_name || '—')}</td>
                <td class="row-actions" onclick="event.stopPropagation()">
                  ${isArchived(c)
                    ? `<button class="icon-btn" title="Restore to the list" onclick="unarchiveCompany('${esc(c.id)}')"><i class="fa-solid fa-rotate-left"></i></button>`
                    : `<button class="icon-btn" title="Archive" onclick="archiveCompany('${esc(c.id)}')"><i class="fa-solid fa-box-archive"></i></button>`}
                  <button class="icon-btn icon-btn-danger" title="Delete permanently" onclick="deleteCompany('${esc(c.id)}')"><i class="fa-solid fa-trash"></i></button>
                </td>
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
      activeCompanies().filter(c => c.status === 'portfolio').map(c =>
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
        const co = companyById(f.company_id);
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
  const co = companyById(id);
  if (!co) return;
  _openCompanyId = id;

  const panel = document.getElementById('company-panel');
  document.getElementById('panel-backdrop').classList.add('open');

  document.getElementById('cp-name').textContent = co.name;
  document.getElementById('cp-status').innerHTML = badge(STATUS_COLOR[co.status] || 'badge-gray', co.status);

  // Overview tab
  document.getElementById('cp-overview').innerHTML = `
    ${isArchived(co) ? `<div class="archive-notice">
      <i class="fa-solid fa-box-archive"></i>
      <span>Archived${co.archived_at ? ' on ' + fmtDate(co.archived_at) : ''}${co.archived_by ? ' by ' + esc(co.archived_by) : ''}${co.archived_reason ? ' — ' + esc(co.archived_reason) : ''}.
      Its records are intact and it is hidden from the lists.</span>
      <button class="btn btn-ghost btn-sm" onclick="unarchiveCompany('${esc(id)}')">Restore</button>
    </div>` : ''}
    <div class="kv-grid">
      <div class="kv-item"><div class="kv-label">Sector</div><div class="kv-val">${esc(co.sector)}</div></div>
      <div class="kv-item"><div class="kv-label">Sub-Sector</div><div class="kv-val">${esc(co.sub_sector || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Partnership</div><div class="kv-val">${esc(co.partnership_name || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Equity Holding</div><div class="kv-val">${co.holding_pct ? fmtPct(co.holding_pct) : '—'}</div></div>
      <div class="kv-item"><div class="kv-label">AUM</div><div class="kv-val" style="color:var(--accent);font-weight:700">${fmtR(co.aum_amount)}</div></div>
      <div class="kv-item"><div class="kv-label">Contract Start</div><div class="kv-val">${fmtDate(contractStart(co))}</div></div>
      <div class="kv-item"><div class="kv-label">Contract End</div><div class="kv-val">${fmtDate(co.contract_end_date)}</div></div>
      <div class="kv-item"><div class="kv-label">Financial Year End</div><div class="kv-val">${monthEndLabel(co.financial_year_end_month)}</div></div>
      <div class="kv-item"><div class="kv-label">Country</div><div class="kv-val">${esc(co.country || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">City</div><div class="kv-val">${esc(co.city || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Founded</div><div class="kv-val">${esc(co.founded_year || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Employees</div><div class="kv-val">${co.employee_count ? parseInt(co.employee_count).toLocaleString() : '—'}</div></div>
      <div class="kv-item"><div class="kv-label">Registration</div><div class="kv-val">${esc(co.registration_number || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">VAT Number</div><div class="kv-val">${esc(co.vat_number || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Contact</div><div class="kv-val">${esc(co.contact_name || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Email</div><div class="kv-val">${co.contact_email ? `<a href="mailto:${esc(co.contact_email)}" style="color:var(--accent)">${esc(co.contact_email)}</a>` : '—'}</div></div>
      <div class="kv-item"><div class="kv-label">Phone</div><div class="kv-val">${esc(co.contact_phone || '—')}</div></div>
      ${businessAddressHtml(co)}
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
        <div class="kv-item"><div class="kv-label">EBITDA</div><div class="kv-val">${fmtR(ebitdaOf(latest))}${latest.ebitda == null ? ' <span class="derived-tag" title="Not stated on the AFS — rebuilt by adding tax, finance cost, depreciation and amortisation back to net profit">derived</span>' : ''}</div></div>
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

  /* Updates, newest FIRST BY THE DATE THEY HAPPENED. This sorted on
     created_at, so an update typed today about last month's board meeting
     jumped the queue ahead of everything that actually happened after it. */
  const updates = _updates.filter(u => u.company_id === id)
    .sort((a, b) => new Date(updateDate(b)) - new Date(updateDate(a)));
  document.getElementById('cp-updates').innerHTML = `
    <div style="margin-bottom:14px">
      <button class="btn btn-primary btn-sm" onclick="openAddUpdate('${esc(id)}')"><i class="fa-solid fa-plus"></i> Add Update</button>
    </div>
    ${updates.length ? updates.map(u => `
      <div class="update-item type-${esc(u.update_type)}">
        <div class="u-header">
          ${badge('badge-gray', u.update_type)}
          <span class="u-title">${esc(u.title)}</span>
          <span class="u-actions">
            <button class="icon-btn" title="Edit" onclick="openEditUpdate('${esc(u.id)}')"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn icon-btn-danger" title="Delete" onclick="deleteUpdate('${esc(u.id)}')"><i class="fa-solid fa-trash"></i></button>
          </span>
        </div>
        <div class="u-meta">${fmtDate(updateDate(u))}${u.author ? ' · ' + esc(u.author) : ''}</div>
        <div class="u-body" style="margin-top:6px">${esc(u.body)}</div>
        <div class="u-attachments" id="u-att-${esc(u.id)}"></div>
      </div>`).join('') : '<p style="color:var(--text-muted);font-size:13px">No updates yet.</p>'}`;
  updates.forEach(u => loadUpdateAttachments(u.id));

  renderFeesTab(id);
  renderComplianceTab(id);
  renderMeetingsTab(id);
  renderReviewsTab(id);

  // Open to overview tab
  switchPanelTab('overview');
  panel.classList.add('open');
  // Load documents tab in background
  loadCompanyDocs(id);
  /* The position tab is the only one that needs the server: the red flags and
     the derived EBITDA are computed there so that the console, the API and the
     check suite cannot each arrive at a different answer. */
  loadCompanyPosition(id);
}

function renderReviewsTab(companyId) {
  const reviews = _reviews
    .filter(r => r.company_id === companyId)
    .sort((a, b) => new Date(b.review_date) - new Date(a.review_date));

  const next = reviews.find(r => r.next_review_date);
  const nextDate = next?.next_review_date;
  const daysUntil = nextDate ? Math.round((new Date(nextDate) - new Date()) / 86400000) : null;

  document.getElementById('cp-reviews').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div>
        ${nextDate ? `
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:3px">Next Review</div>
          <div style="font-size:14px;font-weight:600">${fmtDate(nextDate)}
            <span style="font-size:12px;font-weight:400;color:${daysUntil <= 14 ? 'var(--danger)' : 'var(--text-muted)'};margin-left:6px">${daysUntil !== null ? (daysUntil === 0 ? 'Today' : daysUntil < 0 ? `${Math.abs(daysUntil)}d overdue` : `in ${daysUntil}d`) : ''}</span>
          </div>` : '<div style="font-size:13px;color:var(--text-muted)">No review scheduled</div>'}
      </div>
      <button class="btn btn-primary btn-sm" onclick="openAddReview('${esc(companyId)}')">
        <i class="fa-solid fa-calendar-plus"></i> Schedule Review
      </button>
    </div>
    ${reviews.length ? reviews.map(r => `
      <div class="review-item">
        <div class="review-header">
          <span class="review-date"><i class="fa-solid fa-calendar-check" style="margin-right:6px;color:var(--accent)"></i>${fmtDate(r.review_date)}</span>
          ${r.next_review_date ? `<span style="font-size:12px;color:var(--text-muted)">Next: ${fmtDate(r.next_review_date)}</span>` : ''}
        </div>
        ${r.attendees ? `<div class="review-attendees"><i class="fa-solid fa-users" style="margin-right:5px;color:var(--text-muted)"></i>${esc(r.attendees)}</div>` : ''}
        ${r.notes ? `<div class="review-notes">${esc(r.notes)}</div>` : ''}
        <div style="margin-top:8px">
          <button class="btn btn-ghost btn-sm" onclick="openEditReview('${esc(r.id)}')"><i class="fa-solid fa-pen"></i> Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteReview('${esc(r.id)}','${esc(companyId)}')"><i class="fa-solid fa-trash" style="color:var(--danger)"></i></button>
        </div>
      </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px">No reviews recorded yet.</p>'}`;
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
      <div class="kv-item"><div class="kv-label">Equity Holding</div><div class="kv-val">${deal.holding_pct ? fmtPct(deal.holding_pct) : '—'}</div></div>
      <div class="kv-item"><div class="kv-label">Prospect Fee</div><div class="kv-val">${fmtR(deal.prospect_fee)}</div></div>
      <div class="kv-item"><div class="kv-label">Contact</div><div class="kv-val">${esc(deal.contact_name || '—')}${deal.contact_role ? `<br><span style="font-size:11px;color:var(--text-muted)">${esc(deal.contact_role)}</span>` : ''}</div></div>
      <div class="kv-item"><div class="kv-label">Contact Email</div><div class="kv-val">${deal.contact_email ? `<a href="mailto:${esc(deal.contact_email)}" style="color:var(--accent)">${esc(deal.contact_email)}</a>` : '—'}</div></div>
      <div class="kv-item"><div class="kv-label">Contact Phone</div><div class="kv-val">${esc(deal.contact_phone || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Registration</div><div class="kv-val">${esc(deal.registration_number || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">City</div><div class="kv-val">${esc(deal.city || '—')}</div></div>
      <div class="kv-item"><div class="kv-label">Employees</div><div class="kv-val">${deal.employee_count ? parseInt(deal.employee_count).toLocaleString() : '—'}</div></div>
      ${deal.website ? `<div class="kv-item full"><div class="kv-label">Website</div><div class="kv-val"><a href="${esc(deal.website)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(deal.website)}</a></div></div>` : ''}
      ${deal.prospect_fee_basis ? `<div class="kv-item full"><div class="kv-label">Prospect Fee Basis</div><div class="kv-val" style="color:var(--text-muted)">${esc(deal.prospect_fee_basis)}</div></div>` : ''}
    </div>
    ${deal.deal_description ? `<div style="margin-bottom:14px"><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:6px">Description</div><div style="font-size:13px;line-height:1.6">${esc(deal.deal_description)}</div></div>` : ''}
    ${deal.investment_thesis ? `<div style="margin-bottom:14px"><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:6px">Investment Thesis</div><div style="font-size:13px;line-height:1.6;color:var(--text-muted)">${esc(deal.investment_thesis)}</div></div>` : ''}
    ${deal.key_risks ? `<div style="margin-bottom:14px"><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--danger);margin-bottom:6px">Key Risks</div><div style="font-size:13px;line-height:1.6;color:var(--text-muted)">${esc(deal.key_risks)}</div></div>` : ''}
    ${deal.decision_notes ? `<div><div class="kv-label" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:6px">Decision Notes</div><div style="font-size:13px;line-height:1.6;color:var(--text-muted)">${esc(deal.decision_notes)}</div></div>` : ''}
    <hr class="divider">
    <h4 class="panel-subhead">Notes &amp; Meetings
      <button class="btn btn-primary btn-sm" onclick="openAddMeeting(null,'${esc(deal.id)}')"><i class="fa-solid fa-plus"></i> Add Note</button>
    </h4>
    <div id="dp-meetings">${dealMeetingsHtml(id)}</div>
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

    if (stage === 'closed') {
      const deal = _deals.find(d => d.id === id);
      if (deal) await _autoCreateCompanyFromDeal(deal);
    }
  } catch(e) { alert('Error: ' + e.message); }
}

async function _autoCreateCompanyFromDeal(deal) {
  if (!deal.company_name) return;
  const existing = _companies.find(c =>
    c.name.trim().toLowerCase() === deal.company_name.trim().toLowerCase()
  );
  if (existing) return; // already exists
  try {
    const coData = {
      id:          'peco-' + uid(),
      name:        deal.company_name,
      sector:      deal.sector || null,
      status:      'portfolio',
      description: deal.deal_description || null,
      entry_date:  new Date().toISOString().split('T')[0],
    };
    await apiCreate('pe_companies', coData);
    await loadAll();
    alert(`Company "${deal.company_name}" has been automatically added to your Portfolio.`);
  } catch (e) {
    console.warn('[PE] Auto-create company failed:', e.message);
  }
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

/* One queue per modal, addressed by name. They were two named variables and a
   pair of if/else branches; adding two more modals that way is four branches
   in three functions, each of which is a place to fall through to the wrong
   queue and silently attach a file to the wrong record. */
const DOC_QUEUES = { company: [], deal: [], update: [], bee: [] };
const DOC_QUEUE_EL = {
  company: 'company-doc-queue', deal: 'deal-doc-queue',
  update:  'update-doc-queue',  bee:  'bee-doc-queue',
};
/* Kept as bindings because the existing call sites read them by name. */
let _companyDocQueue = DOC_QUEUES.company;
let _dealDocQueue    = DOC_QUEUES.deal;
let _updateDocQueue  = DOC_QUEUES.update;
let _beeDocQueue     = DOC_QUEUES.bee;

function _docIcon(mimetype) {
  const t = mimetype || '';
  if (t === 'application/pdf') return '<i class="fa-solid fa-file-pdf" style="color:var(--danger)"></i>';
  if (t.startsWith('image/'))  return '<i class="fa-solid fa-file-image" style="color:var(--accent)"></i>';
  /* Spreadsheets are now uploadable, and a Xero export that draws as a
     generic page is indistinguishable from the AFS next to it. */
  if (/spreadsheet|excel|csv/.test(t)) return '<i class="fa-solid fa-file-excel" style="color:#4ade80"></i>';
  if (/word|document/.test(t))         return '<i class="fa-solid fa-file-word" style="color:#3b82f6"></i>';
  return '<i class="fa-solid fa-file-lines" style="color:var(--text-muted)"></i>';
}

/* Labels for the document-kind filing used by the panel and the picker. */
const DOC_TYPE_LABELS = {
  AFS: 'Annual Financial Statements',
  fund_management: 'Fund Management Agreement',
  partnership: 'Partnership Agreement',
  bee: 'BEE Verification',
  xero_invoice: 'Xero Invoices',
  working_spreadsheet: 'Monthly Working Spreadsheets',
  update: 'Update Attachments',
  general: 'Other Documents',
};
/* The order the panel stacks them in: the agreements that define the
   relationship first, then what they produce, then everything else. */
const DOC_TYPE_ORDER = ['fund_management','partnership','AFS','bee','xero_invoice','working_spreadsheet','update','general'];

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

function queueDoc(queueName, files, inputId) {
  const q = DOC_QUEUES[queueName];
  if (!q) return;
  /* The kind is read at queue time, from the picker next to the button, so
     two files added under two different kinds in one sitting keep theirs. */
  const sel = document.getElementById(queueName + '-doc-type');
  const docType = sel ? sel.value : null;
  Array.from(files).forEach(f => q.push({ file: f, label: f.name, doc_type: docType }));
  renderDocQueue(q, DOC_QUEUE_EL[queueName], queueName);
  const input = document.getElementById(inputId);
  if (input) input.value = '';
}

function queueCompanyDoc(files) { queueDoc('company', files, 'company-doc-input'); }
function queueDealDoc(files)    { queueDoc('deal',    files, 'deal-doc-input'); }
function queueUpdateDoc(files)  { queueDoc('update',  files, 'update-doc-input'); }
function queueBeeDoc(files)     { queueDoc('bee',     files, 'bee-doc-input'); }

function updateDocLabel(queueName, i, val) {
  const q = DOC_QUEUES[queueName];
  if (q && q[i]) q[i].label = val;
}

function removeDocFromQueue(queueName, i) {
  const q = DOC_QUEUES[queueName];
  if (!q) return;
  q.splice(i, 1);
  renderDocQueue(q, DOC_QUEUE_EL[queueName], queueName);
}

async function uploadDocQueue(queue, companyId, dealId, extra) {
  for (const item of queue) {
    const fd = new FormData();
    fd.append('document', item.file);
    fd.append('label', item.label || item.file.name);
    /* The kind chosen when the file was queued, then whatever the caller
       forces, then the old default. It was hard-coded to 'AFS', so a signed
       fund management agreement filed itself under Annual Financial
       Statements and there was no way to tell them apart afterwards. */
    fd.append('doc_type', (extra && extra.doc_type) || item.doc_type || 'AFS');
    if (extra && extra.update_id)      fd.append('update_id', extra.update_id);
    if (extra && extra.bee_id)         fd.append('bee_id', extra.bee_id);
    if (extra && extra.financial_year) fd.append('financial_year', extra.financial_year);
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

function _docListHtml(docs, companyId, docType) {
  if (!docs.length) return `<p style="color:var(--text-muted);font-size:13px;padding:4px 0">None yet.</p>`;
  return docs.map(d => `
    <div class="doc-existing-item">
      ${_docIcon(d.mimetype)}
      <div class="doc-existing-info">
        <div class="doc-existing-label">${esc(d.label || d.filename)}</div>
        <div class="doc-existing-meta">${fmtDate(d.uploaded_at)}</div>
      </div>
      <a href="/api/pe/documents/${esc(d.id)}/download" target="_blank"
        class="btn btn-ghost btn-sm" title="Download" onclick="event.stopPropagation()">
        <i class="fa-solid fa-download"></i>
      </a>
      <button class="btn btn-ghost btn-sm" title="Delete"
        onclick="deleteDoc('${esc(d.id)}', () => loadCompanyDocs('${esc(companyId)}'))">
        <i class="fa-solid fa-trash" style="color:var(--danger)"></i>
      </button>
    </div>`).join('');
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
    const all  = json.docs || [];
    const agreements = all.filter(d => d.doc_type === 'partnership');
    const other      = all.filter(d => d.doc_type !== 'partnership');

    el.innerHTML = `
      <!-- Partnership Agreements -->
      <div class="doc-section-header" style="margin-top:0">
        <span><i class="fa-solid fa-file-signature" style="margin-right:6px;color:var(--accent)"></i>Partnership Agreements (${agreements.length})</span>
        <label class="btn btn-ghost btn-sm doc-attach-btn" style="cursor:pointer">
          <i class="fa-solid fa-upload"></i> Upload Agreement
          <input type="file" multiple accept=".pdf,.doc,.docx,image/jpeg,image/png"
            style="display:none"
            onchange="uploadCompanyDoc(event.target.files,'${esc(companyId)}','partnership')">
        </label>
      </div>
      <div style="margin-bottom:20px">${_docListHtml(agreements, companyId, 'partnership')}</div>

      <!-- General Documents -->
      <div class="doc-section-header">
        <span><i class="fa-solid fa-folder-open" style="margin-right:6px;color:var(--accent)"></i>General Documents (${other.length})</span>
        <label class="btn btn-ghost btn-sm doc-attach-btn" style="cursor:pointer">
          <i class="fa-solid fa-upload"></i> Upload
          <input type="file" multiple accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
            style="display:none"
            onchange="uploadCompanyDoc(event.target.files,'${esc(companyId)}','general')">
        </label>
      </div>
      ${_docListHtml(other, companyId, 'general')}`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger);font-size:13px">Could not load documents.</p>`;
  }
}

async function uploadCompanyDoc(files, companyId, docType) {
  try {
    for (const f of files) {
      const fd = new FormData();
      fd.append('document', f);
      fd.append('label', f.name);
      fd.append('doc_type', docType);
      fd.append('company_id', companyId);
      const r = await fetch('/api/pe/documents/upload', {
        method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Upload failed');
    }
    loadCompanyDocs(companyId);
  } catch (e) { alert('Upload error: ' + e.message); }
}

async function uploadAndRefreshCompanyDocs(files, companyId) {
  return uploadCompanyDoc(files, companyId, 'general');
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
  /* Four kinds of owner now, not two. A ternary got the third one wrong by
     construction — anything that was not 'company' was treated as a deal, so
     an update's attachments would have listed every document on some deal
     whose id happened to be the update's. */
  const DOC_OWNER_PARAM = { company: 'company_id', deal: 'deal_id', update: 'update_id', bee: 'bee_id' };
  const param = `${DOC_OWNER_PARAM[type] || 'company_id'}=${encodeURIComponent(recordId)}`;
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

/* One list per form, read by BOTH the populate and the save.

   They used to be two hand-written copies of the same twenty names. Adding a
   field meant remembering both: miss the save list and the input takes typing
   and silently discards it; miss the populate list and editing a record blanks
   the field you did not touch. Neither fails loudly. */
const COMPANY_FIELDS = [
  'name','sector','sub_sector','country','city','description','website',
  'registration_number','vat_number','founded_year','employee_count',
  'status','aum_amount','fee_rate','fee_amount','fee_basis','fee_billing_period',
  'fee_escalation_note','invoice_terms_days','invoice_payable_note',
  'partnership_name','contract_start_date','contract_end_date','entry_date',
  'address_line1','address_line2','address_province','address_postal_code',
  'financial_year_end_month',
  'contact_name','contact_email','contact_phone','notes',
];
/* Rates are stored as decimals — 0.51, not 51 — because that is what every
   calculation multiplies by. People type percentages. These three are the
   only fields where the box and the column deliberately disagree, and the
   conversion happens in exactly one place in each direction. */
const COMPANY_PCT_FIELDS = {
  fee_escalation_pct: 'fee_escalation_pct_display',
  svc_share_pct:      'svc_share_pct_display',
  holding_pct:        'holding_pct_display',
};
const DEAL_FIELDS = [
  'company_name','company_id','stage','deal_type','sector','target_amount',
  'committed_amount','deal_description','investment_thesis','key_risks',
  'source','originator','assigned_analyst','sourced_date','screening_date',
  'dd_start_date','ic_date','decision_date','decision_notes','priority',
  'contact_name','contact_role','contact_email','contact_phone',
  'website','registration_number','city','employee_count',
  'prospect_fee','prospect_fee_basis',
];
const DEAL_PCT_FIELDS = { holding_pct: 'holding_pct_display' };

/* A percentage box back to the decimal the column holds, and out again. Empty
   stays null: 0% and "not agreed yet" are different facts, and storing the
   first for the second would quietly make an escalation clause disappear. */
function pctToDecimal(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n / 100 : null;
}
function decimalToPct(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return '';
  /* toFixed then strip: 0.07 * 100 is 7.000000000000001 in binary floating
     point, and that is what would appear in the box. */
  return String(parseFloat((n * 100).toFixed(4)));
}

function readForm(formId, fields, pctFields) {
  const f = document.getElementById(formId);
  const data = {};
  fields.forEach(k => { data[k] = f.elements[k]?.value || null; });
  Object.entries(pctFields || {}).forEach(([col, box]) => {
    data[col] = pctToDecimal(f.elements[box]?.value);
  });
  return data;
}
function fillForm(formId, record, fields, pctFields) {
  const f = document.getElementById(formId);
  fields.forEach(k => {
    const el = f.elements[k];
    if (!el) return;
    /* A Postgres DATE arrives through the JSON API as a full ISO timestamp —
       "2023-07-01T00:00:00.000Z" — and <input type="date"> rejects that
       silently: the box renders EMPTY. Editing anything then saved the empty
       box back as null, so opening a company to change its city quietly
       erased its contract start date, its entry date and every other date on
       the form. Nothing errored; the dates were just gone. */
    el.value = record[k] == null ? ''
             : (el.type === 'date' ? dateOnly(record[k]) : record[k]);
  });
  Object.entries(pctFields || {}).forEach(([col, box]) => {
    const el = f.elements[box];
    if (el) el.value = decimalToPct(record[col]);
  });
}

// ── Company ──
function openAddCompany() {
  document.getElementById('company-modal-title').textContent = 'Add Company';
  const f = document.getElementById('company-form');
  f.reset();
  f.dataset.editId = '';
  f.dataset.extractedFinancials = '';
  _companyDocQueue.length = 0;
  renderDocQueue(_companyDocQueue, 'company-doc-queue', 'company');
  document.getElementById('company-doc-existing').innerHTML = '';
  /* The partnership split and the payment terms are the same on every
     agreement signed so far. Defaulted, not hard-coded — each is a term of
     that company's agreement and editable per company. */
  if (f.elements['svc_share_pct_display']) f.elements['svc_share_pct_display'].value = '51';
  if (f.elements['invoice_terms_days'])    f.elements['invoice_terms_days'].value = '30';
  if (f.elements['fee_basis'])             f.elements['fee_basis'].value = 'amount';
  toggleFeeBasis('amount');
  const idle = document.getElementById('ai-upload-idle');
  if (idle) idle.querySelector('span').textContent = 'Upload AFS or company doc — AI will pre-fill the form';
  document.getElementById('company-modal').classList.add('open');
}

function openEditCompany(id) {
  const co = companyById(id);
  if (!co) return;
  document.getElementById('company-modal-title').textContent = 'Edit Company';
  const f = document.getElementById('company-form');
  f.dataset.editId = id;
  fillForm('company-form', co, COMPANY_FIELDS, COMPANY_PCT_FIELDS);
  toggleFeeBasis(co.fee_basis || (co.fee_amount != null ? 'amount' : 'percentage'));
  previewFeeSchedule();
  _companyDocQueue.length = 0;
  renderDocQueue(_companyDocQueue, 'company-doc-queue', 'company');
  // Load existing docs into modal
  _loadExistingDocsIntoModal(id, 'company-doc-existing', 'company');
  document.getElementById('company-modal').classList.add('open');
}

async function saveCompany() {
  const f = document.getElementById('company-form');
  const editId = f.dataset.editId;
  const data = readForm('company-form', COMPANY_FIELDS, COMPANY_PCT_FIELDS);
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
    _companyDocQueue.length = 0;
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
  _dealDocQueue.length = 0;
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
  fillForm('deal-form', deal, DEAL_FIELDS, DEAL_PCT_FIELDS);
  _dealDocQueue.length = 0;
  renderDocQueue(_dealDocQueue, 'deal-doc-queue', 'deal');
  _loadExistingDocsIntoModal(id, 'deal-doc-existing', 'deal');
  document.getElementById('deal-modal').classList.add('open');
}

async function saveDeal() {
  const f = document.getElementById('deal-form');
  const editId = f.dataset.editId;
  const data = readForm('deal-form', DEAL_FIELDS, DEAL_PCT_FIELDS);
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
    _dealDocQueue.length = 0;
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
  populateFinancialYears(companyId);
  previewEbitda();
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
   'tax_expense','finance_cost','depreciation','amortisation',
   'total_assets','total_liabilities','equity','cash','total_debt','capex',
   'current_assets','current_liabilities',
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
  /* Default the amount from the agreement. This used to compute
     aum_amount x fee_rate and write the ANNUAL figure into the box whatever
     the billing period said — so a monthly invoice on a quarterly-billed
     client was pre-filled with twelve months of fee. It now escalates to the
     contract year the period falls in and divides by the invoices per year. */
  if (companyId) {
    const co = companyById(companyId);
    const amt = feeForPeriod(co, todayISO());
    if (amt !== null) {
      const el = document.getElementById('fee-form').elements['amount'];
      if (el) el.value = amt.gross.toFixed(2);
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
  if (!data.company_id) { alert('Please select a company'); return; }
  if (!data.amount)     { alert('Amount is required'); return; }
  if (!data.period_start || !data.period_end) { alert('Period start and end dates are required'); return; }
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
  } catch(e) { alert('Error: ' + _cleanErr(e.message)); }
}

// ── Reviews ──
function openAddReview(companyId) {
  document.getElementById('review-form').reset();
  delete document.getElementById('review-form').dataset.editId;
  document.getElementById('review-modal-title').textContent = 'Schedule Review';
  document.getElementById('review-form').elements['company_id'].value = companyId || '';
  // Default review_date to today
  document.getElementById('review-form').elements['review_date'].value = new Date().toISOString().split('T')[0];
  // Default next_review_date to 3 months from now
  const next = new Date();
  next.setMonth(next.getMonth() + 3);
  document.getElementById('review-form').elements['next_review_date'].value = next.toISOString().split('T')[0];
  document.getElementById('review-modal').classList.add('open');
}

function openEditReview(id) {
  const r = _reviews.find(r => r.id === id);
  if (!r) return;
  document.getElementById('review-modal-title').textContent = 'Edit Review';
  const f = document.getElementById('review-form');
  f.dataset.editId = id;
  ['company_id','review_date','next_review_date','attendees','notes'].forEach(k => {
    const el = f.elements[k];
    if (el) el.value = r[k] != null ? r[k] : '';
  });
  document.getElementById('review-modal').classList.add('open');
}

async function saveReview() {
  const f = document.getElementById('review-form');
  const editId = f.dataset.editId;
  const data = {};
  ['company_id','review_date','next_review_date','attendees','notes'].forEach(k => {
    data[k] = f.elements[k]?.value || null;
  });
  if (!data.company_id)   { alert('Company is required'); return; }
  if (!data.review_date)  { alert('Review date is required'); return; }
  try {
    if (editId) {
      await apiUpdate('pe_reviews', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      data.id = 'perev-' + uid();
      await apiCreate('pe_reviews', data);
    }
    closeModal('review-modal');
    await loadAll();
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
    switchPanelTab('reviews');
  } catch(e) { alert('Error: ' + _cleanErr(e.message)); }
}

async function deleteReview(id, companyId) {
  if (!confirm('Delete this review record?')) return;
  try {
    await apiDelete('pe_reviews', id);
    await loadAll();
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
    switchPanelTab('reviews');
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Update note ──
function openAddUpdate(companyId) {
  const f = document.getElementById('update-form');
  f.reset();
  f.dataset.editId = '';
  f.elements['company_id'].value = companyId || '';
  /* Default to today. The date is required and an empty required date blocks
     the save on a field most updates would have filled the same way. */
  f.elements['update_date'].value = todayISO();
  _updateDocQueue.length = 0;
  renderDocQueue(_updateDocQueue, 'update-doc-queue', 'update');
  document.getElementById('update-doc-existing').innerHTML = '';
  document.getElementById('update-modal').classList.add('open');
}

function openEditUpdate(id) {
  const u = _updates.find(x => x.id === id);
  if (!u) return;
  const f = document.getElementById('update-form');
  f.reset();
  f.dataset.editId = id;
  f.elements['company_id'].value = u.company_id || '';
  f.elements['update_type'].value = u.update_type || 'general';
  f.elements['title'].value = u.title || '';
  f.elements['body'].value = u.body || '';
  f.elements['author'].value = u.author || '';
  f.elements['update_date'].value = dateOnly(u.update_date || u.created_at) || '';
  _updateDocQueue.length = 0;
  renderDocQueue(_updateDocQueue, 'update-doc-queue', 'update');
  _loadExistingDocsIntoModal(id, 'update-doc-existing', 'update');
  document.getElementById('update-modal').classList.add('open');
}

async function saveUpdate() {
  const f = document.getElementById('update-form');
  const editId = f.dataset.editId;
  const data = {
    company_id:  f.elements['company_id'].value,
    update_type: f.elements['update_type'].value,
    title:       f.elements['title'].value,
    body:        f.elements['body'].value,
    author:      f.elements['author'].value || null,
    update_date: f.elements['update_date'].value || todayISO(),
  };
  if (!data.company_id || !data.title || !data.body) { alert('Company, title and body are required'); return; }
  try {
    let savedId = editId;
    if (editId) {
      await apiUpdate('pe_updates', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      data.id = 'peupd-' + uid();
      await apiCreate('pe_updates', data);
      savedId = data.id;
    }
    /* Attachments hang off the update AND its company: the update panel lists
       by update_id, the company document tab lists by company_id, and a file
       filed against only the first would vanish from the second. */
    if (_updateDocQueue.length) {
      await uploadDocQueue(_updateDocQueue, data.company_id, null, { update_id: savedId, doc_type: 'update' });
      _updateDocQueue.length = 0;
    }
    closeModal('update-modal');
    await loadAll();
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
  } catch(e) { alert('Error: ' + e.message); }
}

async function deleteUpdate(id) {
  if (!confirm('Delete this update? Any attachments on it are deleted too.')) return;
  try {
    await apiDelete('pe_updates', id);
    await loadAll();
    if (_openCompanyId) openCompanyPanel(_openCompanyId);
  } catch (e) { alert('Error: ' + e.message); }
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
    activeCompanies().map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  ['deal-company-select','fin-company-select-modal','fee-company-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
  // Fin view selector
  const finSel = document.getElementById('fin-company-select');
  if (finSel) {
    finSel.innerHTML = '<option value="">— Select company —</option>' +
      activeCompanies().filter(c => c.status === 'portfolio').map(c =>
        `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  }
}

/* ── Init ── */
/* ═══════════════════════════════════════════════════
   CONTRACT, FEES AND THE ARITHMETIC AROUND THEM

   These mirror server/services/peFinance.js. The server is authoritative —
   the Position tab and the fee schedule both come from /api/pe — but a table
   cell cannot wait for a round trip per row, so the two cheap ones are
   duplicated here. check-pe-monitor.cjs runs the same fixtures through both
   and fails if they disagree, which is the only thing that keeps a copy
   honest.
   ═══════════════════════════════════════════════════ */

function todayISO() { return new Date().toISOString().slice(0, 10); }

/* Any date-ish value down to YYYY-MM-DD. The API returns DATE columns as full
   ISO timestamps, forms hand back plain dates, and one code path was
   concatenating 'T00:00:00Z' onto whatever it got — which produces an Invalid
   Date on the timestamp form and then falls back to a default that looks like
   a plausible answer. */
function dateOnly(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const round2 = n => (n === null ? null : Math.round(n * 100) / 100);

/* (b) The contract date. entry_date stays as the legacy value and is the
   fallback, so nothing that was entered before this field existed loses its
   date — but the escalation anniversary runs off the contract start. */
function contractStart(c) {
  return (c && (c.contract_start_date || c.entry_date)) || null;
}

function updateDate(u) {
  return (u && (u.update_date || u.created_at)) || null;
}

const MONTH_END_LABEL = ['','31 January','End February','31 March','30 April','31 May','30 June',
  '31 July','31 August','30 September','31 October','30 November','31 December'];
function monthEndLabel(m) {
  const n = parseInt(m, 10);
  return (n >= 1 && n <= 12) ? MONTH_END_LABEL[n] : '—';
}

function businessAddressHtml(co) {
  const lines = [co.address_line1, co.address_line2,
                 [co.city, co.address_province].filter(Boolean).join(', '),
                 co.address_postal_code].filter(Boolean);
  if (!lines.length) return '';
  return `<div class="kv-item full"><div class="kv-label">Business Address</div>
    <div class="kv-val" style="line-height:1.6">${lines.map(esc).join('<br>')}</div></div>`;
}

/* EBITDA — stated where the AFS states it, otherwise net profit PLUS tax,
   finance cost, depreciation and amortisation. Adding back, not subtracting:
   net profit is already after all four, so walking back up to operating
   earnings puts each of them on again. */
const EBITDA_ADDBACKS = [
  ['tax_expense',  'Tax'],
  ['finance_cost', 'Finance cost'],
  ['depreciation', 'Depreciation'],
  ['amortisation', 'Amortisation'],
];
function ebitdaOf(fin) {
  if (!fin) return null;
  const stated = numOrNull(fin.ebitda);
  if (stated !== null) return round2(stated);
  const base = numOrNull(fin.net_profit);
  if (base === null) return null;
  return round2(EBITDA_ADDBACKS.reduce((sum, [k]) => sum + (numOrNull(fin[k]) || 0), base));
}

/* The gross annual fee under the agreement, before escalation. */
function annualGrossFee(c) {
  if (!c) return null;
  const basis = c.fee_basis || (numOrNull(c.fee_amount) !== null ? 'amount' : 'percentage');
  if (basis === 'amount') return round2(numOrNull(c.fee_amount));
  const aum = numOrNull(c.aum_amount), rate = numOrNull(c.fee_rate);
  return (aum === null || rate === null) ? null : round2(aum * rate);
}

function svcSharePct(c) {
  const v = numOrNull(c && c.svc_share_pct);
  return v === null ? 0.51 : v;
}

/* Which contract year a date falls in — 1 on the start date, 2 on the first
   anniversary. Before the contract starts it is still year 1: an invoice
   dated a week early must not escalate backwards into year zero. */
function contractYearOn(c, dateISO) {
  const start = dateOnly(contractStart(c));
  const on = dateOnly(dateISO);
  if (!start || !on) return 1;
  const s = new Date(start + 'T00:00:00Z'), d = new Date(on + 'T00:00:00Z');
  if (isNaN(s.getTime()) || isNaN(d.getTime())) return 1;
  let years = d.getUTCFullYear() - s.getUTCFullYear();
  const beforeAnniversary = (d.getUTCMonth() < s.getUTCMonth()) ||
    (d.getUTCMonth() === s.getUTCMonth() && d.getUTCDate() < s.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return Math.max(1, years + 1);
}

const PERIODS_PER_YEAR = { monthly: 12, quarterly: 4, annual: 1 };

/* Gross and SVC's share for one billing period, escalated to the contract
   year the period falls in. */
function feeForPeriod(c, dateISO) {
  const base = annualGrossFee(c);
  if (base === null) return null;
  const esc = numOrNull(c.fee_escalation_pct) || 0;
  const year = contractYearOn(c, dateISO);
  const grossAnnual = round2(base * Math.pow(1 + esc, year - 1));
  const per = PERIODS_PER_YEAR[c.fee_billing_period] || 1;
  const gross = round2(grossAnnual / per);
  return {
    contract_year: year, gross_annual: grossAnnual, gross,
    svc: round2(gross * svcSharePct(c)),
    svc_annual: round2(grossAnnual * svcSharePct(c)),
    per_year: per,
  };
}

function annualSvcShare(c) {
  const f = feeForPeriod(c, todayISO());
  return f ? f.svc_annual : null;
}

function feeCellHtml(c) {
  const f = feeForPeriod(c, todayISO());
  if (!f) return '—';
  const basis = c.fee_basis || (numOrNull(c.fee_amount) !== null ? 'amount' : 'percentage');
  const suffix = basis === 'percentage' && c.fee_rate ? ` <span class="cell-sub">${fmtPct(c.fee_rate)} of AUM</span>` : '';
  const escNote = (numOrNull(c.fee_escalation_pct) || 0) > 0
    ? ` <span class="cell-sub" title="Escalating ${fmtPct(c.fee_escalation_pct)} a year — currently contract year ${f.contract_year}">+${fmtPct(c.fee_escalation_pct)} p.a.</span>` : '';
  return `${fmtR(f.gross_annual)}${suffix}${escNote}`;
}

/* SVC's share of a fee already on the books. The row's own percentage wins —
   a historical invoice raised under a different split must keep it. */
function feeSvcAmount(f, co) {
  const stored = numOrNull(f.svc_share_amount);
  if (stored !== null) return stored;
  const gross = numOrNull(f.gross_amount != null ? f.gross_amount : f.amount);
  if (gross === null) return null;
  const own = numOrNull(f.svc_share_pct);
  return round2(gross * (own !== null ? own : svcSharePct(co)));
}

/* Lifetime revenue from a client. Only real invoices count: a projected fee
   is a plan and a waived one is neither billed nor owed. */
function lifetimeRevenue(feeRows, co) {
  const out = { invoiced_gross: 0, invoiced_svc: 0, paid_gross: 0, paid_svc: 0,
                outstanding_gross: 0, outstanding_svc: 0, invoice_count: 0 };
  (feeRows || []).forEach(f => {
    if (!['invoiced','paid','overdue'].includes(f.status)) return;
    const gross = numOrNull(f.gross_amount != null ? f.gross_amount : f.amount);
    if (gross === null) return;
    const svc = feeSvcAmount(f, co) || 0;
    out.invoiced_gross += gross; out.invoiced_svc += svc; out.invoice_count += 1;
    if (f.status === 'paid') { out.paid_gross += gross; out.paid_svc += svc; }
    else { out.outstanding_gross += gross; out.outstanding_svc += svc; }
  });
  Object.keys(out).forEach(k => { if (k !== 'invoice_count') out[k] = round2(out[k]); });
  return out;
}

/* ── AFS timing ── requested three months after year end, late at six. */
const AFS_REQUEST_MONTHS = 3;
const AFS_OVERDUE_MONTHS = 6;
function financialYearEndISO(month, year) {
  const m = parseInt(month, 10), y = parseInt(year, 10);
  if (!(m >= 1 && m <= 12) || !Number.isFinite(y)) return null;
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function addMonthsISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function afsScheduleFor(co, year) {
  const ye = financialYearEndISO(co && co.financial_year_end_month, year);
  if (!ye) return null;
  const request = addMonthsISO(ye, AFS_REQUEST_MONTHS);
  const overdue = addMonthsISO(ye, AFS_OVERDUE_MONTHS);
  const now = todayISO();
  return { financial_year: year, year_end: ye, request_from: request, overdue_from: overdue,
           status: now >= overdue ? 'overdue' : now >= request ? 'due' : 'not_yet' };
}
/* The years a company can file statements for, newest first. Built from the
   year end so that in January nobody is asked for a year that has not ended. */
function financialYearOptions(co, back, forward) {
  const now = new Date();
  const m = parseInt(co && co.financial_year_end_month, 10);
  let newest = now.getUTCFullYear();
  if (m >= 1 && m <= 12) {
    const ye = financialYearEndISO(m, newest);
    if (ye && todayISO() < ye) newest -= 1;
  } else if (now.getUTCMonth() < 2) {
    newest -= 1;
  }
  const span = back === undefined ? 10 : back;
  const ahead = forward === undefined ? 1 : forward;
  const out = [];
  for (let y = newest + ahead; y >= newest - span; y--) out.push(y);
  return out;
}

/* ═══════════════════════════════════════════════════
   FORM BEHAVIOUR
   ═══════════════════════════════════════════════════ */

/* The two fee inputs are mutually exclusive: showing both invites entering a
   rand amount and a percentage and leaving which one is charged to whichever
   code path reads first. */
function toggleFeeBasis(basis) {
  const f = document.getElementById('company-form');
  if (!f) return;
  if (f.elements['fee_basis']) f.elements['fee_basis'].value = basis || 'amount';
  document.querySelectorAll('#company-form [data-fee-basis]').forEach(el => {
    el.style.display = el.dataset.feeBasis === (basis || 'amount') ? '' : 'none';
  });
  previewFeeSchedule();
}

/* What the agreement will actually bill, shown while it is being typed. An
   escalation clause is easy to enter as 7 and mean 7%, or as 0.07 and mean the
   same thing; seeing year three land on R686 940 rather than R600 004 is what
   catches it. */
function previewFeeSchedule() {
  const el = document.getElementById('fee-preview');
  const f = document.getElementById('company-form');
  if (!el || !f) return;
  const draft = readForm('company-form', COMPANY_FIELDS, COMPANY_PCT_FIELDS);
  const base = annualGrossFee(draft);
  if (base === null) { el.innerHTML = ''; return; }
  const rows = [1, 2, 3].map(n => {
    const e = numOrNull(draft.fee_escalation_pct) || 0;
    const gross = round2(base * Math.pow(1 + e, n - 1));
    return { n, gross, svc: round2(gross * svcSharePct(draft)) };
  });
  const per = PERIODS_PER_YEAR[draft.fee_billing_period] || 1;
  el.innerHTML = `
    <div class="fee-preview-head">What this bills — gross, and SVC's ${fmtPct(svcSharePct(draft))} share</div>
    <table class="mini-table"><thead><tr>
      <th>Contract year</th><th class="num">Gross p.a.</th><th class="num">SVC p.a.</th>
      <th class="num">Per invoice${per > 1 ? ` (÷${per})` : ''}</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>Year ${r.n}</td><td class="num">${fmtR(r.gross)}</td>
        <td class="num">${fmtR(r.svc)}</td><td class="num">${fmtR(round2(r.gross / per))}</td>
      </tr>`).join('')}</tbody></table>
    ${draft.invoice_terms_days ? `<div class="fee-preview-foot">Invoices payable within ${esc(String(draft.invoice_terms_days))} days.</div>` : ''}`;
}

/* The EBITDA the platform will store, shown as its arithmetic while the four
   add-backs are being typed. A derived figure nobody can check is a figure
   nobody should act on. */
function previewEbitda() {
  const el = document.getElementById('ebitda-preview');
  const f  = document.getElementById('fin-form');
  if (!el || !f) return;
  const val = k => f.elements[k] ? f.elements[k].value : '';
  const stated = numOrNull(val('ebitda'));
  if (stated !== null) {
    el.innerHTML = `<div class="ebitda-line"><strong>EBITDA ${fmtR(stated)}</strong> — as stated on the AFS. The add-backs below are not used.</div>`;
    return;
  }
  const base = numOrNull(val('net_profit'));
  if (base === null) {
    el.innerHTML = `<div class="ebitda-line muted">Enter net profit and the add-backs, and EBITDA is computed here.</div>`;
    return;
  }
  const parts = EBITDA_ADDBACKS.map(([k, label]) => ({ label, v: numOrNull(val(k)) }));
  const total = round2(parts.reduce((s, p) => s + (p.v || 0), base));
  const missing = parts.filter(p => p.v === null && p.label !== 'Amortisation').map(p => p.label);
  el.innerHTML = `
    <div class="ebitda-line">
      <strong>EBITDA ${fmtR(total)}</strong>
      <span class="ebitda-sum">${fmtR(base)}${parts.map(p => ` + ${fmtR(p.v || 0)}`).join('')}</span>
    </div>
    <div class="ebitda-note">Net profit plus tax, finance cost, depreciation and amortisation.
      ${missing.length ? `<span class="warn">Missing ${esc(missing.join(', '))} — the figure is understated.</span>` : ''}</div>`;
}

function populateFinancialYears(companyId) {
  const sel = document.getElementById('fin-year-select');
  if (!sel) return;
  const co = companyById(companyId);
  const taken = new Set(_financials.filter(f => f.company_id === companyId).map(f => Number(f.financial_year)));
  const editing = document.getElementById('fin-form').dataset.editId;
  const editingYear = editing ? Number((_financials.find(f => f.id === editing) || {}).financial_year) : null;
  sel.innerHTML = '<option value="">— Select —</option>' +
    financialYearOptions(co).map(y => {
      /* A year already captured is disabled rather than hidden: the UNIQUE
         constraint would reject it anyway, and a silent absence reads like the
         year is not allowed rather than already done. */
      const used = taken.has(y) && y !== editingYear;
      return `<option value="${y}"${used ? ' disabled' : ''}>${y}${used ? ' — already captured' : ''}</option>`;
    }).join('');
  if (editingYear) sel.value = String(editingYear);
}

function beeSuggestExpiry(issueISO) {
  const f = document.getElementById('bee-form');
  if (!f || !issueISO) return;
  const el = f.elements['expiry_date'];
  /* A BEE certificate runs twelve months from issue. Suggested, not forced —
     an affidavit or a re-issued certificate can differ. */
  if (el && !el.value) {
    const d = new Date(issueISO + 'T00:00:00Z');
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    el.value = d.toISOString().slice(0, 10);
  }
}

/* ═══════════════════════════════════════════════════
   ARCHIVE / DELETE
   ═══════════════════════════════════════════════════ */

function toggleArchived(on) { _showArchived = !!on; renderPortfolio(); }

async function archiveCompany(id) {
  const co = companyById(id);
  if (!co) return;
  const reason = prompt(`Archive ${co.name}?\n\nIt comes off every list and every total; its fees, financials and documents are kept.\n\nReason (optional):`, '');
  if (reason === null) return;
  try {
    const res = await fetch(`/api/pe/company/${encodeURIComponent(id)}/archive`, {
      method: 'POST', credentials: 'include',
      headers: _authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ reason: reason || null }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Archive failed');
    await loadAll();
    renderView(_activeView);
    if (_openCompanyId === id) openCompanyPanel(id);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

async function unarchiveCompany(id) {
  try {
    const res = await fetch(`/api/pe/company/${encodeURIComponent(id)}/unarchive`, {
      method: 'POST', credentials: 'include', headers: _authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Restore failed');
    await loadAll();
    renderView(_activeView);
    if (_openCompanyId === id) openCompanyPanel(id);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

/* Delete asks the server first WITHOUT force, so what would be destroyed can
   be named in the confirmation rather than guessed at. On a duplicate client
   you cannot always tell which of the two rows the invoices were filed
   against, and finding out afterwards is too late. */
async function deleteCompany(id) {
  const co = companyById(id);
  if (!co) return;
  try {
    let res = await fetch(`/api/pe/company/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'include',
      headers: _authHeaders({ 'Content-Type': 'application/json' }), body: '{}',
    });
    if (res.status === 409) {
      const j = await res.json();
      const what = Object.entries(j.attached || {}).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ');
      const ok = confirm(
        `${co.name} has records attached: ${what}.\n\n` +
        `Deleting removes the company and all of it, permanently.\n` +
        `Archiving keeps everything and hides the company.\n\n` +
        `OK to DELETE permanently, Cancel to stop (then use Archive).`);
      if (!ok) return;
      res = await fetch(`/api/pe/company/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'include',
        headers: _authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ force: 'true' }),
      });
    } else if (res.ok) {
      /* Nothing attached — but it is still a permanent delete. */
      if (!confirm(`Delete ${co.name}? Nothing is filed against it.`)) { await loadAll(); return; }
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Delete failed');
    document.getElementById('company-panel')?.classList.remove('open');
    document.getElementById('panel-backdrop')?.classList.remove('open');
    _openCompanyId = null;
    await loadAll();
    renderView(_activeView);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

/* ═══════════════════════════════════════════════════
   PANEL TABS — position, fees, compliance, meetings
   ═══════════════════════════════════════════════════ */

async function loadCompanyPosition(id) {
  const el = document.getElementById('cp-position');
  if (!el) return;
  el.innerHTML = '<div class="loading-line"><span class="ai-spinner"></span> Reading the statements…</div>';
  try {
    const res = await fetch(`/api/pe/company/${encodeURIComponent(id)}/summary`, {
      credentials: 'include', headers: _authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load');
    const data = await res.json();
    _summaryCache[id] = data;
    /* The panel can be closed, or moved to another company, while this is in
       flight — writing the answer then would put one company's red flags under
       another company's name. */
    if (_openCompanyId !== id) return;
    el.innerHTML = positionHtml(data);
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:30px">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <p>Could not read the financial position — ${esc(_cleanErr(e.message))}</p>
      <button class="btn btn-ghost btn-sm" onclick="loadCompanyPosition('${esc(id)}')">Try again</button></div>`;
  }
}

const VERDICT_META = {
  critical: { cls: 'verdict-critical', icon: 'fa-circle-exclamation', label: 'Needs attention' },
  watch:    { cls: 'verdict-watch',    icon: 'fa-triangle-exclamation', label: 'Watch' },
  stable:   { cls: 'verdict-stable',   icon: 'fa-circle-check', label: 'Stable' },
  unknown:  { cls: 'verdict-unknown',  icon: 'fa-circle-question', label: 'Nothing on file' },
};
const FLAG_ICON = { critical: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };

function positionHtml(data) {
  const a = data.assessment || {};
  const m = a.metrics || {};
  const v = VERDICT_META[a.verdict] || VERDICT_META.unknown;
  const eb = (data.ebitda_by_year || [])[0];
  const fy = (data.financials || [])[0];

  /* Nothing on file is not a clean bill of health. The generic layout below
     drew a grid of em-dashes under "EBITDA — as stated on the AFS" and closed
     with "Nothing flagged on the figures filed" — which is true only in the
     sense that there are no figures, and reads as though somebody looked. */
  if (a.verdict === 'unknown' || !fy) {
    return `
      <div class="verdict-banner verdict-unknown">
        <i class="fa-solid fa-circle-question"></i>
        <div>
          <div class="verdict-label">Nothing to assess</div>
          <div class="verdict-summary">No annual financial statements are on file for this company,
            so there is no position to read and nothing has been checked.</div>
        </div>
      </div>
      <p class="muted-note">Add a year's figures — or upload the AFS and let it be read off the
        document — and the position, the red flags and EBITDA appear here.</p>
      <div class="tab-actions" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="openAddFinancials('${esc(data.company.id)}')">
          <i class="fa-solid fa-plus"></i> Add Financials
        </button>
      </div>`;
  }

  const metricRow = (label, value, note) => value === undefined || value === null ? '' :
    `<div class="metric-tile"><div class="metric-label">${esc(label)}</div>
       <div class="metric-value">${value}</div>
       ${note ? `<div class="metric-note">${note}</div>` : ''}</div>`;

  return `
    <div class="verdict-banner ${v.cls}">
      <i class="fa-solid ${v.icon}"></i>
      <div>
        <div class="verdict-label">${esc(v.label)}${fy ? ` · FY ${esc(String(fy.financial_year))}` : ''}</div>
        <div class="verdict-summary">${esc(a.summary || '')}</div>
      </div>
    </div>

    <div class="metric-grid">
      ${metricRow('EBITDA', fmtR(m.ebitda),
        eb && eb.source === 'derived'
          ? `Derived${eb.complete ? '' : ' — incomplete'}`
          : 'As stated on the AFS')}
      ${metricRow('EBITDA margin', m.ebitda_margin !== undefined ? fmtPct(m.ebitda_margin) : null)}
      ${metricRow('Equity', fmtR(m.equity), m.equity < 0 ? 'Liabilities exceed assets' : null)}
      ${metricRow('Net debt', fmtR(m.net_debt),
        m.net_debt_to_ebitda !== undefined ? `${m.net_debt_to_ebitda.toFixed(2)}× EBITDA` : null)}
      ${metricRow('Interest cover', m.interest_cover !== undefined ? m.interest_cover.toFixed(2) + '×' : null)}
      ${metricRow('Current ratio', m.current_ratio !== undefined ? m.current_ratio.toFixed(2) : null)}
      ${metricRow('Revenue growth', m.revenue_growth !== undefined ? fmtPct(m.revenue_growth) : null)}
    </div>

    ${(a.flags || []).length ? `
      <h4 class="panel-subhead">What stands out</h4>
      <div class="flag-list">
        ${a.flags.map(f => `
          <div class="flag flag-${esc(f.level)}">
            <i class="fa-solid ${FLAG_ICON[f.level] || 'fa-circle-info'}"></i>
            <div><div class="flag-title">${esc(f.title)}</div>
                 <div class="flag-detail">${esc(f.detail)}</div></div>
          </div>`).join('')}
      </div>` : `<p class="muted-note">Nothing flagged on the figures filed.</p>`}

    ${eb && eb.source === 'derived' && eb.components ? `
      <h4 class="panel-subhead">How EBITDA was derived</h4>
      <table class="mini-table">
        <tbody>${eb.components.map(c => `<tr>
          <td>${esc(c.label)}</td>
          <td class="num">${c.value === null ? '<span class="muted">not on file</span>' : fmtR(c.value)}</td>
        </tr>`).join('')}
        <tr class="total-row"><td><strong>EBITDA</strong></td><td class="num"><strong>${fmtR(eb.ebitda)}</strong></td></tr>
        </tbody>
      </table>
      <p class="muted-note">Net profit plus tax, finance cost, depreciation and amortisation — the four charges EBITDA is defined as excluding.</p>
    ` : ''}

    ${(data.ebitda_by_year || []).length > 1 ? `
      <h4 class="panel-subhead">EBITDA by year</h4>
      <table class="mini-table">
        <thead><tr><th>Year</th><th class="num">EBITDA</th><th>Source</th></tr></thead>
        <tbody>${data.ebitda_by_year.map(r => `<tr>
          <td>FY ${esc(String(r.financial_year))}</td>
          <td class="num">${fmtR(r.ebitda)}</td>
          <td>${r.source === 'derived' ? '<span class="derived-tag">derived</span>' : 'stated'}</td>
        </tr>`).join('')}</tbody>
      </table>` : ''}`;
}

function renderFeesTab(id) {
  const co = companyById(id);
  const coFees = _fees.filter(f => f.company_id === id)
    .sort((a, b) => new Date(b.invoice_date || b.period_end || 0) - new Date(a.invoice_date || a.period_end || 0));
  const rev = lifetimeRevenue(coFees, co);
  const sched = [1, 2, 3, 4, 5].map(n => {
    const base = annualGrossFee(co);
    if (base === null) return null;
    const e = numOrNull(co.fee_escalation_pct) || 0;
    const gross = round2(base * Math.pow(1 + e, n - 1));
    return { n, gross, svc: round2(gross * svcSharePct(co)) };
  }).filter(Boolean);
  const per = PERIODS_PER_YEAR[co && co.fee_billing_period] || 1;
  const thisYear = feeForPeriod(co, todayISO());

  document.getElementById('cp-fees').innerHTML = `
    <div class="tab-actions">
      <button class="btn btn-primary btn-sm" onclick="openAddFee('${esc(id)}')"><i class="fa-solid fa-plus"></i> Add Fee</button>
      <button class="btn btn-ghost btn-sm" onclick="openXeroImport('${esc(id)}')"><i class="fa-solid fa-file-csv"></i> Import Xero Invoices</button>
    </div>

    <div class="metric-grid">
      <div class="metric-tile"><div class="metric-label">Lifetime billed (gross)</div>
        <div class="metric-value">${fmtR(rev.invoiced_gross)}</div>
        <div class="metric-note">${rev.invoice_count} invoice${rev.invoice_count === 1 ? '' : 's'}</div></div>
      <div class="metric-tile"><div class="metric-label">Lifetime — SVC share</div>
        <div class="metric-value" style="color:var(--accent)">${fmtR(rev.invoiced_svc)}</div>
        <div class="metric-note">at ${fmtPct(svcSharePct(co))}</div></div>
      <div class="metric-tile"><div class="metric-label">Received</div>
        <div class="metric-value">${fmtR(rev.paid_svc)}</div>
        <div class="metric-note">of ${fmtR(rev.paid_gross)} gross</div></div>
      <div class="metric-tile"><div class="metric-label">Outstanding</div>
        <div class="metric-value">${fmtR(rev.outstanding_svc)}</div>
        <div class="metric-note">of ${fmtR(rev.outstanding_gross)} gross</div></div>
    </div>

    ${sched.length ? `
      <h4 class="panel-subhead">Fee per the agreement${thisYear ? ` — currently contract year ${thisYear.contract_year}` : ''}</h4>
      <table class="mini-table">
        <thead><tr><th>Contract year</th><th class="num">Gross p.a.</th>
          <th class="num">SVC share</th><th class="num">Per invoice${per > 1 ? ` (÷${per})` : ''}</th></tr></thead>
        <tbody>${sched.map(r => `<tr class="${thisYear && r.n === thisYear.contract_year ? 'row-current' : ''}">
          <td>Year ${r.n}</td><td class="num">${fmtR(r.gross)}</td>
          <td class="num">${fmtR(r.svc)}</td><td class="num">${fmtR(round2(r.gross / per))}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="muted-note">
        ${(numOrNull(co.fee_escalation_pct) || 0) > 0
          ? `Escalating ${fmtPct(co.fee_escalation_pct)} on each anniversary of ${fmtDate(contractStart(co))}.`
          : 'No escalation recorded on this agreement.'}
        ${co.invoice_payable_note ? ` ${esc(co.invoice_payable_note)}` : co.invoice_terms_days ? ` Payable within ${esc(String(co.invoice_terms_days))} days of invoice.` : ''}
      </p>` : '<p class="muted-note">No fee recorded on this agreement yet.</p>'}

    <h4 class="panel-subhead">Invoices</h4>
    ${coFees.length ? `<table class="mini-table">
      <thead><tr><th>Invoice</th><th>Status</th>
        <th class="num">Gross</th><th class="num">SVC share</th></tr></thead>
      <tbody>${coFees.map(f => `<tr>
        <td>${esc(f.invoice_number || '—')}${f.source === 'xero' ? ' <span class="src-tag">Xero</span>' : ''}
            <span class="cell-sub">${fmtDate(f.period_start)} – ${fmtDate(f.period_end)}</span></td>
        <td>${badge(FEE_STATUS_COLOR[f.status] || 'badge-gray', f.status)}</td>
        <td class="num">${fmtR(f.gross_amount != null ? f.gross_amount : f.amount)}</td>
        <td class="num">${fmtR(feeSvcAmount(f, co))}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted-note">No fees recorded.</p>'}`;
}

function renderComplianceTab(id) {
  const co = companyById(id);
  const fins = _financials.filter(f => f.company_id === id);
  const onFile = new Set(fins.map(f => Number(f.financial_year)));
  const tracked = new Map(_afsReq.filter(r => r.company_id === id).map(r => [Number(r.financial_year), r]));
  const bee = _bee.filter(b => b.company_id === id)
    .sort((a, b) => Number(b.verification_year) - Number(a.verification_year));

  const afsRows = co && co.financial_year_end_month
    ? financialYearOptions(co, 4, 0).map(y => {
        const sched = afsScheduleFor(co, y);
        const t = tracked.get(y);
        const settled = onFile.has(y) || (t && ['received','waived'].includes(t.status));
        return { y, sched, t, settled };
      })
    : [];

  const AFS_STATE = {
    overdue: { cls: 'badge-red',  text: 'Overdue' },
    due:     { cls: 'badge-gold', text: 'Request now' },
    not_yet: { cls: 'badge-gray', text: 'Not yet due' },
  };

  document.getElementById('cp-compliance').innerHTML = `
    <h4 class="panel-subhead">Annual Financial Statements</h4>
    ${!co || !co.financial_year_end_month ? `
      <div class="notice-inline">
        <i class="fa-solid fa-circle-info"></i>
        Set this company's financial year end to track AFS requests — statements are requested three months after year end.
        <button class="btn btn-ghost btn-sm" onclick="openEditCompany('${esc(id)}')">Set it</button>
      </div>` : `
      <p class="muted-note">Year end ${monthEndLabel(co.financial_year_end_month)}. Requested three months after; overdue at six.</p>
      <table class="mini-table">
        <thead><tr><th>Year</th><th>Year end</th><th>Request from</th><th>Status</th><th></th></tr></thead>
        <tbody>${afsRows.map(r => {
          const state = r.settled
            ? { cls: 'badge-teal', text: onFile.has(r.y) ? 'On file' : (r.t && r.t.status === 'waived' ? 'Waived' : 'Received') }
            : (r.t && r.t.status === 'requested'
                ? { cls: 'badge-blue', text: 'Requested' }
                : AFS_STATE[r.sched.status]);
          return `<tr>
            <td>FY ${r.y}</td>
            <td>${fmtDate(r.sched.year_end)}</td>
            <td>${fmtDate(r.sched.request_from)}</td>
            <td>${badge(state.cls, state.text)}</td>
            <td class="row-actions">${r.settled ? '' : `
              <button class="btn btn-ghost btn-sm" onclick="setAfsStatus('${esc(id)}',${r.y},'requested')">Mark requested</button>
              <button class="btn btn-ghost btn-sm" onclick="setAfsStatus('${esc(id)}',${r.y},'received')">Received</button>`}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`}

    <h4 class="panel-subhead">BEE Verification
      <button class="btn btn-primary btn-sm" onclick="openAddBee('${esc(id)}')"><i class="fa-solid fa-plus"></i> Add Year</button>
    </h4>
    ${bee.length ? `<table class="mini-table">
      <thead><tr><th>Year</th><th>Level</th><th>Type</th><th>Black ownership</th><th>Expires</th><th></th></tr></thead>
      <tbody>${bee.map(b => {
        const expired = b.expiry_date && new Date(b.expiry_date) < new Date();
        return `<tr>
          <td>${esc(String(b.verification_year))}</td>
          <td>${esc(b.bee_level || '—')}</td>
          <td>${esc(b.certificate_type || '—')}</td>
          <td class="num">${b.black_ownership_pct ? fmtPct(b.black_ownership_pct) : '—'}</td>
          <td>${b.expiry_date ? `${fmtDate(b.expiry_date)} ${expired ? badge('badge-red','Expired') : ''}` : '—'}</td>
          <td class="row-actions">
            <button class="icon-btn" title="Edit" onclick="openEditBee('${esc(b.id)}')"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn icon-btn-danger" title="Delete" onclick="deleteBee('${esc(b.id)}')"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`;
      }).join('')}</tbody></table>` : '<p class="muted-note">No BEE verification captured yet.</p>'}`;
}

async function setAfsStatus(companyId, year, status) {
  const existing = _afsReq.find(r => r.company_id === companyId && Number(r.financial_year) === Number(year));
  const patch = {
    status,
    requested_date: status === 'requested' ? todayISO() : (existing ? existing.requested_date : null),
    received_date:  status === 'received'  ? todayISO() : (existing ? existing.received_date : null),
  };
  try {
    if (existing) await apiUpdate('pe_afs_requests', existing.id, { ...patch, updated_at: new Date().toISOString() });
    else await apiCreate('pe_afs_requests', { id: 'peafs-' + uid(), company_id: companyId, financial_year: year, ...patch });
    await loadAll();
    if (_openCompanyId) renderComplianceTab(_openCompanyId);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

/* Dated notes on a deal. The same table as the client meeting notes — a note
   taken while negotiating should not become a different kind of record the day
   the deal converts to a client. */
function dealMeetingsHtml(dealId) {
  const notes = _meetings.filter(m => m.deal_id === dealId)
    .sort((a, b) => new Date(b.meeting_date) - new Date(a.meeting_date));
  if (!notes.length) return '<p class="muted-note">No notes yet.</p>';
  return notes.map(n => `
    <div class="meeting-item">
      <div class="m-header">
        <span class="m-date">${fmtDate(n.meeting_date)}</span>
        <span class="m-title">${esc(n.title)}</span>
        <span class="u-actions">
          <button class="icon-btn" title="Edit" onclick="openEditMeeting('${esc(n.id)}')"><i class="fa-solid fa-pen"></i></button>
          <button class="icon-btn icon-btn-danger" title="Delete" onclick="deleteMeeting('${esc(n.id)}')"><i class="fa-solid fa-trash"></i></button>
        </span>
      </div>
      ${n.attendees ? `<div class="m-meta"><i class="fa-solid fa-users"></i> ${esc(n.attendees)}</div>` : ''}
      ${n.body ? `<div class="m-body">${esc(n.body)}</div>` : ''}
      ${n.action_items ? `<div class="m-actions-list"><strong>Actions</strong><div>${esc(n.action_items)}</div></div>` : ''}
    </div>`).join('');
}

function renderMeetingsTab(id) {
  const notes = _meetings.filter(m => m.company_id === id)
    .sort((a, b) => new Date(b.meeting_date) - new Date(a.meeting_date));
  document.getElementById('cp-meetings').innerHTML = `
    <div class="tab-actions">
      <button class="btn btn-primary btn-sm" onclick="openAddMeeting('${esc(id)}')"><i class="fa-solid fa-plus"></i> Add Meeting Note</button>
    </div>
    ${notes.length ? notes.map(n => `
      <div class="meeting-item">
        <div class="m-header">
          <span class="m-date">${fmtDate(n.meeting_date)}</span>
          <span class="m-title">${esc(n.title)}</span>
          <span class="u-actions">
            <button class="icon-btn" title="Edit" onclick="openEditMeeting('${esc(n.id)}')"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn icon-btn-danger" title="Delete" onclick="deleteMeeting('${esc(n.id)}')"><i class="fa-solid fa-trash"></i></button>
          </span>
        </div>
        ${n.attendees ? `<div class="m-meta"><i class="fa-solid fa-users"></i> ${esc(n.attendees)}</div>` : ''}
        ${n.location ? `<div class="m-meta"><i class="fa-solid fa-location-dot"></i> ${esc(n.location)}</div>` : ''}
        ${n.body ? `<div class="m-body">${esc(n.body)}</div>` : ''}
        ${n.action_items ? `<div class="m-actions-list"><strong>Actions</strong><div>${esc(n.action_items)}</div></div>` : ''}
      </div>`).join('') : '<p class="muted-note">No meeting notes yet.</p>'}`;
}

/* ═══════════════════════════════════════════════════
   MEETING NOTES / BEE CRUD
   ═══════════════════════════════════════════════════ */

const MEETING_FIELDS = ['company_id','deal_id','meeting_date','title','attendees','location','body','action_items','author'];

function openAddMeeting(companyId, dealId) {
  const f = document.getElementById('meeting-form');
  f.reset();
  f.dataset.editId = '';
  f.elements['company_id'].value = companyId || '';
  f.elements['deal_id'].value = dealId || '';
  f.elements['meeting_date'].value = todayISO();
  document.getElementById('meeting-modal-title').textContent = 'Add Meeting Note';
  document.getElementById('meeting-modal').classList.add('open');
}

function openEditMeeting(id) {
  const n = _meetings.find(m => m.id === id);
  if (!n) return;
  const f = document.getElementById('meeting-form');
  f.reset();
  f.dataset.editId = id;
  fillForm('meeting-form', n, MEETING_FIELDS);
  f.elements['meeting_date'].value = dateOnly(n.meeting_date) || '';
  document.getElementById('meeting-modal-title').textContent = 'Edit Meeting Note';
  document.getElementById('meeting-modal').classList.add('open');
}

async function saveMeetingNote() {
  const f = document.getElementById('meeting-form');
  const editId = f.dataset.editId;
  const data = readForm('meeting-form', MEETING_FIELDS);
  if (!data.meeting_date || !data.title) { alert('Meeting date and title are required'); return; }
  if (!data.company_id && !data.deal_id) { alert('A meeting note must belong to a company or a deal'); return; }
  try {
    if (editId) await apiUpdate('pe_meeting_notes', editId, { ...data, updated_at: new Date().toISOString() });
    else await apiCreate('pe_meeting_notes', { id: 'pemtg-' + uid(), ...data });
    closeModal('meeting-modal');
    await loadAll();
    if (_openCompanyId) renderMeetingsTab(_openCompanyId);
    const dpm = document.getElementById('dp-meetings');
    if (dpm && _openDealId) dpm.innerHTML = dealMeetingsHtml(_openDealId);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

async function deleteMeeting(id) {
  if (!confirm('Delete this meeting note?')) return;
  try {
    await apiDelete('pe_meeting_notes', id);
    await loadAll();
    if (_openCompanyId) renderMeetingsTab(_openCompanyId);
    const dpm = document.getElementById('dp-meetings');
    if (dpm && _openDealId) dpm.innerHTML = dealMeetingsHtml(_openDealId);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

const BEE_FIELDS = ['company_id','verification_year','bee_level','certificate_type','verified_by',
                    'issue_date','expiry_date','notes'];
const BEE_PCT_FIELDS = { black_ownership_pct: 'black_ownership_pct_display',
                         black_women_pct: 'black_women_pct_display' };

function populateBeeYears(companyId, selectedYear) {
  const sel = document.getElementById('bee-year-select');
  if (!sel) return;
  const taken = new Set(_bee.filter(b => b.company_id === companyId).map(b => Number(b.verification_year)));
  const co = companyById(companyId);
  sel.innerHTML = '<option value="">— Select —</option>' +
    financialYearOptions(co, 8, 1).map(y => {
      const used = taken.has(y) && y !== Number(selectedYear);
      return `<option value="${y}"${used ? ' disabled' : ''}>${y}${used ? ' — already captured' : ''}</option>`;
    }).join('');
  if (selectedYear) sel.value = String(selectedYear);
}

function openAddBee(companyId) {
  const f = document.getElementById('bee-form');
  f.reset();
  f.dataset.editId = '';
  f.elements['company_id'].value = companyId || '';
  populateBeeYears(companyId, null);
  _beeDocQueue.length = 0;
  renderDocQueue(_beeDocQueue, 'bee-doc-queue', 'bee');
  document.getElementById('bee-doc-existing').innerHTML = '';
  document.getElementById('bee-modal-title').textContent = 'Add BEE Verification';
  document.getElementById('bee-modal').classList.add('open');
}

function openEditBee(id) {
  const b = _bee.find(x => x.id === id);
  if (!b) return;
  const f = document.getElementById('bee-form');
  f.reset();
  f.dataset.editId = id;
  fillForm('bee-form', b, BEE_FIELDS, BEE_PCT_FIELDS);
  populateBeeYears(b.company_id, b.verification_year);
  ['issue_date','expiry_date'].forEach(k => {
    if (f.elements[k]) f.elements[k].value = dateOnly(b[k]) || '';
  });
  _beeDocQueue.length = 0;
  renderDocQueue(_beeDocQueue, 'bee-doc-queue', 'bee');
  _loadExistingDocsIntoModal(id, 'bee-doc-existing', 'bee');
  document.getElementById('bee-modal-title').textContent = 'Edit BEE Verification';
  document.getElementById('bee-modal').classList.add('open');
}

async function saveBee() {
  const f = document.getElementById('bee-form');
  const editId = f.dataset.editId;
  const data = readForm('bee-form', BEE_FIELDS, BEE_PCT_FIELDS);
  if (!data.company_id || !data.verification_year) { alert('Company and year are required'); return; }
  try {
    let savedId = editId;
    if (editId) {
      await apiUpdate('pe_bee_verifications', editId, { ...data, updated_at: new Date().toISOString() });
    } else {
      savedId = 'pebee-' + uid();
      await apiCreate('pe_bee_verifications', { id: savedId, ...data });
    }
    if (_beeDocQueue.length) {
      await uploadDocQueue(_beeDocQueue, data.company_id, null,
        { bee_id: savedId, doc_type: 'bee', financial_year: data.verification_year });
      _beeDocQueue.length = 0;
    }
    closeModal('bee-modal');
    await loadAll();
    if (_openCompanyId) renderComplianceTab(_openCompanyId);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

async function deleteBee(id) {
  if (!confirm('Delete this BEE verification and its certificate?')) return;
  try {
    await apiDelete('pe_bee_verifications', id);
    await loadAll();
    if (_openCompanyId) renderComplianceTab(_openCompanyId);
  } catch (e) { alert('Error: ' + _cleanErr(e.message)); }
}

/* ═══════════════════════════════════════════════════
   UPDATE ATTACHMENTS
   ═══════════════════════════════════════════════════ */
async function loadUpdateAttachments(updateId) {
  const el = document.getElementById('u-att-' + updateId);
  if (!el) return;
  try {
    const res = await fetch(`/api/pe/documents/list?update_id=${encodeURIComponent(updateId)}`,
      { credentials: 'include', headers: _authHeaders() });
    const json = await res.json();
    const docs = json.docs || [];
    if (!docs.length) { el.innerHTML = ''; return; }
    el.innerHTML = docs.map(d => `
      <a class="attachment-chip" href="/api/pe/documents/${esc(d.id)}/download" target="_blank" rel="noopener">
        ${_docIcon(d.mimetype)} <span>${esc(d.label || d.filename)}</span>
      </a>`).join('');
  } catch (_) { /* an attachment list that cannot load must not blank the update */ }
}

/* ═══════════════════════════════════════════════════
   XERO INVOICE IMPORT
   ═══════════════════════════════════════════════════ */

function openXeroImport(companyId) {
  _xeroPending = null;
  document.getElementById('xero-company-id').value = companyId || '';
  document.getElementById('xero-preview').innerHTML = '';
  document.getElementById('xero-file-input').value = '';
  document.getElementById('xero-import-btn').disabled = true;
  document.getElementById('xero-idle').style.display = 'flex';
  document.getElementById('xero-loading').style.display = 'none';
  const co = companyById(companyId);
  document.getElementById('xero-modal-title').textContent =
    co ? `Import Xero Invoices — ${co.name}` : 'Import Xero Invoices';
  document.getElementById('xero-modal').classList.add('open');
}

/* Parse and show BEFORE writing anything. An import that goes straight to the
   database is one where a wrong column mapping is discovered by finding wrong
   revenue later. */
async function previewXeroImport(file) {
  if (!file) return;
  const companyId = document.getElementById('xero-company-id').value;
  document.getElementById('xero-idle').style.display = 'none';
  document.getElementById('xero-loading').style.display = 'flex';
  document.getElementById('xero-preview').innerHTML = '';
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('company_id', companyId);
    fd.append('dry_run', 'true');
    const res = await fetch('/api/pe/xero-invoices', {
      method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not read the export');
    _xeroPending = { file, companyId };
    document.getElementById('xero-import-btn').disabled = json.parsed_count === 0;
    document.getElementById('xero-preview').innerHTML = `
      <div class="import-summary">
        <strong>${json.parsed_count}</strong> invoice${json.parsed_count === 1 ? '' : 's'} read,
        totalling <strong>${fmtR(json.would_total)}</strong> gross.
        ${json.skipped.length ? `<span class="warn">${json.skipped.length} row${json.skipped.length === 1 ? '' : 's'} skipped.</span>` : ''}
      </div>
      ${json.preview.length ? `<table class="mini-table">
        <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th class="num">Gross</th><th class="num">SVC share</th></tr></thead>
        <tbody>${json.preview.map(p => `<tr>
          <td>${esc(p.invoice_number)}</td><td>${fmtDate(p.invoice_date)}</td>
          <td>${badge(FEE_STATUS_COLOR[p.status] || 'badge-gray', p.status)}</td>
          <td class="num">${fmtR(p.gross_amount)}</td><td class="num">${fmtR(p.svc_share_amount)}</td>
        </tr>`).join('')}</tbody></table>` : ''}
      ${json.skipped.length ? `<details class="skip-details"><summary>${json.skipped.length} skipped</summary>
        <ul>${json.skipped.map(sk => `<li>Line ${sk.line}${sk.invoice ? ` (${esc(sk.invoice)})` : ''} — ${esc(sk.reason)}</li>`).join('')}</ul>
      </details>` : ''}`;
  } catch (e) {
    document.getElementById('xero-preview').innerHTML =
      `<div class="import-error"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(_cleanErr(e.message))}</div>`;
    document.getElementById('xero-import-btn').disabled = true;
  } finally {
    document.getElementById('xero-loading').style.display = 'none';
    document.getElementById('xero-idle').style.display = 'flex';
  }
}

async function commitXeroImport() {
  if (!_xeroPending) return;
  const btn = document.getElementById('xero-import-btn');
  btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append('file', _xeroPending.file);
    fd.append('company_id', _xeroPending.companyId);
    const res = await fetch('/api/pe/xero-invoices', {
      method: 'POST', credentials: 'include', headers: _authHeaders(), body: fd,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Import failed');
    closeModal('xero-modal');
    _xeroPending = null;
    await loadAll();
    if (_openCompanyId) { renderFeesTab(_openCompanyId); }
    renderView(_activeView);
    alert(`Imported ${json.inserted} new invoice${json.inserted === 1 ? '' : 's'}` +
          (json.updated ? `, refreshed ${json.updated} already on file` : '') + '.\n\n' +
          `Lifetime billed: ${fmtR(json.lifetime_revenue.invoiced_gross)} gross, ` +
          `${fmtR(json.lifetime_revenue.invoiced_svc)} SVC share.`);
  } catch (e) {
    alert('Error: ' + _cleanErr(e.message));
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════
   AFS REMINDERS — across the whole book
   ═══════════════════════════════════════════════════ */
async function loadAfsReminders() {
  const el = document.getElementById('afs-reminders');
  if (!el) return;
  try {
    const res = await fetch('/api/pe/afs-due', { credentials: 'include', headers: _authHeaders() });
    if (!res.ok) throw new Error('Could not load');
    const json = await res.json();
    const due = json.due || [];
    if (!due.length) {
      el.innerHTML = '<p class="muted-note">No AFS outstanding — every year end more than three months past has statements on file.</p>';
      return;
    }
    el.innerHTML = due.map(d => `
      <div class="afs-row ${d.status === 'overdue' ? 'afs-overdue' : ''}"
           onclick="openCompanyPanel('${esc(d.company_id)}')">
        <div>
          <div class="afs-company">${esc(d.company_name)}</div>
          <div class="afs-meta">FY ${esc(String(d.financial_year))} · year end ${fmtDate(d.year_end)}</div>
        </div>
        ${badge(d.status === 'overdue' ? 'badge-red' : 'badge-gold',
                d.status === 'overdue' ? 'Overdue' : 'Request now')}
      </div>`).join('');
  } catch (e) {
    el.innerHTML = `<p class="muted-note">Could not load AFS reminders — ${esc(_cleanErr(e.message))}</p>`;
  }
}

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
