/* ============================================================
   SV Capital — Cattle Investment Management
   fund/js/cattle.js
   NAV Engine + CSV Import + All View Renderers
   ============================================================ */

'use strict';

const BASE = '/api/';

/* ── API HELPERS ──────────────────────────────────────────── */
function _getAuthToken() {
  return localStorage.getItem('svc_token') || sessionStorage.getItem('svc_token') || null;
}
async function apiFetch(path, opts = {}) {
  const token = _getAuthToken();
  opts.headers = Object.assign(
    token ? { Authorization: `Bearer ${token}` } : {},
    opts.headers || {}
  );
  opts.credentials = 'include';
  const r = await fetch(BASE + path, opts);
  if (r.status === 401) { let l='/login.html'; try{const s=JSON.parse(localStorage.getItem('staffSession')||'null');if(s&&s.empId&&s.expiresAt>Date.now())l='/team/login.html';}catch(_){} window.location.replace(l); throw new Error('Session expired'); }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`API ${r.status}: ${t}`); }
  return r;
}
async function apiGet(path)       { return (await apiFetch(path)).json(); }
async function apiPost(path, d)   { return (await apiFetch(path, { method: 'POST',  headers: {'Content-Type':'application/json'}, body: JSON.stringify(d) })).json(); }
async function apiPatch(path, d)  { return (await apiFetch(path, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(d) })).json(); }
async function apiDelete(path)    { return apiFetch(path, { method: 'DELETE' }); }

/* ── TOAST ─────────────────────────────────────────────────── */
const CToast = {
  show(msg, type = 'success') {
    let c = document.getElementById('cattleToastContainer');
    if (!c) {
      c = document.createElement('div');
      c.id = 'cattleToastContainer';
      c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px';
      document.body.appendChild(c);
    }
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    const el = document.createElement('div');
    el.className = `cattle-toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icons[type]||icons.info} t-icon"></i><span>${escapeHtml(msg)}</span>`;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }
};

/* ── HTML ESCAPE (XSS prevention) ─────────────────────────── */
function escapeHtml(str) {
  if (str === null || str === undefined || str === '') return '';
  /* Coerced, because a number reaches this from ids and counts and
     (123).replace is a TypeError that takes the whole render with it. */
  return String(str).replace(/[&<>"']/g, function(m) {
    if (m === '"') return '&quot;';
    if (m === "'") return '&#39;';
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

/* ── BOOLEAN NORMALISER — API returns "true"/"false" strings ── */
const isTrue = v => v === true || v === 'true' || v === 1 || v === '1';

/* ── FORMAT HELPERS ────────────────────────────────────────── */
const fmt = {
  zar:  (v) => v == null || isNaN(v) ? '—' : 'R' + Number(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  zarK: (v) => v == null || isNaN(v) ? '—' : 'R' + (Number(v)/1000).toFixed(1) + 'k',
  num:  (v) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-ZA'),
  pct:  (v) => v == null || isNaN(v) ? '—' : Number(v).toFixed(2) + '%',
  date: (v) => {
    if (!v) return '—';
    try { return new Date(v).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return escapeHtml(v); }
  },
  kg: (v) => v == null || isNaN(v) ? '—' : Number(v).toFixed(0) + ' kg'
};

/* ── STATE ─────────────────────────────────────────────────── */
const S = {
  /* `animals` is ONE PAGE of the animals table — 75 rows, whatever the current
     filter selects. It belongs to the Animals view and to nothing else.

     NAV reads `herd`, never `animals`. The two used to be one array, so the
     Cycles tab valued the herd off whatever happened to be in it: the full set
     after visiting the dashboard, 75 filtered rows after visiting Animals, and
     nothing at all on a direct load — where the average entry mass silently
     fell back to a hardcoded 220kg. Three different herd values for the same
     cycle, decided by where the user had clicked first.

     `herd` replaced a second array holding every animal on file. It is the
     same information NAV was reducing that array to, computed by the database
     instead: per-cycle mass sums and counts, three totals, and a breed
     histogram. Nothing in this console needs an individual animal row outside
     the Animals view, which pages. */
  animals:      [],
  costs:        [],
  animalTotal:  0,
  animalPages:  0,
  animalStats:  { total: 0, sold: 0, mortalities: 0, avg_mass: null },
  herd: { cycles: {}, totals: { total: 0, sold: 0, mortalities: 0 }, breeds: [] },
  animalBatches: [],
  animalBreeds:  [],
  cycles:   [],
  navSettings: {},
  currentView: 'nav',
  animalPage: 1,
  animalPageSize: 75,
  animalFilter: { search: '', batch: '', status: '', breed: '' },
  cyclePage: 1,
  cycleFilter: { search: '', company: '', status: '' },
  /* Batch ids ticked on the cycles list. A Set, and it survives a re-render —
     typing in the search box re-renders, and a selection that emptied itself
     every keystroke would be unusable on a list of 138. */
  cycleSel: new Set(),
  /* The animals of the batch whose detail modal is open: { cycleId, offset,
     total, rows }. Scoped to one batch and fetched for it — never the animals
     table's page. */
  cycleAnimals: null,
  selectedCycle: null,
  charts: {}
};

/* ── SAFE GET (swallows 422/404 — returns empty data) ──────── */
async function safeGet(path) {
  try { return await apiGet(path); } catch(e) { return { data: [], total: 0 }; }
}

/* ── FETCH ALL PAGES — handles large tables (API max 100/page) */
async function fetchAll(table, onProgress) {
  const PAGE = 100;
  let page = 1, all = [];
  while (true) {
    const res = await safeGet(`tables/${table}?limit=${PAGE}&page=${page}`);
    const rows = res.data || [];
    all = all.concat(rows);
    const total = res.total || 0;
    if (onProgress) onProgress(all.length, total);
    if (rows.length < PAGE) break;
    if (total > 0 && all.length >= total) break;
    page++;
  }
  return all;
}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  bindNav();
  await loadNavSettings();
  navigate('nav', document.querySelector('[data-view="nav"]'));
});

function bindNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view, btn));
  });
}

async function navigate(view, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('view-' + view);
  if (el) el.classList.add('active');
  if (btn) btn.classList.add('active');

  const titles = {
    nav:       'NAV Dashboard',
    cycles:    'Cattle Cycles (Backgrounded)',
    animals:   'Individual Animals (Purchased)',
    import:    'Import Data',
    settings:  'NAV Settings',
    costs:     'Cycle Cost Ledger',
    reconcile: 'Herd Reconciliation'
  };
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl) titleEl.textContent = titles[view] || view;

  const loaders = {
    nav:       loadNAVDashboard,
    cycles:    loadCycles,
    animals:   loadAnimals,
    import:    setupImportView,
    settings:  loadSettingsView,
    costs:     loadCostLedger,
    reconcile: loadReconciliation
  };
  if (loaders[view]) await loaders[view]();
}

/* ══════════════════════════════════════════════════════════════
   NAV SETTINGS
══════════════════════════════════════════════════════════════ */
async function loadNavSettings() {
  try {
    const res = await safeGet('tables/cattle_nav_settings?limit=50');
    const rows = (res.data || []);
    S.navSettings = {};
    rows.forEach(r => { S.navSettings[r.setting_key] = parseFloat(r.setting_value) || r.setting_value; });
    // fill missing defaults
    const defaults = {
      live_cattle_price_per_kg: 42.50,
      avg_daily_weight_gain_kg: 1.2,
      mortality_rate_assumption_pct: 1.5,
      svc_standing_fee_per_day_per_head: 3.50,
      target_return_pct: 14.83,
      feedlot_cost_per_day_per_head: 28.00
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (S.navSettings[k] === undefined) S.navSettings[k] = v;
    }
  } catch(e) {
    S.navSettings = {
      live_cattle_price_per_kg: 42.50,
      avg_daily_weight_gain_kg: 1.2,
      mortality_rate_assumption_pct: 1.5,
      svc_standing_fee_per_day_per_head: 3.50,
      target_return_pct: 14.83,
      feedlot_cost_per_day_per_head: 28.00
    };
  }
}

/* ══════════════════════════════════════════════════════════════
   NAV ENGINE  — Core calculation logic (fixed)
══════════════════════════════════════════════════════════════ */
const NAV = {

  /* Days a cycle has been running, from its start date to today. */
  daysIn(cycle) {
    if (!cycle || !cycle.cycle_start_date) return 0;
    const start = new Date(cycle.cycle_start_date);
    if (isNaN(start.getTime())) return 0;
    return Math.max(0, Math.round((Date.now() - start.getTime()) / 86400000));
  },

  /**
   * Current value of a single animal.
   *
   * Exit mass is used the moment it exists: it is what the animal actually
   * weighed, and no growth model beats a scale. The daily-gain estimate is the
   * fallback for animals still in the feedlot, and `estimated` says which of
   * the two produced the number.
   */
  animalNAV(animal, daysInCycle = 0) {
    const pricePerKg  = S.navSettings.live_cattle_price_per_kg  || 42.50;
    const dailyGain   = S.navSettings.avg_daily_weight_gain_kg   || 1.2;
    const entryMass   = parseFloat(animal.entry_mass) || 0;
    const exitMass    = parseFloat(animal.exit_mass);
    const weighed     = !isNaN(exitMass) && exitMass > 0;
    const estMass     = weighed ? exitMass : entryMass + (dailyGain * daysInCycle);
    const grossValue  = estMass * pricePerKg;
    const feedCost    = (S.navSettings.feedlot_cost_per_day_per_head || 28) * daysInCycle;
    const netValue    = Math.max(0, grossValue - feedCost);
    return { entryMass, exitMass: weighed ? exitMass : null, estMass, estimated: !weighed,
             grossValue, feedCost, netValue, pricePerKg };
  },

  /**
   * NAV for one cycle: what the live herd is worth, less everything spent
   * getting it there.
   *
   * CARRY COSTS COME FROM THE LEDGER FIRST. A cycle with invoices captured in
   * cattle_costs is valued against those invoices; the per-day feedlot and
   * standing-fee assumptions are used only for cycles with no invoices at all,
   * and `costSource` records which happened. Before this, NAV always used the
   * assumption — so the Cycle Costs tab could hold a season of real feed bills
   * and the valuation would not move by a rand. (It could not, in fact, hold
   * anything: every cost entry failed to save. Both halves of that are fixed.)
   *
   * The modelled fallback is per LIVE head per day, which understates the
   * carry on a cycle that lost animals late — they ate until they died. It is
   * an assumption standing in for a missing invoice, and it is labelled as one.
   */
  /* The four numbers a cycle's valuation actually needs from its animals:
     the entry and exit masses on file, as sums and counts.

     Reducing a herd to this is what lets the console stop downloading it. The
     server returns exactly this shape per cycle from /cattle/herd-summary; this
     function produces it from an array for anything that still holds one, so
     the arithmetic below has one definition rather than two that must agree. */
  massSummary(animals = []) {
    let entry_sum = 0, entry_count = 0, exit_sum = 0, exit_count = 0;
    for (const a of animals) {
      const e = parseFloat(a.entry_mass);
      if (e > 0) { entry_sum += e; entry_count++; }
      const x = parseFloat(a.exit_mass);
      if (x > 0) { exit_sum += x; exit_count++; }
    }
    return { entry_sum, entry_count, exit_sum, exit_count, animals: animals.length };
  },

  /* `herd` is either that summary or a plain array of animals. The array form
     is what the NAV check exercises and what any caller holding real rows can
     still pass; the summary form is what the console uses now. Same maths
     either way — the array is summarised and then forgotten. */
  cycleNAV(cycle, herd = [], costs = null) {
    const m = Array.isArray(herd) ? NAV.massSummary(herd) : (herd || NAV.massSummary([]));

    const daysIn      = NAV.daysIn(cycle);
    const liveCount   = parseInt(cycle.no_live) || 0;
    const purchased   = parseInt(cycle.no_purchased) || 0;
    const mortalities = parseInt(cycle.mortalities) || 0;

    const pricePerKg = S.navSettings.live_cattle_price_per_kg || 42.50;
    const dailyGain  = S.navSettings.avg_daily_weight_gain_kg || 1.2;

    /* Averaging entry mass over the animals on file. `massKnown` is how many
       that was: a cycle with no animal records falls back to the settings
       default, and a valuation resting on a default should say so rather than
       look identical to one resting on 400 weigh-in slips. */
    const massKnown    = Number(m.entry_count) || 0;
    const avgEntryMass = massKnown
      ? Number(m.entry_sum) / massKnown
      : (S.navSettings.default_entry_mass_kg || 220);

    /* Where animals have been weighed out, that is the herd's real average. */
    const weighedCount = Number(m.exit_count) || 0;
    const estAvgMass = weighedCount
      ? Number(m.exit_sum) / weighedCount
      : avgEntryMass + (dailyGain * daysIn);

    const herdValue = liveCount * estAvgMass * pricePerKg;

    const purchaseValue = parseFloat(cycle.purchase_value) || 0;

    const recorded = (costs || []).filter(c => c.cycle_id === cycle.id);
    const recordedTotal = recorded.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);

    let feedCosts, standingFees, carryCosts, costSource;
    if (recorded.length) {
      /* Purchase cost, if someone booked it to the ledger as well, is already
         in purchase_value — counting it twice would halve the cycle's NAV. */
      carryCosts   = recorded.filter(c => c.category !== 'purchase')
                             .reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
      feedCosts    = recorded.filter(c => c.category === 'feed')
                             .reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
      standingFees = carryCosts - feedCosts;
      costSource   = 'actual';
    } else {
      feedCosts    = (S.navSettings.feedlot_cost_per_day_per_head || 28) * liveCount * daysIn;
      standingFees = (S.navSettings.svc_standing_fee_per_day_per_head || 3.50) * liveCount * daysIn;
      carryCosts   = feedCosts + standingFees;
      costSource   = 'modelled';
    }

    const totalCosts   = purchaseValue + carryCosts;
    const expectedSale = parseFloat(cycle.expected_sale_value) || herdValue;

    const nav    = herdValue - totalCosts;
    const navPct = purchaseValue > 0 ? (nav / purchaseValue) * 100 : 0;

    return {
      daysIn, liveCount, purchased, mortalities,
      pricePerKg, estAvgMass, avgEntryMass, massKnown, weighedCount,
      herdValue, purchaseValue,
      standingFees, feedCosts, carryCosts, totalCosts, costSource, recordedTotal,
      expectedSale, nav, navPct,
      /* What the herd would lose if the mortalities were valued at entry. Kept
         for the cycle detail panel; it is NOT deducted from nav, because a dead
         animal is already absent from liveCount and subtracting it again would
         charge the loss twice. */
      mortalityCost: mortalities * avgEntryMass * pricePerKg,
      cycleStatus: cycle.status
    };
  },

  /**
   * The whole book.
   *
   * portNAV is the SUM OF THE CYCLE NAVs — the same number the per-cycle rows
   * show, added up. It used to be herdValue − purchaseValue, which quietly
   * dropped every carry cost the rows deducted, so the headline unrealised gain
   * and the cycles listed directly beneath it disagreed by the entire feed
   * bill. On a hundred head over four months at R28/day that is over R330 000
   * of difference between two numbers on the same screen.
   */
  /* `herd` is the per-cycle summary map from /cattle/herd-summary, or an array
     of animals. The array form is grouped once here rather than filtered once
     per cycle: that filter was O(cycles × animals) and ran again on every
     re-render — 45 cycles against 20 000 animals is 900 000 comparisons to
     produce 180 numbers. */
  byCycle(herd) {
    if (!Array.isArray(herd)) return herd || {};
    const map = {};
    for (const a of herd) {
      const k = a.cycle_id;
      if (!k) continue;
      const m = map[k] || (map[k] = { entry_sum: 0, entry_count: 0, exit_sum: 0, exit_count: 0, animals: 0 });
      m.animals++;
      const e = parseFloat(a.entry_mass);
      if (e > 0) { m.entry_sum += e; m.entry_count++; }
      const x = parseFloat(a.exit_mass);
      if (x > 0) { m.exit_sum += x; m.exit_count++; }
    }
    return map;
  },

  portfolioNAV(cycles, herd = [], costs = null) {
    const summaries    = NAV.byCycle(herd);
    /* A DISCONTINUED cycle is in neither list, deliberately. It is frozen: it
       keeps its recorded numbers for the record and contributes nothing to
       herd value, to capital, or to realised return. It falls out here by
       naming the two statuses that count rather than by excluding the one that
       does not — but that is easy to "fix" by widening `active` to mean
       "not sold", so: widening it would put a batch nobody is feeding back
       into the herd value, still accruing 1.2kg a day. */
    const activeCycles = cycles.filter(c => c.status === 'active');
    const soldCycles   = cycles.filter(c => c.status === 'sold');

    let totalHerdValue = 0, totalPurchaseValue = 0, totalCarryCosts = 0, portNAV = 0;
    let totalLiveAnimals = 0, totalMortalities = 0, totalPurchased = 0;
    let modelledCycles = 0;

    activeCycles.forEach(c => {
      const nav = NAV.cycleNAV(c, summaries[c.id], costs);
      totalHerdValue     += nav.herdValue;
      totalPurchaseValue += nav.purchaseValue;
      totalCarryCosts    += nav.carryCosts;
      portNAV            += nav.nav;
      totalLiveAnimals   += nav.liveCount;
      totalMortalities   += nav.mortalities;
      totalPurchased     += nav.purchased;
      if (nav.costSource === 'modelled') modelledCycles++;
    });

    let totalSold = 0, totalSaleValue = 0, soldCost = 0;
    soldCycles.forEach(c => {
      totalSold      += parseInt(c.no_sold) || 0;
      totalSaleValue += parseFloat(c.total_selling_price) || 0;
      totalPurchased += parseInt(c.no_purchased) || 0;
      soldCost       += parseFloat(c.purchase_value) || 0;
    });

    const totalReturn = totalSaleValue - soldCost;

    /* CAPITAL-WEIGHTED, not the mean of the percentages. A R10 000 cycle
       returning 20% and a R500 000 cycle returning 2% averaged to 11% — a
       number no rand in the fund earned. Weighting by the capital each cycle
       actually employed gives 2.35%, which is what the book made. Cycles with
       no purchase value recorded are excluded rather than counted as zero,
       since a missing cost basis is not a nil return. */
    const weighted = soldCycles.filter(c => (parseFloat(c.purchase_value) || 0) > 0);
    const weightedCost = weighted.reduce((s, c) => s + parseFloat(c.purchase_value), 0);
    const totalReturnPct = weightedCost > 0
      ? (weighted.reduce((s, c) =>
           s + parseFloat(c.purchase_value) * (parseFloat(c.net_return_pct) || 0), 0) / weightedCost)
      : 0;

    return {
      activeCycles: activeCycles.length,
      soldCycles:   soldCycles.length,
      totalCycles:  cycles.length,
      totalHerdValue, totalPurchaseValue, totalCarryCosts, modelledCycles,
      totalLiveAnimals, totalMortalities, totalPurchased,
      totalSold, totalSaleValue, totalReturn, totalReturnPct,
      portNAV,
      returnBasis: weighted.length < soldCycles.length ? 'partial' : 'full',
      mortalityRate: totalPurchased > 0 ? (totalMortalities / totalPurchased) * 100 : 0
    };
  }
};

/* ══════════════════════════════════════════════════════════════
   THE HERD — cycles, every animal, and the cost ledger.

   One loader, because NAV needs all three and every view that shows a NAV
   number needs the same three. The Cycles tab used to load cycles only and
   value the herd against whatever animals happened to be in memory; landing on
   it directly meant valuing it against none.

   `force` is for the dashboard's Refresh. Everything else reuses what is
   already loaded rather than re-walking a herd of thousands one 100-row page
   at a time.
══════════════════════════════════════════════════════════════ */
let _herdLoaded = false;
async function _loadHerd(onStatus = () => {}, force = false) {
  if (_herdLoaded && !force) return;
  onStatus('Loading herd…');

  /* Three independent reads, so three at once. Sequentially they were the
     console's whole start-up cost; the slowest now sets the pace instead of
     the sum.

     The herd arrives as aggregates rather than as animals. It used to be
     walked out of the generic table API a hundred rows at a time — 210
     requests and 8.7 MB for a 20 000-head herd, measured, of which 4.6 of the
     4.8 seconds was the walk — and then reduced in the browser to about fifty
     numbers. /cattle/herd-summary is those numbers. */
  const [cycles, costs, herd] = await Promise.all([
    fetchAll('cattle_cycles'),
    fetchAll('cattle_costs'),
    safeGet('cattle/herd-summary'),
  ]);

  S.cycles = cycles;
  S.costs  = costs;
  S.herd   = (herd && herd.cycles) ? herd : { cycles: {}, totals: { total: 0, sold: 0, mortalities: 0 }, breeds: [] };
  _herdLoaded = true;
}

/* ══════════════════════════════════════════════════════════════
   VIEW: NAV DASHBOARD (with error handling)
══════════════════════════════════════════════════════════════ */
async function loadNAVDashboard() {
  const el = document.getElementById('view-nav');
  if (!el) return;
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Calculating NAV…</div>`;

  try {
    await _loadHerd(msg => {
      const lbl = document.getElementById('navLoadStatus');
      if (lbl) lbl.textContent = msg;
      else el.innerHTML = `<div class="loading-state"><div class="spinner"></div> <span id="navLoadStatus">${escapeHtml(msg)}</span></div>`;
    }, true);

    const pNav = NAV.portfolioNAV(S.cycles, S.herd.cycles, S.costs);
    const activeCycles = S.cycles.filter(c => c.status === 'active');
    const soldCycles   = S.cycles.filter(c => c.status === 'sold');
    const now = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    // Breed breakdown for active animals
    /* Already grouped, and already ordered by size — so the six drawn are the
       six largest rather than whichever six happened to sort first. */
    const breedTop    = (S.herd.breeds || []).slice(0, 6);
    const breedLabels = breedTop.map(b => b.breed);
    const breedData   = breedTop.map(b => b.count);

    // Cycle return history for chart
    const chartCycles = soldCycles.slice(-12);
    const chartLabels = chartCycles.map(c => c.batch_name ? c.batch_name.split(' - ')[0] : c.id);
    const chartPurchase = chartCycles.map(c => parseFloat(c.purchase_value)||0);
    const chartSale     = chartCycles.map(c => parseFloat(c.total_selling_price)||0);

    /* Negatives need the sign, and -R0 is not a number anyone should read. */
    const zarM  = v => {
      if (v === null || v === undefined || isNaN(v)) return '—';
      const n = Number(v), a = Math.abs(n), sign = n < 0 ? '-' : '';
      return a >= 1e6 ? `${sign}R${(a/1e6).toFixed(2)}M`
           : a >= 1e3 ? `${sign}R${(a/1e3).toFixed(1)}k`
                      : `${sign}R${a.toFixed(0)}`;
    };
    /* The hero is the herd's gross value; the gain beneath it is the NAV, which
       is that value less the purchase AND the carry. Both come off the same
       cycleNAV the rows below use, so the headline and the table now describe
       one book. */
    const portNAVTotal    = pNav.totalHerdValue;
    const unrealisedPct   = pNav.totalPurchaseValue > 0 ? ((pNav.portNAV / pNav.totalPurchaseValue) * 100) : 0;
    const unrealisedColor = pNav.portNAV >= 0 ? '#74c69d' : '#ff8080';
    const totalCapital    = pNav.totalPurchaseValue + soldCycles.reduce((s,c) => s + (parseFloat(c.purchase_value)||0), 0);
    const costBasisNote   = pNav.modelledCycles === 0
      ? 'Carry costs from the recorded ledger'
      : pNav.modelledCycles === pNav.activeCycles
        ? `Carry costs estimated — no invoices captured${pNav.activeCycles ? ' for any active cycle' : ''}`
        : `Carry costs recorded for ${pNav.activeCycles - pNav.modelledCycles} of ${pNav.activeCycles} cycles, estimated for the rest`;

    el.innerHTML = `
      <div class="nav-panel">
        <div class="nav-panel-header">
          <div>
            <div class="nav-panel-title"><i class="fa-solid fa-cow" style="opacity:.6"></i> &nbsp;Cattle Finance — Portfolio NAV</div>
            <div class="nav-hero-value">${zarM(portNAVTotal)}</div>
            <div class="nav-hero-sub">Estimated total herd value &nbsp;·&nbsp; ${pNav.activeCycles} active cycle${pNav.activeCycles!==1?'s':''}</div>
          </div>
          <div style="display:flex;gap:32px;align-items:flex-start">
            <div style="text-align:right">
              <div class="nav-panel-title">Unrealised Gain</div>
              <div style="font-size:28px;font-weight:900;color:${unrealisedColor};letter-spacing:-.5px;line-height:1">
                ${pNav.portNAV >= 0 ? '+' : ''}${unrealisedPct.toFixed(2)}%
              </div>
              <div class="nav-hero-sub">${pNav.portNAV >= 0 ? '+' : ''}${zarM(pNav.portNAV)} after ${zarM(pNav.totalCarryCosts)} carry</div>
            </div>
            <div style="text-align:right">
              <div class="nav-panel-title">Market Price / kg</div>
              <div style="font-size:28px;font-weight:900;color:#fff;letter-spacing:-.5px;line-height:1">
                R${(S.navSettings.live_cattle_price_per_kg||42.5).toFixed(2)}
              </div>
              <div class="nav-hero-sub">Liveweight &nbsp;<a href="#" onclick="navigate('settings',document.querySelector('[data-view=settings]'));return false;" style="color:var(--green-light)">Edit</a></div>
            </div>
          </div>
        </div>

        <div class="nav-metrics">
          <div class="nav-metric">
            <div class="nav-metric-label">Capital Deployed</div>
            <div class="nav-metric-value">${zarM(pNav.totalPurchaseValue)}</div>
            <div class="nav-metric-sub">${pNav.activeCycles} active cycles</div>
          </div>
          <div class="nav-metric">
            <div class="nav-metric-label">Live Herd</div>
            <div class="nav-metric-value">${fmt.num(pNav.totalLiveAnimals)} head</div>
            <div class="nav-metric-sub">${fmt.num(pNav.totalMortalities)} mort. &nbsp;(${pNav.mortalityRate.toFixed(1)}%)</div>
          </div>
          <div class="nav-metric">
            <div class="nav-metric-label">Realised Returns</div>
            <div class="nav-metric-value" style="color:#74c69d">${zarM(pNav.totalReturn)}</div>
            <div class="nav-metric-sub">${fmt.pct(pNav.totalReturnPct)} capital-weighted${pNav.returnBasis === 'partial' ? ' *' : ''}</div>
          </div>
          <div class="nav-metric">
            <div class="nav-metric-label">Carry Costs (Active)</div>
            <div class="nav-metric-value" style="color:#fec24f">${zarM(pNav.totalCarryCosts)}</div>
            <div class="nav-metric-sub">${escapeHtml(costBasisNote)}</div>
          </div>
          <div class="nav-metric">
            <div class="nav-metric-label">Total Cycles</div>
            <div class="nav-metric-value">${pNav.totalCycles}</div>
            <div class="nav-metric-sub">${pNav.activeCycles} active &nbsp;·&nbsp; ${pNav.soldCycles} sold</div>
          </div>
          <div class="nav-metric">
            <div class="nav-metric-label">Animals Tracked</div>
            <div class="nav-metric-value">${fmt.num(S.herd.totals.total)}</div>
            <div class="nav-metric-sub">${fmt.num(S.herd.totals.sold)} sold &nbsp;·&nbsp; ${fmt.num(S.herd.totals.mortalities)} mort.</div>
          </div>
          <div class="nav-metric">
            <div class="nav-metric-label">Total Capital (All)</div>
            <div class="nav-metric-value">${zarM(totalCapital)}</div>
            <div class="nav-metric-sub">Sale revenue: ${zarM(pNav.totalSaleValue)}</div>
          </div>
        </div>

        <div class="nav-date">
          <i class="fa-regular fa-clock"></i>
          Calculated: ${escapeHtml(now)}
          &nbsp;·&nbsp;
          ${pNav.returnBasis === 'partial' ? `<span style="color:#fec24f">* weighted over the sold cycles with a purchase value recorded</span> &nbsp;·&nbsp;` : ''}
          <a href="#" onclick="navigate('reconcile',document.querySelector('[data-view=reconcile]'));return false;" style="color:var(--green-light);text-decoration:none">
            <i class="fa-solid fa-scale-unbalanced"></i> Reconcile herd
          </a>
          &nbsp;·&nbsp;
          <a href="#" onclick="loadNAVDashboard();return false;" style="color:var(--green-light);text-decoration:none">
            <i class="fa-solid fa-rotate"></i> Refresh
          </a>
        </div>
      </div>

      ${activeCycles.length > 0 ? `
      <div class="card" style="margin-bottom:22px">
        <div class="card-header">
          <i class="fa-solid fa-clock" style="color:var(--green-mid)"></i>
          Active Cycles — Live NAV
          <span class="count-badge" style="background:var(--green-pale);color:var(--green);font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;margin-left:auto">${activeCycles.length}</span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>Batch</th><th>Company</th><th style="text-align:center">Days</th><th style="text-align:center">Live / Mort.</th><th class="num">Cost Basis</th><th class="num">Est. Value</th><th class="num">Gain / Loss</th><th class="num">NAV %</th></tr>
            </thead>
            <tbody>
              ${activeCycles.map(c => {
                const nav = NAV.cycleNAV(c, S.herd.cycles[c.id], S.costs);
                const isUp = nav.navPct >= 0;
                const pctColor = isUp ? 'var(--green-mid)' : 'var(--red)';
                /* An estimated carry and an invoiced one are different claims,
                   and the row says which without needing a second table. */
                const carryTitle = nav.costSource === 'actual'
                  ? `${fmt.zar(nav.carryCosts)} carry, from recorded invoices`
                  : `${fmt.zar(nav.carryCosts)} carry, estimated — no costs captured for this cycle`;
                return `<tr style="cursor:pointer" onclick="openCycleDetail('${escapeHtml(c.id)}')">
                  <td><strong>${escapeHtml(c.batch_name || c.id)}</strong></td>
                  <td style="color:var(--text-muted);font-size:12px">${escapeHtml(c.company || '—')}</td>
                  <td style="text-align:center"><span class="badge badge-blue">${nav.daysIn}d</span></td>
                  <td style="text-align:center"><span class="badge badge-green" style="margin-right:4px">${nav.liveCount}</span>${nav.mortalities > 0 ? `<span class="badge badge-red">${nav.mortalities}</span>` : ''}</td>
                  <td class="num" style="color:var(--text-muted)" title="${escapeHtml(carryTitle)}">${zarM(nav.totalCosts)}${nav.costSource === 'modelled' ? ' <span style="color:#fec24f;font-weight:700" title="Carry costs estimated">~</span>' : ''}</td>
                  <td class="num"><strong>${zarM(nav.herdValue)}</strong></td>
                  <td class="num" style="color:${pctColor};font-weight:700">${isUp?'+':''}${zarM(nav.nav)}</td>
                  <td class="num"><span style="display:inline-flex;align-items:center;gap:4px;font-weight:700;color:${pctColor}"><i class="fa-solid fa-arrow-${isUp?'up':'down'}" style="font-size:10px"></i>${Math.abs(nav.navPct).toFixed(2)}%</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : `
      <div class="card" style="margin-bottom:24px">
        <div class="card-body">
          <div class="empty-state">
            <i class="fa-solid fa-cow"></i>
            <h3>No active cycles</h3>
            <p>Import cycle data or create a cycle to see live NAV calculations</p>
            <button class="btn btn-primary" style="margin-top:12px" onclick="navigate('import', document.querySelector('[data-view=import]'))">
              <i class="fa-solid fa-upload"></i> Import Data
            </button>
          </div>
        </div>
      </div>`}

      <div class="grid-2" style="margin-bottom:24px">
        <div class="card"><div class="card-header"><i class="fa-solid fa-chart-bar" style="color:var(--green-mid)"></i> Purchase vs Sale by Cycle</div><div class="card-body"><div class="chart-container" style="height:240px"><canvas id="cycleReturnChart"></canvas></div></div></div>
        <div class="card"><div class="card-header"><i class="fa-solid fa-chart-pie" style="color:var(--amber-dark)"></i> Breed Composition (Active)</div><div class="card-body"><div class="chart-container" style="height:240px"><canvas id="breedChart"></canvas></div></div></div>
      </div>

      ${soldCycles.length > 0 ? `
      <div class="card">
        <div class="card-header">
          <i class="fa-solid fa-flag-checkered" style="color:var(--green-mid)"></i>
          Completed Cycle Performance
          <span style="font-size:11px;color:var(--text-muted);margin-left:auto;font-weight:400">Most recent ${Math.min(soldCycles.length,20)}</span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Batch</th><th>Company</th><th style="text-align:center">Days</th><th style="text-align:center">Head</th><th class="num">Cost Basis</th><th class="num">Sale Value</th><th class="num">Net Return</th><th class="num">Return %</th></tr></thead>
            <tbody>
              ${soldCycles.slice(-20).reverse().map(c => {
                const ret    = (parseFloat(c.total_selling_price)||0) - (parseFloat(c.purchase_value)||0);
                const retPct = parseFloat(c.net_return_pct) || 0;
                const isUp   = retPct >= 0;
                const color  = isUp ? 'var(--green-mid)' : 'var(--red)';
                return `<tr onclick="openCycleDetail('${escapeHtml(c.id)}')" style="cursor:pointer">
                  <td><strong>${escapeHtml(c.batch_name||c.id)}</strong></td>
                  <td style="color:var(--text-muted);font-size:12px">${escapeHtml(c.company||'—')}</td>
                  <td style="text-align:center"><span class="badge badge-grey">${c.days_in_cycle||'—'}d</span></td>
                  <td style="text-align:center">${c.no_purchased||'—'}</td>
                  <td class="num" style="color:var(--text-muted)">${zarM(c.purchase_value)}</td>
                  <td class="num">${zarM(c.total_selling_price)}</td>
                  <td class="num" style="color:${color};font-weight:700">${isUp?'+':''}${zarM(ret)}</td>
                  <td class="num"><span style="display:inline-flex;align-items:center;gap:4px;color:${color};font-weight:800"><i class="fa-solid fa-arrow-${isUp?'up':'down'}" style="font-size:10px"></i>${Math.abs(retPct).toFixed(2)}%</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    `;

    setTimeout(() => {
      if (typeof Chart !== 'undefined') {
        renderCycleReturnChart(chartLabels, chartPurchase, chartSale);
        renderBreedChart(breedLabels, breedData);
      } else {
        console.warn('Chart.js not loaded');
      }
    }, 50);
  } catch (err) {
    console.error(err);
    el.innerHTML = `<div class="card"><div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Error loading NAV</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary" onclick="loadNAVDashboard()">Retry</button></div></div>`;
  }
}

function renderCycleReturnChart(labels, purchase, sale) {
  const canvas = document.getElementById('cycleReturnChart');
  if (!canvas) return;
  if (typeof Chart === 'undefined') return;
  if (S.charts.cycleReturn) S.charts.cycleReturn.destroy();
  if (!labels.length) { canvas.parentElement.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-chart-bar"></i><p>No sold cycles yet</p></div>'; return; }
  S.charts.cycleReturn = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Purchase Value', data: purchase, backgroundColor: 'rgba(33,150,243,.6)', borderRadius: 4 }, { label: 'Sale Value', data: sale, backgroundColor: 'rgba(64,145,108,.75)', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', labels: { font: { size: 11 } } } }, scales: { y: { ticks: { callback: v => 'R' + (v/1000).toFixed(0) + 'k', font: { size: 10 } }, grid: { color: 'rgba(0,0,0,.06)' } }, x: { ticks: { font: { size: 10 }, maxRotation: 40 } } } }
  });
}

function renderBreedChart(labels, data) {
  const canvas = document.getElementById('breedChart');
  if (!canvas) return;
  if (typeof Chart === 'undefined') return;
  if (S.charts.breed) S.charts.breed.destroy();
  if (!labels.length) { canvas.parentElement.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-chart-pie"></i><p>No breed data</p></div>'; return; }
  const colors = ['#2d6a4f','#40916c','#74c69d','#e9c46a','#f4a261','#e63946','#656565','#9C27B0'];
  S.charts.breed = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'right', labels: { font: { size: 11 }, padding: 10 } } } }
  });
}

/* ══════════════════════════════════════════════════════════════
   VIEW: CATTLE CYCLES (Backgrounded)
══════════════════════════════════════════════════════════════ */
async function loadCycles() {
  const el = document.getElementById('view-cycles');
  if (!el) return;
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Loading cycles…</div>`;
  try {
    /* The whole herd, not just the cycles: every card on this page shows a NAV,
       and a NAV computed against an empty animal list is a NAV against a
       hardcoded 220kg. */
    await _loadHerd(msg => { el.innerHTML = `<div class="loading-state"><div class="spinner"></div> ${escapeHtml(msg)}</div>`; });
    renderCyclesView();
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Error loading cycles</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

/* One definition of what the cycles list is showing. The selection bar and the
   card list both need it, and two copies would let the bar count one set while
   the list drew another. */
function _filteredCycles() {
  const q = (S.cycleFilter.search || '').toLowerCase();
  return S.cycles.filter(c => {
    const matchSearch  = !q || (c.batch_name||'').toLowerCase().includes(q) || (c.company||'').toLowerCase().includes(q) || (c.inv_no||'').toLowerCase().includes(q);
    const matchCompany = !S.cycleFilter.company || c.company === S.cycleFilter.company;
    const matchStatus  = !S.cycleFilter.status  || c.status  === S.cycleFilter.status;
    return matchSearch && matchCompany && matchStatus;
  });
}

function renderCyclesView() {
  const el = document.getElementById('view-cycles');
  if (!el) return;
  const companies = [...new Set(S.cycles.map(c => c.company).filter(Boolean))].sort();

  const filtered = _filteredCycles();


  const activeCycles = filtered.filter(c => c.status === 'active');
  const soldCycles   = filtered.filter(c => c.status === 'sold');
  /* Its own tile. Without one, discontinuing a batch makes it vanish from both
     Active and Sold while Total Cycles stays put, and the three stop adding
     up with nothing on screen saying where it went. */
  const discCycles   = filtered.filter(c => c.status === 'discontinued');
  const totalCapital = filtered.reduce((s,c) => s + (parseFloat(c.purchase_value)||0), 0);
  const totalSale    = soldCycles.reduce((s,c) => s + (parseFloat(c.total_selling_price)||0), 0);

  el.innerHTML = `
    <div class="stat-row">
      <div class="stat-item"><div class="stat-item-label">Total Cycles</div><div class="stat-item-value">${filtered.length}</div></div>
      <div class="stat-item"><div class="stat-item-label">Active</div><div class="stat-item-value green">${activeCycles.length}</div></div>
      <div class="stat-item"><div class="stat-item-label">Sold</div><div class="stat-item-value">${soldCycles.length}</div></div>
      ${discCycles.length ? `<div class="stat-item"><div class="stat-item-label">Discontinued</div><div class="stat-item-value">${discCycles.length}</div></div>` : ''}
      <div class="stat-item"><div class="stat-item-label">Total Capital</div><div class="stat-item-value">${fmt.zar(totalCapital)}</div></div>
      <div class="stat-item"><div class="stat-item-label">Total Sale Revenue</div><div class="stat-item-value green">${fmt.zar(totalSale)}</div></div>
    </div>

    <div class="filter-bar">
      <div class="search-box">
        <i class="fa-solid fa-search"></i>
        <input type="text" id="cycleSearch" placeholder="Search batch, company or invoice no…" value="${escapeHtml(S.cycleFilter.search)}" oninput="S.cycleFilter.search=this.value;renderCyclesView()">
      </div>
      <select class="filter-select" onchange="S.cycleFilter.company=this.value;renderCyclesView()">
        <option value="">All Companies</option>
        ${companies.map(c=>`<option value="${escapeHtml(c)}" ${S.cycleFilter.company===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <select class="filter-select" onchange="S.cycleFilter.status=this.value;renderCyclesView()">
        <option value="">All Statuses</option>
        <option value="active" ${S.cycleFilter.status==='active'?'selected':''}>Active</option>
        <option value="sold" ${S.cycleFilter.status==='sold'?'selected':''}>Sold</option>
        <option value="discontinued" ${S.cycleFilter.status==='discontinued'?'selected':''}>Discontinued</option>
        <option value="draft" ${S.cycleFilter.status==='draft'?'selected':''}>Draft</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="openAddCycleModal()"><i class="fa-solid fa-plus"></i> Add Cycle</button>
    </div>

    <div class="cycle-bulk-bar" id="cycleBulkBar">${_cycleBulkBarHtml()}</div>

    ${filtered.length === 0 ? `<div class="empty-state"><i class="fa-solid fa-cow"></i><h3>No cycles found</h3><p>Import data or adjust filters</p></div>` : filtered.map(c => renderCycleCard(c)).join('')}
  `;
}

/* ── Selection ─────────────────────────────────────────────────────────────
   The selection is by id and is pruned to what is currently shown, so a batch
   filtered out of view cannot be acted on by a button that says "3 selected"
   while meaning something else. */
function _selectedCycles() {
  return S.cycles.filter(c => S.cycleSel.has(c.id));
}

/* The bar counts what is BOTH selected and on screen. A selection made before a
   filter was applied still exists; acting on the hidden part of it from a
   button labelled with a number the user can see would be acting on batches
   they are not looking at. */
function _cycleBulkBarHtml() {
  const filtered = _filteredCycles();
  const shownSel = filtered.filter(c => S.cycleSel.has(c.id));
  const n        = shownSel.length;
  const all      = filtered.length > 0 && n === filtered.length;
  const open     = shownSel.filter(c => c.status !== 'sold' && c.status !== 'discontinued').length;
  const disc     = shownSel.filter(c => c.status === 'discontinued').length;
  return `
    <label class="cycle-pick">
      <input type="checkbox" id="cycleSelectAll" onchange="toggleSelectAllCycles(this.checked)" ${all ? 'checked' : ''}>
    </label>
    <span id="cycleSelCount">${n ? `${n} selected` : `Select batches to act on ${filtered.length === S.cycles.length ? 'them' : 'the ' + filtered.length + ' shown'}`}</span>
    ${n ? `
      <div class="cycle-bulk-actions">
        <button class="btn btn-secondary btn-sm" onclick="clearCycleSelection()">Clear</button>
        ${disc ? `<button class="btn btn-secondary btn-sm" onclick="bulkReopenCycles()"><i class="fa-solid fa-rotate-left"></i> Reopen (${disc})</button>` : ''}
        ${open ? `<button class="btn btn-secondary btn-sm" onclick="bulkDiscontinueCycles()"><i class="fa-solid fa-snowflake"></i> Discontinue (${open})</button>` : ''}
        ${open ? `<button class="btn btn-primary btn-sm" onclick="openBulkSoldModal()"><i class="fa-solid fa-tag"></i> Mark sold (${open})</button>` : ''}
      </div>` : ''}`;
}

function _refreshCycleBulkBar() {
  const bar = document.getElementById('cycleBulkBar');
  if (bar) bar.innerHTML = _cycleBulkBarHtml();
}

/* Ticking a box redraws the bar and that card's outline — NOT the list.
   Rebuilding the list detached every other checkbox mid-click, so the second
   box a user ticked did nothing and the count stuck at one: the whole point of
   the feature, broken by a re-render nobody needed. It is also 138 cards
   rebuilt per tick, losing the scroll position each time. */
function toggleCycleSelected(id, on) {
  if (on) S.cycleSel.add(id); else S.cycleSel.delete(id);
  const box = document.querySelector(`#view-cycles .cycle-pick input[data-cycle="${CSS.escape(id)}"]`);
  const card = box && box.closest('.cycle-card');
  if (card) card.classList.toggle('cycle-card--selected', on);
  _refreshCycleBulkBar();
}

function toggleSelectAllCycles(on) {
  const shown = _filteredCycles();
  if (on) shown.forEach(c => S.cycleSel.add(c.id));
  else    shown.forEach(c => S.cycleSel.delete(c.id));
  /* Every card changes, so this one really does redraw the list. */
  renderCyclesView();
}

function clearCycleSelection() {
  S.cycleSel.clear();
  renderCyclesView();
}

/* ── A modal built from JS ─────────────────────────────────────────────────
   The console's other modals are markup in cattle.html with fields known ahead
   of time. These two are not: the sale dialog has a row per selected batch and
   the animal dialog depends on which animal. */
function _openModal(title, bodyHtml, footerHtml) {
  const o = document.getElementById('genericOverlay');
  if (!o) return;
  document.getElementById('genericTitle').textContent = title;
  document.getElementById('genericBody').innerHTML = bodyHtml;
  document.getElementById('genericFooter').innerHTML = footerHtml || '';
  o.classList.add('open');
}

function _closeModal() {
  const o = document.getElementById('genericOverlay');
  if (o) o.classList.remove('open');
}

/* ── Bulk actions ──────────────────────────────────────────────────────────
   All three go through one route in one transaction, so a run that fails
   leaves nothing half-applied — cycles and animals disagreeing about what was
   sold is the state nobody could unpick afterwards. */
async function _bulkStatus(action, cycles, describe) {
  try {
    const r = await apiPost('cattle/cycles/bulk-status', { action, cycles });
    const parts = [`${r.cyclesChanged} batch${r.cyclesChanged === 1 ? '' : 'es'} ${describe}`];
    if (r.animalsChanged) parts.push(`${fmt.num(r.animalsChanged)} animals updated`);
    if (r.skipped && r.skipped.length) parts.push(`${r.skipped.length} skipped`);
    CToast.show(parts.join(' · '));
    S.cycleSel.clear();
    /* force: these are the figures that just changed. */
    await _loadHerd(() => {}, true);
    renderCyclesView();
  } catch (e) {
    CToast.show(e.message || 'Could not apply that', 'error');
  }
}

function bulkDiscontinueCycles() {
  const list = _filteredCycles().filter(c => S.cycleSel.has(c.id) && c.status !== 'sold' && c.status !== 'discontinued');
  if (!list.length) return;
  const head = list.reduce((n, c) => n + (parseInt(c.no_live) || 0), 0);
  if (!confirm(
    `Discontinue ${list.length} batch${list.length === 1 ? '' : 'es'}?\n\n` +
    `Each is frozen where it stands — it keeps its recorded numbers and stops being valued, ` +
    `so it no longer counts toward herd value or returns.\n` +
    (head ? `${fmt.num(head)} live animal${head === 1 ? '' : 's'} will be marked sold.\n` : '') +
    `\nThis can be reversed with Reopen.`
  )) return;
  _bulkStatus('discontinued', list.map(c => ({ id: c.id })), 'discontinued');
}

function bulkReopenCycles() {
  const list = _filteredCycles().filter(c => S.cycleSel.has(c.id) && c.status === 'discontinued');
  if (!list.length) return;
  if (!confirm(
    `Reopen ${list.length} batch${list.length === 1 ? '' : 'es'}?\n\n` +
    `They go back to active and start being valued again. Animals that this ` +
    `console marked sold when the batch was discontinued go back to live; ` +
    `animals sold any other way stay sold.`
  )) return;
  _bulkStatus('reopen', list.map(c => ({ id: c.id })), 'reopened');
}

/* ── Mark sold ─────────────────────────────────────────────────────────────
   A sale value per batch, and the dialog will not submit without one for each.

   Not a convenience: a sold cycle reports total_selling_price as its realised
   value and (sale − purchase) ÷ purchase as its realised return, so a batch
   marked sold at nothing books its whole purchase value as a loss. Across the
   138 cycles and R110m on this book, defaulting the field would have put a
   nine-figure hole in the fund's reported return, produced by two clicks and
   no typing.

   Pre-filled, in order of what is actually known: the sum of the animals'
   own sale values if they have been captured one by one, then the cycle's
   expected sale value. The source is named on the row so the operator knows
   whether they are confirming a fact or an estimate. */
function openBulkSoldModal() {
  const list = _filteredCycles().filter(c => S.cycleSel.has(c.id) && c.status !== 'sold' && c.status !== 'discontinued');
  if (!list.length) return;

  const rows = list.map(c => {
    const fromAnimals = parseFloat((S.herd.cycles[c.id] || {}).sale_sum) || 0;
    const expected    = parseFloat(c.expected_sale_value) || 0;
    const value  = fromAnimals > 0 ? fromAnimals : (expected > 0 ? expected : '');
    const source = fromAnimals > 0 ? 'from animals sold' : (expected > 0 ? 'expected sale value' : 'no figure on file');
    return { c, value, source };
  });

  const body = `
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">
      A batch marked sold reports this as its realised value, and its return as
      <strong>(sale &minus; purchase) &divide; purchase</strong> &mdash; gross of the standing fee.
      Every batch needs a figure.
    </p>
    <div class="bulk-sold-list">
      ${rows.map(({ c, value, source }) => `
        <div class="bulk-sold-row" data-cycle="${escapeHtml(c.id)}">
          <div>
            <div class="bsr-name">${escapeHtml(c.batch_name || c.id)}</div>
            <div class="bsr-sub">Cost ${fmt.zar(c.purchase_value)} · ${escapeHtml(source)}</div>
          </div>
          <div class="bsr-input">
            <span>R</span>
            <input type="number" step="0.01" min="0" value="${value}"
                   data-purchase="${parseFloat(c.purchase_value) || 0}"
                   oninput="_bulkSoldPreview(this)" placeholder="Sale value">
          </div>
          <div class="bsr-ret" data-ret>&mdash;</div>
        </div>`).join('')}
    </div>`;

  _openModal('Mark ' + list.length + ' batch' + (list.length === 1 ? '' : 'es') + ' sold', body,
    `<button class="btn btn-secondary" onclick="_closeModal()">Cancel</button>
     <button class="btn btn-primary" onclick="confirmBulkSold(this)">Mark sold</button>`);

  document.querySelectorAll('.bulk-sold-row input').forEach(_bulkSoldPreview);
}

/* The realised return, as it will be recorded, updated as the figure is typed.
   The number that goes into the book should not be a surprise. */
function _bulkSoldPreview(input) {
  const row = input.closest('.bulk-sold-row');
  const out = row && row.querySelector('[data-ret]');
  if (!out) return;
  const purchase = parseFloat(input.dataset.purchase) || 0;
  const sale     = parseFloat(input.value);
  if (!isFinite(sale) || input.value === '' || purchase <= 0) {
    out.textContent = purchase > 0 ? '—' : 'no cost on file';
    out.style.color = 'var(--text-muted)';
    return;
  }
  const pct = ((sale - purchase) / purchase) * 100;
  out.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  out.style.color = pct >= 0 ? 'var(--green-mid)' : 'var(--red)';
}

async function confirmBulkSold(btn) {
  const rows = [...document.querySelectorAll('.bulk-sold-row')];
  const cycles = [], missing = [];
  for (const r of rows) {
    const input = r.querySelector('input');
    const v = parseFloat(input.value);
    if (input.value === '' || !isFinite(v) || v < 0) {
      missing.push(r);
      input.style.borderColor = 'var(--red)';
    } else {
      input.style.borderColor = '';
      cycles.push({ id: r.dataset.cycle, total_selling_price: v });
    }
  }
  if (missing.length) {
    CToast.show(`${missing.length} batch${missing.length === 1 ? ' needs' : 'es need'} a sale value`, 'error');
    missing[0].querySelector('input').focus();
    return;
  }
  btn.disabled = true;
  _closeModal();
  await _bulkStatus('sold', cycles, 'marked sold');
}

function renderCycleCard(cycle) {
  const nav = NAV.cycleNAV(cycle, S.herd.cycles[cycle.id], S.costs);
  /* Frozen: no live valuation, and no day counter running against a batch
     nobody is feeding. The runaway day count is what this status exists for —
     a stale import at 1 355 days was accruing 1 626kg of modelled gain a head. */
  const frozen = cycle.status === 'discontinued';
  const statusMap = { active: 'badge-blue', sold: 'badge-green', draft: 'badge-grey', cancelled: 'badge-red', discontinued: 'badge-grey' };
  const mortalityPct = cycle.no_purchased > 0 ? ((parseInt(cycle.mortalities)||0) / parseInt(cycle.no_purchased) * 100).toFixed(1) : 0;

  return `
    <div class="cycle-card${S.cycleSel.has(cycle.id) ? ' cycle-card--selected' : ''}" onclick="openCycleDetail('${escapeHtml(cycle.id)}')">
      <div class="cycle-card-header">
        <label class="cycle-pick" onclick="event.stopPropagation()" title="Select this batch">
          <input type="checkbox" data-cycle="${escapeHtml(cycle.id)}" ${S.cycleSel.has(cycle.id) ? 'checked' : ''}
                 onchange="toggleCycleSelected('${escapeHtml(cycle.id)}', this.checked)">
        </label>
        <div>
          <div class="cycle-card-title">${escapeHtml(cycle.batch_name || cycle.id)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${escapeHtml(cycle.company||'')} &nbsp;·&nbsp; ${escapeHtml(cycle.cycle_no||'')} &nbsp;·&nbsp; INV ${escapeHtml(cycle.inv_no||'—')}</div>
        </div>
        <span class="badge ${statusMap[cycle.status]||'badge-grey'}">${(cycle.status||'—').toUpperCase()}</span>
        <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation();openEditCycleModal('${escapeHtml(cycle.id)}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-xs" style="background:#fff3cd;color:#856404" onclick="event.stopPropagation();deleteCycle('${escapeHtml(cycle.id)}')"><i class="fa-solid fa-trash"></i></button>
      </div>
      ${renderAnimalBar(cycle)}
      <div class="cycle-card-metrics">
        <div><div class="cycle-metric-label">Purchased</div><div class="cycle-metric-value">${fmt.num(cycle.no_purchased)}</div></div>
        <div><div class="cycle-metric-label">Live / Mortalities</div><div class="cycle-metric-value">${fmt.num(cycle.no_live)} <span style="color:var(--red);font-size:12px">/ ${cycle.mortalities||0} (${mortalityPct}%)</span></div></div>
        <div><div class="cycle-metric-label">Purchase Value</div><div class="cycle-metric-value">${fmt.zar(cycle.purchase_value)}</div></div>
        <div><div class="cycle-metric-label">${cycle.status === 'sold' ? 'Sale Value' : frozen ? 'Herd Value' : 'Est. Herd Value'}</div><div class="cycle-metric-value" style="color:${frozen?'var(--text-muted)':'var(--green-mid)'}">${cycle.status==='sold' ? fmt.zar(cycle.total_selling_price) : frozen ? '&mdash;' : fmt.zar(nav.herdValue)}</div></div>
        <div><div class="cycle-metric-label">${cycle.status === 'sold' ? 'Realised Return' : frozen ? 'Status' : 'Unrealised NAV'}</div><div class="cycle-metric-value" style="color:${frozen?'var(--text-muted)':(nav.navPct>=0?'var(--green-mid)':'var(--red)')};font-weight:800">${cycle.status==='sold' ? fmt.pct(cycle.net_return_pct) : frozen ? 'Frozen' : (nav.navPct>=0?'+':'')+nav.navPct.toFixed(2)+'%'}</div></div>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">${cycle.cycle_start_date ? `Start: ${fmt.date(cycle.cycle_start_date)}` : ''}${cycle.sale_date ? ` &nbsp;·&nbsp; Sold: ${fmt.date(cycle.sale_date)}` : cycle.end_date ? ` &nbsp;·&nbsp; Expected end: ${fmt.date(cycle.end_date)}` : ''}${cycle.status === 'active' ? ` &nbsp;·&nbsp; <strong>${nav.daysIn} days in cycle</strong>` : frozen ? ` &nbsp;·&nbsp; <strong>Frozen &mdash; not valued</strong>` : ''}</div>
    </div>`;
}

function renderAnimalBar(cycle) {
  const purchased = parseInt(cycle.no_purchased) || 0;
  if (!purchased) return '';
  const sold      = parseInt(cycle.no_sold)    || 0;
  const mortality = parseInt(cycle.mortalities) || 0;
  const active    = Math.max(0, purchased - sold - mortality);
  const soldPct      = (sold / purchased * 100).toFixed(1);
  const mortalityPct = (mortality / purchased * 100).toFixed(1);
  const activePct    = (active / purchased * 100).toFixed(1);
  return `
    <div class="animal-count-bar" title="${sold} sold, ${active} active, ${mortality} mortalities" style="margin-bottom:12px">
      <div class="seg-sold"     style="width:${soldPct}%"      title="${sold} sold"></div>
      <div class="seg-active"   style="width:${activePct}%"    title="${active} active"></div>
      <div class="seg-mortality"style="width:${mortalityPct}%" title="${mortality} mortalities"></div>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:12px;font-size:11px">
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--green-mid);margin-right:4px"></span>Sold ${sold}</span>
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--blue);margin-right:4px"></span>Active ${active}</span>
      <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--red);margin-right:4px"></span>Mortalities ${mortality}</span>
      ${cycle.unsold_cattle > 0 ? `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--amber);margin-right:4px"></span>Unsold ${cycle.unsold_cattle}</span>` : ''}
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   VIEW: INDIVIDUAL ANIMALS
══════════════════════════════════════════════════════════════ */
async function loadAnimals() {
  const el = document.getElementById('view-animals');
  if (!el) return;
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading animals…</span></div>`;
  try {
    /* Cycles too: the per-animal valuation needs each animal's cycle start
       date, and the Edit Animal cycle picker was showing a permanent
       "Loading cycles…" for anyone who opened this tab first. */
    if (!S.cycles.length) S.cycles = await fetchAll('cattle_cycles');
    await Promise.all([_fetchAnimalStats(), _fetchAnimalPage()]);
    renderAnimalsView();
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Error loading animals</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function _fetchAnimalStats() {
  const q = new URLSearchParams();
  if (S.animalFilter.search) q.set('search', S.animalFilter.search);
  if (S.animalFilter.status) q.set('status', S.animalFilter.status);
  if (S.animalFilter.batch)  q.set('batch_no', S.animalFilter.batch);
  if (S.animalFilter.breed)  q.set('breed', S.animalFilter.breed);
  const data = await apiGet(`cattle/animals/stats?${q}`);
  S.animalStats   = data;
  if (data.batches) S.animalBatches = data.batches;
  if (data.breeds)  S.animalBreeds  = data.breeds;
}

async function _fetchAnimalPage() {
  const q = new URLSearchParams({ page: S.animalPage, limit: S.animalPageSize, sort: 'tag_number', order: 'ASC' });
  if (S.animalFilter.search) q.set('search', S.animalFilter.search);
  if (S.animalFilter.status) q.set('status', S.animalFilter.status);
  if (S.animalFilter.batch)  q.set('batch_no', S.animalFilter.batch);
  if (S.animalFilter.breed)  q.set('breed', S.animalFilter.breed);
  const res   = await apiGet(`tables/cattle_animals?${q}`);
  S.animals     = res.data  || [];
  S.animalTotal = res.total || 0;
  S.animalPages = res.pages || 0;
}

let _animalSearchTimer = null;
function _animalFilterChange(key, val) {
  S.animalFilter[key] = val;
  S.animalPage = 1;
  if (key === 'search') {
    clearTimeout(_animalSearchTimer);
    _animalSearchTimer = setTimeout(_reloadAnimalPage, 350);
  } else {
    _reloadAnimalPage();
  }
}

async function _reloadAnimalPage() {
  const tbody = document.querySelector('#view-animals tbody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="display:inline-block;margin-right:8px"></div>Loading…</td></tr>`;
  try {
    await Promise.all([_fetchAnimalStats(), _fetchAnimalPage()]);
    renderAnimalsView();
  } catch (err) {
    CToast.show('Failed to load animals: ' + err.message, 'error');
  }
}

function renderAnimalsView() {
  const el = document.getElementById('view-animals');
  if (!el) return;
  const st   = S.animalStats;
  const mort = st.mortalities || 0;
  const tot  = st.total || 0;

  el.innerHTML = `
    <div class="stat-row">
      <div class="stat-item"><div class="stat-item-label">Total Animals</div><div class="stat-item-value">${fmt.num(tot)}</div></div>
      <div class="stat-item"><div class="stat-item-label">Avg Entry Mass</div><div class="stat-item-value">${st.avg_mass ? parseFloat(st.avg_mass).toFixed(0) + ' kg' : '—'}</div></div>
      <div class="stat-item" title="Averaged over the animals with both an entry and an exit weight — not the whole herd">
        <div class="stat-item-label">Avg Weight Gain</div>
        <div class="stat-item-value green">${st.avg_gain != null ? '+' + parseFloat(st.avg_gain).toFixed(0) + ' kg' : '—'}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${st.weighed ? `${fmt.num(st.weighed)} of ${fmt.num(tot)} weighed out` : 'none weighed out yet'}</div>
      </div>
      <div class="stat-item"><div class="stat-item-label">Sold</div><div class="stat-item-value green">${fmt.num(st.sold || 0)}</div></div>
      <div class="stat-item"><div class="stat-item-label">Mortalities</div><div class="stat-item-value red">${fmt.num(mort)}</div></div>
      <div class="stat-item"><div class="stat-item-label">Mortality Rate</div><div class="stat-item-value">${tot > 0 ? (mort/tot*100).toFixed(2) : 0}%</div></div>
    </div>

    <div class="filter-bar">
      <div class="search-box"><i class="fa-solid fa-search"></i><input type="text" placeholder="Search tag or batch…" value="${escapeHtml(S.animalFilter.search)}" oninput="_animalFilterChange('search',this.value)"></div>
      <select class="filter-select" onchange="_animalFilterChange('batch',this.value)"><option value="">All Batches</option>${S.animalBatches.map(b=>`<option value="${escapeHtml(b)}" ${S.animalFilter.batch===b?'selected':''}>${escapeHtml(b)}</option>`).join('')}</select>
      <select class="filter-select" onchange="_animalFilterChange('status',this.value)"><option value="">All Statuses</option><option value="active" ${S.animalFilter.status==='active'?'selected':''}>Active</option><option value="sold" ${S.animalFilter.status==='sold'?'selected':''}>Sold</option><option value="mortality" ${S.animalFilter.status==='mortality'?'selected':''}>Mortality</option></select>
      <select class="filter-select" onchange="_animalFilterChange('breed',this.value)"><option value="">All Breeds</option>${S.animalBreeds.map(b=>`<option value="${escapeHtml(b)}" ${S.animalFilter.breed===b?'selected':''}>${escapeHtml(b)}</option>`).join('')}</select>
      <button class="btn btn-primary btn-sm" onclick="openAddAnimalModal()"><i class="fa-solid fa-plus"></i> Add Animal</button>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Tag Number</th><th>Batch</th><th>Batch Name</th><th>Breed</th><th>Gender</th><th class="num">Entry Mass</th><th class="num">Exit Mass</th><th>Status</th><th>Sale Batch</th><th>Sale Date</th><th class="num">NAV Value</th><th>Actions</th></tr></thead>
          <tbody>${S.animals.map(a => {
            const status = isTrue(a.mortality) ? 'mortality' : isTrue(a.sold) ? 'sold' : (a.status || 'active');
            const statusBadge = { sold:'badge-green', mortality:'badge-red', active:'badge-blue' };
            /* Days from the animal's OWN cycle. This was hardcoded to 30, so
               every animal in the fund was valued as if it were one month into
               the feedlot — an animal on day 4 and an animal on day 180 carried
               the same estimated mass and the same rand value. */
            const aCycle = a.cycle_id ? S.cycles.find(c => c.id === a.cycle_id) : null;
            const nav = status === 'active' ? NAV.animalNAV(a, NAV.daysIn(aCycle)) : null;
            return `<tr>
              <td class="mono">${escapeHtml(a.tag_number||'—')}</td>
              <td>${escapeHtml(a.batch_no||'—')}</td>
              <td style="font-size:12px">${escapeHtml(a.batch_name||'—')}</td>
              <td><span class="breed-pill">${escapeHtml(a.breed||'—')}</span></td>
              <td>${escapeHtml(a.gender||'—')}</td>
              <td class="num">${a.entry_mass ? a.entry_mass + ' kg' : '—'}</td>
              <td class="num">${a.exit_mass  ? a.exit_mass  + ' kg' : '—'}</td>
              <td><span class="badge ${statusBadge[status]||'badge-grey'}">${status}</span></td>
              <td>${escapeHtml(a.sale_batch||'—')}</td>
              <td>${fmt.date(a.sale_date)}</td>
              <td class="num" style="color:${status==='active'?'var(--green-mid)':'var(--text-muted)'}">${status==='active' ? fmt.zar(nav.grossValue) : status==='sold' ? '<span style="color:var(--green-mid)">Sold</span>' : '<span style="color:var(--red)">—</span>'}</td>
              <td style="white-space:nowrap"><button class="btn btn-secondary btn-xs" onclick="openEditAnimalModal('${escapeHtml(a.id)}')" title="Edit"><i class="fa-solid fa-pen"></i></button><button class="btn btn-xs" style="background:#fff3cd;color:#856404;margin-left:4px" onclick="deleteAnimal('${escapeHtml(a.id)}')" title="Delete"><i class="fa-solid fa-trash"></i></button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      ${renderPagination(S.animalPage, S.animalPages, 'animalPage', '_reloadAnimalPage')}
    </div>
  `;
}

function renderPagination(current, total, pageVar, renderFn) {
  if (total <= 1) return '';
  const pages = [];
  for (let i = Math.max(1, current-2); i <= Math.min(total, current+2); i++) pages.push(i);
  return `<div class="pagination">
    <button class="page-btn" onclick="S.${pageVar}=1;${renderFn}()" ${current<=1?'disabled':''}>«</button>
    <button class="page-btn" onclick="S.${pageVar}=${current-1};${renderFn}()" ${current<=1?'disabled':''}>‹</button>
    ${pages.map(p => `<button class="page-btn ${p===current?'active':''}" onclick="S.${pageVar}=${p};${renderFn}()">${p}</button>`).join('')}
    <button class="page-btn" onclick="S.${pageVar}=${current+1};${renderFn}()" ${current>=total?'disabled':''}>›</button>
    <button class="page-btn" onclick="S.${pageVar}=${total};${renderFn}()" ${current>=total?'disabled':''}>»</button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════
   IMPORT DATA (fixed: no client-side ID, proper parsing)
══════════════════════════════════════════════════════════════ */
function setupImportView() {
  const el = document.getElementById('view-import');
  if (!el) return;
  el.innerHTML = `
    <div style="max-width:780px">
      <div class="section-header"><h2>Import Cattle Data from CSV</h2></div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:24px">Upload your Airtable CSV exports. The system will parse, validate and import records into the database. Existing records with the same identifiers will be skipped.</p>
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><i class="fa-solid fa-layer-group" style="color:var(--green-mid)"></i> Backgrounded Cattle — Cycle Data <span style="font-size:11px;color:var(--text-muted);margin-left:auto">cattle_cycles table</span></div>
        <div class="card-body">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:14px">Expected columns: <strong>Name, INV No, Invoice Date, Cycle Start Date, End date, Cycle No, Company, No of Purchased cattle, Mortalities, Live # of cattle, Average Cattle Cost, Purchase Value, Expected Sale value, Sale Date, No of cattle sold, Total Selling Price, Selling price per head, Status, Return, Unsold Cattle…</strong></p>
          <div class="import-zone" id="dropZoneCycles" onclick="document.getElementById('fileCycles').click()"><i class="fa-solid fa-file-csv"></i><h3>Drop CSV here or click to browse</h3><p>Backgrounded Cattle-Grid view.csv</p><input type="file" id="fileCycles" accept=".csv,text/csv,text/plain" onchange="handleCyclesFile(this.files[0])"></div>
          <div id="cyclesImportPreview"></div>
          <div id="cyclesImportProgress" style="display:none"><div class="progress-bar-wrap"><div class="progress-bar-fill" id="cyclesProgressBar" style="width:0%"></div></div><div style="font-size:12px;color:var(--text-muted)" id="cyclesProgressLabel">Importing…</div></div>
          <div id="cyclesImportActions" style="display:none;margin-top:12px"><button class="btn btn-primary" onclick="importCycles()"><i class="fa-solid fa-database"></i> Import Cycles</button><button class="btn btn-secondary" onclick="clearCyclesPreview()">Cancel</button></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><i class="fa-solid fa-cow" style="color:var(--amber-dark)"></i> Purchased Cattle — Individual Animals <span style="font-size:11px;color:var(--text-muted);margin-left:auto">cattle_animals table</span></div>
        <div class="card-body">
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:14px">Expected columns: <strong>Batch No, Main tag number, Entry Mass, Gender, Breed, Name, Mortality, Date, Mortality Report, Sold, Sale Batch, Sale date, Notes</strong></p>
          <div class="import-zone" id="dropZoneAnimals" onclick="document.getElementById('fileAnimals').click()"><i class="fa-solid fa-file-csv"></i><h3>Drop CSV here or click to browse</h3><p>Purchased Cattle-Grid view.csv</p><input type="file" id="fileAnimals" accept=".csv,text/csv,text/plain" onchange="handleAnimalsFile(this.files[0])"></div>
          <div id="animalsImportPreview"></div>
          <div id="animalsImportProgress" style="display:none"><div class="progress-bar-wrap"><div class="progress-bar-fill" id="animalsProgressBar" style="width:0%"></div></div><div style="font-size:12px;color:var(--text-muted)" id="animalsProgressLabel">Importing…</div></div>
          <div id="animalsImportActions" style="display:none;margin-top:12px"><button class="btn btn-primary" onclick="importAnimals()"><i class="fa-solid fa-database"></i> Import Animals</button><button class="btn btn-secondary" onclick="clearAnimalsPreview()">Cancel</button></div>
        </div>
      </div>
      <div class="card" style="margin-top:20px;border:1px solid rgba(255,82,41,0.35)">
        <div class="card-header" style="background:rgba(255,82,41,0.06);color:#cc3e1e"><i class="fa-solid fa-triangle-exclamation"></i> Danger Zone</div>
        <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div>
            <div style="font-weight:600;font-size:14px;color:#cc3e1e;margin-bottom:3px">Remove all cattle data</div>
            <div style="font-size:12px;color:var(--text-muted)">Permanently deletes all cycles and animals from the database. This cannot be undone.</div>
          </div>
          <button class="btn" onclick="purgeAllCattleData()" style="white-space:nowrap;background:rgba(255,82,41,0.1);color:#cc3e1e;border:1px solid rgba(255,82,41,0.4);flex-shrink:0"><i class="fa-solid fa-trash"></i> Clear All Data</button>
        </div>
      </div>
    </div>`;
  setupDropZone('dropZoneCycles', 'fileCycles', handleCyclesFile);
  setupDropZone('dropZoneAnimals', 'fileAnimals', handleAnimalsFile);
}

/* The most destructive button in Fund Ops, on the same screen as CSV import.
 *
 * It used to be a browser confirm() reading "Type OK to confirm" — over a
 * dialog with nothing to type into, where OK is the default button. A stray
 * Enter emptied the cattle books, and nothing in the app could put them back.
 * It now asks for the phrase and sends it, and the server refuses without it.
 *
 * It also called loadCattleView(), which does not exist in this file and never
 * has: the purge succeeded and the page then threw a ReferenceError instead of
 * refreshing, leaving the console showing a herd that was no longer there. */
const PURGE_PHRASE = 'DELETE ALL CATTLE DATA';

async function purgeAllCattleData() {
  const n = S.herd.totals.total, c = S.cycles.length;
  const typed = prompt(
    `This permanently deletes ALL cattle cycles and animals.\n` +
    (n || c ? `Currently on file: ${c} cycle${c === 1 ? '' : 's'}, ${n} animal${n === 1 ? '' : 's'}.\n` : '') +
    `It cannot be undone from inside the console.\n\n` +
    `Type ${PURGE_PHRASE} to confirm.`);
  if (typed === null) return;
  if (typed.trim() !== PURGE_PHRASE) {
    CToast.show('Not deleted — the confirmation phrase did not match.', 'info');
    return;
  }
  try {
    const r = await apiFetch('cattle/purge', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: PURGE_PHRASE }),
    });
    const data = await r.json();
    CToast.show(`Deleted ${data.deleted.animals} animal(s) and ${data.deleted.cycles} cycle(s).`, 'success');
    S.cycles = []; S.animals = []; S.costs = [];
    S.herd = { cycles: {}, totals: { total: 0, sold: 0, mortalities: 0 }, breeds: [] };
    _herdLoaded = false;
    await loadNAVDashboard();
    navigate('nav', document.querySelector('[data-view=nav]'));
  } catch (err) {
    CToast.show('Purge failed: ' + err.message, 'error');
  }
}

function setupDropZone(zoneId, inputId, handler) {
  const zone = document.getElementById(zoneId);
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
}

function parseCSV(text) {
  // Strip UTF-8 BOM if present (Airtable exports include it)
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseCSVLine(lines[i]);
    if (cells.length < 2) continue;
    const row = {};
    headers.forEach((h, j) => { row[h.trim()] = (cells[j]||'').trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function cleanZAR(val) {
  if (!val) return null;
  // Remove R, spaces, then strip thousands-separator commas before parsing
  let cleaned = val.toString().replace(/[R\s]/g, '').replace(/,(?=\d{3})/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function cleanDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/* ── Gender helper ───────────────────────────────────────── */
function parseGender(raw) {
  const v = String(raw || '').trim();
  if (v === '1' || v.toLowerCase() === 'male')   return 'Male';
  if (v === '3' || v.toLowerCase() === 'female') return 'Female';
  return v || null;
}

/* ── Batch sender: send records to endpoint in chunks ────── */
async function sendInChunks(endpoint, records, bar, lbl, chunkSize = 200) {
  let totalInserted = 0, totalSkipped = 0, totalFailed = 0;
  const failures = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const result = await apiPost(endpoint, { records: chunk });
    totalInserted += result.inserted || 0;
    totalSkipped  += result.skipped  || 0;
    totalFailed   += result.failed   || 0;
    if (result.failures) failures.push(...result.failures);
    const pct = Math.min(100, Math.round((i + chunk.length) / records.length * 100));
    bar.style.width = pct + '%';
    lbl.textContent = `Importing… ${Math.min(i + chunkSize, records.length)} / ${records.length} — ${totalInserted} saved, ${totalSkipped} skipped${totalFailed ? `, ${totalFailed} failed` : ''}`;
    await new Promise(r => setTimeout(r, 0));
  }
  return { inserted: totalInserted, skipped: totalSkipped, failed: totalFailed, failures };
}

/* What the import actually did, in the operator's words rather than a count.
 *
 * The old label said "N imported, M already existed" from a server that
 * counted attempts — a row the database refused was reported as imported, and
 * the operator's next act was to close a spreadsheet they believed had landed.
 * Rows that failed are now named, because a rejected row is data that needs
 * fixing and re-importing, not a number to note. */
function _importSummary(what, r) {
  const parts = [`${r.inserted} ${what} imported`];
  if (r.skipped) parts.push(`${r.skipped} already existed`);
  if (r.failed)  parts.push(`${r.failed} could not be saved`);
  let html = `${r.failed ? '⚠️' : '✅'} Done — ${parts.join(', ')}`;
  if (r.failed && r.failures.length) {
    const shown = r.failures.slice(0, 5);
    html += `<div style="margin-top:8px;padding:10px;border-radius:8px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);font-size:11px;line-height:1.6">
      <strong style="color:#f87171">Not saved — fix these rows and re-import:</strong><br>
      ${shown.map(f => `<span style="color:rgba(255,255,255,.75)">${escapeHtml(f.row || '(unnamed row)')}</span> <span style="color:rgba(255,255,255,.4)">— ${escapeHtml(f.error)}</span>`).join('<br>')}
      ${r.failures.length > shown.length ? `<br><span style="color:rgba(255,255,255,.4)">…and ${r.failures.length - shown.length} more</span>` : ''}
    </div>`;
  }
  return html;
}

let _cyclesData = [];
function handleCyclesFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    _cyclesData = rows;
    const statusCounts = {};
    rows.forEach(r => { const s = (r['Status']||'unknown').toLowerCase(); statusCounts[s]=(statusCounts[s]||0)+1; });
    const sold    = statusCounts['sold']   || 0;
    const active  = statusCounts['active'] || statusCounts['open'] || (rows.length - sold);
    document.getElementById('cyclesImportPreview').innerHTML = `
      <div class="import-preview">
        <h4><i class="fa-solid fa-check-circle" style="color:var(--green-mid)"></i> File ready: ${escapeHtml(file.name)}</h4>
        <div class="import-stats">
          <div class="import-stat">Batches found: <strong>${rows.length}</strong></div>
          <div class="import-stat">Sold: <strong>${sold}</strong></div>
          <div class="import-stat">Active: <strong>${active}</strong></div>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:10px">Preview (first 3):</p>
        <table class="data-table" style="font-size:11px;margin-top:6px">
          <thead><tr><th>Batch Name</th><th>INV No</th><th>Company</th><th>Purchased</th><th>Live</th><th>Purchase Value</th><th>Status</th></tr></thead>
          <tbody>${rows.slice(0,3).map(r=>`<tr>
            <td>${escapeHtml(r['Name']||'—')}</td>
            <td>${escapeHtml(r['INV No (IN0)']||r['INV No']||'—')}</td>
            <td>${escapeHtml(r['Company']||'—')}</td>
            <td>${escapeHtml(r['No of Purchased cattle']||'—')}</td>
            <td>${escapeHtml(r['Live # of cattle']||'—')}</td>
            <td>${escapeHtml(r['Purchase Value']||'—')}</td>
            <td>${escapeHtml(r['Status']||'—')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
    document.getElementById('cyclesImportActions').style.display = 'flex';
    document.getElementById('cyclesImportActions').style.gap = '10px';
  };
  reader.readAsText(file);
}

async function importCycles() {
  if (!_cyclesData.length) return;
  const prog = document.getElementById('cyclesImportProgress');
  const bar  = document.getElementById('cyclesProgressBar');
  const lbl  = document.getElementById('cyclesProgressLabel');
  prog.style.display = 'block';
  document.getElementById('cyclesImportActions').style.display = 'none';

  const records = _cyclesData.map(r => ({
    batch_name:             r['Name'] || '',
    inv_no:                 r['INV No (IN0)'] || r['INV No'] || '',
    invoice_date:           cleanDate(r['Invoice Date_'] || r['Invoice Date']),
    cycle_start_date:       cleanDate(r['Cycle Start Date'] || r['Invoice Date_'] || r['Invoice Date']),
    end_date:               cleanDate(r['End date']),
    sale_date:              cleanDate(r['Sale Date']),
    cycle_no:               r['Cycle No'] || '',
    days_in_cycle:          parseInt(r['Final No of days for cycle']) || parseInt(r['# of days left']) || null,
    company:                r['Company'] || '',
    no_purchased:           parseInt(r['No of Purchased cattle']) || 0,
    mortalities:            parseInt(r['Mortalities']) || 0,
    no_live:                parseInt(r['Live # of cattle']) || 0,
    no_sold:                parseInt(r['No of cattle sold']) || 0,
    unsold_cattle:          parseInt(r['Unsold Cattle']) || 0,
    avg_cattle_cost:        cleanZAR(r['Average Cattle Cost']),
    purchase_value:         cleanZAR(r['Purchase Value']),
    expected_sale_value:    cleanZAR(r['Expected Sale value']),
    total_selling_price:    cleanZAR(r['Total Selling Price']),
    selling_price_per_head: cleanZAR(r['Selling price per head of cattle']),
    svc_standing_fee:       cleanZAR(r['SVC Standing Fee']),
    net_return_pct:         parseFloat((r['Return']||'').replace(/[%,\s]/g,'')) || null,
    outstanding_invoice:    cleanZAR(r['Outstanding Invoice PMT']),
    invoice_paid:           r['Invoice paid'] || 'Pending',
    status:                 (r['Status']||'').toLowerCase() === 'sold' ? 'sold' : 'active',
    notes:                  (r['Additional Notes']||r['Notes']||'').substring(0,500),
  }));

  try {
    const r = await sendInChunks('cattle/import/cycles', records, bar, lbl);
    bar.style.width = '100%';
    lbl.innerHTML = _importSummary('cycles', r);
    CToast.show(r.failed ? `${r.inserted} imported, ${r.failed} could not be saved` : `${r.inserted} cattle cycles imported`,
                r.failed ? 'error' : 'success');
  } catch(err) {
    lbl.textContent = `❌ Import failed: ${err.message}`;
    CToast.show('Import failed — check console', 'error');
  }

  _cyclesData = [];
  _herdLoaded = false;
  await loadCycles();
}

function clearCyclesPreview() {
  _cyclesData = [];
  document.getElementById('cyclesImportPreview').innerHTML = '';
  document.getElementById('cyclesImportActions').style.display = 'none';
  document.getElementById('cyclesImportProgress').style.display = 'none';
  document.getElementById('fileCycles').value = '';
}

let _animalsData = [];
function handleAnimalsFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = parseCSV(e.target.result);
    _animalsData = rows;
    const breedCounts = {};
    rows.forEach(r => { const b = (r['Breed']||'Unknown'); breedCounts[b]=(breedCounts[b]||0)+1; });
    const topBreeds   = Object.entries(breedCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const mortalities = rows.filter(r => r['Mortality'] && r['Mortality'].trim()).length;
    const sold        = rows.filter(r => (r['Sold']||'').toLowerCase()==='checked').length;
    const males       = rows.filter(r => String(r['Gender']).trim() === '1').length;
    const females     = rows.filter(r => String(r['Gender']).trim() === '3').length;
    const batches     = new Set(rows.map(r => r['Name']).filter(Boolean)).size;
    document.getElementById('animalsImportPreview').innerHTML = `
      <div class="import-preview">
        <h4><i class="fa-solid fa-check-circle" style="color:var(--green-mid)"></i> File ready: ${escapeHtml(file.name)}</h4>
        <div class="import-stats">
          <div class="import-stat">Animals: <strong>${rows.length.toLocaleString()}</strong></div>
          <div class="import-stat">Batches: <strong>${batches}</strong></div>
          <div class="import-stat">Male: <strong>${males.toLocaleString()}</strong></div>
          <div class="import-stat">Female: <strong>${females.toLocaleString()}</strong></div>
          <div class="import-stat">Sold: <strong>${sold.toLocaleString()}</strong></div>
          <div class="import-stat">Mortalities: <strong>${mortalities}</strong></div>
          ${topBreeds.map(([b,c])=>`<div class="import-stat">${escapeHtml(b)}: <strong>${c}</strong></div>`).join('')}
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:10px">Preview (first 3 rows):</p>
        <table class="data-table" style="font-size:11px;margin-top:6px">
          <thead><tr><th>Tag #</th><th>Batch Name</th><th>Breed</th><th>Gender</th><th>Mass (kg)</th><th>Dim Tag</th><th>Sold</th><th>Status</th></tr></thead>
          <tbody>${rows.slice(0,3).map(r => {
            const isMort = r['Mortality'] && r['Mortality'].trim();
            const isSold = (r['Sold']||'').toLowerCase() === 'checked';
            const status = isMort ? 'mortality' : isSold ? 'sold' : 'active';
            return `<tr>
              <td>${escapeHtml(r['Main tag number']||'—')}</td>
              <td>${escapeHtml(r['Name']||'—')}</td>
              <td>${escapeHtml(r['Breed']||'—')}</td>
              <td>${escapeHtml(parseGender(r['Gender']))}</td>
              <td>${escapeHtml(r['Entry Mass']||'—')}</td>
              <td style="font-size:10px">${escapeHtml(r['Dim Tag']||'—')}</td>
              <td>${isSold ? '✅' : '—'}</td>
              <td>${status}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
    document.getElementById('animalsImportActions').style.display = 'flex';
    document.getElementById('animalsImportActions').style.gap = '10px';
  };
  reader.readAsText(file);
}

async function importAnimals() {
  if (!_animalsData.length) return;
  const prog = document.getElementById('animalsImportProgress');
  const bar  = document.getElementById('animalsProgressBar');
  const lbl  = document.getElementById('animalsProgressLabel');
  prog.style.display = 'block';
  document.getElementById('animalsImportActions').style.display = 'none';

  const records = _animalsData.map(r => {
    const isMortality = !!(r['Mortality'] && r['Mortality'].trim());
    const isSold      = (r['Sold']||'').toLowerCase() === 'checked';
    return {
      tag_number:       r['Main tag number'] || '',
      batch_no:         r['Batch No']        || '',
      batch_name:       r['Name']            || '',
      entry_mass:       parseFloat(r['Entry Mass']) || null,
      /* Exit mass had nowhere to land until now, so the export column was
         dropped on the floor along with the only measure of what the animals
         actually gained. */
      exit_mass:        parseFloat(r['Exit Mass'] || r['Exit mass'] || r['Sale Mass']) || null,
      gender:           parseGender(r['Gender']),
      breed:            r['Breed']           || '',
      dim_tag:          r['Dim Tag']         || '',
      extra_colour_tag: r['Extra Colour Tag']|| '',
      mortality:        isMortality,
      mortality_date:   cleanDate(r['Date']),
      mortality_report: r['Mortality Report']|| '',
      sold:             isSold,
      sale_batch:       r['Sale Batch']      || '',
      sale_date:        cleanDate(r['Sale date']),
      notes:            '',
    };
  });

  try {
    const r = await sendInChunks('cattle/import/animals', records, bar, lbl);
    bar.style.width = '100%';
    lbl.innerHTML = _importSummary('animals', r);
    CToast.show(r.failed ? `${r.inserted} imported, ${r.failed} could not be saved` : `${r.inserted.toLocaleString()} animals imported`,
                r.failed ? 'error' : 'success');
  } catch(err) {
    lbl.textContent = `❌ Import failed: ${err.message}`;
    CToast.show('Import failed — check console', 'error');
  }

  _animalsData = [];
  _herdLoaded = false;
  await loadAnimals();
}

function clearAnimalsPreview() {
  _animalsData = [];
  document.getElementById('animalsImportPreview').innerHTML = '';
  document.getElementById('animalsImportActions').style.display = 'none';
  document.getElementById('animalsImportProgress').style.display = 'none';
  document.getElementById('fileAnimals').value = '';
}

/* ══════════════════════════════════════════════════════════════
   VIEW: SETTINGS (with create missing)
══════════════════════════════════════════════════════════════ */
async function loadSettingsView() {
  await loadNavSettings();
  const el = document.getElementById('view-settings');
  if (!el) return;
  const ns = S.navSettings;
  el.innerHTML = `
    <div style="max-width:640px">
      <div class="section-header"><h2>NAV Calculation Settings</h2></div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px">These parameters drive the live NAV engine. Update them whenever market prices or operational costs change.</p>
      <div class="card">
        <div class="card-header"><i class="fa-solid fa-sliders" style="color:var(--green-mid)"></i> Market & Operational Parameters</div>
        <div class="card-body">
          <div class="settings-grid">
            <div class="form-group"><label>Live Cattle Price (R/kg liveweight)</label><input type="number" id="s_price_per_kg" step="0.01" value="${ns.live_cattle_price_per_kg||42.50}"><span class="hint">Current market buying price per kg</span></div>
            <div class="form-group"><label>Avg Daily Weight Gain (kg/day)</label><input type="number" id="s_daily_gain" step="0.01" value="${ns.avg_daily_weight_gain_kg||1.2}"><span class="hint">Used to estimate current mass from entry mass</span></div>
            <div class="form-group"><label>Feedlot Cost per Head per Day (R)</label><input type="number" id="s_feedlot_cost" step="0.01" value="${ns.feedlot_cost_per_day_per_head||28.00}"><span class="hint">Feed, vet, admin combined daily cost</span></div>
            <div class="form-group"><label>SVC Standing Fee per Head per Day (R)</label><input type="number" id="s_standing_fee" step="0.01" value="${ns.svc_standing_fee_per_day_per_head||3.50}"><span class="hint">Daily management/standing fee</span></div>
            <div class="form-group"><label>Mortality Risk Assumption (%)</label><input type="number" id="s_mortality_pct" step="0.1" value="${ns.mortality_rate_assumption_pct||1.5}"><span class="hint">Applied as risk discount in forward NAV</span></div>
            <div class="form-group"><label>Target Annual Return (%)</label><input type="number" id="s_target_return" step="0.01" value="${ns.target_return_pct||14.83}"><span class="hint">Cattle Finance product target rate</span></div>
          </div>
          <div style="margin-top:20px"><button class="btn btn-primary" onclick="saveSettings()"><i class="fa-solid fa-save"></i> Save Settings & Recalculate</button></div>
        </div>
      </div>
      <div class="card" style="margin-top:20px"><div class="card-header"><i class="fa-solid fa-info-circle" style="color:var(--blue)"></i> NAV Calculation Method</div><div class="card-body" style="font-size:13px;line-height:1.7;color:var(--text-muted)"><p><strong>For Active Cycles:</strong></p><p>Est. Current Mass = Entry Mass + (Daily Gain × Days In Cycle)</p><p>Herd Value = Live Count × Est. Mass × Price/kg</p><p>NAV = Herd Value − Purchase Value − Feed Costs − Standing Fees</p><br><p><strong>For Individual Animals:</strong></p><p>Gross Value = Est. Mass × Price/kg</p><p>Net Value = Gross Value − (Feedlot Cost/day × Days)</p><br><p><strong>For Completed/Sold Cycles:</strong></p><p>Realised Return = Total Selling Price − Purchase Value</p><p>Return % = (Realised Return / Purchase Value) × 100</p></div></div>
    </div>`;
}

async function saveSettings() {
  const fields = {
    live_cattle_price_per_kg:          parseFloat(document.getElementById('s_price_per_kg').value),
    avg_daily_weight_gain_kg:          parseFloat(document.getElementById('s_daily_gain').value),
    feedlot_cost_per_day_per_head:     parseFloat(document.getElementById('s_feedlot_cost').value),
    svc_standing_fee_per_day_per_head: parseFloat(document.getElementById('s_standing_fee').value),
    mortality_rate_assumption_pct:     parseFloat(document.getElementById('s_mortality_pct').value),
    target_return_pct:                 parseFloat(document.getElementById('s_target_return').value)
  };

  try {
    const res = await safeGet('tables/cattle_nav_settings?limit=100');
    const existing = res.data || [];
    for (const [key, value] of Object.entries(fields)) {
      const row = existing.find(r => r.setting_key === key);
      if (row) {
        await apiPatch(`tables/cattle_nav_settings/${row.id}`, { setting_value: value });
      } else {
        await apiPost('tables/cattle_nav_settings', { setting_key: key, setting_value: value });
      }
    }
    await loadNavSettings();
    CToast.show('NAV settings saved and recalculated', 'success');
  } catch(e) {
    CToast.show('Error saving settings: ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   CYCLE DETAIL MODAL (unchanged, uses escapeHtml)
══════════════════════════════════════════════════════════════ */
function openCycleDetail(id, keepAnimals = false) {
  const cycle = S.cycles.find(c => c.id === id);
  if (!cycle) return;
  /* The herd summary for THIS cycle, not S.animals — which is the animals
     table's current page, 75 rows of whatever filter was last applied. Reading
     it here meant the modal valued a batch off animals belonging to other
     batches, or off none at all, in which case the average entry mass fell back
     to the settings default. The card and the modal showed different herd
     values for the same cycle: R776 356 against R829 056 on a 24-head batch,
     the difference being a real 168kg average against an assumed 220kg. */
  const nav = NAV.cycleNAV(cycle, S.herd.cycles[id], S.costs);
  const frozen = cycle.status === 'discontinued';
  const statusMap = { active: 'badge-blue', sold: 'badge-green', draft: 'badge-grey', cancelled: 'badge-red' };
  const ret = (parseFloat(cycle.total_selling_price)||0) - (parseFloat(cycle.purchase_value)||0);

  const overlay = document.getElementById('cycleDetailOverlay');
  const body = document.getElementById('cycleDetailBody');
  if (!overlay || !body) return;
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
      <div><div style="font-size:18px;font-weight:800">${escapeHtml(cycle.batch_name||cycle.id)}</div><div style="font-size:13px;color:var(--text-muted)">${escapeHtml(cycle.company||'')} · ${escapeHtml(cycle.cycle_no||'')} · INV ${escapeHtml(cycle.inv_no||'—')}</div></div>
      <span class="badge ${statusMap[cycle.status]||'badge-grey'}" style="margin-left:auto;font-size:13px">${(cycle.status||'—').toUpperCase()}</span>
    </div>
    <div style="background:linear-gradient(135deg,#0d1e13,#1a3a26);border-radius:12px;padding:20px;color:#fff;margin-bottom:20px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--green-light);margin-bottom:14px">Live NAV — This Cycle</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
        <div><div style="font-size:10px;color:rgba(255,255,255,.5);margin-bottom:3px">DAYS IN CYCLE</div><div style="font-size:20px;font-weight:800">${nav.daysIn}</div></div>
        <div><div style="font-size:10px;color:rgba(255,255,255,.5);margin-bottom:3px">EST. HERD VALUE</div><div style="font-size:20px;font-weight:800">${fmt.zar(nav.herdValue)}</div></div>
        <div><div style="font-size:10px;color:rgba(255,255,255,.5);margin-bottom:3px">NAV vs. COST</div><div style="font-size:20px;font-weight:800;color:${nav.navPct>=0?'#74c69d':'#ff6b6b'}">${nav.navPct>=0?'+':''}${nav.navPct.toFixed(2)}%</div></div>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div><div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Cycle Details</div><div class="info-grid">
        <div class="info-row"><div class="info-row-label">Start Date</div><div class="info-row-value">${fmt.date(cycle.cycle_start_date)}</div></div>
        <div class="info-row"><div class="info-row-label">End Date</div><div class="info-row-value">${fmt.date(cycle.end_date)}</div></div>
        <div class="info-row"><div class="info-row-label">Sale Date</div><div class="info-row-value">${fmt.date(cycle.sale_date)}</div></div>
        <div class="info-row"><div class="info-row-label">Days in Cycle</div><div class="info-row-value">${cycle.days_in_cycle||nav.daysIn}</div></div>
        <div class="info-row"><div class="info-row-label">Invoice Status</div><div class="info-row-value">${escapeHtml(cycle.invoice_paid||'—')}</div></div>
        <div class="info-row"><div class="info-row-label">Invoice No.</div><div class="info-row-value">${escapeHtml(cycle.inv_no||'—')}</div></div>
      </div></div>
      <div><div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Financial Summary</div><div class="info-grid">
        <div class="info-row"><div class="info-row-label">Purchased</div><div class="info-row-value">${cycle.no_purchased||'—'}</div></div>
        <div class="info-row"><div class="info-row-label">Live / Mortalities</div><div class="info-row-value">${cycle.no_live||'—'} / ${cycle.mortalities||0}</div></div>
        <div class="info-row"><div class="info-row-label">Avg Cost/Head</div><div class="info-row-value">${fmt.zar(cycle.avg_cattle_cost)}</div></div>
        <div class="info-row"><div class="info-row-label">Purchase Value</div><div class="info-row-value">${fmt.zar(cycle.purchase_value)}</div></div>
        <div class="info-row"><div class="info-row-label">SVC Standing Fee</div><div class="info-row-value">${fmt.zar(cycle.svc_standing_fee)}</div></div>
        ${cycle.status === 'sold' ? `
        <div class="info-row"><div class="info-row-label">Sale Price/Head</div><div class="info-row-value">${fmt.zar(cycle.selling_price_per_head)}</div></div>
        <div class="info-row"><div class="info-row-label">Total Sale Value</div><div class="info-row-value" style="color:var(--green-mid);font-weight:800">${fmt.zar(cycle.total_selling_price)}</div></div>
        <div class="info-row"><div class="info-row-label">Return</div><div class="info-row-value" style="color:${ret>=0?'var(--green-mid)':'var(--red)'};font-weight:800">${ret>=0?'+':''}${fmt.zar(ret)} (${fmt.pct(cycle.net_return_pct)})</div></div>
        ` : `
        <div class="info-row"><div class="info-row-label">Expected Sale</div><div class="info-row-value">${fmt.zar(cycle.expected_sale_value)}</div></div>
        <div class="info-row"><div class="info-row-label">Outstanding</div><div class="info-row-value">${fmt.zar(cycle.outstanding_invoice)}</div></div>
        `}
      </div></div>
    </div>
    ${renderAnimalBar(cycle)}
    ${cycle.notes ? `<div style="background:var(--surface-2);border-radius:8px;padding:12px 16px;font-size:12px;color:var(--text-muted);margin-top:8px"><strong>Notes:</strong> ${escapeHtml(cycle.notes)}</div>` : ''}
    <div id="cycleAnimalsPanel" style="margin-top:20px"></div>
  `;
  overlay.classList.add('open');
  /* keepAnimals: the caller already has the list and only needs the panels
     above it redrawn. Refetching would drop the operator back to page one of
     several hundred animals after every row they touched. */
  if (keepAnimals && S.cycleAnimals && S.cycleAnimals.cycleId === id) renderCycleAnimals();
  else loadCycleAnimals(id);
}

/* ══════════════════════════════════════════════════════════════
   THE ANIMALS IN ONE BATCH

   Fetched for this cycle rather than filtered out of whatever the animals
   table happens to be showing, and paged: a batch can hold several hundred
   head and this panel sits inside a modal.
══════════════════════════════════════════════════════════════ */
async function loadCycleAnimals(cycleId, offset = 0) {
  const el = document.getElementById('cycleAnimalsPanel');
  if (!el) return;
  el.innerHTML = `<div class="loading-state" style="padding:20px"><div class="spinner"></div> Loading animals…</div>`;
  try {
    const res = await apiGet(`cattle/cycles/${encodeURIComponent(cycleId)}/animals?limit=200&offset=${offset}`);
    S.cycleAnimals = { cycleId, offset, total: res.total, rows: res.data || [] };
    renderCycleAnimals();
  } catch (e) {
    el.innerHTML = `<div class="empty-state" style="padding:20px"><p>Could not load animals: ${escapeHtml(e.message)}</p></div>`;
  }
}

function renderCycleAnimals() {
  const el = document.getElementById('cycleAnimalsPanel');
  const st = S.cycleAnimals;
  if (!el || !st) return;
  const cycle = S.cycles.find(c => c.id === st.cycleId) || {};
  const closed = cycle.status === 'sold' || cycle.status === 'discontinued';

  if (!st.total) {
    el.innerHTML = `<div class="empty-state" style="padding:20px"><i class="fa-solid fa-cow"></i><h3>No animal records</h3>
      <p>This batch's numbers come from the cycle header. Import animals to manage them individually.</p></div>`;
    return;
  }

  const shownFrom = st.offset + 1, shownTo = st.offset + st.rows.length;
  const soldValue = st.rows.reduce((n, a) => n + (parseFloat(a.sale_value) || 0), 0);

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px">Animals in this batch</div>
      <span style="font-size:12px;color:var(--text-muted)">${fmt.num(st.total)} on file${st.total > st.rows.length ? ` · showing ${shownFrom}–${shownTo}` : ''}</span>
      ${soldValue > 0 ? `<span style="margin-left:auto;font-size:12px">Sale value on this page: <strong style="color:var(--green-mid)">${fmt.zar(soldValue)}</strong></span>` : ''}
    </div>
    ${closed ? `<div style="background:var(--surface-2);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--text-muted);margin-bottom:10px">
      This batch is ${escapeHtml(cycle.status)} &mdash; a closed record. Reopen it to change individual animals.</div>` : ''}
    <div style="overflow-x:auto">
      <table class="data-table" style="min-width:640px">
        <thead><tr>
          <th>Tag</th><th>Breed</th><th class="num">Entry kg</th><th class="num">Exit kg</th>
          <th>Status</th><th class="num">Sale value</th><th style="width:150px"></th>
        </tr></thead>
        <tbody>
          ${st.rows.map(a => {
            const status = isTrue(a.mortality) ? 'mortality' : isTrue(a.sold) ? 'sold' : (a.status || 'active');
            const chip = status === 'sold'      ? '<span style="color:var(--green-mid);font-weight:700">Sold</span>'
                       : status === 'mortality' ? '<span style="color:var(--red);font-weight:700">Deceased</span>'
                       : '<span style="color:var(--text-muted)">Live</span>';
            return `
            <tr>
              <td style="font-weight:600">${escapeHtml(a.tag_number || a.id)}</td>
              <td style="color:var(--text-muted)">${escapeHtml(a.breed || '—')}</td>
              <td class="num">${a.entry_mass ? fmt.num(a.entry_mass) : '—'}</td>
              <td class="num">${a.exit_mass ? fmt.num(a.exit_mass) : '—'}</td>
              <td>${chip}</td>
              <td class="num">${a.sale_value != null ? fmt.zar(a.sale_value) : '—'}</td>
              <td style="text-align:right;white-space:nowrap">
                ${closed ? '' : status === 'active' ? `
                  <button class="btn btn-xs btn-primary" onclick="openAnimalSale('${escapeHtml(a.id)}')">Sold</button>
                  <button class="btn btn-xs" style="background:#fdecea;color:#a3241a" onclick="markAnimal('${escapeHtml(a.id)}','mortality')">Deceased</button>
                ` : `
                  <button class="btn btn-xs btn-secondary" onclick="markAnimal('${escapeHtml(a.id)}','active')">Undo</button>
                `}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${st.total > 200 ? `
      <div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:12px">
        <button class="btn btn-secondary btn-sm" ${st.offset === 0 ? 'disabled' : ''}
                onclick="loadCycleAnimals('${escapeHtml(st.cycleId)}', ${Math.max(0, st.offset - 200)})">Previous</button>
        <span style="font-size:12px;color:var(--text-muted)">${shownFrom}–${shownTo} of ${fmt.num(st.total)}</span>
        <button class="btn btn-secondary btn-sm" ${shownTo >= st.total ? 'disabled' : ''}
                onclick="loadCycleAnimals('${escapeHtml(st.cycleId)}', ${st.offset + 200})">Next</button>
      </div>` : ''}
  `;
}

/* Marking one animal sold asks for what it fetched. Deceased and Undo do not:
   there is no figure to record, and Undo clears the one that was there. */
function openAnimalSale(animalId) {
  const st = S.cycleAnimals;
  const a  = st && st.rows.find(x => x.id === animalId);
  if (!a) return;
  const body = `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">
      Tag <strong style="color:var(--text)">${escapeHtml(a.tag_number || a.id)}</strong>${a.breed ? ' · ' + escapeHtml(a.breed) : ''}${a.entry_mass ? ' · entered at ' + fmt.num(a.entry_mass) + 'kg' : ''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px">
      <div class="form-group">
        <label>Sale value (R)</label>
        <input type="number" step="0.01" min="0" id="animalSaleValue" placeholder="e.g. 9850.00" value="${a.sale_value != null ? a.sale_value : ''}">
      </div>
      <div class="form-group">
        <label>Exit mass (kg) &mdash; optional</label>
        <input type="number" step="0.1" min="0" id="animalExitMass" placeholder="e.g. 478" value="${a.exit_mass != null ? a.exit_mass : ''}">
      </div>
      <div class="form-group">
        <label>Sale date &mdash; defaults to today</label>
        <input type="date" id="animalSaleDate" value="${a.sale_date ? String(a.sale_date).slice(0,10) : ''}">
      </div>
    </div>
    <p style="font-size:12px;color:var(--text-muted);margin:12px 0 0">
      An exit mass is what the animal actually weighed, and the whole batch is
      valued from the weigh-outs on file in preference to the growth model &mdash;
      so entering it improves the batch's valuation, not just this row.
    </p>`;
  _openModal('Mark animal sold', body,
    `<button class="btn btn-secondary" onclick="_closeModal()">Cancel</button>
     <button class="btn btn-primary" onclick="confirmAnimalSale('${escapeHtml(animalId)}', this)">Mark sold</button>`);
  setTimeout(() => { const f = document.getElementById('animalSaleValue'); if (f) f.focus(); }, 30);
}

async function confirmAnimalSale(animalId, btn) {
  const val  = document.getElementById('animalSaleValue').value;
  const mass = document.getElementById('animalExitMass').value;
  const date = document.getElementById('animalSaleDate').value;
  btn.disabled = true;
  _closeModal();
  await markAnimal(animalId, 'sold', { sale_value: val === '' ? null : val, exit_mass: mass || null, date: date || null });
}

async function markAnimal(animalId, status, extra = {}) {
  try {
    const r = await apiPatch(`cattle/animals/${encodeURIComponent(animalId)}`, { status, ...extra });
    /* The row is patched in place rather than the page refetched: the operator
       is working down a list and losing their position after every animal is
       what makes a screen like this unusable. */
    const st = S.cycleAnimals;
    if (st) {
      const i = st.rows.findIndex(x => x.id === animalId);
      if (i > -1) st.rows[i] = { ...st.rows[i], ...r.animal };
    }
    /* The cycle's live/dead/sold counts move with it, and so does the herd
       summary the batch is valued from. */
    if (r.cycle) {
      const c = S.cycles.find(x => x.id === r.cycle.id);
      if (c) Object.assign(c, r.cycle);
    }
    try { S.herd = await apiGet('cattle/herd-summary'); } catch (_) { /* figures stay as they were */ }
    /* Redraw the panels above the list — the batch's counts and its valuation
       have just moved — without refetching the list itself. */
    if (st) openCycleDetail(st.cycleId, true);
    else renderCycleAnimals();
    CToast.show(status === 'sold' ? 'Animal marked sold' : status === 'mortality' ? 'Animal marked deceased' : 'Animal set back to live');
  } catch (e) {
    CToast.show(e.message || 'Could not update that animal', 'error');
  }
}



function closeCycleDetail() {
  const ov = document.getElementById('cycleDetailOverlay');
  if (ov) ov.classList.remove('open');
}

/* ── ADD / EDIT CYCLE MODALS (unchanged, but safe) ── */
function openAddCycleModal() {
  document.getElementById('cycleFormTitle').textContent = 'Add Cattle Cycle';
  document.getElementById('cycleFormId').value = '';
  document.getElementById('cycleForm').reset();
  document.getElementById('cycleFormOverlay').classList.add('open');
}

function openEditCycleModal(id) {
  const c = S.cycles.find(x => x.id === id);
  if (!c) return;
  document.getElementById('cycleFormTitle').textContent = 'Edit Cattle Cycle';
  document.getElementById('cycleFormId').value = id;
  const setVal = (fid, val) => { const el = document.getElementById(fid); if (el && val!=null) el.value = val; };
  setVal('cf_batch_name',    c.batch_name);
  setVal('cf_company',       c.company);
  setVal('cf_inv_no',        c.inv_no);
  setVal('cf_cycle_no',      c.cycle_no);
  setVal('cf_status',        c.status);
  setVal('cf_no_purchased',  c.no_purchased);
  setVal('cf_mortalities',   c.mortalities);
  setVal('cf_no_live',       c.no_live);
  setVal('cf_no_sold',       c.no_sold);
  setVal('cf_purchase_value',c.purchase_value);
  setVal('cf_sale_value',    c.total_selling_price);
  setVal('cf_return_pct',    c.net_return_pct);
  setVal('cf_start_date',    c.cycle_start_date ? c.cycle_start_date.split('T')[0] : '');
  setVal('cf_sale_date',     c.sale_date ? c.sale_date.split('T')[0] : '');
  setVal('cf_notes',         c.notes);
  document.getElementById('cycleFormOverlay').classList.add('open');
}

function closeCycleForm() {
  document.getElementById('cycleFormOverlay').classList.remove('open');
}

async function saveCycleForm() {
  const id = document.getElementById('cycleFormId').value;
  const getVal = fid => { const el=document.getElementById(fid); return el?el.value:''; };
  const data = {
    batch_name:         getVal('cf_batch_name'),
    company:            getVal('cf_company'),
    inv_no:             getVal('cf_inv_no'),
    cycle_no:           getVal('cf_cycle_no'),
    status:             getVal('cf_status'),
    no_purchased:       parseInt(getVal('cf_no_purchased')) || 0,
    mortalities:        parseInt(getVal('cf_mortalities'))  || 0,
    no_live:            parseInt(getVal('cf_no_live'))       || 0,
    no_sold:            parseInt(getVal('cf_no_sold'))       || 0,
    purchase_value:     parseFloat(getVal('cf_purchase_value')) || 0,
    total_selling_price:parseFloat(getVal('cf_sale_value'))  || 0,
    net_return_pct:     parseFloat(getVal('cf_return_pct'))  || 0,
    cycle_start_date:   getVal('cf_start_date') ? new Date(getVal('cf_start_date')).toISOString() : null,
    sale_date:          getVal('cf_sale_date')  ? new Date(getVal('cf_sale_date')).toISOString()  : null,
    notes:              getVal('cf_notes')
  };

  try {
    if (id) {
      await apiPatch(`cattle/cycles/${id}`, data);
      CToast.show('Cycle updated', 'success');
    } else {
      await apiPost('cattle/cycles', data);
      CToast.show('Cycle added', 'success');
    }
    closeCycleForm();
    _herdLoaded = false;
    await loadCycles();
  } catch(e) {
    CToast.show('Error saving cycle', 'error');
  }
}

async function deleteCycle(id) {
  if (!confirm('Delete this cycle? This cannot be undone.')) return;
  try {
    /* apiFetch throws on any non-2xx, so the 409 is read here rather than in
       the catch: deleting a cycle that still has animals is not an error, it is
       a question. The server refuses the first time and names the number of
       animals about to lose their batch — they are unlinked, not deleted, and
       nothing in the console can put the link back except a re-import. */
    const r = await fetch(BASE + `cattle/cycles/${id}`, {
      method: 'DELETE', credentials: 'include',
      headers: _getAuthToken() ? { Authorization: `Bearer ${_getAuthToken()}` } : {},
    });
    if (r.status === 409) {
      const info = await r.json().catch(() => ({}));
      if (!confirm(`${info.message || 'This cycle still has animals linked to it.'}\n\nDelete it anyway?`)) return;
      await apiDelete(`cattle/cycles/${id}?orphan=1`);
      CToast.show(`Cycle deleted — ${info.linkedAnimals} animal record(s) unlinked`, 'info');
    } else if (!r.ok) {
      throw new Error(`API ${r.status}`);
    } else {
      CToast.show('Cycle deleted', 'success');
    }
    S.cycles = S.cycles.filter(c => c.id !== id);
    /* The deleted cycle's animals are unlinked server-side; drop its summary
       so the next render does not value a cycle that is gone. */
    delete S.herd.cycles[id];
    renderCyclesView();
  } catch(e) {
    CToast.show('Error deleting cycle: ' + e.message, 'error');
  }
}

/* ── ANIMAL CRUD (unchanged but with safe escape) ── */
let _editingAnimalId = null;

function openAddAnimalModal() {
  _editingAnimalId = null;
  document.getElementById('animalFormTitle').textContent = 'Add Animal';
  document.getElementById('animalFormId').value = '';
  document.getElementById('animalForm').reset();
  const cycleSelect = document.getElementById('af_cycle_id');
  if (cycleSelect) {
    cycleSelect.innerHTML = '<option value="">— No cycle linked —</option>' + _buildAnimalCycleOptions('');
  }
  document.getElementById('animalMortFields').style.display = 'none';
  document.getElementById('animalFormOverlay').classList.add('open');
}

function openEditAnimalModal(id) {
  const a = S.animals.find(x => x.id === id);
  if (!a) return;
  _editingAnimalId = id;
  document.getElementById('animalFormTitle').textContent = 'Edit Animal';
  document.getElementById('animalFormId').value = id;

  const setVal = (fid, val) => { const el = document.getElementById(fid); if (el) el.value = val || ''; };
  setVal('af_tag_number',      a.tag_number);
  setVal('af_batch_no',        a.batch_no);
  setVal('af_batch_name',      a.batch_name);
  setVal('af_breed',           a.breed);
  setVal('af_gender',          a.gender);
  setVal('af_entry_mass',      a.entry_mass);
  setVal('af_exit_mass',       a.exit_mass);
  setVal('af_status',          a.status || (isTrue(a.mortality) ? 'mortality' : isTrue(a.sold) ? 'sold' : 'active'));
  setVal('af_cycle_id',        a.cycle_id);
  setVal('af_sale_batch',      a.sale_batch);
  setVal('af_sale_date',       a.sale_date ? a.sale_date.split('T')[0] : '');
  setVal('af_mortality',       isTrue(a.mortality) ? 'true' : 'false');
  setVal('af_mortality_date',  a.mortality_date ? a.mortality_date.split('T')[0] : '');
  setVal('af_mortality_report',a.mortality_report);
  setVal('af_notes',           a.notes);

  const cycleSelect = document.getElementById('af_cycle_id');
  if (cycleSelect) {
    cycleSelect.innerHTML = '<option value="">— No cycle linked —</option>' + _buildAnimalCycleOptions(a.cycle_id);
  }
  document.getElementById('animalFormOverlay').classList.add('open');
  _toggleMortalityFields();
}

function closeAnimalForm() {
  document.getElementById('animalFormOverlay').classList.remove('open');
  _editingAnimalId = null;
}

function _toggleMortalityFields() {
  const status = document.getElementById('af_status');
  const mortFields = document.getElementById('animalMortFields');
  if (!status || !mortFields) return;
  mortFields.style.display = (status.value === 'mortality') ? 'grid' : 'none';
}

async function saveAnimalForm() {
  const getVal = fid => { const el = document.getElementById(fid); return el ? el.value.trim() : ''; };
  const status = getVal('af_status');

  const data = {
    tag_number:        getVal('af_tag_number'),
    batch_no:          getVal('af_batch_no'),
    batch_name:        getVal('af_batch_name'),
    breed:             getVal('af_breed'),
    gender:            getVal('af_gender'),
    entry_mass:        parseFloat(getVal('af_entry_mass'))  || null,
    exit_mass:         parseFloat(getVal('af_exit_mass'))   || null,
    status:            status,
    cycle_id:          getVal('af_cycle_id') || null,
    sale_batch:        getVal('af_sale_batch') || null,
    sale_date:         getVal('af_sale_date')  ? new Date(getVal('af_sale_date')).toISOString()  : null,
    sold:              status === 'sold',
    mortality:         status === 'mortality',
    mortality_date:    getVal('af_mortality_date')   ? new Date(getVal('af_mortality_date')).toISOString()   : null,
    mortality_report:  getVal('af_mortality_report') || null,
    notes:             getVal('af_notes') || null,
  };

  if (!data.tag_number) { CToast.show('Tag number is required', 'error'); return; }

  const saveBtn = document.getElementById('animalSaveBtn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

  try {
    if (_editingAnimalId) {
      await apiPatch(`tables/cattle_animals/${_editingAnimalId}`, data);
      CToast.show('Animal updated', 'success');
    } else {
      await apiPost('tables/cattle_animals', data);
      CToast.show('Animal added', 'success');
    }
    closeAnimalForm();
    /* The full herd NAV reads is now stale — this animal's mass, status or
       cycle just changed. */
    _herdLoaded = false;
    S.animalPage = 1;
    await _reloadAnimalPage();
  } catch(e) {
    CToast.show('Error saving animal: ' + e.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-save"></i> Save Animal';
  }
}

async function deleteAnimal(id) {
  if (!confirm('Delete this animal record? This cannot be undone.')) return;
  try {
    await apiDelete(`tables/cattle_animals/${id}`);
    CToast.show('Animal deleted', 'success');
    _herdLoaded = false;
    await _reloadAnimalPage();
  } catch(e) {
    CToast.show('Error deleting animal', 'error');
  }
}

function _buildAnimalCycleOptions(selectedId) {
  if (!S.cycles.length) return '<option value="">Loading cycles…</option>';
  return S.cycles
    .sort((a, b) => (a.batch_name||'').localeCompare(b.batch_name||''))
    .map(c => `<option value="${escapeHtml(c.id)}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.batch_name||c.id)} (${c.status||''})</option>`)
    .join('');
}

/* ══════════════════════════════════════════════════════════════
   HERD RECONCILIATION

   The cycle header and the animal records describe the same herd, and until
   now nothing compared them. That is not a bookkeeping nicety here: NAV
   multiplies the HEADER's live count by an estimated mass and a market price,
   so a live count three too high values three animals that do not exist.

   Read-only, except for one action — relinking animals whose batch name still
   names exactly one cycle. Everything else is a question about the actual herd
   and belongs to a person, not to a button.
══════════════════════════════════════════════════════════════ */
async function loadReconciliation() {
  const el = document.getElementById('view-reconcile');
  if (!el) return;
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div> Comparing headers against animal records…</div>`;
  try {
    if (!S.cycles.length) S.cycles = await fetchAll('cattle_cycles');
    S._recon = await apiGet('cattle/reconcile');
    renderReconciliation();
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><h3>Could not reconcile</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary" onclick="loadReconciliation()">Retry</button></div>`;
  }
}

function renderReconciliation() {
  const el = document.getElementById('view-reconcile');
  const r  = S._recon;
  if (!el || !r) return;
  const t = r.totals;

  const deltaCell = c => {
    const up = c.delta > 0;
    return `<span style="color:${up ? '#fec24f' : '#f87171'};font-weight:700">${up ? '+' : ''}${c.delta}</span>`;
  };

  el.innerHTML = `
    <div class="stat-row">
      <div class="stat-item"><div class="stat-item-label">Cycles Checked</div><div class="stat-item-value">${t.cycles}</div></div>
      <div class="stat-item"><div class="stat-item-label">Disagreeing</div><div class="stat-item-value ${t.mismatched ? 'red' : 'green'}">${t.mismatched}</div></div>
      <div class="stat-item" title="Head the NAV counts as live that have no animal record behind them">
        <div class="stat-item-label">Live Overstated</div><div class="stat-item-value ${t.liveOverstated ? 'red' : 'green'}">${t.liveOverstated}</div>
      </div>
      <div class="stat-item" title="Animals on file that the header does not count as live">
        <div class="stat-item-label">Live Understated</div><div class="stat-item-value">${t.liveUnderstated}</div>
      </div>
      <div class="stat-item"><div class="stat-item-label">Orphaned Animals</div><div class="stat-item-value ${t.orphans ? 'red' : 'green'}">${t.orphans}</div></div>
      <div class="stat-item"><div class="stat-item-label">Header Doesn't Balance</div><div class="stat-item-value ${t.imbalanced ? 'red' : 'green'}">${t.imbalanced}</div></div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" onclick="loadReconciliation()"><i class="fa-solid fa-rotate"></i> Re-run</button>
      <button class="btn btn-secondary btn-sm" onclick="exportReconciliationCSV()"><i class="fa-solid fa-download"></i> Export CSV</button>
      ${t.relinkable ? `<button class="btn btn-primary btn-sm" onclick="relinkOrphans(this)"><i class="fa-solid fa-link"></i> Relink ${t.relinkable} matched orphan${t.relinkable===1?'':'s'}</button>` : ''}
    </div>

    ${r.verdict === 'clean' ? `
      <div class="empty-state"><i class="fa-solid fa-circle-check" style="color:var(--green-mid)"></i>
        <h3>The headers and the animals agree</h3>
        <p>Every cycle's purchased, live, sold and mortality counts match the animal records behind them, and no animal is missing its cycle.</p>
      </div>` : ''}

    ${r.mismatched.length ? `
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><i class="fa-solid fa-scale-unbalanced" style="color:var(--red)"></i>
        Header vs animals on file
        <span style="font-size:11px;color:var(--text-muted);margin-left:auto;font-weight:400">NAV uses the header — a wrong live count is a wrong valuation</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Batch</th><th>Status</th><th>Disagreement</th><th class="num">Header</th><th class="num">On file</th><th class="num">Diff</th><th class="num">Capital</th></tr></thead>
          <tbody>
            ${r.mismatched.map(c => c.checks.map((chk, i) => `
              <tr${chk.key === 'live' && c.severity === 'high' ? ' style="background:rgba(248,113,113,.05)"' : ''}>
                ${i === 0 ? `<td rowspan="${c.checks.length}"><strong>${escapeHtml(c.batchName)}</strong><div style="font-size:11px;color:var(--text-muted)">${escapeHtml(c.company || '')}</div></td>
                             <td rowspan="${c.checks.length}"><span class="badge ${c.status === 'active' ? 'badge-blue' : 'badge-grey'}">${escapeHtml((c.status || '—').toUpperCase())}</span></td>` : ''}
                <td>${escapeHtml(chk.label)}${chk.key === 'live' ? ' <span title="This is the count NAV multiplies" style="color:#fec24f">◆</span>' : ''}</td>
                <td class="num">${chk.header}</td>
                <td class="num">${chk.counted}</td>
                <td class="num">${deltaCell(chk)}</td>
                ${i === 0 ? `<td class="num" rowspan="${c.checks.length}" style="color:var(--text-muted)">${fmt.zar(c.purchaseValue)}</td>` : ''}
              </tr>`).join('')).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${r.imbalanced.length ? `
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><i class="fa-solid fa-calculator" style="color:#fec24f"></i>
        Headers that don't add up
        <span style="font-size:11px;color:var(--text-muted);margin-left:auto;font-weight:400">live + sold + mortalities should equal purchased</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Batch</th><th class="num">Purchased</th><th class="num">Live</th><th class="num">Sold</th><th class="num">Mortalities</th><th class="num">Accounted</th><th class="num">Unaccounted</th></tr></thead>
          <tbody>
            ${r.imbalanced.map(c => `<tr>
              <td><strong>${escapeHtml(c.batchName)}</strong></td>
              <td class="num">${c.header.purchased}</td>
              <td class="num">${c.header.live}</td>
              <td class="num">${c.header.sold}</td>
              <td class="num">${c.header.mortalities}</td>
              <td class="num">${c.imbalance.accounted}</td>
              <td class="num" style="color:${c.imbalance.delta > 0 ? '#fec24f' : '#f87171'};font-weight:700">${c.imbalance.delta > 0 ? '+' : ''}${c.imbalance.delta}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${r.orphans.length ? `
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><i class="fa-solid fa-link-slash" style="color:#fec24f"></i>
        Animals with no cycle
        <span style="font-size:11px;color:var(--text-muted);margin-left:auto;font-weight:400">${r.relinkable.length} of ${r.orphans.length} still name a cycle that exists</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Tag</th><th>Batch No</th><th>Batch Name</th><th>Status</th><th>Matches</th></tr></thead>
          <tbody>
            ${r.orphans.slice(0, 200).map(o => `<tr>
              <td class="mono">${escapeHtml(o.tagNumber || '—')}</td>
              <td>${escapeHtml(o.batchNo || '—')}</td>
              <td>${escapeHtml(o.batchName || '—')}</td>
              <td><span class="badge badge-grey">${escapeHtml(o.status || '—')}</span></td>
              <td>${o.matchedCycle
                    ? `<span class="badge badge-green">${escapeHtml(o.matchedBatch)}</span>`
                    : `<span style="color:var(--text-muted);font-size:12px">no matching cycle — needs a person</span>`}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${r.orphans.length > 200 ? `<div style="padding:10px 14px;font-size:12px;color:var(--text-muted)">Showing the first 200 of ${r.orphans.length} — export the CSV for the rest.</div>` : ''}
    </div>` : ''}

    ${r.headerOnly.length ? `
    <div class="card">
      <div class="card-header"><i class="fa-solid fa-file-lines" style="color:var(--text-muted)"></i>
        Cycles with no animal records
        <span style="font-size:11px;color:var(--text-muted);margin-left:auto;font-weight:400">imported header-only — nothing to reconcile against</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Batch</th><th>Company</th><th>Status</th><th class="num">Header says purchased</th><th class="num">Capital</th></tr></thead>
          <tbody>
            ${r.headerOnly.map(c => `<tr>
              <td><strong>${escapeHtml(c.batchName)}</strong></td>
              <td style="color:var(--text-muted);font-size:12px">${escapeHtml(c.company || '—')}</td>
              <td><span class="badge ${c.status === 'active' ? 'badge-blue' : 'badge-grey'}">${escapeHtml((c.status || '—').toUpperCase())}</span></td>
              <td class="num">${c.header.purchased}</td>
              <td class="num" style="color:var(--text-muted)">${fmt.zar(c.purchaseValue)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}
  `;
}

async function relinkOrphans(btn) {
  const n = (S._recon && S._recon.totals.relinkable) || 0;
  if (!confirm(`Reattach ${n} animal record${n === 1 ? '' : 's'} to the cycle their batch name already names?\n\nThis changes no counts and no values — it restores a link. Animals whose batch name matches more than one cycle are left alone.`)) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Relinking…'; }
  try {
    const res = await apiPost('cattle/reconcile/relink', {});
    S._recon = res.report;
    /* The herd in memory is now stale — NAV groups animals by cycle_id. */
    _herdLoaded = false;
    CToast.show(`${res.relinked} animal record(s) reattached`, 'success');
    renderReconciliation();
  } catch (err) {
    CToast.show('Relink failed: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-link"></i> Relink matched orphans'; }
  }
}

function exportReconciliationCSV() {
  const r = S._recon;
  if (!r) { CToast.show('Run the reconciliation first', 'info'); return; }
  const rows = [['Section','Batch','Company','Status','Field','Header','On file','Difference','Tag','Matches cycle']];
  r.mismatched.forEach(c => c.checks.forEach(chk =>
    rows.push(['header vs animals', c.batchName, c.company || '', c.status || '', chk.label, chk.header, chk.counted, chk.delta, '', ''])));
  r.imbalanced.forEach(c =>
    rows.push(['header does not balance', c.batchName, c.company || '', c.status || '', 'purchased vs accounted',
               c.imbalance.purchased, c.imbalance.accounted, c.imbalance.delta, '', '']));
  r.orphans.forEach(o =>
    rows.push(['orphaned animal', o.batchName || '', '', o.status || '', '', '', '', '', o.tagNumber || '', o.matchedBatch || '']));
  r.headerOnly.forEach(c =>
    rows.push(['no animal records', c.batchName, c.company || '', c.status || '', 'purchased', c.header.purchased, 0, -c.header.purchased, '', '']));

  const csv = rows.map(row => row.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `cattle_reconciliation_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  CToast.show('Reconciliation exported', 'success');
}

/* ══════════════════════════════════════════════════════════════
   COST LEDGER (fully fixed: preserves filters, charts safe)
══════════════════════════════════════════════════════════════ */
let _currentCostCycleFilter = '';
let _currentCostTypeFilter = '';

async function loadCostLedger() {
  const tbody = document.getElementById('costLedgerBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:20px;color:rgba(255,255,255,.4)"><i class="fa-solid fa-spinner fa-spin"></i> Loading costs…</td></tr>`;
  try {
    if (!S.cycles.length) {
      const res = await safeGet('tables/cattle_cycles?limit=200');
      S.cycles = res.data || [];
    }
    const costs = await fetchAll('cattle_costs');
    /* One array. NAV reads S.costs, this view reads S._costCache, and two
       copies of the cost ledger that can drift is exactly how a valuation ends
       up disagreeing with the ledger it is supposedly built on. */
    S._costCache = S.costs = costs;
    // restore filters if they exist
    _currentCostCycleFilter = document.getElementById('costCycleFilter')?.value || '';
    _currentCostTypeFilter = document.getElementById('costTypeFilter')?.value || '';
    renderCostsView(costs);
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:20px;color:#f87171"><i class="fa-solid fa-triangle-exclamation"></i> Failed to load: ${escapeHtml(e.message)}</td></tr>`;
  }
}

/* A cycle's name, looked up rather than stored on every cost row. */
function _cycleName(cycleId) {
  if (!cycleId) return null;
  const c = S.cycles.find(x => x.id === cycleId);
  return (c && c.batch_name) || cycleId;
}

function renderCostsView(costs) {
  S.costs = costs;
  const total    = costs.reduce((s,c) => s + (parseFloat(c.amount)||0), 0);
  const feed     = costs.filter(c => c.category==='feed').reduce((s,c)=>s+(parseFloat(c.amount)||0),0);
  const vet      = costs.filter(c => c.category==='vet').reduce((s,c)=>s+(parseFloat(c.amount)||0),0);
  const mort     = costs.filter(c => c.category==='mortality').reduce((s,c)=>s+(parseFloat(c.amount)||0),0);

  const setTxt = (id, val) => { const e=document.getElementById(id); if(e) e.textContent=val; };
  setTxt('cost-total',    fmt.zar(total));
  setTxt('cost-feed',     fmt.zar(feed));
  setTxt('cost-vet',      fmt.zar(vet));
  setTxt('cost-mortality',fmt.zar(mort));

  const cycleFilter = document.getElementById('costCycleFilter');
  if (cycleFilter) {
    const cycleNames = [...new Set(costs.map(c => _cycleName(c.cycle_id)).filter(Boolean))].sort();
    cycleFilter.innerHTML = '<option value="">All Cycles</option>' + cycleNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    cycleFilter.value = _currentCostCycleFilter;
  }

  if (typeof Chart !== 'undefined') {
    _renderCostTypeChart(costs);
    _renderCostCycleChart(costs);
  }
  renderCostTable(costs, _currentCostCycleFilter, _currentCostTypeFilter);
  renderCostNetReturnPanel(costs);
}

function _renderCostTypeChart(costs) {
  const canvas = document.getElementById('costTypeChart');
  if (!canvas) return;
  if (S.charts.costType) S.charts.costType.destroy();
  const TYPE_COLORS = { feed: '#fec24f', vet: '#656565', transport: '#eda5ff', labour: '#34d399', mortality: '#f87171', other: 'rgba(255,255,255,.35)' };
  const types = {};
  costs.forEach(c => { const t = c.category||'other'; types[t] = (types[t]||0) + (parseFloat(c.amount)||0); });
  const labels = Object.keys(types);
  const data   = labels.map(k => types[k]);
  const colors = labels.map(k => TYPE_COLORS[k] || 'rgba(255,255,255,.35)');
  S.charts.costType = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth:2, borderColor:'#16213e' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position:'bottom', labels:{ color:'rgba(255,255,255,.7)', padding:10, font:{size:11} } }, tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt.zar(ctx.raw)}` } } } }
  });
}

function _renderCostCycleChart(costs) {
  const canvas = document.getElementById('costCycleChart');
  if (!canvas) return;
  if (S.charts.costCycle) S.charts.costCycle.destroy();
  const byCycle = {};
  costs.forEach(c => { const name = _cycleName(c.cycle_id) || "Unknown"; byCycle[name] = (byCycle[name]||0) + (parseFloat(c.amount)||0); });
  const labels = Object.keys(byCycle).slice(0, 10);
  const data   = labels.map(k => byCycle[k]);
  S.charts.costCycle = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label:'Total Cost', data, backgroundColor:'rgba(254,194,79,.7)', borderRadius:6, borderSkipped:false }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis:'y', plugins: { legend: { display:false }, tooltip: { callbacks: { label: ctx => ` ${fmt.zar(ctx.raw)}` } } }, scales: { x: { ticks:{ color:'rgba(255,255,255,.5)', font:{size:11}, callback: v=>'R'+Math.round(v/1000)+'k' }, grid:{ color:'rgba(255,255,255,.04)' } }, y: { ticks:{ color:'rgba(255,255,255,.6)', font:{size:11} }, grid:{ color:'rgba(255,255,255,.04)' } } } }
  });
}

function renderCostTable(costs, cycleFilter, typeFilter) {
  const tbody = document.getElementById('costLedgerBody');
  const sub   = document.getElementById('costLedgerSub');
  if (!tbody) return;
  let rows = [...costs];
  if (cycleFilter) rows = rows.filter(c => (_cycleName(c.cycle_id)) === cycleFilter);
  if (typeFilter)  rows = rows.filter(c => c.category === typeFilter);
  rows.sort((a,b) => (String(b.date||"")).localeCompare(String(a.date||"")));
  if (sub) sub.textContent = `${rows.length} entries · Total: ${fmt.zar(rows.reduce((s,c)=>s+(parseFloat(c.amount)||0),0))}`;
  const TYPE_COLORS = { feed:'#fec24f', vet:'#656565', transport:'#eda5ff', labour:'#34d399', mortality:'#f87171', other:'rgba(255,255,255,.35)' };
  const statusBadge = s => {
    const cfg = { paid:['#74c69d','#052e16'], pending:['#fec24f','#1c1400'], approved:['#656565','#0c1a2e'] };
    const [bg,fg] = cfg[s] || ['rgba(255,255,255,.12)','rgba(255,255,255,.5)'];
    return `<span style="background:${bg};color:${fg};padding:2px 7px;border-radius:8px;font-size:11px;font-weight:700">${(s||'?').toUpperCase()}</span>`;
  };
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:30px;color:rgba(255,255,255,.3)">No cost entries match filters</td></tr>`; return; }
  tbody.innerHTML = rows.map(c => {
    const typeColor = TYPE_COLORS[c.category] || 'rgba(255,255,255,.4)';
    return `<tr>
      <td style="font-size:11px;color:rgba(255,255,255,.45)">${fmt.date(c.date)}</td>
      <td style="font-weight:600;font-size:12px">${escapeHtml(_cycleName(c.cycle_id)||'—')}</td>
      <td><span style="background:${typeColor}22;color:${typeColor};padding:2px 8px;border-radius:8px;font-size:11px;font-weight:700;text-transform:capitalize">${escapeHtml(c.category||'—')}</span></td>
      <td style="font-size:12px;color:rgba(255,255,255,.7)">${escapeHtml(c.description||'—')}</td>
      <td style="text-align:right;font-size:12px;color:rgba(255,255,255,.5)">${c.per_animal ? fmt.zar(c.per_animal) : '—'}</td>
      <td style="text-align:right;font-size:12px;color:rgba(255,255,255,.5)">${c.animals_count || '—'}</td>
      <td style="text-align:right;font-weight:700;color:#fec24f">${fmt.zar(parseFloat(c.amount)||0)}</td>
      <td style="font-size:11px;color:rgba(255,255,255,.4)">${escapeHtml(c.vendor||'—')}</td>
      <td style="font-size:11px;color:rgba(255,255,255,.35)">${escapeHtml(c.invoice_ref||'—')}</td>
      <td>${statusBadge(c.status)}</td>
      <td style="white-space:nowrap"><button onclick="openEditCostModal('${escapeHtml(c.id)}')" style="background:none;border:none;color:rgba(255,255,255,.35);cursor:pointer;padding:4px" title="Edit"><i class="fa-solid fa-pen"></i></button><button onclick="deleteCostEntry('${escapeHtml(c.id)}')" style="background:none;border:none;color:rgba(248,113,113,.4);cursor:pointer;padding:4px" title="Delete"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`;
  }).join('');
}

function applyCostFilters() {
  _currentCostCycleFilter = document.getElementById('costCycleFilter')?.value || '';
  _currentCostTypeFilter = document.getElementById('costTypeFilter')?.value || '';
  if (S._costCache) renderCostTable(S._costCache, _currentCostCycleFilter, _currentCostTypeFilter);
}

function renderCostNetReturnPanel(costs) {
  const el = document.getElementById('costNetReturnBody');
  if (!el) return;
  const byCycle = {};
  costs.forEach(c => { const key = c.cycle_id || 'unknown'; if (!byCycle[key]) byCycle[key] = { name: _cycleName(c.cycle_id) || key, total:0 }; byCycle[key].total += parseFloat(c.amount)||0; });
  const rows = Object.entries(byCycle).map(([id, info]) => {
    const cycle = S.cycles.find(c => c.id === id);
    const saleValue = cycle ? (parseFloat(cycle.total_selling_price)||0) : 0;
    const purchaseV = cycle ? (parseFloat(cycle.purchase_value)||0) : 0;
    const grossReturn = saleValue - purchaseV;
    const netReturn   = grossReturn - info.total;
    return { name: info.name, costs: info.total, gross: grossReturn, net: netReturn, saleV: saleValue };
  });
  if (!rows.length) { el.innerHTML = `<p style="color:rgba(255,255,255,.3);padding:16px;text-align:center">No cost data available</p>`; return; }
  el.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="border-bottom:1px solid rgba(255,255,255,.07)"><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px">Cycle</th><th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px">Sale Value</th><th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px">Total Costs</th><th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px">Gross Return</th><th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px">Net Return</th><th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.5px">Margin</th></tr></thead><tbody>${rows.map(r => { const netColor = r.net >= 0 ? '#74c69d' : '#f87171'; const margin = r.saleV > 0 ? ((r.net/r.saleV)*100).toFixed(1) : '—'; return `<tr style="border-bottom:1px solid rgba(255,255,255,.04)"><td style="padding:10px 12px;font-weight:600;color:#fff">${escapeHtml(r.name)}</td><td style="padding:10px 12px;text-align:right;color:rgba(255,255,255,.6)">${fmt.zar(r.saleV)}</td><td style="padding:10px 12px;text-align:right;color:#f87171">${fmt.zar(r.costs)}</td><td style="padding:10px 12px;text-align:right;color:${r.gross>=0?'#fec24f':'#f87171'}">${fmt.zar(r.gross)}</td><td style="padding:10px 12px;text-align:right;font-weight:700;color:${netColor}">${fmt.zar(r.net)}</td><td style="padding:10px 12px;text-align:right;color:${parseFloat(margin)>=0?'#74c69d':'#f87171'}">${margin !== '—' ? margin+'%' : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
}

let _editingCostId = null;

/* The cost modal's fields are prefixed co_, not cf_.
 *
 * They used to share the cycle form's prefix, and shared one id outright:
 * cattle.html has <select id="cf_status"> for a cycle's status and this modal
 * built another for a cost's. getElementById returns the first in the document,
 * which is always the cycle form's — so every cost was saved with the status of
 * whatever the cycle form happened to be showing ('active', 'sold', 'draft'),
 * never 'pending' or 'paid', and editing a cost silently reached into the other
 * form. Separate prefixes make the collision impossible rather than fixed. */
function openAddCostModal() {
  _editingCostId = null;
  _ensureCostModal();
  document.getElementById('costFormTitle').textContent = 'Add Cost Entry';
  document.getElementById('costForm').reset();
  document.getElementById('co_date').value = new Date().toISOString().slice(0,10);
  const sel = document.getElementById('co_cycle_id');
  if (sel) sel.innerHTML = '<option value="">— Select Cycle —</option>' + S.cycles.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.batch_name||c.id)}</option>`).join('');
  document.getElementById('costFormOverlay').classList.add('open');
}

function openEditCostModal(id) {
  const cost = (S._costCache||[]).find(c => c.id === id);
  if (!cost) return;
  _editingCostId = id;
  _ensureCostModal();
  document.getElementById('costFormTitle').textContent = 'Edit Cost Entry';
  const setV = (fid, val) => { const e=document.getElementById(fid); if(e) e.value = (val === null || val === undefined) ? '' : val; };
  const sel  = document.getElementById('co_cycle_id');
  if (sel) sel.innerHTML = '<option value="">— Select Cycle —</option>' + S.cycles.map(c => `<option value="${escapeHtml(c.id)}" ${c.id===cost.cycle_id?'selected':''}>${escapeHtml(c.batch_name||c.id)}</option>`).join('');
  setV('co_cycle_id',     cost.cycle_id);
  setV('co_category',     cost.category);
  setV('co_description',  cost.description);
  setV('co_amount',       cost.amount);
  setV('co_per_animal',   cost.per_animal);
  setV('co_animals_count',cost.animals_count);
  setV('co_date',         cost.date ? String(cost.date).slice(0,10) : '');
  setV('co_vendor',       cost.vendor);
  setV('co_invoice_ref',  cost.invoice_ref);
  setV('co_status',       cost.status || 'pending');
  document.getElementById('costFormOverlay').classList.add('open');
}

function closeCostForm() {
  const ov = document.getElementById('costFormOverlay');
  if (ov) ov.classList.remove('open');
  _editingCostId = null;
}

async function saveCostForm() {
  const saveBtn = document.getElementById('costSaveBtn');
  if (saveBtn) { saveBtn.disabled=true; saveBtn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }
  try {
    const getV = id => { const e=document.getElementById(id); return e ? e.value.trim() : ''; };
    const cycleId = getV('co_cycle_id');
    /* The column names are the table's, not the form's. This payload named
       seven columns cattle_costs does not have — cost_type, cost_date,
       supplier, cycle_name, and three more — and the generic table API builds
       its INSERT straight from the body, so every single "Add Cost" died on the
       first one and reported "Error saving cost". Not one cost entry had ever
       been recorded, which is why NAV had no invoices to value against.

       cycle_name is gone rather than renamed: the cycle's name belongs to the
       cycle, and a copy stored here goes stale the moment a batch is renamed.
       It is looked up for display instead. */
    const payload = {
      cycle_id:     cycleId || null,
      category:     getV('co_category'),
      description:  getV('co_description'),
      amount:       parseFloat(getV('co_amount'))||0,
      per_animal:   parseFloat(getV('co_per_animal'))||null,
      animals_count:parseInt(getV('co_animals_count'))||null,
      date:         getV('co_date') || null,
      vendor:       getV('co_vendor'),
      invoice_ref:  getV('co_invoice_ref'),
      status:       getV('co_status') || 'pending'
    };
    if (!payload.amount) { CToast.show('Enter the amount for this cost', 'error'); return; }
    if (!payload.category) { CToast.show('Choose a cost type', 'error'); return; }
    if (_editingCostId) {
      await apiPatch(`tables/cattle_costs/${_editingCostId}`, payload);
      const idx = (S._costCache||[]).findIndex(c => c.id === _editingCostId);
      if (idx >= 0) S._costCache[idx] = { ...S._costCache[idx], ...payload };
      CToast.show('Cost entry updated', 'success');
    } else {
      const created = await apiPost('tables/cattle_costs', payload);
      if (!S._costCache) S._costCache = [];
      S._costCache.push(created);
      CToast.show('Cost entry added', 'success');
    }
    closeCostForm();
    /* NAV values active cycles against these invoices, so a cost that has just
       changed makes the herd in memory stale. */
    _herdLoaded = false;
    renderCostsView(S._costCache);
  } catch(e) {
    CToast.show('Error saving cost: ' + e.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled=false; saveBtn.innerHTML='<i class="fa-solid fa-save"></i> Save Cost'; }
  }
}

async function deleteCostEntry(id) {
  if (!confirm('Delete this cost entry? This cannot be undone.')) return;
  try {
    await apiDelete(`tables/cattle_costs/${id}`);
    S._costCache = (S._costCache||[]).filter(c => c.id !== id);
    _herdLoaded = false;
    renderCostsView(S._costCache);
    CToast.show('Cost entry deleted', 'success');
  } catch(e) {
    CToast.show('Error deleting cost: ' + e.message, 'error');
  }
}

function exportCostLedger() {
  const costs = S._costCache || [];
  if (!costs.length) { CToast.show('No cost data to export', 'info'); return; }
  const headers = ['Date','Cycle','Type','Description','Per Animal','Animals','Total Amount','Supplier','Invoice','Status'];
  const rows = costs.map(c => [c.date||'', _cycleName(c.cycle_id)||'', c.category||'', c.description||'', c.per_animal||'', c.animals_count||'', c.amount||'', c.vendor||'', c.invoice_ref||'', c.status||'']);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `cattle_costs_${new Date().toISOString().slice(0,10)}.csv` });
  a.click();
  CToast.show('Cost ledger exported', 'success');
}

function _ensureCostModal() {
  if (document.getElementById('costFormOverlay')) return;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'costFormOverlay';
  ov.setAttribute('onclick', "if(event.target===this)closeCostForm()");
  ov.innerHTML = `
    <div class="modal">
      <div class="modal-header"><i class="fa-solid fa-receipt" style="color:var(--gold)"></i><span class="modal-title" id="costFormTitle">Add Cost Entry</span><button class="modal-close" onclick="closeCostForm()"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body"><form id="costForm" onsubmit="event.preventDefault();saveCostForm()"><div class="settings-grid" style="margin-bottom:14px">
        <div class="form-group"><label>Cycle</label><select id="co_cycle_id" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"><option value="">— Select Cycle —</option></select></div>
        <div class="form-group"><label>Cost Type</label><select id="co_category" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"><option value="feed">Feed</option><option value="vet">Vet / Medical</option><option value="transport">Transport</option><option value="labour">Labour</option><option value="mortality">Mortality</option><option value="other">Other</option></select></div>
        <div class="form-group"><label>Description</label><input type="text" id="co_description" placeholder="e.g. Bulk feed delivery" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
        <div class="form-group"><label>Total Amount (R)</label><input type="number" id="co_amount" step="0.01" min="0" required placeholder="0.00" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
        <div class="form-group"><label>Per Animal (R)</label><input type="number" id="co_per_animal" step="0.01" min="0" placeholder="0.00" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
        <div class="form-group"><label>Animals Count</label><input type="number" id="co_animals_count" step="1" min="0" placeholder="0" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
        <div class="form-group"><label>Date</label><input type="date" id="co_date" required style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
        <div class="form-group"><label>Status</label><select id="co_status" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"><option value="pending">Pending</option><option value="paid">Paid</option><option value="approved">Approved</option></select></div>
        <div class="form-group"><label>Supplier</label><input type="text" id="co_vendor" placeholder="Supplier name" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
        <div class="form-group"><label>Invoice Ref</label><input type="text" id="co_invoice_ref" placeholder="INV-0001" style="width:100%;background:#16213e;border:1px solid rgba(255,255,255,.12);color:#fff;padding:8px 10px;border-radius:8px;font-size:13px"></div>
      </div></form></div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="closeCostForm()">Cancel</button><button class="btn" id="costSaveBtn" onclick="saveCostForm()"><i class="fa-solid fa-save"></i> Save Cost</button></div>
    </div>`;
  document.body.appendChild(ov);
}
