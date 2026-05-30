/* ═══════════════════════════════════════════════
   SV CAPITAL — Investor Portal JS
   ═══════════════════════════════════════════════ */
'use strict';

/* ─── Resolve investor ID from JWT session or fall back to demo ─── */
const DEMO_INVESTOR_ID = (() => {
  // Check JWT-based auth first
  if (typeof Auth !== 'undefined') {
    if (!Auth.isLoggedIn()) {
      window.location.href = '/login.html';
      return 'INV-001';
    }
    const user = Auth.getUser();
    if (user && user.investorId) return user.investorId;
  }
  return 'INV-001'; // fallback for demo
})();

let PORTAL = {
  investor: null,
  investments: [],
  transactions: [],
  pools: [],
  tickets: [],
  charts: {},
  myInvFilter: 'all',
  marketFilter: 'all',
  quests: null,       // { xp, level, currentLevel, nextLevel, completedIds, quests, levels, profile }
};

/* ─── Notifications ─── */
function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const btn   = document.getElementById('notifBtn');
  if (!panel) return;

  const isOpen = panel.classList.contains('notif-panel--open');
  if (isOpen) {
    panel.classList.remove('notif-panel--open');
    panel.style.display = 'none';
  } else {
    panel.style.display = 'block';
    // Force reflow so transition plays
    panel.offsetHeight; // eslint-disable-line no-unused-expressions
    panel.classList.add('notif-panel--open');
    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', function closePanel(e) {
        if (!panel.contains(e.target) && !btn?.contains(e.target)) {
          panel.classList.remove('notif-panel--open');
          panel.style.display = 'none';
          document.removeEventListener('click', closePanel);
        }
      });
    }, 10);
  }
}

/* Initialise the unread dot based on actual unread items */
function _syncNotifDot() {
  const dot     = document.getElementById('notifDot');
  const unread  = document.querySelectorAll('#notifPanel .notif-item.unread').length;
  if (dot) dot.classList.toggle('has-unread', unread > 0);
}

function markAllRead() {
  document.querySelectorAll('#notifPanel .notif-item.unread').forEach(el => el.classList.remove('unread'));
  const dot = document.getElementById('notifDot');
  if (dot) dot.classList.remove('has-unread');
}

/* ─── Time-based greeting ─── */
function _timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/* ─── Animated number ─── */
function _animateNum(el, target, prefix = '', suffix = '', duration = 900) {
  if (!el) return;
  const safeTarget = (target == null || isNaN(Number(target))) ? 0 : Number(target);
  const start = parseFloat(el.dataset.animated || 0);
  const startTime = performance.now();
  const step = (now) => {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = start + (safeTarget - start) * eased;
    el.textContent = prefix + Math.round(current).toLocaleString('en-ZA') + suffix;
    if (progress < 1) requestAnimationFrame(step);
    else { el.textContent = prefix + Math.round(safeTarget).toLocaleString('en-ZA') + suffix; el.dataset.animated = safeTarget; }
  };
  requestAnimationFrame(step);
}

/* ─── Navigation ─── */
function navigate(view, btnEl) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  const titles = {
    overview: 'Portfolio Overview', investments: 'My Investments',
    transactions: 'Transactions', wallet: 'Wallet', marketplace: 'Browse Pools',
    maturity: 'Maturity Instructions', profile: 'My Profile',
    support: 'Support', referral: 'Refer & Earn', statement: 'Account Statement',
    quests: 'Earn Rewards', learn: 'Learning Hub',
  };
  document.getElementById('topbarTitle').textContent = titles[view] || view;

  const loaders = {
    investments: loadMyInvestments,
    transactions: loadMyTransactions,
    wallet: loadWallet,
    marketplace: loadMarketplace,
    maturity: loadMaturity,
    support: loadSupport,
    statement: initStatementView,
    quests: renderQuestView,
    learn: renderLearnView,
  };
  if (loaders[view]) loaders[view]();
}

/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  Toast.init();
  initDarkMode();
  await loadPortalData();
  _syncNotifDot();
  checkFirstDepositPrompt();
  _checkAutoStartTour();
});

async function loadPortalData() {
  try {
    const [invRes, invstRes, txnRes, poolRes] = await Promise.all([
      API.investors.list({ limit: 100 }),
      API.investments.list({ limit: 200 }),
      API.transactions.list({ limit: 200 }),
      API.pools.list({ limit: 100 }),
    ]);

    const allInvestors   = invRes.data   || [];
    const allInvestments = invstRes.data || [];
    const allTxns        = txnRes.data   || [];

    // Find demo investor (INV-002), fall back to second then first in list
    PORTAL.investor = allInvestors.find(i => i.id === DEMO_INVESTOR_ID)
                   || allInvestors.find(i => i.status === 'active')
                   || allInvestors[0]
                   || null;

    const demoId = PORTAL.investor ? PORTAL.investor.id : DEMO_INVESTOR_ID;

    // Filter by matched investor ID
    let myInvests = allInvestments.filter(i => i.investor_id === demoId);
    let myTxns    = allTxns.filter(t => t.investor_id === demoId);

    // Fallback: if the seeded investor_id uses a different format, try case-insensitive match
    if (myInvests.length === 0 && allInvestments.length > 0) {
      const demoIdLower = demoId.toLowerCase();
      myInvests = allInvestments.filter(i =>
        (i.investor_id || '').toLowerCase() === demoIdLower ||
        (i.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      const demoIdLower = demoId.toLowerCase();
      myTxns = allTxns.filter(t =>
        (t.investor_id || '').toLowerCase() === demoIdLower ||
        (t.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }

    // Last resort: show the first investor's data so portal is never empty
    if (myInvests.length === 0 && allInvestments.length > 0) {
      const fallbackId = allInvestments[0].investor_id;
      myInvests = allInvestments.filter(i => i.investor_id === fallbackId);
      // also align investor object to fallback if needed
      if (!PORTAL.investor) {
        PORTAL.investor = allInvestors.find(i => i.id === fallbackId) || allInvestors[0] || {};
      }
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      const fallbackId = allTxns[0].investor_id;
      myTxns = allTxns.filter(t => t.investor_id === fallbackId);
    }

    PORTAL.investments  = myInvests;
    PORTAL.transactions = myTxns;
    PORTAL.pools        = poolRes.data || [];

    // Ensure investor object is never null so statement guard passes
    if (!PORTAL.investor) PORTAL.investor = { id: demoId, first_name: 'Thabo', last_name: 'Khumalo' };

    renderOverview();
    updateStmtQuickStats();

    // Load gamification data (non-blocking — don't fail portal if quests fail)
    loadQuestData().catch(err => console.warn('[Quests] load error:', err.message));
  } catch (e) {
    Toast.error('Failed to load portfolio data');
    console.error('loadPortalData error:', e);
  }
}

/* ═══════════════════════════════════════════════
   OVERVIEW
   ═══════════════════════════════════════════════ */
function renderOverview() {
  const inv = PORTAL.investor;
  if (!inv) return;

  const totalInvested = parseFloat(inv.total_invested) || 0;
  const totalValue    = totalInvested + (parseFloat(inv.wallet_balance) || 0);
  const totalRet      = parseFloat(inv.total_returns) || 0;
  const returnPct     = totalInvested > 0 ? (totalRet / totalInvested * 100).toFixed(1) : '0';
  const activeCount = PORTAL.investments.filter(i => i.status === 'active').length;
  const firstName   = inv.first_name || 'Investor';

  // ── Topbar greeting ──────────────────────────────────────────
  const greetEl = document.getElementById('topbarGreeting');
  if (greetEl) greetEl.textContent = `${_timeGreeting()}, ${firstName} 👋`;

  // ── Portfolio hero values ────────────────────────────────────
  // Animate portfolio hero
  const totEl = document.getElementById('pov-total');
  if (totEl) _animateNum(totEl, totalValue, 'R ', '', 1100);

  document.getElementById('pov-return').innerHTML = `<i class="fa-solid fa-arrow-trend-up"></i> <span>+${returnPct}% effective return · ${Utils.rand(totalRet)} earned</span>`;

  const invEl = document.getElementById('pov-invested');
  if (invEl) _animateNum(invEl, totalInvested, 'R ', '', 900);
  const walEl = document.getElementById('pov-wallet');
  if (walEl) _animateNum(walEl, inv.wallet_balance || 0, 'R ', '', 800);
  const retEl = document.getElementById('pov-returns');
  if (retEl) _animateNum(retEl, totalRet, 'R ', '', 900);
  document.getElementById('pov-active').textContent = activeCount;

  // ── Welcome banner ───────────────────────────────────────────
  const initials = `${(inv.first_name || '')[0] || '?'}${(inv.last_name || '')[0] || ''}`.toUpperCase();
  const avatarEl = document.getElementById('welcomeAvatar');
  if (avatarEl) avatarEl.textContent = initials;
  const nameEl = document.getElementById('welcomeName');
  if (nameEl) nameEl.textContent = `${inv.first_name || ''} ${inv.last_name || ''}`.trim() || 'Investor';
  const greetEl2 = document.getElementById('welcomeGreeting');
  if (greetEl2) greetEl2.textContent = _timeGreeting();
  const chipId = document.getElementById('wchipIdText');
  if (chipId) chipId.textContent = inv.id || '—';

  // Member since
  if (inv.created_at || inv.registration_date) {
    const since = new Date(inv.created_at || inv.registration_date);
    const sinceEl = document.getElementById('wchipSinceText');
    if (sinceEl) sinceEl.textContent = `Since ${since.toLocaleString('en-ZA', { month: 'short', year: 'numeric' })}`;
  }

  // FICA chip
  const ficaEl = document.getElementById('wchipFica');
  if (ficaEl && inv.fica_status === 'approved') ficaEl.style.display = 'inline-flex';

  // Next maturity chip
  const upcoming = PORTAL.investments
    .filter(i => i.status === 'active' && i.maturity_date)
    .sort((a, b) => new Date(a.maturity_date) - new Date(b.maturity_date));
  if (upcoming.length) {
    const days = Utils.daysRemaining(upcoming[0].maturity_date);
    const nextEl = document.getElementById('wchipNext');
    const nextTxt = document.getElementById('wchipNextText');
    if (nextEl && nextTxt && days !== null) {
      nextTxt.textContent = `Next maturity in ${days}d`;
      nextEl.style.display = 'inline-flex';
    }
  }

  // ── Sidebar user card ────────────────────────────────────────
  const sAvatar = document.querySelector('.sidebar-user__avatar');
  const sName   = document.querySelector('.user-name');
  const sRole   = document.querySelector('.user-role');
  if (sAvatar) sAvatar.textContent = initials;
  if (sName)   sName.textContent   = `${inv.first_name || ''} ${inv.last_name || ''}`.trim();
  if (sRole)   sRole.textContent   = `${inv.id || 'INV'} · ${inv.status === 'active' ? 'Active' : (inv.status || 'Investor')}`;

  // ── FICA pending alert ───────────────────────────────────────
  const ficaPending = inv.fica_status === 'pending' || inv.status === 'pending_fica' || inv.fica_status === 'submitted';
  let ficaBanner = document.getElementById('ficaAlertBanner');
  if (ficaPending && !ficaBanner) {
    ficaBanner = document.createElement('div');
    ficaBanner.id = 'ficaAlertBanner';
    ficaBanner.className = 'fica-alert-banner';
    ficaBanner.innerHTML = `
      <div class="fica-alert-banner__icon"><i class="fa-solid fa-id-card"></i></div>
      <div class="fica-alert-banner__body">
        <div class="fica-alert-banner__title">FICA Verification Pending</div>
        <div class="fica-alert-banner__sub">Your identity documents are under review (1–2 business days). You can invest once approved.</div>
      </div>
      <div class="fica-alert-banner__action">
        <button class="btn btn--primary btn--sm" onclick="navigate('support', document.querySelector('[data-view=support]'))">
          <i class="fa-solid fa-headset"></i> Contact Us
        </button>
      </div>`;
    const welcomeBanner = document.getElementById('welcomeBanner');
    if (welcomeBanner) welcomeBanner.after(ficaBanner);
  }

  // ── Performance panel ────────────────────────────────────────
  const perfInvested = document.getElementById('perf-invested');
  const perfReturns  = document.getElementById('perf-returns');
  const perfRate     = document.getElementById('perf-rate');
  const perfPools    = document.getElementById('perf-pools');
  if (perfInvested) perfInvested.textContent = Utils.rand(inv.total_invested || 0);
  if (perfReturns)  perfReturns.textContent  = '+' + Utils.rand(totalRet);
  if (perfRate)     perfRate.textContent     = returnPct + '% p.a.';
  if (perfPools)    perfPools.textContent    = activeCount + ' active';

  renderOverviewInvestments();
  renderOverviewTxns();
  renderPortfolioTrendChart();
  renderAllocationChart();
  renderXPWidget();
}

function renderOverviewInvestments() {
  const body = document.getElementById('overviewInvestmentsBody');
  const active = PORTAL.investments.filter(i => i.status === 'active');

  if (!active.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No active investments. <a href="#" onclick="navigate(\'marketplace\', null)" style="color:var(--gold)">Browse pools →</a></td></tr>'; return; }

  body.innerHTML = active.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const days = Utils.daysRemaining(inv.maturity_date);
    const pool = PORTAL.pools.find(p => p.id === inv.pool_id);
    const progress = pool ? Utils.poolFillPct(pool) : 100;

    return `<tr>
      <td>
        <div class="td-strong">${inv.pool_name}</div>
        <div style="margin-top:4px">
          <div class="progress-bar" style="width:120px;height:4px"><div class="progress-fill" style="width:${progress}%"></div></div>
        </div>
      </td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td class="td-green">${Utils.rand(inv.expected_return_amount)}</td>
      <td class="${days <= 30 ? 'td-gold' : 'td-muted'} fw-700">${days !== null ? days + ' days' : '—'}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
    </tr>`;
  }).join('');
}

function renderOverviewTxns() {
  const body = document.getElementById('overviewTxnBody');
  const recent = [...PORTAL.transactions].sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)).slice(0, 5);
  const typeColors = { deposit: 'green', investment: 'blue', return: 'gold', payout: 'green', fee: 'orange', referral_bonus: 'purple', withdrawal: 'red' };

  if (!recent.length) { body.innerHTML = '<tr><td colspan="4" class="text-center text-muted" style="padding:24px">No transactions yet</td></tr>'; return; }

  body.innerHTML = recent.map(t => `<tr>
    <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${t.type?.replace(/_/g, ' ')}</span></td>
    <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
    <td class="td-muted" style="font-size:0.75rem">${t.description || '—'}</td>
    <td class="td-muted">${Utils.date(t.transaction_date)}</td>
  </tr>`).join('');
}

function renderPortfolioTrendChart() {
  const canvas = document.getElementById('portfolioTrendChart');
  if (!canvas) return;

  // ── Build last-6-months labels ───────────────────────────────
  const now    = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toLocaleString('en-ZA', { month: 'short', year: '2-digit' }));
  }

  // ── Derive realistic trend data from actual investor totals ──
  const base     = Math.max(parseFloat(PORTAL.investor?.total_invested) || 0, 1000);
  const wallet   = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  const totalNow = base + wallet;
  const seed     = totalNow * 0.82;                    // ~18% lower 6 months ago

  const data = months.map((_, i) => {
    const trend = seed + (totalNow - seed) * (i / 5);
    const jitter = (Math.random() - 0.35) * (totalNow * 0.012);
    return Math.max(0, Math.round(trend + jitter));
  });
  data[5] = Math.round(totalNow);                      // pin last point to actual value

  // ── Y-axis nice min/max so bars don't hug the edges ─────────
  const yMin = Math.max(0, Math.floor(Math.min(...data) * 0.94 / 1000) * 1000);
  const yMax = Math.ceil(Math.max(...data) * 1.06 / 1000) * 1000;

  // ── Destroy previous instance if it exists ───────────────────
  if (PORTAL.charts.trend) {
    PORTAL.charts.trend.destroy();
    PORTAL.charts.trend = null;
  }

  PORTAL.charts.trend = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months,
      datasets: [{
        label: 'Portfolio Value',
        data,
        borderColor:          '#FF9B0C',
        borderWidth:          2.5,
        fill:                 true,
        backgroundColor: c => {
          const g = c.chart.ctx.createLinearGradient(0, 0, 0, c.chart.height);
          g.addColorStop(0, 'rgba(255,155,12,0.28)');
          g.addColorStop(1, 'rgba(255,155,12,0.01)');
          return g;
        },
        tension:              0.42,
        pointRadius:          4,
        pointBackgroundColor: '#FF9B0C',
        pointBorderColor:     'rgba(255,255,255,0.9)',
        pointBorderWidth:     2,
        pointHoverRadius:     6,
        pointHoverBorderWidth:2,
        clip:                 false,
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 600, easing: 'easeInOutQuart' },
      layout: { padding: { top: 10, right: 12, bottom: 4, left: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:  'rgba(13,17,23,0.96)',
          titleColor:       '#9ca3af',
          bodyColor:        '#f0f4ff',
          borderColor:      'rgba(255,155,12,0.35)',
          borderWidth:      1,
          padding:          12,
          displayColors:    false,
          callbacks: {
            title: items => items[0].label,
            label: c    => '  Portfolio: ' + Utils.rand(c.parsed.y),
          }
        }
      },
      scales: {
        x: {
          display: true,
          offset:  true,
          grid: {
            display:    false,
            drawBorder: false,
          },
          ticks: {
            color:       'rgba(255,255,255,0.70)',
            font:        { size: 10, weight: '500', family: 'Inter, sans-serif' },
            maxRotation: 0,
            padding:     4,
          },
          border: {
            display: true,
            color:   'rgba(255,255,255,0.15)',
          },
        },
        y: {
          display:  true,
          position: 'left',
          min:      yMin,
          max:      yMax,
          grid: {
            color:      'rgba(255,255,255,0.07)',
            drawBorder: false,
          },
          ticks: {
            color:         'rgba(255,255,255,0.70)',
            font:          { size: 10, weight: '500', family: 'Inter, sans-serif' },
            maxTicksLimit: 5,
            padding:       6,
            callback: v => {
              if (v >= 1_000_000) return 'R' + (v / 1_000_000).toFixed(1) + 'M';
              if (v >= 1_000)     return 'R' + (v / 1_000).toFixed(0) + 'k';
              return 'R' + v;
            }
          },
          border: {
            display: true,
            color:   'rgba(255,255,255,0.15)',
          },
        }
      }
    }
  });
}

function renderAllocationChart() {
  const ctx = document.getElementById('allocationChart');
  if (!ctx) return;

  const allocation = {};
  PORTAL.investments.filter(i => i.status === 'active').forEach(i => {
    const label = Utils.productInfo(i.product_type).label;
    allocation[label] = (allocation[label] || 0) + i.amount;
  });

  if (!Object.keys(allocation).length) {
    allocation['No Investments'] = 1;
  }

  const colors = ['#D4AF37', '#22c55e', '#3b82f6', '#f97316', '#a855f7'];

  if (PORTAL.charts.alloc) PORTAL.charts.alloc.destroy();
  PORTAL.charts.alloc = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(allocation),
      datasets: [{ data: Object.values(allocation), backgroundColor: colors.slice(0, Object.keys(allocation).length), borderColor: 'var(--dark-2)', borderWidth: 3, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7a92a8', font: { size: 10 }, boxWidth: 10, padding: 8 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${Utils.rand(c.parsed)}` } }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   MY INVESTMENTS
   ═══════════════════════════════════════════════ */
async function loadMyInvestments() {
  if (!PORTAL.investments.length) await loadPortalData();
  renderMyInvestmentStats();
  renderMyInvestmentCards();
}

function renderMyInvestmentStats() {
  const d = PORTAL.investments;
  document.getElementById('mi-capital').textContent = Utils.rand(d.reduce((s, i) => s + (i.amount || 0), 0));
  document.getElementById('mi-expected').textContent = Utils.rand(d.reduce((s, i) => s + (i.expected_return_amount || 0), 0));
  document.getElementById('mi-earned').textContent = Utils.rand(d.reduce((s, i) => s + (i.actual_return_amount || 0), 0));
  document.getElementById('mi-count').textContent = d.length;
}

function filterMyInvestments(filter, btn) {
  PORTAL.myInvFilter = filter;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMyInvestmentCards();
}

function renderMyInvestmentCards() {
  const grid = document.getElementById('myInvestmentsGrid');
  const items = PORTAL.myInvFilter === 'all' ? PORTAL.investments : PORTAL.investments.filter(i => i.status === PORTAL.myInvFilter);

  if (!items.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-chart-line"></i><p>No investments in this category. <br><a href="#" onclick="navigate(\'marketplace\',null)" style="color:var(--gold)">Explore pools →</a></p></div>';
    return;
  }

  grid.innerHTML = items.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const days = Utils.daysRemaining(inv.maturity_date);
    const progress = days !== null && inv.amount ? Math.min(100, Math.max(0, 100 - (days / (365 * 1.5) * 100))) : 100;
    const isPaidOut = inv.status === 'paid_out';

    return `
      <div class="my-inv-card ${isPaidOut ? 'my-inv-card--paidout' : ''}">
        <div class="my-inv-card__header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <i class="fa-solid ${pi.icon}" style="color:${pi.color}"></i>
              <span class="my-inv-card__name">${inv.pool_name}</span>
            </div>
            <div class="my-inv-card__partner">${inv.investor_id}</div>
          </div>
          ${Utils.statusBadge(inv.status)}
        </div>

        ${!isPaidOut ? `
          <div class="my-inv-progress">
            <div class="my-inv-progress__label">
              <span>Term Progress</span>
              <span>${days !== null ? days + ' days remaining' : Utils.date(inv.maturity_date)}</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
          </div>
        ` : ''}

        <div class="my-inv-card__stats">
          <div class="mic-stat"><span class="mic-stat__label">Invested</span><span class="mic-stat__value mic-stat__value--gold">${Utils.rand(inv.amount)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">${isPaidOut ? 'Actual Return' : 'Exp. Return'}</span><span class="mic-stat__value mic-stat__value--green">${isPaidOut ? Utils.rand(inv.actual_return_amount) : Utils.rand(inv.expected_return_amount)}</span></div>
          <div class="mic-stat"><span class="mic-stat__label">Rate p.a.</span><span class="mic-stat__value">${Utils.pct(inv.expected_return_rate)}</span></div>
        </div>

        <div class="flex-between" style="font-size:0.72rem;color:var(--text-dim)">
          <span>Invested: ${Utils.date(inv.investment_date)}</span>
          <span>Matures: ${Utils.date(inv.maturity_date)}</span>
        </div>

        ${inv.status === 'matured' ? `
          <button class="btn btn--primary btn--full btn--sm" onclick='openMaturityModal(${JSON.stringify(inv.id)})'>
            <i class="fa-solid fa-hourglass-end"></i> Submit Maturity Instruction
          </button>
        ` : ''}
        ${isPaidOut ? `
          <div style="font-size:0.75rem;color:var(--text-muted);text-align:center">
            <i class="fa-solid fa-check-circle" style="color:var(--green)"></i> 
            Paid out ${Utils.date(inv.payout_date)} — Total: ${Utils.rand(inv.amount + inv.actual_return_amount)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

/* ═══════════════════════════════════════════════
   TRANSACTIONS
   ═══════════════════════════════════════════════ */
async function loadMyTransactions() {
  if (!PORTAL.transactions.length) await loadPortalData();
  renderMyTxnTable();

  document.getElementById('myTxnTypeFilter').addEventListener('change', renderMyTxnTable);
}

function renderMyTxnTable() {
  const body = document.getElementById('myTxnBody');
  const filter = document.getElementById('myTxnTypeFilter').value;
  const items = filter ? PORTAL.transactions.filter(t => t.type === filter) : PORTAL.transactions;
  const sorted = [...items].sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

  const typeColors = { deposit: 'green', investment: 'blue', return: 'gold', payout: 'green', fee: 'orange', referral_bonus: 'purple', withdrawal: 'red' };

  if (!sorted.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:32px">No transactions found</td></tr>'; return; }

  body.innerHTML = sorted.map(t => `<tr>
    <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${t.type?.replace(/_/g, ' ')}</span></td>
    <td class="${t.amount > 0 ? 'td-green' : 'td-red'} fw-700">${t.amount > 0 ? '+' : ''}${Utils.rand(t.amount)}</td>
    <td>${Utils.statusBadge(t.status)}</td>
    <td class="td-muted" style="font-size:0.72rem">${t.reference || '—'}</td>
    <td class="td-muted" style="font-size:0.75rem">${t.description || '—'}</td>
    <td class="td-muted">${Utils.date(t.transaction_date)}</td>
  </tr>`).join('');
}

/* ─── Refresh every wallet balance element on the page ─── */
function _refreshWalletUI(balance) {
  const fmt = Utils.rand(balance);
  // Overview KPI
  const povWallet = document.getElementById('pov-wallet');
  if (povWallet) povWallet.textContent = fmt;
  // Wallet view balance
  const wbEl = document.getElementById('walletBalance');
  if (wbEl) wbEl.textContent = fmt;
  // Overview total portfolio value (invested + wallet + returns)
  const inv = PORTAL.investor;
  if (inv) {
    const totalValue = (parseFloat(inv.total_invested) || 0) + balance + (parseFloat(inv.total_returns) || 0);
    const povTotal = document.getElementById('pov-total');
    if (povTotal) povTotal.textContent = Utils.rand(totalValue);
  }
}

/* ═══════════════════════════════════════════════
   WALLET
   ═══════════════════════════════════════════════ */
async function loadWallet() {
  if (!PORTAL.investor) await loadPortalData();
  document.getElementById('walletBalance').textContent = Utils.rand(PORTAL.investor?.wallet_balance || 0);

  const activity = document.getElementById('walletActivity');
  const deposits = PORTAL.transactions.filter(t => ['deposit', 'return', 'payout', 'referral_bonus'].includes(t.type)).slice(0, 5);

  if (!deposits.length) { activity.innerHTML = '<div class="empty-state" style="padding:16px"><i class="fa-solid fa-wallet"></i><p>No wallet activity yet.</p></div>'; return; }

  activity.innerHTML = deposits.map(t => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
      <div>
        <div style="font-size:0.82rem;font-weight:600;color:#1a1a1a">${t.description || t.type?.replace(/_/g, ' ')}</div>
        <div style="font-size:0.7rem;color:#9ca3af">${Utils.date(t.transaction_date)}</div>
      </div>
      <span style="font-weight:700;color:#22c55e">+${Utils.rand(Math.abs(t.amount))}</span>
    </div>
  `).join('');
}

/* ═══════════════════════════════════════════════
   PAYMENT GATEWAY — 3-Step flow
   Step 1: Enter amount
   Step 2: Choose gateway (Paystack | Ozow | EFT)
   Step 3: Process / confirm / show bank details

   Paystack public key (test): pk_test_72040393098052bb00477db9fb8f69f369193707
   ═══════════════════════════════════════════════ */

// ⚠️  REPLACE WITH LIVE KEY before going live — pk_live_xxxxxxxxxxxxxxxx
// Test key only works in Paystack's sandbox — real cards are declined
const PAYSTACK_PUBLIC_KEY = 'pk_test_72040393098052bb00477db9fb8f69f369193707';

// ⚠️  REPLACE with your real Ozow SiteCode from the Ozow merchant portal
// Set IsTest=false in launchOzow() when going live
const OZOW_SITE_CODE      = 'SMA-SMA-030';
const TX_FEE_RATE         = 0.029;   // 2.9% + R1 flat — charged by gateway (Paystack & Ozow)

// Internal state
let _pmAmount       = 0;       // base deposit amount entered by investor (ZAR)
let _pmGateway      = null;    // 'paystack' | 'ozow' | 'eft'

/* ── helpers ─────────────────────────────────── */
function _pmEl(id) { return document.getElementById(id); }

function _pmShowOnly(...ids) {
  ['pmStep1','pmStep2','pmStep3Eft','pmStep3Processing','pmStep3Success'].forEach(id => {
    const el = _pmEl(id);
    if (!el) return;
    // Must use explicit 'block' — setting '' falls back to the inline display:none
    // that is baked into the HTML for Steps 2/3, so they'd never show
    el.style.display = ids.includes(id) ? 'block' : 'none';
  });
}

function _pmSetProgress(pct) {
  const bar = _pmEl('pmProgressBar');
  if (bar) bar.style.width = pct + '%';
}

function _pmSetStepLabel(txt) {
  const lbl = _pmEl('pmStepLabel');
  if (lbl) lbl.textContent = txt;
}

function _pmInvestorName() {
  return PORTAL.investor
    ? `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`
    : 'Investor';
}

function _pmInvestorEmail() {
  return PORTAL.investor?.email || 'investor@svcapital.co.za';
}

function _pmInvestorId() {
  return PORTAL.investor?.id || DEMO_INVESTOR_ID;
}

/* ── public entry point ─────────────────────── */
/**
 * openTopUpModal(gateway?)
 * Call with no arg (generic) or 'paystack' / 'ozow' to pre-select.
 */
function openTopUpModal(gateway) {
  _pmAmount  = 0;
  _pmGateway = null;

  // Reset to step 1
  _pmEl('pmAmount').value = '';
  _pmEl('pmAmountHint').textContent = 'Minimum deposit: R100';
  _pmEl('pmAmountHint').style.color = 'var(--text-muted)';
  document.querySelectorAll('.pm-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.pm-gateway-card').forEach(c => c.classList.remove('selected'));

  _pmShowOnly('pmStep1');
  _pmSetProgress(33);
  _pmSetStepLabel('Step 1 of 3 — Enter amount');

  Modal.open('topUpModal');

  // If a gateway was passed, pre-fill and jump to step 2 after amount chip
  if (gateway === 'paystack' || gateway === 'ozow') {
    _pmGateway = gateway;
  }
}

/* ── Step 1: amount helpers ─────────────────── */
function setAmount(val) {
  _pmEl('pmAmount').value = val;
  document.querySelectorAll('.pm-chip').forEach(c => {
    c.classList.toggle('active', parseInt(c.textContent.replace(/[^0-9]/g,'')) === val);
  });
  updateAmountPreview();
}

/* Return the 2.9% + R1 fee amount for gateways that charge it */
function _pmFee(baseAmount) { return Math.round((baseAmount * TX_FEE_RATE + 1) * 100) / 100; }
/* Total charged to card/bank for non-EFT gateways */
function _pmTotal(baseAmount) { return Math.round((baseAmount + _pmFee(baseAmount)) * 100) / 100; }

function updateAmountPreview() {
  const raw = parseFloat(_pmEl('pmAmount').value);
  const hint = _pmEl('pmAmountHint');
  if (!raw || raw < 100) {
    hint.textContent = raw > 0 && raw < 100 ? 'Amount too low — minimum is R100' : 'Minimum deposit: R100';
    hint.style.color = raw > 0 && raw < 100 ? '#ef4444' : 'var(--text-muted)';
  } else {
    hint.textContent = `R${raw.toLocaleString('en-ZA')} will be credited to your SV Capital wallet`;
    hint.style.color = '#22c55e';
  }
}

/* Update the fee summary strip in Step 2 whenever gateway or amount changes */
function _pmUpdateFeeSummary() {
  const strip = _pmEl('pmFeeSummary');
  if (!strip) return;
  if (!_pmGateway || _pmGateway === 'eft') {
    strip.style.display = 'none';
    return;
  }
  const fee   = _pmFee(_pmAmount);
  const total = _pmTotal(_pmAmount);
  strip.style.display = 'block';
  strip.innerHTML = `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <span style="color:#9ca3af;font-size:0.78rem">Deposit amount</span>
      <span style="color:#f0f4ff;font-weight:600;font-size:0.78rem">R${_pmAmount.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.07)">
      <span style="color:#9ca3af;font-size:0.78rem">Gateway fee (2.9% + R1)</span>
      <span style="color:#f59e0b;font-weight:600;font-size:0.78rem">+ R${fee.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </div>
    <div style="display:flex;justify-content:space-between;padding:8px 0">
      <span style="color:#f0f4ff;font-size:0.82rem;font-weight:700">Total charged to you</span>
      <span style="color:#FF9B0C;font-size:0.88rem;font-weight:900">R${total.toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
    </div>
    <div style="font-size:0.69rem;color:#6b7280;margin-top:2px">
      <i class="fa-solid fa-circle-info" style="color:#6b7280"></i>
      The 2.9% + R1 fee is charged by the payment gateway provider and does not form part of your wallet credit.
    </div>
  `;
}

function goToStep2() {
  const raw = parseFloat(_pmEl('pmAmount').value);
  if (!raw || raw < 100) {
    Toast.error('Please enter at least R100 to continue');
    _pmEl('pmAmount').focus();
    return;
  }
  _pmAmount = raw;
  _pmEl('pmAmountDisplay').textContent = `R${raw.toLocaleString('en-ZA')}`;

  // If a gateway was pre-selected from the wallet card, highlight it
  if (_pmGateway) {
    document.querySelectorAll('.pm-gateway-card').forEach(c => c.classList.remove('selected'));
    const card = _pmEl(_pmGateway === 'paystack' ? 'gwPaystack' : _pmGateway === 'ozow' ? 'gwOzow' : 'gwEft');
    if (card) card.classList.add('selected');
  }

  _pmUpdateFeeSummary();
  _pmShowOnly('pmStep2');
  _pmSetProgress(66);
  _pmSetStepLabel('Step 2 of 3 — Choose payment method');
}

function goToStep1() {
  _pmShowOnly('pmStep1');
  _pmSetProgress(33);
  _pmSetStepLabel('Step 1 of 3 — Enter amount');
}

/* ── Step 2: gateway selection ──────────────── */
function selectGateway(gw) {
  _pmGateway = gw;
  document.querySelectorAll('.pm-gateway-card').forEach(c => c.classList.remove('selected'));
  const map = { paystack: 'gwPaystack', ozow: 'gwOzow', eft: 'gwEft' };
  const card = _pmEl(map[gw]);
  if (card) card.classList.add('selected');
  // Refresh fee strip whenever gateway changes
  _pmUpdateFeeSummary();
}

function proceedPayment() {
  if (!_pmGateway) {
    Toast.error('Please select a payment method');
    return;
  }
  if (_pmGateway === 'paystack') launchPaystack();
  else if (_pmGateway === 'ozow')    launchOzow();
  else if (_pmGateway === 'eft')     showEftDetails();
}

/* ── Paystack inline popup (v2 API) ─────────────── */
function launchPaystack() {
  _pmShowOnly('pmStep3Processing');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Paystack');

  // Total charged to card = base amount + 2.9% + R1 gateway fee
  const totalCharged = _pmTotal(_pmAmount);

  setTimeout(() => {
    try {
      if (typeof PaystackPop === 'undefined') {
        throw new Error('Paystack JS library did not load. Check your internet connection and try again.');
      }

      // Paystack v2 API — replaces deprecated PaystackPop.setup() + openIframe()
      const popup = new PaystackPop();
      popup.newTransaction({
        key:      PAYSTACK_PUBLIC_KEY,
        email:    _pmInvestorEmail(),
        amount:   Math.round(totalCharged * 100),   // Paystack expects kobo/cents
        currency: 'ZAR',
        ref:      `SVC-PS-${Date.now()}`,
        metadata: {
          investor_id:   _pmInvestorId(),
          investor_name: _pmInvestorName(),
          wallet_credit: _pmAmount,
          gateway_fee:   _pmFee(_pmAmount),
          custom_fields: [
            { display_name: 'Investor ID',    variable_name: 'investor_id',   value: _pmInvestorId() },
            { display_name: 'Investor Name',  variable_name: 'investor_name', value: _pmInvestorName() },
            { display_name: 'Wallet Credit',  variable_name: 'wallet_credit', value: `R${_pmAmount}` },
            { display_name: 'Gateway Fee',    variable_name: 'gateway_fee',   value: `R${_pmFee(_pmAmount)}` },
          ]
        },
        onSuccess: function(transaction) {
          // Payment authorised — credit wallet with base amount only (fee stays with gateway)
          _recordDeposit('paystack', transaction.reference, 'completed');
        },
        onCancel: function() {
          // User closed the Paystack popup without completing payment
          _pmShowOnly('pmStep2');
          _pmSetProgress(66);
          _pmSetStepLabel('Step 2 of 3 — Choose payment method');
          Toast.info('Payment cancelled — you can try again anytime.');
        }
      });
    } catch (err) {
      console.error('Paystack error:', err);
      Toast.error(err.message || 'Could not launch Paystack. Please try another method.');
      _pmShowOnly('pmStep2');
      _pmSetProgress(66);
      _pmSetStepLabel('Step 2 of 3 — Choose payment method');
    }
  }, 300);
}

/* ── Ozow redirect ──────────────────────────── */
/**
 * Ozow uses a server-side hash; on the frontend we build the
 * payment URL and redirect the client. For test/sandbox mode we
 * simulate the redirect — in production replace with your real
 * Ozow site-code and server-generated hash.
 *
 * Ozow sandbox URL: https://pay.ozow.com/
 * Required params: SiteCode, CountryCode, CurrencyCode, Amount,
 *                  TransactionReference, BankReference, Customer,
 *                  CancelUrl, ErrorUrl, SuccessUrl, IsTest
 */
function launchOzow() {
  _pmShowOnly('pmStep3Processing');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Ozow');
  _pmEl('pmProcessingTitle').textContent    = 'Redirecting to Ozow…';
  _pmEl('pmProcessingSubtitle').textContent = 'You will be taken to the Ozow secure payment page';

  const ref          = `SVC-OZ-${Date.now()}`;
  // The total charged to the client includes the 2.9% + R1 gateway fee
  const totalCharged = _pmTotal(_pmAmount);
  const baseUrl      = window.location.href.split('?')[0];
  const successUrl   = encodeURIComponent(`${baseUrl}?payment=success&ref=${ref}&gw=ozow`);
  const cancelUrl    = encodeURIComponent(`${baseUrl}?payment=cancelled&gw=ozow`);
  const errorUrl     = encodeURIComponent(`${baseUrl}?payment=error&gw=ozow`);
  const amountFmt    = totalCharged.toFixed(2);

  // ── Persist amount to sessionStorage so it survives the redirect ──
  try {
    sessionStorage.setItem('svc_ozow_amount', String(_pmAmount));
    sessionStorage.setItem('svc_ozow_ref',    ref);
    sessionStorage.setItem('svc_ozow_inv_id', _pmInvestorId());
  } catch (_) { /* private-mode browsers may block sessionStorage */ }

  const ozowUrl = [
    'https://pay.ozow.com/',
    `?SiteCode=${OZOW_SITE_CODE}`,
    `&CountryCode=ZA`,
    `&CurrencyCode=ZAR`,
    `&Amount=${amountFmt}`,
    `&TransactionReference=${ref}`,
    `&BankReference=${_pmInvestorId()}`,
    `&Customer=${encodeURIComponent(_pmInvestorName())}`,
    `&CancelUrl=${cancelUrl}`,
    `&ErrorUrl=${errorUrl}`,
    `&SuccessUrl=${successUrl}`,
    `&IsTest=false`,   // ⚠️ Change to true while testing in Ozow sandbox
  ].join('');

  // Pre-record a pending deposit (base amount only — fee stays with gateway)
  _recordDeposit('ozow', ref, 'pending', false);

  setTimeout(() => {
    window.location.href = ozowUrl;
  }, 1200);
}

/* ── EFT (manual) ───────────────────────────── */
function showEftDetails() {
  const investorId = _pmInvestorId();
  _pmEl('eftAmountDisplay').textContent = `R${_pmAmount.toLocaleString('en-ZA')}`;
  _pmEl('eftReference').textContent     = investorId;

  _pmShowOnly('pmStep3Eft');
  _pmSetProgress(100);
  _pmSetStepLabel('Step 3 of 3 — Bank Transfer');
}

/* ── EFT proof of payment file handler ─── */
let _eftProofFile = null;
let _eftProofBase64 = null;

function handleEftProofFile(input) {
  const file = input.files[0];
  if (!file) return;

  // Validate size (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    Toast.error('File too large — maximum size is 5MB');
    input.value = '';
    return;
  }

  _eftProofFile = file;

  // Show file name
  const status = document.getElementById('eftProofStatus');
  const name   = document.getElementById('eftProofFileName');
  if (status && name) {
    name.textContent = file.name;
    status.style.display = 'block';
  }

  // Read as base64 so we can reference it in the support ticket
  const reader = new FileReader();
  reader.onload = e => { _eftProofBase64 = e.target.result; };
  reader.readAsDataURL(file);

  Toast.success(`Proof attached: ${file.name}`);
}

function copyEftRef() {
  const ref = _pmEl('eftReference').textContent;
  navigator.clipboard.writeText(ref).then(() => {
    Toast.success(`Reference "${ref}" copied to clipboard`);
  }).catch(() => {
    Toast.error('Could not copy — please copy the reference manually');
  });
}

async function confirmEftDeposit() {
  const ref = `EFT-${Date.now()}`;
  await _recordDeposit('eft', ref, 'pending', true);

  // Submit proof-of-payment as a support ticket to the admin
  try {
    const investorId   = _pmInvestorId();
    const investorName = _pmInvestorName();
    const amount       = _pmAmount;
    let description = `EFT wallet top-up of R${amount.toLocaleString('en-ZA',{minimumFractionDigits:2})} submitted by ${investorName} (${investorId}). Reference: ${ref}.`;

    if (_eftProofFile && _eftProofBase64) {
      description += `\n\nProof of payment attached: ${_eftProofFile.name} (${(_eftProofFile.size/1024).toFixed(1)} KB).\nData URL: ${_eftProofBase64.substring(0, 200)}...`;
    } else {
      description += '\n\nNo proof of payment was uploaded. Investor was advised to email admin@svcapital.co.za.';
    }

    await API.tickets.create({
      id:            Utils.genId('TKT'),
      investor_id:   investorId,
      investor_name: investorName,
      subject:       `EFT Proof of Payment — ${investorName} — R${amount.toLocaleString('en-ZA')} — ${ref}`,
      category:      'payment_proof',
      priority:      'high',
      status:        'open',
      message:       description,
      proof_filename: _eftProofFile ? _eftProofFile.name : '',
      proof_attached: !!_eftProofFile,
      created_at:    new Date().toISOString(),
    });
  } catch (ticketErr) {
    console.warn('Could not create EFT proof ticket:', ticketErr);
    // Non-fatal — the deposit was still recorded
  } finally {
    // Reset proof state
    _eftProofFile   = null;
    _eftProofBase64 = null;
    const input = document.getElementById('eftProofFile');
    if (input) input.value = '';
    const status = document.getElementById('eftProofStatus');
    if (status) status.style.display = 'none';
  }
}

/* ── core: record deposit transaction + update wallet balance ─── */
/**
 * _recordDeposit(gateway, reference, status, showSuccess)
 * 1. Creates a deposit transaction record.
 * 2. For completed payments, updates the investor's wallet_balance directly
 *    so the balance shown in the portal reflects the new funds immediately.
 * 3. For gateway payments (Paystack/Ozow) the fee is recorded separately
 *    as a 'fee' transaction so the ledger is transparent.
 * Only the BASE amount (_pmAmount) is credited to the wallet — the gateway
 * fee is charged on top of that by the provider and never touches the wallet.
 */
async function _recordDeposit(gateway, reference, status, showSuccess = true) {
  const gatewayLabel = { paystack: 'Paystack', ozow: 'Ozow', eft: 'EFT' }[gateway] || gateway;
  const isGateway    = gateway === 'paystack' || gateway === 'ozow';
  const fee          = isGateway ? _pmFee(_pmAmount) : 0;

  const depositDesc = status === 'pending'
    ? `Wallet top-up via ${gatewayLabel} — pending confirmation`
    : `Wallet top-up via ${gatewayLabel} — R${_pmAmount.toLocaleString('en-ZA')} credited to wallet`;

  try {
    // 1. Record the deposit transaction (base wallet-credit amount)
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: _pmInvestorId(),
      type:        'deposit',
      amount:      _pmAmount,
      status:      status,
      reference:   reference,
      description: depositDesc,
    });

    // 2. Record the gateway fee as a separate fee transaction (transparency)
    if (isGateway && fee > 0) {
      await API.transactions.create({
        id:          Utils.genId('TXN'),
        investor_id: _pmInvestorId(),
        type:        'fee',
        amount:      -fee,
        status:      status,
        reference:   `FEE-${reference}`,
        description: `Gateway fee (2.9% + R1) — ${gatewayLabel} · charged by payment provider`,
      });
    }

    // 3. If completed, update the investor's wallet_balance in the DB
    //    Only the base amount (_pmAmount) is credited — fee was paid to the gateway
    if (status === 'completed' && PORTAL.investor) {
      const currentBalance = parseFloat(PORTAL.investor.wallet_balance) || 0;
      const newBalance     = Math.round((currentBalance + _pmAmount) * 100) / 100;

      // Persist to DB using PATCH (only update wallet_balance field)
      try {
        await API.investors.update(PORTAL.investor.id, { wallet_balance: newBalance });
      } catch (dbErr) {
        console.warn('wallet_balance DB update failed, retrying with full record:', dbErr);
        await API.investors.update(PORTAL.investor.id, {
          ...PORTAL.investor,
          wallet_balance: newBalance,
        });
      }

      // Update local cache immediately so all UI shows the new balance
      PORTAL.investor.wallet_balance = newBalance;

      // Update every wallet balance display on the page right now
      _refreshWalletUI(newBalance);
    }

    if (showSuccess) {
      _pmShowOnly('pmStep3Success');
      _pmSetProgress(100);
      _pmSetStepLabel('Complete');

      const fmtBase = `R${_pmAmount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (status === 'pending') {
        _pmEl('pmSuccessAmount').textContent = `${fmtBase} deposit registered — awaiting bank confirmation`;
      } else {
        _pmEl('pmSuccessAmount').innerHTML =
          `<strong style="color:#22c55e">${fmtBase}</strong> successfully credited to your wallet` +
          (isGateway ? `<br><span style="font-size:0.75rem;color:#6b7280">R${fee.toFixed(2)} gateway fee was charged by ${gatewayLabel}</span>` : '');
      }

      _pmEl('pmSuccessRef').textContent = `Reference: ${reference}`;

      // Reload portal data fully, then refresh wallet view
      PORTAL.transactions = [];
      await loadPortalData();
      loadWallet();
    }

  } catch (err) {
    console.error('recordDeposit error:', err);
    Toast.error('Failed to record deposit — please contact support if funds were deducted');
  }
}

/* ── modal close ────────────────────────────── */
function closePaymentModal() {
  Modal.close('topUpModal');
  // If success was shown, refresh wallet display
  if (_pmEl('pmStep3Success') && _pmEl('pmStep3Success').style.display !== 'none') {
    PORTAL.transactions = [];
    loadPortalData().then(() => loadWallet());
  }
}

/* ── handle Ozow return URL params ─────────── */
(function checkOzowReturn() {
  const params  = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  const ref     = params.get('ref');
  const gw      = params.get('gw');

  if (!payment) return;

  // Clean URL immediately so refresh doesn't retrigger
  window.history.replaceState({}, document.title, window.location.pathname);

  if (payment === 'success' && gw === 'ozow' && ref) {

    // ── Restore the deposit amount that was saved before redirect ──
    let ozowAmount = 0;
    try {
      const stored = sessionStorage.getItem('svc_ozow_amount');
      ozowAmount   = stored ? parseFloat(stored) : 0;
      // Keep sessionStorage until we confirm we've handled it
    } catch (_) { /* private-mode browsers */ }

    // Wait for portal data to load before crediting the wallet
    setTimeout(async () => {
      try {
        // Ensure portal data is ready
        if (!PORTAL.investor) await loadPortalData();

        const investorId = _pmInvestorId();

        // 1. Find the matching pending transaction and mark it completed
        const txnRes  = await API.transactions.list({ limit: 200 });
        const allTxns = txnRes.data || [];
        const match   = allTxns.find(t =>
          t.reference === ref &&
          (t.investor_id === investorId || t.investor_id === (sessionStorage.getItem('svc_ozow_inv_id') || investorId))
        );
        if (match) {
          await API.transactions.update(match.id, { ...match, status: 'completed' });
          // If the transaction has an amount recorded, use that as the canonical credit
          if (!ozowAmount && match.amount > 0) ozowAmount = match.amount;
        }

        // 2. Credit wallet balance — use restored ozowAmount (or _pmAmount as fallback)
        const creditAmount = ozowAmount || _pmAmount;
        if (PORTAL.investor && creditAmount > 0) {
          const currentBalance = parseFloat(PORTAL.investor.wallet_balance) || 0;
          const newBalance     = Math.round((currentBalance + creditAmount) * 100) / 100;
          try {
            await API.investors.update(PORTAL.investor.id, { wallet_balance: newBalance });
          } catch (_dbErr) {
            // Retry with full record spread
            await API.investors.update(PORTAL.investor.id, {
              ...PORTAL.investor,
              wallet_balance: newBalance,
            });
          }
          // Update local cache so all UI elements show the new balance immediately
          PORTAL.investor.wallet_balance = newBalance;
          _refreshWalletUI(newBalance);

          // Also record any outstanding fee transaction if it wasn't logged pre-redirect
          // (only if the pre-record call failed before the redirect)
        }

        // Clean up sessionStorage
        try {
          sessionStorage.removeItem('svc_ozow_amount');
          sessionStorage.removeItem('svc_ozow_ref');
          sessionStorage.removeItem('svc_ozow_inv_id');
        } catch (_) { /* ignore */ }

      } catch (err) {
        console.error('Ozow return handler error:', err);
      }

      Toast.success(`Ozow payment successful! R${ozowAmount ? ozowAmount.toLocaleString('en-ZA') : ''} has been credited to your wallet.`);
      navigate('wallet', document.querySelector('[data-view=wallet]'));
      PORTAL.transactions = [];
      loadPortalData().then(() => loadWallet());
    }, 800);

  } else if (payment === 'cancelled') {
    Toast.info('Ozow payment was cancelled. No funds were deducted.');
    navigate('wallet', document.querySelector('[data-view=wallet]'));
    // Clear any stored Ozow session state
    try { sessionStorage.removeItem('svc_ozow_amount'); sessionStorage.removeItem('svc_ozow_ref'); sessionStorage.removeItem('svc_ozow_inv_id'); } catch (_) { /* ignore */ }

  } else if (payment === 'error') {
    Toast.error('Ozow payment failed. Please try again or contact support.');
    navigate('wallet', document.querySelector('[data-view=wallet]'));
    try { sessionStorage.removeItem('svc_ozow_amount'); sessionStorage.removeItem('svc_ozow_ref'); sessionStorage.removeItem('svc_ozow_inv_id'); } catch (_) { /* ignore */ }
  }
})();

/* ═══════════════════════════════════════════════
   MARKETPLACE
   ═══════════════════════════════════════════════ */
async function loadMarketplace() {
  if (!PORTAL.pools.length) {
    const res = await API.pools.list({ limit: 100 });
    PORTAL.pools = res.data || [];
  }
  renderMarketplace();
}

function filterMarket(type, btn) {
  PORTAL.marketFilter = type;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMarketplace();
}

const _POOL_META = {
  solar:         { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Medium',      riskColor: '#f59e0b' },
  cattle:        { blurb: 'Invests in livestock purchasing, management, and resale cycles.',   risk: 'Medium-High',  riskColor: '#ff9b0c' },
  short_term:    { blurb: 'Short-duration bridging finance to vetted borrowers. High liquidity.', risk: 'Medium',   riskColor: '#f59e0b' },
  delivery_bike: { blurb: 'Fleet funding for delivery riders. Steady, predictable returns.',   risk: 'Low-Medium',   riskColor: '#22c55e' },
};

function renderMarketplace() {
  const grid = document.getElementById('marketplaceGrid');
  const openPools = PORTAL.pools.filter(p => p.status === 'open');
  const filtered = PORTAL.marketFilter === 'all'
    ? openPools
    : openPools.filter(p => {
        if (PORTAL.marketFilter === 'solar') return p.product_type.includes('solar');
        return p.product_type === PORTAL.marketFilter;
      });

  // Update wallet strip
  const strip = document.getElementById('mktWalletStrip');
  const walletBal = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  if (strip) {
    strip.style.display = 'flex';
    const balEl = document.getElementById('mktWalletBal');
    if (balEl) {
      balEl.textContent = Utils.rand(walletBal);
      balEl.style.color = walletBal >= 500 ? 'var(--green)' : 'var(--gold)';
    }
  }

  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-layer-group"></i><p>No open pools in this category right now.</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(pool => {
    const pi   = Utils.productInfo(pool.product_type);
    const pct  = Utils.poolFillPct(pool);
    const days = Utils.daysRemaining(pool.close_date);
    const meta = _POOL_META[pool.product_type] || { blurb: '', risk: 'Medium', riskColor: '#f59e0b' };
    const canInvest = walletBal >= pool.min_investment;
    const urgency   = days !== null && days <= 7;

    return `
      <div class="market-pool-card">
        <div class="flex-between">
          <div class="market-pool-card__icon" style="background:${pi.color}18;color:${pi.color}"><i class="fa-solid ${pi.icon}"></i></div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="pool-risk-badge" style="background:${meta.riskColor}18;color:${meta.riskColor}">${meta.risk} risk</span>
            ${urgency ? `<span class="pool-urgency-badge"><i class="fa-solid fa-fire"></i> Closing soon</span>` : Utils.statusBadge(pool.status)}
          </div>
        </div>

        <div>
          <div class="market-pool-card__title">${pool.pool_name}</div>
          <div class="market-pool-card__blurb">${meta.blurb}</div>
        </div>

        <div class="pool-rate-row">
          <div>
            <div class="market-pool-card__rate">${Utils.pct(pool.benchmark_rate)}</div>
            <div class="market-pool-card__rate-label">per annum</div>
          </div>
          <div class="pool-rate-divider"></div>
          <div>
            <div class="market-pool-card__rate" style="font-size:1.4rem">${pool.term_months}mo</div>
            <div class="market-pool-card__rate-label">fixed term</div>
          </div>
          <div class="pool-rate-divider"></div>
          <div>
            <div class="market-pool-card__rate" style="font-size:1.4rem">${Utils.rand(pool.min_investment)}</div>
            <div class="market-pool-card__rate-label">minimum</div>
          </div>
        </div>

        <div class="market-pool-stats">
          <div class="mps"><span class="mps__label"><i class="fa-solid fa-users" style="font-size:0.65rem"></i> Investors</span><span class="mps__value">${pool.investor_count}</span></div>
          <div class="mps"><span class="mps__label"><i class="fa-solid fa-clock" style="font-size:0.65rem"></i> Closes in</span><span class="mps__value" style="${urgency?'color:var(--gold)':''}">${days !== null ? days + 'd' : '—'}</span></div>
          <div class="mps"><span class="mps__label"><i class="fa-solid fa-building-columns" style="font-size:0.65rem"></i> Partner</span><span class="mps__value" style="font-size:0.72rem">${pool.partner_name}</span></div>
        </div>

        <div>
          <div class="pool-card__progress-label">
            <span>${Utils.rand(pool.raised_amount)} raised</span>
            <span>${pct}% funded</span>
          </div>
          <div class="progress-bar"><div class="progress-fill${pool.product_type.includes('solar') ? ' progress-fill--green' : pool.product_type === 'short_term' ? ' progress-fill--blue' : ''}" style="width:${pct}%"></div></div>
        </div>

        ${canInvest
          ? `<button class="btn btn--primary btn--full" onclick='openInvestModal(${JSON.stringify(pool.id)})'>
               <i class="fa-solid fa-coins"></i> Invest Now
             </button>`
          : `<div class="pool-card__need-topup">
               <i class="fa-solid fa-wallet"></i>
               <span>Need ${Utils.rand(pool.min_investment - walletBal)} more in wallet</span>
               <button class="btn btn--ghost btn--sm" onclick="navigate('wallet',document.querySelector('[data-view=wallet]'))">Top Up</button>
             </div>`
        }
      </div>
    `;
  }).join('');
}

function openInvestModal(poolId) {
  const pool = PORTAL.pools.find(p => p.id === poolId);
  if (!pool) return;

  const walletBal  = parseFloat(PORTAL.investor?.wallet_balance) || 0;
  const pi         = Utils.productInfo(pool.product_type);
  const meta       = _POOL_META[pool.product_type] || { risk: 'Medium', riskColor: '#f59e0b' };
  const maturityDt = new Date();
  maturityDt.setMonth(maturityDt.getMonth() + pool.term_months);
  const maturityStr = maturityDt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

  document.getElementById('investModalTitle').textContent = `Invest in ${pool.pool_name}`;

  document.getElementById('investModalBody').innerHTML = `
    <!-- Pool summary card -->
    <div class="invest-modal-pool-card">
      <div class="invest-modal-pool-icon" style="background:${pi.color}20;color:${pi.color}">
        <i class="fa-solid ${pi.icon}"></i>
      </div>
      <div class="invest-modal-pool-info">
        <div class="invest-modal-pool-name">${pool.pool_name}</div>
        <div class="invest-modal-pool-meta">
          <span style="color:${pi.color};font-weight:700">${Utils.pct(pool.benchmark_rate)} p.a.</span>
          <span>·</span>
          <span>${pool.term_months}-month term</span>
          <span>·</span>
          <span class="pool-risk-badge" style="background:${meta.riskColor}18;color:${meta.riskColor}">${meta.risk} risk</span>
        </div>
      </div>
    </div>

    <!-- Wallet balance indicator -->
    <div class="invest-wallet-indicator ${walletBal >= pool.min_investment ? 'invest-wallet-ok' : 'invest-wallet-low'}">
      <i class="fa-solid fa-wallet"></i>
      <span>Your wallet: <strong>${Utils.rand(walletBal)}</strong></span>
      ${walletBal < pool.min_investment
        ? `<button class="btn btn--ghost btn--sm" onclick="Modal.close('investModal');navigate('wallet',document.querySelector('[data-view=wallet]'))">
             <i class="fa-solid fa-plus"></i> Top Up
           </button>`
        : `<span class="invest-wallet-ok-badge"><i class="fa-solid fa-circle-check"></i> Sufficient</span>`}
    </div>

    <!-- Quick-pick amount buttons -->
    <div class="form-group" style="margin-top:14px">
      <label class="form-label">How much would you like to invest?</label>
      <div class="invest-quickpick mb-8">
        ${[pool.min_investment, 5000, 10000, 25000].filter(v => v <= walletBal || v === pool.min_investment).map(v =>
          `<button class="invest-qp-btn" onclick="document.getElementById('investAmount').value=${v};_updateInvestCalc(${v},${pool.benchmark_rate},${pool.term_months},${pool.min_investment})">${Utils.rand(v)}</button>`
        ).join('')}
      </div>
      <input type="number" class="form-input" id="investAmount"
        placeholder="Enter amount (min ${Utils.rand(pool.min_investment)})"
        min="${pool.min_investment}" max="${walletBal}" oninput="_updateInvestCalc(parseFloat(this.value)||0,${pool.benchmark_rate},${pool.term_months},${pool.min_investment})" />
    </div>

    <!-- Live return calculator -->
    <div id="investCalcPreview" class="invest-calc-box">
      <div class="invest-calc-label">Estimated return at maturity</div>
      <div class="invest-calc-grid">
        <div><div class="invest-calc-caption">Invested</div><div class="invest-calc-val" id="ic-invested">—</div></div>
        <div class="invest-calc-plus">+</div>
        <div><div class="invest-calc-caption">Returns</div><div class="invest-calc-val" id="ic-returns" style="color:var(--green)">—</div></div>
        <div class="invest-calc-equals">=</div>
        <div><div class="invest-calc-caption">Total payout</div><div class="invest-calc-val invest-calc-total" id="ic-total">—</div></div>
      </div>
      <div class="invest-calc-date" id="ic-maturity">Maturity date: <strong>${maturityStr}</strong></div>
    </div>

    <!-- What happens next timeline -->
    <div class="invest-next-steps">
      <div class="ins-step"><div class="ins-dot ins-dot--active"></div><div class="ins-label"><b>Now</b> — funds deducted from wallet</div></div>
      <div class="ins-step"><div class="ins-dot"></div><div class="ins-label"><b>Ongoing</b> — returns accrue daily</div></div>
      <div class="ins-step"><div class="ins-dot"></div><div class="ins-label"><b>${maturityStr}</b> — payout to your wallet</div></div>
    </div>

    <div class="invest-lock-note">
      <i class="fa-solid fa-lock" style="color:var(--gold)"></i>
      Capital is locked for <strong>${pool.term_months} months</strong>. Early withdrawal is not available. Returns are not guaranteed.
    </div>
  `;

  document.getElementById('investConfirmBtn').onclick = () => confirmInvestment(pool);
  Modal.open('investModal');
}

function _updateInvestCalc(amt, rate, termMonths, minInvest) {
  const preview = document.getElementById('investCalcPreview');
  if (!preview) return;
  if (amt >= minInvest) {
    const ret = amt * rate * (termMonths / 12);
    document.getElementById('ic-invested').textContent = Utils.rand(Math.round(amt));
    document.getElementById('ic-returns').textContent  = '+' + Utils.rand(Math.round(ret));
    document.getElementById('ic-total').textContent    = Utils.rand(Math.round(amt + ret));
    preview.classList.add('invest-calc-box--visible');
  } else {
    document.getElementById('ic-invested').textContent = '—';
    document.getElementById('ic-returns').textContent  = '—';
    document.getElementById('ic-total').textContent    = '—';
    preview.classList.remove('invest-calc-box--visible');
  }
}

async function confirmInvestment(pool) {
  const amount = parseFloat(document.getElementById('investAmount').value);
  if (!amount || amount < pool.min_investment) { Toast.error(`Minimum investment is ${Utils.rand(pool.min_investment)}`); return; }

  const wallet = PORTAL.investor?.wallet_balance || 0;
  if (amount > wallet) { Toast.error('Insufficient wallet balance. Please top up first.'); return; }

  try {
    const expectedReturn = amount * pool.benchmark_rate * (pool.term_months / 12);
    const maturityDate = new Date();
    maturityDate.setMonth(maturityDate.getMonth() + pool.term_months);

    // Create investment
    await API.investments.create({
      id: Utils.genId('INVST'),
      investor_id: DEMO_INVESTOR_ID,
      pool_id: pool.id,
      product_type: pool.product_type,
      pool_name: pool.pool_name,
      investor_name: `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      investor_email: PORTAL.investor.email,
      amount,
      expected_return_rate: pool.benchmark_rate,
      expected_return_amount: Math.round(expectedReturn),
      actual_return_amount: 0,
      status: 'active',
      maturity_instruction: 'pending',
      investment_date: new Date().toISOString(),
      maturity_date: maturityDate.toISOString(),
      payout_date: ''
    });

    // Record transaction
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: DEMO_INVESTOR_ID,
      type:        'investment',
      amount:      -amount,
      status:      'completed',
      reference:   `INVST-${Date.now()}`,
      description: `Investment into ${pool.pool_name}`,
      pool_id:     pool.id,
    });

    // Update investor wallet and totals
    await API.investors.update(DEMO_INVESTOR_ID, {
      wallet_balance: Math.max(0, wallet - amount),
      total_invested: (parseFloat(PORTAL.investor.total_invested) || 0) + amount
    });

    Toast.success(`Successfully invested ${Utils.rand(amount)} in ${pool.pool_name}!`);
    Modal.close('investModal');

    // Reload data
    PORTAL.investments = [];
    PORTAL.transactions = [];
    await loadPortalData();
    renderOverview();
  } catch (e) {
    Toast.error('Investment failed. Please try again.');
    console.error(e);
  }
}

/* ═══════════════════════════════════════════════
   MATURITY
   ═══════════════════════════════════════════════ */
async function loadMaturity() {
  if (!PORTAL.investments.length) await loadPortalData();

  const container = document.getElementById('maturityInvestments');
  const matured = PORTAL.investments.filter(i => i.status === 'matured');
  const active = PORTAL.investments.filter(i => i.status === 'active');

  let html = '';

  if (matured.length) {
    html += `<h3 style="font-size:0.85rem;font-weight:700;color:var(--red);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.08em"><i class="fa-solid fa-exclamation-circle"></i> Requires Instruction (${matured.length})</h3>`;
    html += matured.map(inv => {
      const total = inv.amount + (inv.actual_return_amount || inv.expected_return_amount);
      return `<div class="maturity-card">
        <div class="maturity-card__info">
          <div class="maturity-card__name">${inv.pool_name}</div>
          <div class="maturity-card__detail">Matured: ${Utils.date(inv.maturity_date)} · Rate: ${Utils.pct(inv.expected_return_rate)}</div>
        </div>
        <div class="maturity-card__payout">
          <div class="maturity-card__payout-value">${Utils.rand(total)}</div>
          <div class="maturity-card__payout-label">Total payout value</div>
        </div>
        <button class="btn btn--primary" onclick='openMaturityModal(${JSON.stringify(inv.id)})'>
          <i class="fa-solid fa-paper-plane"></i> Submit Instruction
        </button>
      </div>`;
    }).join('');
  }

  if (active.length) {
    html += `<h3 style="font-size:0.85rem;font-weight:700;color:var(--text-muted);margin-top:24px;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.08em">Upcoming Maturities</h3>`;
    html += active.map(inv => {
      const days = Utils.daysRemaining(inv.maturity_date);
      return `<div class="maturity-card" style="border-color:var(--border);opacity:${days > 60 ? '0.6' : '1'}">
        <div class="maturity-card__info">
          <div class="maturity-card__name">${inv.pool_name}</div>
          <div class="maturity-card__detail">Matures: ${Utils.date(inv.maturity_date)} · ${days} days remaining</div>
        </div>
        <div class="maturity-card__payout">
          <div class="maturity-card__payout-value">${Utils.rand(inv.amount + inv.expected_return_amount)}</div>
          <div class="maturity-card__payout-label">Expected payout</div>
        </div>
        <span class="badge badge--gray">Not yet due</span>
      </div>`;
    }).join('');
  }

  if (!matured.length && !active.length) {
    html = '<div class="empty-state"><i class="fa-solid fa-hourglass"></i><p>No investments to show maturity instructions for.</p></div>';
  }

  container.innerHTML = html;
}

function openMaturityModal(investmentId) {
  const inv = PORTAL.investments.find(i => i.id === investmentId);
  if (!inv) return;

  const total = inv.amount + (inv.actual_return_amount || inv.expected_return_amount);

  document.getElementById('maturityModalBody').innerHTML = `
    <div class="info-list mb-16">
      <div class="info-row"><span class="info-row__label">Pool</span><span class="info-row__value">${inv.pool_name}</span></div>
      <div class="info-row"><span class="info-row__label">Capital</span><span class="info-row__value">${Utils.rand(inv.amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Returns</span><span class="info-row__value text-green">${Utils.rand(inv.actual_return_amount || inv.expected_return_amount)}</span></div>
      <div class="info-row"><span class="info-row__label">Total Payout</span><span class="info-row__value text-gold fw-700">${Utils.rand(total)}</span></div>
    </div>

    <div class="form-group">
      <label class="form-label">Instruction Type *</label>
      <select class="form-select" id="matInstructionType">
        <option value="payout_all">Payout All — Receive full capital + returns</option>
        <option value="payout_return">Payout Returns Only — Keep capital reinvested</option>
        <option value="reinvest">Reinvest — Roll over into same product</option>
        <option value="payout_custom">Custom Payout — Specify amount</option>
      </select>
    </div>

    <div id="customPayoutGroup" style="display:none">
      <div class="form-group">
        <label class="form-label">Custom Payout Amount (R)</label>
        <input type="number" class="form-input" id="matCustomAmount" placeholder="Amount to withdraw" />
      </div>
    </div>

    <div style="font-size:0.72rem;color:var(--text-dim);line-height:1.6;margin-top:8px">
      <i class="fa-solid fa-clock" style="color:var(--gold)"></i> 
      Instruction must be submitted before <strong>5:00 PM on ${Utils.date(inv.maturity_date)}</strong>. 
      If not submitted, funds will be automatically reinvested.
    </div>
  `;

  document.getElementById('matInstructionType').addEventListener('change', e => {
    document.getElementById('customPayoutGroup').style.display = e.target.value === 'payout_custom' ? 'block' : 'none';
  });

  document.getElementById('maturityConfirmBtn').onclick = () => submitMaturityInstruction(inv);
  Modal.open('maturityModal');
}

async function submitMaturityInstruction(inv) {
  const type = document.getElementById('matInstructionType').value;
  const customAmt = type === 'payout_custom' ? parseFloat(document.getElementById('matCustomAmount').value) : null;

  if (type === 'payout_custom' && (!customAmt || customAmt <= 0)) { Toast.error('Please enter a valid custom payout amount'); return; }

  try {
    await API.maturityInstructions.create({
      id: Utils.genId('MAT'),
      investment_id: inv.id,
      investor_id: DEMO_INVESTOR_ID,
      investor_name: `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      pool_name: inv.pool_name,
      instruction_type: type,
      custom_payout_amount: customAmt || 0,
      status: 'submitted',
      submitted_date: new Date().toISOString(),
      total_payout: inv.amount + (inv.actual_return_amount || inv.expected_return_amount)
    });

    await API.investments.update(inv.id, { maturity_instruction: type });

    Toast.success('Maturity instruction submitted successfully!');
    Modal.close('maturityModal');
    PORTAL.investments = [];
    await loadPortalData();
    loadMaturity();
  } catch (e) { Toast.error('Failed to submit instruction'); }
}

/* ═══════════════════════════════════════════════
   SUPPORT
   ═══════════════════════════════════════════════ */
async function loadSupport() {
  try {
    const res = await API.tickets.list({ limit: 100 });
    PORTAL.tickets = (res.data || []).filter(t => t.investor_id === DEMO_INVESTOR_ID);
    renderMyTickets();
  } catch (e) { Toast.error('Failed to load tickets'); }
}

function renderMyTickets() {
  const body = document.getElementById('myTicketsBody');
  if (!PORTAL.tickets.length) {
    body.innerHTML = '<div class="empty-state" style="padding:16px"><i class="fa-solid fa-ticket"></i><p>No support tickets yet.</p></div>';
    return;
  }

  body.innerHTML = PORTAL.tickets.map(t => `
    <div class="my-ticket-item">
      <div class="my-ticket-header">
        <span class="my-ticket-subject">${t.subject}</span>
        ${Utils.statusBadge(t.status)}
      </div>
      <div class="my-ticket-meta">${Utils.date(t.created_date)} · ${t.category?.replace(/_/g, ' ')}</div>
      ${t.admin_response ? `<div class="my-ticket-response"><strong>Admin:</strong> ${t.admin_response}</div>` : ''}
    </div>
  `).join('');
}

/* ── Ticket attachment state ─── */
let _tktAttachFile   = null;
let _tktAttachBase64 = null;

function handleTicketAttachment(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    Toast.error('File too large — maximum 10 MB');
    input.value = '';
    return;
  }
  _tktAttachFile = file;
  const status = document.getElementById('tktAttachStatus');
  const name   = document.getElementById('tktAttachName');
  if (status && name) { name.textContent = file.name; status.style.display = 'flex'; }
  const reader = new FileReader();
  reader.onload = e => { _tktAttachBase64 = e.target.result; };
  reader.readAsDataURL(file);
  Toast.success(`Attached: ${file.name}`);
}

function removeTicketAttachment() {
  _tktAttachFile   = null;
  _tktAttachBase64 = null;
  const inp = document.getElementById('tktAttachFile');
  if (inp) inp.value = '';
  const status = document.getElementById('tktAttachStatus');
  if (status) status.style.display = 'none';
}

async function submitTicket() {
  const subject = document.getElementById('tktSubject').value.trim();
  const message = document.getElementById('tktMessage').value.trim();
  if (!subject || !message) { Toast.error('Subject and message are required'); return; }

  let attachmentInfo = '';
  if (_tktAttachFile && _tktAttachBase64) {
    attachmentInfo = `\n\n📎 Attachment: ${_tktAttachFile.name} (${(_tktAttachFile.size/1024).toFixed(1)} KB)\nData: ${_tktAttachBase64}`;
  }

  try {
    await API.tickets.create({
      id: Utils.genId('TKT'),
      investor_id: DEMO_INVESTOR_ID,
      investor_name: `${PORTAL.investor?.first_name || 'Thabo'} ${PORTAL.investor?.last_name || 'Khumalo'}`,
      investor_email: PORTAL.investor?.email || '',
      subject,
      category: document.getElementById('tktCategory').value,
      priority: document.getElementById('tktPriority').value,
      message: message + attachmentInfo,
      proof_attached: !!_tktAttachFile,
      proof_filename: _tktAttachFile ? _tktAttachFile.name : '',
      attachment_data: _tktAttachBase64 || '',
      status: 'open',
      admin_response: '',
      created_date: new Date().toISOString()
    });
    Toast.success('Support ticket submitted. We\'ll respond within 1 business day.');
    document.getElementById('tktSubject').value = '';
    document.getElementById('tktMessage').value = '';
    removeTicketAttachment();
    await loadSupport();
  } catch (e) { Toast.error('Failed to submit ticket'); }
}

/* ─── FAQ ─── */
function toggleQuickFaq(btn) {
  const item = btn.closest('.faq-quick-item');
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-quick-item.open').forEach(i => i.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}

/* ═══════════════════════════════════════════════════════════════
   STATEMENT GENERATOR
   ═══════════════════════════════════════════════════════════════ */

function initStatementView() {
  // Set wide default date range: 2020-01-01 → today to catch all seeded data
  const today = new Date();
  const toDate   = today.toISOString().split('T')[0];
  const fromDate = '2020-01-01';   // wide range to capture all seeded records
  const fromEl = document.getElementById('stmtFrom');
  const toEl   = document.getElementById('stmtTo');
  if (fromEl) fromEl.value = fromDate;
  if (toEl)   toEl.value   = toDate;
  // Update quick stats sidebar straight away
  updateStmtQuickStats();
}

function updateStmtQuickStats() {
  const previewEl = document.getElementById('stmtQuickStats');
  if (!previewEl) return;
  // Use ALL portal data (ignore date filter for summary)
  const investments  = PORTAL.investments  || [];
  const transactions = PORTAL.transactions || [];
  const investor     = PORTAL.investor     || {};
  const totalInvested = investments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalReturns  = investments.reduce((s, i) => s + (Number(i.actual_return_amount) || 0), 0);
  const walletBal     = Number(investor.wallet_balance) || 0;
  const totalValue    = totalInvested + walletBal + totalReturns;

  if (investments.length === 0 && transactions.length === 0) {
    previewEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted)">
      <i class="fa-solid fa-file-invoice" style="font-size:2rem;margin-bottom:8px;display:block;opacity:0.4"></i>
      <span style="font-size:0.8rem">Portfolio data loading…</span>
    </div>`;
    return;
  }

  previewEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:0">
    ${qsr('Investor', `${investor.first_name||'Thabo'} ${investor.last_name||'Khumalo'}`)}
    ${qsr('Investor ID', investor.id||'INV-002')}
    ${qsr('Total Investments', investments.length)}
    ${qsr('Total Transactions', transactions.length)}
    ${qsr('Capital Deployed', Utils.rand(totalInvested, 2))}
    ${qsr('Returns Earned', Utils.rand(totalReturns, 2))}
    ${qsr('Portfolio Value', Utils.rand(totalValue, 2))}
  </div>`;
}

function qsr(label, val) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:0.78rem">
    <span style="color:#6b7280;font-weight:500">${label}</span>
    <span style="font-weight:700;color:#1a1a1a">${val}</span>
  </div>`;
}

function generateStatement() {
  // Guard: PORTAL.investor must be populated (set in loadPortalData)
  if (!PORTAL.investor) {
    Toast.error('Portfolio data is still loading — please wait a moment and try again.');
    return;
  }

  const fromEl = document.getElementById('stmtFrom');
  const toEl   = document.getElementById('stmtTo');
  const fromVal = fromEl ? fromEl.value : '2020-01-01';
  const toVal   = toEl   ? toEl.value   : new Date().toISOString().split('T')[0];

  const from = new Date(fromVal + 'T00:00:00');
  const to   = new Date(toVal   + 'T23:59:59');
  // Safety: if dates are invalid, use wide range
  if (isNaN(from.getTime())) from.setFullYear(2020, 0, 1);
  if (isNaN(to.getTime()))   to.setTime(Date.now());

  const incPortfolio    = !!(document.getElementById('stmtIncPortfolio')?.checked);
  const incInvestments  = !!(document.getElementById('stmtIncInvestments')?.checked);
  const incTransactions = !!(document.getElementById('stmtIncTransactions')?.checked);
  const incPerformance  = !!(document.getElementById('stmtIncPerformance')?.checked);

  // Always include at least portfolio summary if nothing checked
  const anyChecked = incPortfolio || incInvestments || incTransactions || incPerformance;
  const effectivePortfolio    = anyChecked ? incPortfolio    : true;
  const effectiveInvestments  = anyChecked ? incInvestments  : true;
  const effectiveTransactions = anyChecked ? incTransactions : true;
  const effectivePerformance  = anyChecked ? incPerformance  : true;

  const investor    = PORTAL.investor || {};
  // Use ALL investments (not date-filtered — investment dates may predate range)
  const investments = PORTAL.investments || [];

  // Filter transactions by date range
  const allTxns = PORTAL.transactions || [];
  const transactions = allTxns.filter(t => {
    const raw = t.transaction_date || t.created_at;
    if (!raw) return true;
    const d = (typeof raw === 'number') ? new Date(raw) : new Date(String(raw).length === 10 ? raw + 'T00:00:00' : raw);
    if (isNaN(d.getTime())) return true;
    return d >= from && d <= to;
  });

  // Compute stats
  const totalInvested = investments.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalReturns  = investments.reduce((s, i) => s + (Number(i.actual_return_amount) || 0), 0);
  const activeInv     = investments.filter(i => i.status === 'active').length;
  const walletBal     = Number(investor.wallet_balance) || 0;
  const totalValue    = totalInvested + walletBal + totalReturns;

  // Build preview quick stats
  const previewEl = document.getElementById('stmtQuickStats');
  if (previewEl) {
    previewEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${quickStatRow('Period', `${fmtDate(from)} — ${fmtDate(to)}`)}
        ${quickStatRow('Investments in Period', investments.length)}
        ${quickStatRow('Transactions in Period', transactions.length)}
        ${quickStatRow('Total Capital', Utils.rand(totalInvested))}
        ${quickStatRow('Returns Paid', Utils.rand(totalReturns))}
        ${quickStatRow('Portfolio Value', Utils.rand(totalValue))}
      </div>
    `;
  }

  // Build full statement document
  const doc = document.getElementById('statementDocument');
  if (!doc) return;

  const statementNumber = `SVC-${new Date().getFullYear()}-${String(Math.floor(Math.random()*90000)+10000)}`;
  const generatedAt = new Date().toLocaleString('en-ZA', {dateStyle:'long', timeStyle:'short'});

  let html = buildStatementHTML({
    investor, investments, transactions,
    from, to, totalInvested, totalReturns, walletBal, totalValue, activeInv,
    statementNumber, generatedAt,
    incPortfolio:    effectivePortfolio,
    incInvestments:  effectiveInvestments,
    incTransactions: effectiveTransactions,
    incPerformance:  effectivePerformance
  });

  doc.innerHTML = html;
  document.getElementById('statementPreview').style.display = 'block';
  document.getElementById('statementPreview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function quickStatRow(label, val) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:0.78rem">
    <span style="color:#6b7280;font-weight:500">${label}</span>
    <span style="font-weight:700;color:#1a1a1a">${val}</span>
  </div>`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = typeof d === 'number' ? new Date(d) : new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-ZA', { day:'2-digit', month:'short', year:'numeric' });
}

function fmtNum(n) {
  const val = Number(n) || 0;
  return 'R\u00A0' + val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
}

function buildStatementHTML(opts) {
  const {
    investor, investments, transactions,
    from, to, totalInvested, totalReturns, walletBal, totalValue, activeInv,
    statementNumber, generatedAt,
    incPortfolio, incInvestments, incTransactions, incPerformance
  } = opts;

  const fullName = `${investor.first_name || 'Thabo'} ${investor.last_name || 'Khumalo'}`;
  const investorId = investor.id || 'INV-002';
  const memberSince = investor.date_joined ? fmtDate(investor.date_joined) : '20 Aug 2022';
  const ficaStatus = investor.fica_status || 'approved';

  // SVG logo (inline base64-friendly reference)
  const logoSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 106.921 106.921" width="54" height="54">
    <defs>
      <linearGradient id="sl1" x1="0.874" x2="0.11" y1="0.034" y2="0.986" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#ff9b0c"/><stop offset="0.997" stop-color="#ff5229"/>
      </linearGradient>
      <linearGradient id="sl2" x1="0.5" x2="0.5" y1="0.027" y2="0.994" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#eda5ff"/><stop offset="1" stop-color="#fec24f"/>
      </linearGradient>
      <linearGradient id="sl3" x2="1" y1="0.5" y2="0.5" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#65ed00"/><stop offset="0.997" stop-color="#0096ff"/>
      </linearGradient>
      <linearGradient id="sl6" x1="0.131" x2="0.889" y1="0.029" y2="0.996" gradientUnits="objectBoundingBox">
        <stop offset="0.003" stop-color="#ffe86a"/><stop offset="1" stop-color="#ffb782"/>
      </linearGradient>
      <linearGradient id="sl7" x1="0.049" x2="0.965" y1="0.044" y2="0.971" gradientUnits="objectBoundingBox">
        <stop offset="0" stop-color="#ff9b0c"/><stop offset="0.997" stop-color="#ff5229"/>
      </linearGradient>
    </defs>
    <g transform="translate(7,4)">
      <path d="M47.268 21.928s-10.411-21.618-.073-41.726 33.975-24.223 33.975-24.223 10.41 21.619.073 41.727S47.268 21.928 47.268 21.928z" fill="url(#sl1)" opacity="0.85" transform="translate(-0.569 43.969)"/>
      <path d="M41.394 17.261s20.658-15.612 20.658-40.011-20.658-40.011-20.658-40.011-20.657 15.612-20.657 40.011 20.657 40.011 20.657 40.011z" fill="url(#sl2)" opacity="0.85" transform="translate(5.99 48.73)"/>
      <path d="M4.457 53.091a18.793 18.793 0 0 0 12.588 5.087 18.791 18.791 0 0 0 12.586-5.086 18.79 18.79 0 0 0-12.587-5.087A18.8 18.8 0 0 0 4.457 53.091z" fill="url(#sl3)" opacity="0.85" transform="translate(21.126 20.591)"/>
      <path d="M34.864 21.928s10.411-21.618.074-41.726-33.975-24.223-33.975-24.223-10.411 21.619-.074 41.727 33.975 24.222 33.975 24.222z" fill="url(#sl6)" opacity="0.85" transform="translate(22.194 43.969)"/>
      <path d="M32.301 28.28s2.935-21.1-11.262-35.3-35.3-11.261-35.3-11.261-2.935 21.1 11.262 35.3 35.3 11.261 35.3 11.261z" fill="url(#sl7)" opacity="0.85" transform="translate(24.945 36.806)"/>
    </g>
  </svg>`;

  let sections = '';

  // ─── PORTFOLIO SUMMARY ───
  if (incPortfolio) {
    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #ff9b0c">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#FF9B0C,#FF5229);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Portfolio Summary</h3>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
          ${stmtKPIBox('Total Portfolio Value', fmtNum(totalValue), '#ff9b0c')}
          ${stmtKPIBox('Capital Deployed', fmtNum(totalInvested), '#2F8C9B')}
          ${stmtKPIBox('Returns Earned', fmtNum(totalReturns), '#22C55E')}
          ${stmtKPIBox('Wallet Balance', fmtNum(walletBal), '#A855F7')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Account Details</div>
            ${stmtInfoRow('Investor Name', fullName)}
            ${stmtInfoRow('Investor ID', investorId)}
            ${stmtInfoRow('Email', investor.email || '—')}
            ${stmtInfoRow('Phone', investor.phone || '—')}
            ${stmtInfoRow('Member Since', memberSince)}
            ${stmtInfoRow('FICA Status', ficaStatus.charAt(0).toUpperCase() + ficaStatus.slice(1))}
          </div>
          <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Investment Snapshot</div>
            ${stmtInfoRow('Total Investments', investments.length)}
            ${stmtInfoRow('Active Investments', activeInv)}
            ${stmtInfoRow('Matured/Paid Out', investments.filter(i=>['matured','paid_out'].includes(i.status)).length)}
            ${stmtInfoRow('Risk Profile', investor.risk_profile ? investor.risk_profile.charAt(0).toUpperCase() + investor.risk_profile.slice(1) : 'Moderate')}
            ${stmtInfoRow('Province', investor.province || '—')}
            ${stmtInfoRow('Referral Code', investor.referral_code || '—')}
          </div>
        </div>
      </section>`;
  }

  // ─── PERFORMANCE ANALYSIS ───
  if (incPerformance && investments.length > 0) {
    const byProduct = {};
    investments.forEach(inv => {
      const p = inv.product_type || 'unknown';
      if (!byProduct[p]) byProduct[p] = { count: 0, capital: 0, returns: 0 };
      byProduct[p].count++;
      byProduct[p].capital += Number(inv.amount) || 0;
      byProduct[p].returns += Number(inv.actual_return_amount) || 0;
    });

    const perfRows = Object.entries(byProduct).map(([prod, d]) => {
      const pct = d.capital > 0 ? ((d.returns / d.capital) * 100).toFixed(2) : '0.00';
      const info = getProductInfo(prod);
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:11px;font-weight:700;color:#1a1a1a">${info.label}</td>
        <td style="padding:8px 10px;font-size:11px;color:#6b7280;text-align:center">${d.count}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:600">${fmtNum(d.capital)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#22C55E;text-align:right;font-weight:700">${fmtNum(d.returns)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#ff9b0c;text-align:right;font-weight:700">${pct}%</td>
      </tr>`;
    }).join('');

    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #2F8C9B">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#2F8C9B,#0096FF);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Performance Analysis</h3>
        </div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea">
          <thead>
            <tr style="background:#F7F8FA">
              <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
              <th style="padding:9px 10px;font-size:10px;text-align:center;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Count</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Capital</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Returns</th>
              <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Return %</th>
            </tr>
          </thead>
          <tbody>${perfRows}</tbody>
          <tfoot>
            <tr style="background:#F7F8FA">
              <td colspan="2" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">TOTAL</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a;text-align:right">${fmtNum(totalInvested)}</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#22C55E;text-align:right">${fmtNum(totalReturns)}</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#ff9b0c;text-align:right">${totalInvested>0?((totalReturns/totalInvested)*100).toFixed(2):0}%</td>
            </tr>
          </tfoot>
        </table>
      </section>`;
  }

  // ─── INVESTMENT DETAILS ───
  if (incInvestments && investments.length > 0) {
    const invRows = investments.map(inv => {
      const info = getProductInfo(inv.product_type);
      const rate = ((Number(inv.expected_return_rate)||0)*100).toFixed(2);
      const maturity = inv.maturity_date ? fmtDate(inv.maturity_date) : '—';
      const statusColor = inv.status === 'active' ? '#2F8C9B' : inv.status === 'paid_out' ? '#22C55E' : '#9ca3af';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:8px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${inv.id}</td>
        <td style="padding:8px 10px;font-size:11px;font-weight:600;color:#1a1a1a">${inv.pool_name || '—'}</td>
        <td style="padding:8px 10px">
          <span style="background:${info.bg};color:${info.color};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em">${info.label}</span>
        </td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right;font-weight:700">${fmtNum(inv.amount)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#ff9b0c;text-align:right;font-weight:700">${rate}%</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right">${fmtDate(inv.investment_date)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:right">${maturity}</td>
        <td style="padding:8px 10px">
          <span style="color:${statusColor};font-size:10px;font-weight:700;text-transform:uppercase">${inv.status}</span>
        </td>
      </tr>`;
    }).join('');

    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #22C55E">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#22C55E,#16A34A);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Investment Details</h3>
          <span style="margin-left:auto;font-size:10px;color:#9ca3af">${investments.length} records</span>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:700px">
            <thead>
              <tr style="background:#F7F8FA">
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">ID</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Pool</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Product</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Rate</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Invested</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Maturity</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Status</th>
              </tr>
            </thead>
            <tbody>${invRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ─── TRANSACTION LEDGER ───
  if (incTransactions) {
    const txnRows = transactions.length > 0 ? transactions.map(t => {
      const isPos = t.type !== 'withdrawal' && t.type !== 'fee';
      const amt = isPos ? `+${fmtNum(Math.abs(t.amount))}` : `-${fmtNum(Math.abs(t.amount))}`;
      const amtColor = isPos ? '#22C55E' : '#EF4444';
      const typeMap = {deposit:'Deposit',withdrawal:'Withdrawal',investment:'Investment',return:'Return',payout:'Payout',fee:'Fee',referral_bonus:'Referral Bonus'};
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:7px 10px;font-size:10px;color:#9ca3af;font-family:monospace">${t.reference || '—'}</td>
        <td style="padding:7px 10px;font-size:11px;color:#1a1a1a">${typeMap[t.type] || t.type}</td>
        <td style="padding:7px 10px;font-size:11px;color:#1a1a1a">${t.pool_name || t.description || '—'}</td>
        <td style="padding:7px 10px;font-size:11px;font-weight:700;color:${amtColor};text-align:right">${amt}</td>
        <td style="padding:7px 10px;font-size:10px;color:#9ca3af;text-align:right">${fmtDate(t.transaction_date || t.created_at)}</td>
        <td style="padding:7px 10px">
          <span style="background:${t.status==='completed'?'#dcfce7':'#fef9c3'};color:${t.status==='completed'?'#16a34a':'#92400e'};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase">${t.status}</span>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="padding:20px;text-align:center;color:#9ca3af;font-size:11px">No transactions in selected period</td></tr>`;

    // Running balance
    let running = 0;
    const sortedTxns = [...transactions].sort((a,b) => new Date(a.transaction_date||a.created_at) - new Date(b.transaction_date||b.created_at));
    const totalDeposits = transactions.filter(t=>t.type==='deposit').reduce((s,t)=>s+Number(t.amount||0),0);
    const totalWithdrawals = transactions.filter(t=>t.type==='withdrawal'||t.type==='investment').reduce((s,t)=>s+Math.abs(Number(t.amount||0)),0);
    const totalReturnsTxn = transactions.filter(t=>t.type==='return'||t.type==='payout').reduce((s,t)=>s+Number(t.amount||0),0);

    sections += `
      <section style="margin-bottom:36px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #A855F7">
          <div style="width:4px;height:22px;background:linear-gradient(180deg,#A855F7,#7C3AED);border-radius:2px"></div>
          <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">Transaction Ledger</h3>
          <span style="margin-left:auto;font-size:10px;color:#9ca3af">${transactions.length} transactions · ${fmtDate(from)} — ${fmtDate(to)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
          ${stmtMiniBox('Total Deposits', fmtNum(totalDeposits), '#22C55E')}
          ${stmtMiniBox('Total Invested', fmtNum(totalWithdrawals), '#2F8C9B')}
          ${stmtMiniBox('Returns Received', fmtNum(totalReturnsTxn), '#ff9b0c')}
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:600px">
            <thead>
              <tr style="background:#F7F8FA">
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Reference</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Type</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Description</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Amount</th>
                <th style="padding:9px 10px;font-size:10px;text-align:right;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Date</th>
                <th style="padding:9px 10px;font-size:10px;text-align:left;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em">Status</th>
              </tr>
            </thead>
            <tbody>${txnRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ─── FULL DOCUMENT ───
  return `
    <div id="stmtPrintArea" style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:#fff;min-height:100%">

      <!-- Header Band -->
      <div style="background:linear-gradient(135deg,#1a3a4a 0%,#0d2535 100%);padding:32px 40px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:16px">
          ${logoSVG}
          <div>
            <div style="font-size:20px;font-weight:900;color:#fff;letter-spacing:0.06em;line-height:1">SV CAPITAL</div>
            <div style="font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:0.12em;margin-top:3px;font-weight:500">INVESTMENTS THAT MAKE SENSE</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:16px;font-weight:800;color:#ff9b0c;letter-spacing:0.04em">ACCOUNT STATEMENT</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:4px"># ${statementNumber}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:2px">Generated: ${generatedAt}</div>
        </div>
      </div>

      <!-- Period Banner -->
      <div style="background:linear-gradient(90deg,rgba(255,155,12,0.08),rgba(47,140,155,0.06));border-top:3px solid #ff9b0c;border-bottom:1px solid rgba(0,0,0,0.06);padding:12px 40px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Statement Period:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${fmtDate(from)} — ${fmtDate(to)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Investor:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${fullName}</span>
          <span style="background:rgba(255,155,12,0.1);color:#ff5229;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid rgba(255,155,12,0.2);margin-left:4px">${investorId}</span>
        </div>
      </div>

      <!-- Body -->
      <div style="padding:32px 40px">
        ${sections}
      </div>

      <!-- Footer -->
      <div style="background:#F7F8FA;border-top:1px solid rgba(0,0,0,0.07);padding:20px 40px;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:10px;font-weight:700;color:#1a1a1a;margin-bottom:3px">SmartVest Financial Services (Pty) Ltd</div>
          <div style="font-size:9px;color:#9ca3af">Authorised Financial Services Provider · FSP License #52449 · Regulated by the FSCA</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;color:#9ca3af">info@svcapital.co.za · www.svcapital.co.za</div>
          <div style="font-size:9px;color:#c1c7d0;margin-top:2px">This statement is computer generated and does not require a signature.</div>
        </div>
      </div>

    </div>`;
}

function stmtKPIBox(label, value, color) {
  return `<div style="background:linear-gradient(135deg,${color}08,${color}12);border:1px solid ${color}22;border-radius:10px;padding:16px;text-align:center">
    <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:6px">${label}</div>
    <div style="font-size:15px;font-weight:900;color:${color};letter-spacing:-0.02em">${value}</div>
  </div>`;
}

function stmtMiniBox(label, value, color) {
  return `<div style="background:#F7F8FA;border:1px solid rgba(0,0,0,0.06);border-radius:8px;padding:12px">
    <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:4px">${label}</div>
    <div style="font-size:13px;font-weight:800;color:${color}">${value}</div>
  </div>`;
}

function stmtInfoRow(label, val) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:10px">
    <span style="color:#9ca3af;font-weight:600">${label}</span>
    <span style="font-weight:700;color:#1a1a1a">${val}</span>
  </div>`;
}

function getProductInfo(type) {
  const map = {
    cattle:        { label:'Cattle Finance',   color:'#d97706', bg:'#fef3c7' },
    solar_7yr:     { label:'Solar 7yr',        color:'#ea580c', bg:'#ffedd5' },
    solar_6yr:     { label:'Solar 6yr',        color:'#ea580c', bg:'#fff7ed' },
    solar_5yr:     { label:'Solar 5yr',        color:'#c2410c', bg:'#fff7ed' },
    short_term:    { label:'SMME Short-Term',  color:'#2563eb', bg:'#dbeafe' },
    delivery_bike: { label:'Delivery Bike',    color:'#7c3aed', bg:'#ede9fe' },
  };
  return map[type] || { label: type || 'Investment', color:'#6b7280', bg:'#f3f4f6' };
}

function printStatement() {
  // Use statementDocument container (which holds the rendered HTML)
  const doc = document.getElementById('statementDocument');
  if (!doc || !doc.innerHTML.trim()) {
    Toast.error('Please generate a statement first, then print.');
    return;
  }
  const printWin = window.open('', '_blank', 'width=960,height=800');
  if (!printWin) {
    Toast.error('Pop-up blocked. Please allow pop-ups for this site.');
    return;
  }
  printWin.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SV Capital — Account Statement</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;color:#1a1a1a}
    @page{size:A4;margin:0}
    @media print{.no-print{display:none!important}.print-body{padding-top:0!important}}
    .no-print{position:fixed;top:0;left:0;right:0;background:#1a1a1a;padding:12px 24px;display:flex;justify-content:space-between;align-items:center;z-index:999;box-shadow:0 2px 12px rgba(0,0,0,0.3)}
    .no-print span{color:#fff;font-size:13px;font-weight:600;font-family:'Inter',sans-serif}
    .no-print button{background:linear-gradient(135deg,#FF9B0C,#FF5229);color:#fff;border:none;padding:8px 22px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif}
    .no-print button:hover{opacity:0.9}
    .print-body{padding-top:50px}
  </style>
</head>
<body>
  <div class="no-print">
    <span>SV Capital — Account Statement</span>
    <button onclick="window.print()">⬇&nbsp; Save as PDF / Print</button>
  </div>
  <div class="print-body">${doc.innerHTML}</div>
</body>
</html>`);
  printWin.document.close();
}

/* ─── Profile ─── */
function saveProfile() { Toast.success('Profile updated successfully'); }

/* ─── Referral ─── */
function copyReferralLink() {
  const link = document.getElementById('referralLink').textContent;
  navigator.clipboard.writeText(link).then(() => Toast.success('Link copied to clipboard!')).catch(() => Toast.error('Copy failed'));
}

/* ═══════════════════════════════════════════════════════════════
   GAMIFICATION — XP, Quests & Learning Hub
   ═══════════════════════════════════════════════════════════════ */

const XP_LEVELS = [
  { id: 'seed',       label: 'Seed',       min: 0,    icon: 'fa-seedling',         color: '#9ca3af' },
  { id: 'sprout',     label: 'Sprout',     min: 100,  icon: 'fa-leaf',             color: '#22c55e' },
  { id: 'grower',     label: 'Grower',     min: 300,  icon: 'fa-tree',             color: '#16a34a' },
  { id: 'cultivator', label: 'Cultivator', min: 600,  icon: 'fa-spa',              color: '#2F8C9B' },
  { id: 'harvester',  label: 'Harvester',  min: 1000, icon: 'fa-wheat-awn',        color: '#ff9b0c' },
  { id: 'pioneer',    label: 'Pioneer',    min: 1500, icon: 'fa-compass',          color: '#f59e0b' },
  { id: 'architect',  label: 'Architect',  min: 2500, icon: 'fa-building-columns', color: '#a855f7' },
  { id: 'luminary',   label: 'Luminary',   min: 5000, icon: 'fa-crown',            color: '#D4AF37' },
];

function _getLevelForXP(xp) {
  let level = XP_LEVELS[0];
  for (const l of XP_LEVELS) {
    if (xp >= l.min) level = l;
    else break;
  }
  return level;
}

function _getNextLevel(xp) {
  return XP_LEVELS.find(l => l.min > xp) || null;
}

/* ─── Fetch quest data from server ─────────────────────── */
async function loadQuestData() {
  try {
    const token = Auth.getToken();
    if (!token) return;
    const res  = await fetch('/api/quests/my', {
      headers: { 'Authorization': `Bearer ${token}` },
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
    PORTAL.quests = data;

    // Auto-detect and claim milestone quests silently
    await _autoClaimMilestones();

    renderXPWidget();
    _updateXPNavBadge();
  } catch (e) {
    console.warn('[Quests] loadQuestData failed:', e.message);
  }
}

/* ─── Check milestone conditions and auto-claim if met ─── */
async function _autoClaimMilestones() {
  if (!PORTAL.quests || !PORTAL.investor) return;
  const completed = new Set(PORTAL.quests.completedIds || []);
  const inv       = PORTAL.investor;
  const invests   = PORTAL.investments;
  const txns      = PORTAL.transactions;
  const totalInvested = parseFloat(inv.total_invested) || 0;

  const productTypes = new Set(invests.filter(i => i.status === 'active' || i.status === 'paid_out')
    .map(i => i.product_type).filter(Boolean));

  const milestoneConditions = {
    first_topup:    txns.some(t => t.type === 'deposit'),
    first_investment: invests.length > 0,
    diversify:      productTypes.size >= 2,
    milestone_10k:  totalInvested >= 10000,
    milestone_50k:  totalInvested >= 50000,
    milestone_100k: totalInvested >= 100000,
  };

  for (const [questId, met] of Object.entries(milestoneConditions)) {
    if (met && !completed.has(questId)) {
      try {
        const result = await _postQuestComplete(questId, {});
        if (result && !result.error) {
          completed.add(questId);
          PORTAL.quests.completedIds = [...completed];
          PORTAL.quests.xp   = result.newXP;
          PORTAL.quests.xpToNext = result.xpToNext;
          if (result.leveledUp) _showLevelUpModal(result);
        }
      } catch (_) {}
    }
  }
}

/* ─── POST to complete a quest ──────────────────────────── */
async function _postQuestComplete(questId, data) {
  const token = Auth.getToken();
  if (!token) return null;
  const res = await fetch('/api/quests/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    credentials: 'include',
    body: JSON.stringify({ questId, data }),
  });
  return res.json();
}

/* ─── XP bar widget in overview ─────────────────────────── */
function renderXPWidget() {
  const q = PORTAL.quests;
  if (!q) return;

  const xp    = q.xp || 0;
  const lvl   = _getLevelForXP(xp);
  const next  = _getNextLevel(xp);
  const pct   = next ? Math.round(((xp - lvl.min) / (next.min - lvl.min)) * 100) : 100;

  const wrap = document.getElementById('xpProgressWrap');
  if (wrap) wrap.style.display = 'flex';

  const pill = document.getElementById('xpLevelPill');
  if (pill) {
    pill.innerHTML = `<i class="fa-solid ${lvl.icon}"></i> ${lvl.label}`;
    pill.style.background = lvl.color;
  }

  const fill = document.getElementById('xpProgressFill');
  if (fill) fill.style.width = pct + '%';

  const label = document.getElementById('xpProgressLabel');
  if (label) label.textContent = xp.toLocaleString('en-ZA') + ' XP';

  const nextEl = document.getElementById('xpProgressNext');
  if (nextEl) nextEl.textContent = next ? `+${(next.min - xp).toLocaleString('en-ZA')} to ${next.label}` : 'Max level!';
}

/* ─── Update sidebar XP badge with pending quest count ─── */
function _updateXPNavBadge() {
  const q = PORTAL.quests;
  if (!q) return;

  const completed = new Set(q.completedIds || []);
  const inv       = PORTAL.investor;
  const invests   = PORTAL.investments;
  const txns      = PORTAL.transactions;
  const totalInvested = parseFloat(inv?.total_invested) || 0;

  const productTypes = new Set(invests.filter(i => i.status === 'active' || i.status === 'paid_out')
    .map(i => i.product_type).filter(Boolean));

  const milestones = {
    first_topup:    txns.some(t => t.type === 'deposit'),
    first_investment: invests.length > 0,
    diversify:      productTypes.size >= 2,
    milestone_10k:  totalInvested >= 10000,
    milestone_50k:  totalInvested >= 50000,
    milestone_100k: totalInvested >= 100000,
  };

  const readyCount = q.quests.filter(quest => {
    if (completed.has(quest.id)) return false;
    if (quest.category === 'milestone') return milestones[quest.id] === true;
    if (quest.category === 'profile' || quest.category === 'learning') return true;
    return false;
  }).length;

  const badge = document.getElementById('xpNavBadge');
  if (badge) {
    if (readyCount > 0) {
      badge.textContent = readyCount;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }
}

/* ═════════════════════════════════════════════════════════
   QUEST VIEW
   ═════════════════════════════════════════════════════════ */
function renderQuestView() {
  if (!PORTAL.quests) {
    loadQuestData().then(renderQuestView);
    return;
  }

  const q         = PORTAL.quests;
  const xp        = q.xp || 0;
  const lvl       = _getLevelForXP(xp);
  const next      = _getNextLevel(xp);
  const completed = new Set(q.completedIds || []);

  // ── Hero
  const heroIcon = document.getElementById('questLevelIcon');
  if (heroIcon) { heroIcon.innerHTML = `<i class="fa-solid ${lvl.icon}"></i>`; heroIcon.style.background = lvl.color; }
  const heroName = document.getElementById('questLevelName');
  if (heroName) heroName.textContent = lvl.label;
  const heroXP = document.getElementById('questXpVal');
  if (heroXP) heroXP.textContent = xp.toLocaleString('en-ZA') + ' XP';
  const heroBar = document.getElementById('questXpBar');
  if (heroBar) {
    const pct = next ? Math.round(((xp - lvl.min) / (next.min - lvl.min)) * 100) : 100;
    heroBar.style.width = pct + '%';
    heroBar.style.background = lvl.color;
  }
  const heroTrackLabel = document.getElementById('questXpTrackLabel');
  if (heroTrackLabel) heroTrackLabel.textContent = next ? `${(next.min - xp).toLocaleString('en-ZA')} XP to ${next.label} (+R50)` : 'Maximum level reached!';

  // ── Rewards earned (levels passed × R50)
  const levelsEarned = XP_LEVELS.filter(l => l.min > 0 && xp >= l.min).length;
  const rewardsEl = document.getElementById('questRewardsEarned');
  if (rewardsEl) rewardsEl.textContent = `R${levelsEarned * 50}`;

  // ── Level track
  const trackEl = document.getElementById('levelTrack');
  if (trackEl) {
    trackEl.innerHTML = XP_LEVELS.map(l => {
      const isDone    = xp >= l.min;
      const isCurrent = lvl.id === l.id;
      return `
        <div class="level-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}">
          <div class="level-step__icon" style="${isCurrent ? `background:${l.color};color:#fff;box-shadow:0 4px 14px ${l.color}55` : isDone ? `background:${l.color}22;color:${l.color};border:2px solid ${l.color}` : ''}">
            <i class="fa-solid ${l.icon}"></i>
          </div>
          <div class="level-step__name">${l.label}</div>
          ${l.min > 0 ? `<div class="level-step__reward" style="color:${isCurrent||isDone?l.color:'#9ca3af'}">+R50</div>` : ''}
        </div>`;
    }).join('');
  }

  // ── Quest categories
  const categories = [
    { key: 'profile',   label: 'Profile & Compliance', icon: 'fa-user-check',      desc: 'Help us know you better. Each survey unlocks better investment recommendations.' },
    { key: 'milestone', label: 'Investment Milestones', icon: 'fa-trophy',          desc: 'Earn XP for reaching investment goals. Milestones are auto-detected.' },
    { key: 'learning',  label: 'Learning Modules',      icon: 'fa-graduation-cap',  desc: 'Earn XP for completing educational modules in the Learning Hub.' },
  ];

  const catEl = document.getElementById('questCategories');
  if (!catEl) return;

  const inv       = PORTAL.investor;
  const invests   = PORTAL.investments;
  const txns      = PORTAL.transactions;
  const totalInv  = parseFloat(inv?.total_invested) || 0;
  const productTypes = new Set(invests.filter(i => i.status === 'active' || i.status === 'paid_out').map(i => i.product_type).filter(Boolean));

  const milestones = {
    first_topup:    txns.some(t => t.type === 'deposit'),
    first_investment: invests.length > 0,
    diversify:      productTypes.size >= 2,
    milestone_10k:  totalInv >= 10000,
    milestone_50k:  totalInv >= 50000,
    milestone_100k: totalInv >= 100000,
    set_maturity:   false,   // can't auto-detect without loading maturity_instructions
    first_referral: false,
  };

  // ── Helper: build a single quest card HTML
  function _qCard(quest, cat) {
    const isDone  = completed.has(quest.id);
    const isReady = !isDone && (
      cat === 'profile'   ? true :
      cat === 'milestone' ? milestones[quest.id] === true :
      cat === 'learning'  ? true : false
    );
    return `
      <div class="quest-card ${isDone ? 'quest-card--done' : isReady ? 'quest-card--ready' : ''}" id="qcard-${quest.id}">
        <div class="quest-card__icon" style="background:${quest.color}22;color:${quest.color}">
          <i class="fa-solid ${quest.icon}"></i>
        </div>
        <div class="quest-card__body">
          <div class="quest-card__title">${quest.title}</div>
          ${quest.description ? `<div class="quest-card__desc">${quest.description}</div>` : ''}
        </div>
        <div class="quest-card__right">
          <div class="quest-card__xp" style="color:${quest.color}">+${quest.xp} XP</div>
          ${isDone
            ? `<div class="quest-card__done-badge"><i class="fa-solid fa-circle-check"></i> Done</div>`
            : isReady
              ? (cat === 'milestone'
                  ? `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="claimMilestoneQuest('${quest.id}')">Claim</button>`
                  : cat === 'learning'
                    ? `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="navigate('learn', document.querySelector('[data-view=learn]'))">Start</button>`
                    : `<button class="btn quest-claim-btn" style="background:${quest.color}" onclick="openSurveyModal('${quest.id}')">Start</button>`)
              : `<div class="quest-card__locked"><i class="fa-solid fa-lock-open"></i> Available</div>`
          }
        </div>
      </div>`;
  }

  // ── "What to do next" pending section ─────────────────
  const claimable  = q.quests.filter(quest => quest.category === 'milestone' && !completed.has(quest.id) && milestones[quest.id] === true);
  const quickWins  = q.quests.filter(quest => quest.category === 'profile'   && !completed.has(quest.id));
  const learnReady = q.quests.filter(quest => quest.category === 'learning'  && !completed.has(quest.id));
  const totalPending = claimable.length + quickWins.length + learnReady.length;

  let pendingHtml = '';
  if (totalPending > 0) {
    const pendingXP = [...claimable, ...quickWins, ...learnReady].reduce((s, qst) => s + qst.xp, 0);
    const nextLvlXp = next ? (next.min - xp) : 0;

    let pendingGroups = '';
    if (claimable.length) {
      pendingGroups += `
        <div class="pending-group">
          <div class="pending-group__label"><i class="fa-solid fa-gift" style="color:#22c55e"></i> Ready to claim — milestone reached!</div>
          <div class="quest-cards-grid">${claimable.map(qst => _qCard(qst, 'milestone')).join('')}</div>
        </div>`;
    }
    if (quickWins.length) {
      pendingGroups += `
        <div class="pending-group">
          <div class="pending-group__label"><i class="fa-solid fa-bolt" style="color:#ff9b0c"></i> Quick wins — complete a short survey</div>
          <div class="quest-cards-grid">${quickWins.map(qst => _qCard(qst, 'profile')).join('')}</div>
        </div>`;
    }
    if (learnReady.length) {
      pendingGroups += `
        <div class="pending-group">
          <div class="pending-group__label"><i class="fa-solid fa-graduation-cap" style="color:#2F8C9B"></i> Learning modules — earn XP & knowledge</div>
          <div class="quest-cards-grid">${learnReady.map(qst => _qCard(qst, 'learning')).join('')}</div>
        </div>`;
    }

    pendingHtml = `
      <div class="pending-section mb-28">
        <div class="pending-section__header">
          <div class="pending-section__title-row">
            <div>
              <div class="pending-section__title"><i class="fa-solid fa-list-check"></i> What to do next</div>
              <div class="pending-section__sub">${totalPending} reward${totalPending !== 1 ? 's' : ''} waiting for you · <span style="color:var(--gold)">${pendingXP} XP available</span>${nextLvlXp > 0 ? ` · <span style="color:#22c55e">${nextLvlXp} XP to next level (+R50)</span>` : ''}</div>
            </div>
          </div>
        </div>
        ${pendingGroups}
      </div>`;
  }

  // ── Full category breakdown ──────────────────────────
  const categoryHtml = categories.map(cat => {
    const catQuests = q.quests.filter(quest => quest.category === cat.key);
    const doneCount = catQuests.filter(quest => completed.has(quest.id)).length;
    const questCards = catQuests.map(quest => _qCard(quest, cat.key)).join('');

    return `
      <div class="quest-category mb-24">
        <div class="quest-category__header">
          <div class="quest-category__icon-wrap" style="background:rgba(255,155,12,0.1)">
            <i class="fa-solid ${cat.icon}" style="color:#ff9b0c"></i>
          </div>
          <div>
            <div class="quest-category__title">${cat.label}</div>
            <div class="quest-category__sub">${cat.desc}</div>
          </div>
          <div class="quest-category__progress ml-auto">
            <div class="quest-category__count">${doneCount}/${catQuests.length}</div>
            <div class="quest-cat-bar"><div class="quest-cat-bar__fill" style="width:${Math.round((doneCount/catQuests.length)*100)}%"></div></div>
          </div>
        </div>
        <div class="quest-cards-grid">${questCards}</div>
      </div>`;
  }).join('');

  catEl.innerHTML = pendingHtml + categoryHtml;
}

/* ─── Claim a milestone quest via button ─────────────────── */
async function claimMilestoneQuest(questId) {
  const btn = document.querySelector(`#qcard-${questId} .quest-claim-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const result = await _postQuestComplete(questId, {});
    if (result.error) {
      if (result.error.includes('already completed')) {
        Toast.info('Already claimed!');
      } else {
        Toast.error(result.error);
      }
    } else {
      Toast.success(`+${result.xpAwarded} XP earned!`);
      if (PORTAL.quests) {
        PORTAL.quests.xp  = result.newXP;
        PORTAL.quests.xpToNext = result.xpToNext;
        PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), questId];
      }
      if (result.leveledUp) _showLevelUpModal(result);
      renderQuestView();
      renderXPWidget();
      _updateXPNavBadge();
    }
  } catch (e) {
    Toast.error('Failed to claim reward. Try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Claim'; }
  }
}

/* ─── Survey Modal ───────────────────────────────────────── */
function openSurveyModal(questId) {
  const q = PORTAL.quests?.quests?.find(q => q.id === questId);
  if (!q) return;

  const answers = {};
  const questionsHtml = (q.questions || []).map((ques, i) => {
    if (ques.type === 'choice') {
      return `
        <div class="survey-q" data-qid="${ques.id}">
          <div class="survey-q__label">${i + 1}. ${ques.label}</div>
          <div class="survey-q__options">
            ${ques.options.map((opt, j) => `
              <label class="survey-opt">
                <input type="radio" name="sq_${questId}_${i}" value="${opt}">
                <span>${opt}</span>
              </label>`).join('')}
          </div>
        </div>`;
    }
    // text input
    return `
      <div class="survey-q" data-qid="${ques.id}">
        <div class="survey-q__label">${i + 1}. ${ques.label}</div>
        <input class="form-input" type="text" placeholder="${ques.placeholder || ''}" data-sqid="${questId}-${ques.id}">
      </div>`;
  }).join('');

  document.getElementById('surveyModalContent').innerHTML = `
    <div class="survey-modal-header">
      <div class="survey-modal-icon" style="background:${q.color}22;color:${q.color}">
        <i class="fa-solid ${q.icon}"></i>
      </div>
      <div>
        <div class="survey-modal-title">${q.title}</div>
        <div class="survey-modal-sub">${q.description || ''}</div>
      </div>
      <div class="survey-modal-xp" style="color:${q.color}">+${q.xp} XP</div>
    </div>
    <div class="survey-body">${questionsHtml}</div>
    <div class="survey-footer">
      <button class="btn btn--secondary" onclick="closeSurveyModal()">Cancel</button>
      <button class="btn btn--primary survey-submit-btn" onclick="submitSurvey('${questId}')">
        <i class="fa-solid fa-paper-plane"></i> Submit &amp; Earn XP
      </button>
    </div>`;

  document.getElementById('surveyModal').style.display = 'flex';
}

function closeSurveyModal() {
  document.getElementById('surveyModal').style.display = 'none';
}

async function submitSurvey(questId) {
  const q = PORTAL.quests?.quests?.find(q => q.id === questId);
  if (!q) return;

  const data = {};
  let allAnswered = true;

  (q.questions || []).forEach((ques, i) => {
    if (ques.type === 'choice') {
      const checked = document.querySelector(`input[name="sq_${questId}_${i}"]:checked`);
      if (checked) data[ques.id] = checked.value;
      else allAnswered = false;
    } else {
      const inp = document.querySelector(`input[data-sqid="${questId}-${ques.id}"]`);
      if (inp && inp.value.trim()) data[ques.id] = inp.value.trim();
      else allAnswered = false;
    }
  });

  if (!allAnswered) {
    Toast.error('Please answer all questions before submitting.');
    return;
  }

  const btn = document.querySelector('.survey-submit-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...'; }

  try {
    const result = await _postQuestComplete(questId, data);
    if (result.error) {
      Toast.error(result.error.includes('already') ? 'Already completed!' : result.error);
      closeSurveyModal();
    } else {
      closeSurveyModal();
      Toast.success(`+${result.xpAwarded} XP earned!`);
      if (PORTAL.quests) {
        PORTAL.quests.xp  = result.newXP;
        PORTAL.quests.xpToNext = result.xpToNext;
        PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), questId];
      }
      if (result.leveledUp) _showLevelUpModal(result);
      renderQuestView();
      renderXPWidget();
      _updateXPNavBadge();
    }
  } catch (e) {
    Toast.error('Submission failed. Please try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit & Earn XP'; }
  }
}

/* ─── Level-up Celebration Modal ────────────────────────── */
function _showLevelUpModal(result) {
  const lvl = XP_LEVELS.find(l => l.id === result.newLevel) || XP_LEVELS[0];

  document.getElementById('levelupIcon').innerHTML    = `<i class="fa-solid ${lvl.icon}"></i>`;
  document.getElementById('levelupIcon').style.background = lvl.color;
  document.getElementById('levelupLevel').textContent = lvl.label;
  document.getElementById('levelupXP').textContent    = `${result.newXP.toLocaleString('en-ZA')} XP total`;

  const rewardEl = document.getElementById('levelupReward');
  if (result.rewardGiven > 0) {
    rewardEl.innerHTML = `<strong>R${result.rewardGiven}</strong> has been added to your wallet! 🎉`;
    rewardEl.style.display = 'block';
  } else {
    rewardEl.style.display = 'none';
  }

  document.getElementById('levelUpModal').style.display = 'flex';
  _launchConfettiParticles();
}

function closeLevelUpModal() {
  document.getElementById('levelUpModal').style.display = 'none';
}

function _launchConfettiParticles() {
  const container = document.getElementById('levelupConfetti');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#ff9b0c', '#22c55e', '#2F8C9B', '#D4AF37', '#a855f7'];
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('span');
    p.style.cssText = `
      position:absolute;
      width:${6 + Math.random()*8}px;height:${6 + Math.random()*8}px;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      border-radius:${Math.random()>0.5?'50%':'2px'};
      top:0;left:${Math.random()*100}%;
      animation:confettiFall ${0.8 + Math.random()*1.2}s ease-in ${Math.random()*0.5}s forwards;
      opacity:0;
    `;
    container.appendChild(p);
  }
}

/* ═════════════════════════════════════════════════════════
   LEARNING HUB
   ═════════════════════════════════════════════════════════ */

const LEARN_MODULES = [
  // ── Explorer Track (getting started) ───────────────────
  {
    id: 'learn_what_is_svc', track: 'explorer', order: 1,
    title: 'What is SV Capital?', readTime: 5, xp: 50,
    icon: 'fa-building-columns', color: '#2F8C9B',
    keyPoints: [
      'SV Capital pools investor capital into tangible South African alternative assets',
      'Products include solar projects, cattle farming, short-term loans, and delivery bikes',
      'Each product has a defined term, return rate, and maturity date',
      'All investments are backed by real, income-generating assets',
    ],
    content: `SV Capital is a South African alternative investment platform that connects investors with real-economy projects generating above-inflation returns. Unlike unit trusts or share portfolios, your money is put to work in tangible assets — solar panels generating electricity, cattle being raised and sold at market, or secured loans to operating businesses.

Each investment has a clearly defined term (typically 6–36 months) and a fixed annual rate of return, so you know exactly what to expect. Your capital is tracked in real time on this portal, and returns are credited directly to your wallet on maturity.

The platform charges no entry fees and no monthly platform fees. Our revenue comes from structuring fees on the underlying transactions, so your quoted return is your net return.`,
  },
  {
    id: 'learn_how_returns', track: 'explorer', order: 2,
    title: 'How Your Returns Work', readTime: 7, xp: 50,
    icon: 'fa-percent', color: '#22c55e',
    keyPoints: [
      'Returns are expressed as an annual percentage rate (p.a.)',
      'Your actual payout = capital × annual rate × (term in days ÷ 365)',
      'Reinvesting your returns compounds your growth over time',
      'Effective return % accounts for the full term, not just one year',
    ],
    content: `When you invest with SV Capital, you earn a return based on two factors: the annual rate and the term. For example, R10,000 invested at 14% p.a. for 12 months returns R11,400 — the R10,000 original capital plus R1,400 in returns.

Shorter-term products like cattle cycles (150–180 days) work the same way, but on a pro-rated basis. A 14% annual rate for 150 days pays roughly R575 on a R10,000 investment.

The "effective return" you see on your dashboard is the annualised figure, allowing you to compare products fairly regardless of their term length.`,
  },
  {
    id: 'learn_solar', track: 'explorer', order: 3,
    title: 'Solar Energy Investing', readTime: 8, xp: 50,
    icon: 'fa-solar-panel', color: '#f59e0b',
    keyPoints: [
      'SV Capital funds solar panel installations for South African businesses',
      'Businesses pay structured lease or energy purchase agreements',
      'Returns typically range from 14–18% p.a. over 24–36 month terms',
      'Solar projects benefit from long-term, predictable contractual cash flows',
    ],
    content: `Solar projects work by financing the installation of commercial-scale photovoltaic (PV) systems for verified South African businesses. Once installed, the business pays a set monthly amount — either as an energy purchase agreement (EPA) or a finance lease — providing predictable monthly revenue.

SV Capital aggregates these returns and passes them to investors net of all structuring costs. Solar assets are long-duration, making them ideal for capital you do not need access to for 2–3 years. Loadshedding in South Africa has significantly increased demand for behind-the-meter solar, providing strong deal flow for this product.

Each solar project undergoes technical assessment, legal review, and business viability checks before being made available to investors.`,
  },
  {
    id: 'learn_cattle', track: 'explorer', order: 4,
    title: 'Cattle & Short-term Loans', readTime: 8, xp: 50,
    icon: 'fa-cow', color: '#a855f7',
    keyPoints: [
      'Cattle are purchased at auction, raised on commercial farms, and resold',
      'Each cycle typically runs 150–180 days with 12–16% p.a. returns',
      'Short-term loans are made to businesses with real collateral',
      'These shorter terms allow for reinvestment and capital recycling',
    ],
    content: `SV Capital's cattle product funds the purchase of commercial beef cattle at verified South African livestock auctions. The cattle are placed on contracted farms where they are fed and managed under professional supervision, then sold at market at the end of the cycle.

Returns are driven by weight gain and market price at sale. SV Capital hedges execution risk through diversified lots and vetted farming partners. Each batch is tracked and reported on in real time via the admin platform.

Short-term business loans are secured against verifiable collateral (trading assets, debtor books, or property bonds) and carry slightly lower rates than cattle due to their fixed repayment structure. Both products offer higher liquidity than solar, with capital recycling every 5–6 months.`,
  },
  {
    id: 'learn_diversification', track: 'explorer', order: 5,
    title: 'Diversification 101', readTime: 6, xp: 50,
    icon: 'fa-chart-pie', color: '#ff9b0c',
    keyPoints: [
      'Spreading capital across products reduces exposure to any single risk',
      'Different products have different maturity timelines, creating natural liquidity',
      'A blended portfolio smooths your overall return over time',
      'Diversification is not just by product — also consider term length and entry date',
    ],
    content: `Diversification means not putting all your eggs in one basket — a principle that applies as much to alternative investments as to traditional ones. By spreading your capital across solar, cattle, and loans, you reduce the impact if any single investment underperforms.

Equally important is timeline diversification. If all your investments mature at the same time, you face reinvestment risk. Staggering your investments across different start dates means you always have capital returning, which can be reinvested into new opportunities.

Our data shows that investors with 3+ active product types consistently achieve smoother returns and higher portfolio satisfaction than those concentrated in a single product.`,
  },

  // ── Builder Track (growing investor) ───────────────────
  {
    id: 'learn_risk', track: 'builder', order: 1,
    title: 'Risk vs Return', readTime: 8, xp: 50,
    icon: 'fa-scale-balanced', color: '#a855f7',
    keyPoints: [
      'Higher potential returns always come with higher risk — there are no exceptions',
      'Risk in alternative investments includes liquidity risk, operational risk, and market risk',
      'Your risk profile determines the right mix of products for you',
      'Diversification reduces but cannot eliminate all risk',
    ],
    content: `Every investment involves a trade-off between risk and return. At SV Capital, solar projects carry the lowest operational risk (contractual cash flows) but require the longest capital commitment. Cattle farming offers higher potential returns but involves biological and market variables that solar does not.

Understanding your own risk tolerance is critical. If you might need access to your capital within 12 months, short-term products are more appropriate than 36-month solar commitments. If you can commit capital for longer and tolerate some variability, the blended portfolio approach tends to deliver the best long-term outcomes.

The risk profile survey in the Earn Rewards section helps us calibrate your portfolio recommendations to your personal risk appetite.`,
  },
  {
    id: 'learn_compounding', track: 'builder', order: 2,
    title: 'The Compounding Effect', readTime: 7, xp: 50,
    icon: 'fa-chart-line', color: '#22c55e',
    keyPoints: [
      'Compounding means earning returns on your returns, not just your original capital',
      'The longer your investment horizon, the more powerful compounding becomes',
      'Reinvesting at maturity is the single most impactful decision you can make',
      'A 14% p.a. return, reinvested over 5 years, nearly doubles your capital',
    ],
    content: `Albert Einstein reportedly called compound interest the "eighth wonder of the world." In practice, compounding means that after your first investment matures, you reinvest both the original capital and the returns — so in the next cycle, you earn returns on a larger base.

At 14% p.a., R10,000 grows to R11,400 after year 1. Reinvested, it becomes R12,996 after year 2 — not R12,800. The difference compounds every year. After 5 years, R10,000 compounding at 14% p.a. becomes approximately R19,254 — nearly double.

The key to unlocking compounding is acting quickly at maturity. Capital sitting idle in your wallet earns nothing. Set your maturity instructions to reinvest, and let time do the work.`,
  },
  {
    id: 'learn_tax', track: 'builder', order: 3,
    title: 'Investment Tax in South Africa', readTime: 9, xp: 50,
    icon: 'fa-receipt', color: '#64748b',
    keyPoints: [
      'Investment returns from SV Capital are generally treated as ordinary income in South Africa',
      'You are required to declare investment returns in your annual tax return (ITR12)',
      'SV Capital issues statements to assist with your tax declarations',
      'Consult a registered tax practitioner for personalised advice',
    ],
    content: `In South Africa, income earned from investments is generally subject to income tax at your marginal rate. This applies to the returns (interest or profit share) you earn through SV Capital products. Your original capital returned at maturity is not taxable — only the profit portion is.

SARS requires you to disclose all South African and foreign income on your annual return (ITR12). Your SV Capital account statement (available under "My Statement") provides a breakdown of all returns earned in each tax year, which you or your accountant can use for tax submissions.

Note that SV Capital does not deduct tax at source — you are responsible for declaring and paying tax on returns earned. If your total investment income exceeds R23,800 per year (the annual interest exemption for individuals under 65), the excess is taxable. We strongly recommend consulting a registered tax practitioner.`,
  },

  // ── Strategist Track (advanced) ────────────────────────
  {
    id: 'learn_yield_opt', track: 'strategist', order: 1,
    title: 'Yield Optimisation', readTime: 10, xp: 50,
    icon: 'fa-chart-line-up', color: '#ff9b0c',
    keyPoints: [
      'Blending high-rate short-term products with stable long-term ones maximises risk-adjusted yield',
      'Entry timing and reinvestment speed have a significant impact on effective annualised returns',
      'Laddering (staggered maturity dates) ensures continuous capital deployment',
      'Idle wallet balances are a hidden drag on your portfolio performance',
    ],
    content: `Yield optimisation is about maximising your effective annualised return across your whole portfolio — not just picking the highest individual rate. A sophisticated investor uses a laddering strategy: starting multiple investments with staggered maturity dates so capital is always being deployed or reinvested.

Equally, minimise idle time. Capital sitting in your wallet between investments earns 0%. Even a 2-week idle period on R50,000 costs you approximately R380 in lost returns at 14% p.a. The fastest investors reinvest within 48 hours of maturity.

The optimal blend for most SV Capital investors in 2025 is approximately 40% solar (stable base), 40% cattle/loans (higher rate, shorter term), and 20% in reserve for opportunistic reinvestment when high-rate pools open.`,
  },
  {
    id: 'learn_estate', track: 'strategist', order: 2,
    title: 'Protecting Your Investment Wealth', readTime: 12, xp: 50,
    icon: 'fa-people-roof', color: '#22c55e',
    keyPoints: [
      'South African law requires all assets to go through the estate when you die',
      'Naming a beneficiary ensures your family knows where your investments are',
      'SV Capital stores your beneficiary details securely in your profile',
      'A will that references your investment accounts speeds up estate administration',
    ],
    content: `Many investors focus on growing wealth but neglect protecting it for the next generation. In South Africa, all assets — including investments on platforms like SV Capital — form part of your deceased estate and must go through the Master of the High Court unless specifically structured otherwise.

The most important first step is ensuring your beneficiary details are on file with SV Capital (add them via the "Complete Your Profile" quest), and that your will references your investment accounts. Without clear documentation, your family may wait months or years to access funds.

For larger portfolios (R500,000+), consider consulting an estate planner about structuring investments via a trust or company to minimise estate duty and executor's fees. Estate duty in South Africa is charged at 20% on dutiable estates above R3.5 million.`,
  },
];

const LEARN_TRACKS = [
  { id: 'explorer',   label: 'Explorer',   desc: 'New to investing — start here',        icon: 'fa-compass',          color: '#2F8C9B',  minInvested: 0 },
  { id: 'builder',    label: 'Builder',    desc: 'Growing your portfolio',                icon: 'fa-hammer',           color: '#22c55e',  minInvested: 5000 },
  { id: 'strategist', label: 'Strategist', desc: 'Advanced portfolio management',         icon: 'fa-chess-knight',     color: '#a855f7',  minInvested: 50000 },
];

let _learnActiveTrack = null;

function renderLearnView() {
  const completed = new Set(PORTAL.quests?.completedIds || []);
  const totalInv  = parseFloat(PORTAL.investor?.total_invested) || 0;

  // Auto-select recommended track based on invested amount
  const recommended = [...LEARN_TRACKS].reverse().find(t => totalInv >= t.minInvested) || LEARN_TRACKS[0];
  if (!_learnActiveTrack) _learnActiveTrack = recommended.id;

  // Update header sub label
  const sub = document.getElementById('learnTrackLabel');
  if (sub) sub.textContent = `Recommended for you: ${recommended.label} track`;

  const container = document.getElementById('learnContent');
  if (!container) return;

  // Track tabs
  const tabs = LEARN_TRACKS.map(t => `
    <button class="learn-track-tab ${_learnActiveTrack === t.id ? 'active' : ''}"
            onclick="_setLearnTrack('${t.id}')"
            style="${_learnActiveTrack === t.id ? `border-color:${t.color};color:${t.color}` : ''}">
      <i class="fa-solid ${t.icon}"></i>
      <div>
        <div class="learn-tab-name">${t.label}</div>
        <div class="learn-tab-sub">${t.desc}</div>
      </div>
      ${t.id === recommended.id ? `<span class="learn-tab-recommended">Recommended</span>` : ''}
    </button>`).join('');

  const activeTrack = LEARN_TRACKS.find(t => t.id === _learnActiveTrack) || LEARN_TRACKS[0];
  const modules = LEARN_MODULES.filter(m => m.track === _learnActiveTrack)
    .sort((a, b) => a.order - b.order);

  const moduleCards = modules.map(mod => {
    const isDone = completed.has(mod.id);
    return `
      <div class="learn-module-card ${isDone ? 'learn-module-card--done' : ''}" id="lmod-${mod.id}">
        <div class="learn-module-card__header">
          <div class="learn-module-card__icon" style="background:${mod.color}22;color:${mod.color}">
            <i class="fa-solid ${mod.icon}"></i>
          </div>
          <div class="learn-module-card__meta">
            <div class="learn-module-card__title">${mod.title}</div>
            <div class="learn-module-card__info">
              <span><i class="fa-regular fa-clock"></i> ${mod.readTime} min</span>
              <span style="color:${mod.color}"><i class="fa-solid fa-star"></i> +${mod.xp} XP</span>
            </div>
          </div>
          ${isDone
            ? `<div class="learn-done-badge"><i class="fa-solid fa-circle-check"></i> Completed</div>`
            : `<button class="learn-expand-btn" onclick="_toggleModule('${mod.id}')">
                 <i class="fa-solid fa-chevron-down" id="lchev-${mod.id}"></i>
               </button>`
          }
        </div>
        <div class="learn-module-body" id="lbody-${mod.id}" style="display:none">
          <div class="learn-key-points">
            <div class="learn-key-points__title"><i class="fa-solid fa-list-check"></i> Key Takeaways</div>
            <ul>${mod.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>
          </div>
          <div class="learn-content-text">${mod.content.split('\n\n').map(p => `<p>${p.trim()}</p>`).join('')}</div>
          <div class="learn-module-footer">
            <button class="btn btn--primary" onclick="markModuleComplete('${mod.id}')">
              <i class="fa-solid fa-check"></i> Mark Complete — Earn ${mod.xp} XP
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="learn-track-tabs">${tabs}</div>
    <div class="learn-modules-list">${moduleCards}</div>`;
}

function _setLearnTrack(trackId) {
  _learnActiveTrack = trackId;
  renderLearnView();
}

function _toggleModule(modId) {
  const body = document.getElementById(`lbody-${modId}`);
  const chev = document.getElementById(`lchev-${modId}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(180deg)';
}

async function markModuleComplete(modId) {
  const btn = document.querySelector(`#lmod-${modId} .btn--primary`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }

  try {
    const result = await _postQuestComplete(modId, { source: 'learning_hub' });
    if (result.error) {
      if (result.error.includes('already')) {
        Toast.info('Already completed!');
      } else {
        Toast.error(result.error);
      }
    } else {
      Toast.success(`Module complete! +${result.xpAwarded} XP`);
      if (PORTAL.quests) {
        PORTAL.quests.xp  = result.newXP;
        PORTAL.quests.xpToNext = result.xpToNext;
        PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), modId];
      }
      if (result.leveledUp) _showLevelUpModal(result);
      renderLearnView();
      renderXPWidget();
      _updateXPNavBadge();
    }
  } catch (e) {
    Toast.error('Could not save completion. Try again.');
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-check"></i> Mark Complete — Earn ${LEARN_MODULES.find(m=>m.id===modId)?.xp||50} XP`; }
  }
}

function shareReferral(method) {
  const link = document.getElementById('referralLink').textContent;
  if (method === 'whatsapp') {
    window.open(`https://api.whatsapp.com/send?text=Join SV Capital and start earning inflation-beating returns on your investments! Use my referral code THA002: ${encodeURIComponent(link)}`, '_blank');
  } else {
    copyReferralLink();
  }
}

/* ═══════════════════════════════════════════════════════════════
   DARK MODE
   ═══════════════════════════════════════════════════════════════ */
function initDarkMode() {
  const saved = localStorage.getItem('svc_dark_mode');
  if (saved === 'dark') _applyDark(true);
}

function toggleDarkMode() {
  const isDark = document.body.classList.contains('dark-mode');
  _applyDark(!isDark);
}

function _applyDark(on) {
  document.body.classList.toggle('dark-mode', on);
  localStorage.setItem('svc_dark_mode', on ? 'dark' : 'light');
  const icon = document.getElementById('darkModeIcon');
  if (icon) {
    icon.className = on ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  }
}

/* ═══════════════════════════════════════════════════════════════
   GUIDED TOUR
   ═══════════════════════════════════════════════════════════════ */

const TOUR_STEPS = [
  {
    id: 'welcome',
    type: 'center',
    icon: 'fa-hand-wave',
    title: 'Welcome to your Investor Portal!',
    body: 'Let us give you a quick tour of everything available to you. It takes about 2 minutes and you\'ll earn <strong>100 XP</strong> when you\'re done.',
  },
  {
    id: 'portfolio_hero',
    target: '.portfolio-hero',
    position: 'bottom',
    icon: 'fa-chart-simple',
    title: 'Your Portfolio Overview',
    body: 'This hero panel shows your <strong>total portfolio value</strong>, effective return %, and a live breakdown of invested, wallet, and returns earned.',
  },
  {
    id: 'overview_investments',
    target: '#overviewInvestmentsBody',
    position: 'top',
    icon: 'fa-list-check',
    title: 'Active Investments',
    body: 'Your current investments are listed here with product type, amount, expected return, and days remaining until maturity.',
  },
  {
    id: 'nav_wallet',
    target: '[data-view="wallet"]',
    position: 'right',
    icon: 'fa-wallet',
    title: 'Fund Your Wallet',
    body: 'Top up your wallet via EFT bank transfer or card. Your wallet balance is what you use to invest in pools.',
  },
  {
    id: 'nav_marketplace',
    target: '[data-view="marketplace"]',
    position: 'right',
    icon: 'fa-store',
    title: 'Browse Investment Pools',
    body: 'Explore open pools across solar, cattle, loans, and delivery bikes. Each shows its rate, term, and how much is still available.',
  },
  {
    id: 'nav_maturity',
    target: '[data-view="maturity"]',
    position: 'right',
    icon: 'fa-hourglass-end',
    title: 'Maturity Instructions',
    body: 'Tell us what to do when your investment matures — reinvest automatically, add to wallet, or transfer to your bank account.',
  },
  {
    id: 'nav_quests',
    target: '[data-view="quests"]',
    position: 'right',
    icon: 'fa-trophy',
    title: 'Earn Rewards',
    body: 'Complete quests and surveys to earn XP. Every time you level up, <strong>R50 is added to your wallet</strong>. There are 8 levels to reach.',
  },
  {
    id: 'nav_learn',
    target: '[data-view="learn"]',
    position: 'right',
    icon: 'fa-graduation-cap',
    title: 'Learning Hub',
    body: 'Educational modules tailored to your investment level. Complete them to earn XP and become a more confident investor.',
  },
  {
    id: 'nav_referral',
    target: '[data-view="referral"]',
    position: 'right',
    icon: 'fa-share-nodes',
    title: 'Refer & Earn',
    body: 'Share your unique referral link. When a friend joins and invests, you both benefit.',
  },
  {
    id: 'complete',
    type: 'center',
    icon: 'fa-trophy',
    title: 'You\'re all set! 🎉',
    body: 'You now know your way around. Head to <strong>Earn Rewards</strong> to complete your first quest and start climbing the XP ladder.',
    isLast: true,
  },
];

let _tourStep = 0;
let _tourActive = false;

function _checkAutoStartTour() {
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const key = `svc_tour_done_${investorId}`;
  if (!localStorage.getItem(key)) {
    // Small delay so overview renders first
    setTimeout(startTour, 1200);
  }
}

function startTour() {
  _tourActive = true;
  _tourStep = 0;
  document.getElementById('tourOverlay').style.display = 'block';
  // Hide the pulsing badge on tour button
  const pulse = document.querySelector('.tour-btn-pulse');
  if (pulse) pulse.style.display = 'none';
  _renderTourStep(_tourStep);
}

function skipTour() {
  _endTour(false);
}

function nextTourStep() {
  if (_tourStep >= TOUR_STEPS.length - 1) {
    _endTour(true);
  } else {
    _tourStep++;
    _renderTourStep(_tourStep);
  }
}

function prevTourStep() {
  if (_tourStep > 0) {
    _tourStep--;
    _renderTourStep(_tourStep);
  }
}

function _endTour(completed) {
  _tourActive = false;
  document.getElementById('tourOverlay').style.display = 'none';

  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  localStorage.setItem(`svc_tour_done_${investorId}`, '1');

  if (completed) {
    // Award tour XP
    _postQuestComplete('complete_tour', { completed: true }).then(result => {
      if (result && !result.error) {
        Toast.success(`Tour complete! +${result.xpAwarded} XP earned`);
        if (PORTAL.quests) {
          PORTAL.quests.xp  = result.newXP;
          PORTAL.quests.completedIds = [...(PORTAL.quests.completedIds || []), 'complete_tour'];
        }
        if (result.leveledUp) _showLevelUpModal(result);
        renderXPWidget();
        _updateXPNavBadge();
      }
    }).catch(() => {});
  }
}

function _renderTourStep(idx) {
  const step    = TOUR_STEPS[idx];
  const total   = TOUR_STEPS.length;
  const isFirst = idx === 0;
  const isLast  = idx === total - 1;

  // Update text content
  document.getElementById('tourStepBadge').textContent = `Step ${idx + 1} of ${total}`;
  document.getElementById('tourTitle').textContent      = step.title;
  document.getElementById('tourBody').innerHTML         = step.body;

  // Icon
  const iconEl = document.getElementById('tourIcon');
  if (step.icon) {
    iconEl.innerHTML = `<i class="fa-solid ${step.icon}"></i>`;
    iconEl.style.display = 'flex';
  } else {
    iconEl.style.display = 'none';
  }

  // Dots
  const dotsEl = document.getElementById('tourDots');
  dotsEl.innerHTML = TOUR_STEPS.map((_, i) =>
    `<span class="tour-dot ${i === idx ? 'active' : i < idx ? 'done' : ''}"></span>`
  ).join('');

  // Prev / Next buttons
  document.getElementById('tourPrevBtn').style.display = isFirst ? 'none' : 'flex';
  const nextBtn = document.getElementById('tourNextBtn');
  if (isLast) {
    nextBtn.innerHTML = '<i class="fa-solid fa-check"></i> Done — Earn 100 XP';
    nextBtn.className = 'tour-next-btn tour-next-btn--done';
  } else {
    nextBtn.innerHTML = 'Next <i class="fa-solid fa-arrow-right"></i>';
    nextBtn.className = 'tour-next-btn';
  }

  // Position spotlight + tooltip
  _positionTour(step);
}

function _positionTour(step) {
  const spotlight = document.getElementById('tourSpotlight');
  const tooltip   = document.getElementById('tourTooltip');

  if (step.type === 'center' || !step.target) {
    // Centre: no spotlight, centred tooltip
    spotlight.style.cssText = 'display:none';
    tooltip.style.cssText   = `
      display:flex; position:fixed;
      top:50%; left:50%; transform:translate(-50%,-50%);
      z-index:10002; max-width:440px; width:calc(100vw - 32px);`;
    return;
  }

  const el = document.querySelector(step.target);
  if (!el) {
    // Element not visible — just centre
    spotlight.style.cssText = 'display:none';
    tooltip.style.cssText   = `
      display:flex; position:fixed;
      top:50%; left:50%; transform:translate(-50%,-50%);
      z-index:10002; max-width:440px; width:calc(100vw - 32px);`;
    return;
  }

  const pad  = 8;
  const r    = el.getBoundingClientRect();
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;

  // Spotlight
  spotlight.style.cssText = `
    display:block; position:fixed;
    left:${r.left - pad}px; top:${r.top - pad}px;
    width:${r.width + pad * 2}px; height:${r.height + pad * 2}px;
    border-radius:12px;
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.72);
    z-index:10001; pointer-events:none;
    transition: all 0.4s cubic-bezier(0.22,1,0.36,1);`;

  // Tooltip positioning
  const ttW  = Math.min(340, vw - 32);
  let left, top, transform = '';

  if (step.position === 'right') {
    left = Math.min(r.right + 16, vw - ttW - 8);
    top  = r.top + r.height / 2;
    transform = 'translateY(-50%)';
  } else if (step.position === 'bottom') {
    left = r.left + r.width / 2;
    top  = r.bottom + 16;
    transform = 'translateX(-50%)';
    // If out of viewport bottom, flip up
    if (top + 250 > vh) { top = r.top - 16; transform = 'translateX(-50%) translateY(-100%)'; }
  } else if (step.position === 'top') {
    left = r.left + r.width / 2;
    top  = r.top - 16;
    transform = 'translateX(-50%) translateY(-100%)';
    if (top - 250 < 0) { top = r.bottom + 16; transform = 'translateX(-50%)'; }
  } else {
    left = r.left - ttW - 16;
    top  = r.top + r.height / 2;
    transform = 'translateY(-50%)';
  }

  // Clamp horizontally
  left = Math.max(8, Math.min(left, vw - ttW - 8));

  tooltip.style.cssText = `
    display:flex; position:fixed;
    left:${left}px; top:${top}px;
    width:${ttW}px; max-width:${ttW}px;
    transform:${transform};
    z-index:10002;`;
}

/* ═══════════════════════════════════════════════════════════════
   FIRST DEPOSIT PROMPT
   ═══════════════════════════════════════════════════════════════ */
function checkFirstDepositPrompt() {
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  const neverKey   = `svc_deposit_never_${investorId}`;
  const laterKey   = `svc_deposit_later_${investorId}`;

  if (localStorage.getItem(neverKey)) return;  // permanently dismissed

  const snoozeUntil = parseInt(localStorage.getItem(laterKey) || '0');
  if (Date.now() < snoozeUntil) return;   // snoozed

  const hasDeposit = PORTAL.transactions.some(t => t.type === 'deposit');
  if (hasDeposit) return;  // already deposited

  // Show with a short delay so overview loads first
  setTimeout(() => {
    document.getElementById('depositPromptModal').style.display = 'flex';
  }, 2500);
}

function dismissDepositPrompt(never) {
  document.getElementById('depositPromptModal').style.display = 'none';
  const investorId = PORTAL.investor?.id || DEMO_INVESTOR_ID;
  if (never) {
    localStorage.setItem(`svc_deposit_never_${investorId}`, '1');
  } else {
    // Snooze for 24 hours
    localStorage.setItem(`svc_deposit_later_${investorId}`, String(Date.now() + 86_400_000));
  }
}

function goFundWallet() {
  dismissDepositPrompt(false);
  navigate('wallet', document.querySelector('[data-view="wallet"]'));
}
