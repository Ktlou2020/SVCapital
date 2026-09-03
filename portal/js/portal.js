/* ═══════════════════════════════════════════════
   SV CAPITAL — Investor Portal JS
   ═══════════════════════════════════════════════ */
'use strict';

/* ─── Admin "View as Investor" — consume ?viewas=<jwt> before any auth check ─── */
(() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const viewasToken = params.get('viewas');
    if (!viewasToken) return;

    // Decode JWT payload (no crypto verification — server already signed it)
    const parts = viewasToken.split('.');
    if (parts.length !== 3) return;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.sub || payload.purpose !== 'admin_view_as') return;

    // Inject token so Auth.isLoggedIn() and all API calls work as the investor
    localStorage.setItem('svc_token', viewasToken);
    localStorage.setItem('svc_user', JSON.stringify({
      investorId: payload.sub,
      email:      payload.email || '',
      firstName:  payload.firstName || '',
      lastName:   payload.lastName  || '',
      role:       'investor',
      _viewas:    true,
    }));
    // Clear stale cache so fresh investor data loads
    localStorage.removeItem('svc_portal_cache');
    // Flag for the banner (sessionStorage so it clears when the tab closes)
    sessionStorage.setItem('svc_viewas_active', '1');
    sessionStorage.setItem('svc_viewas_name', `${payload.firstName || ''} ${payload.lastName || ''}`.trim() || payload.email || payload.sub);

    // Remove token from URL so it isn't visible or re-processed on refresh
    const clean = window.location.pathname + window.location.hash;
    history.replaceState(null, '', clean);
  } catch (_) {}
})();

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

/* Escape user-controlled strings before inserting into innerHTML */
const _esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const _safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '#';

/* ── Stale data notice ──────────────────────────────────────────────────────
   The portal renders from localStorage the moment it opens so a repeat launch
   is never a blank screen, and there is deliberately no TTL on that cache.
   The hazard is what happens when the background refresh then fails: the
   wallet balance, investments and transactions on screen are whatever was
   last saved — possibly days old — presented identically to live figures.
   That is how "my deposit is missing" support tickets start. Say plainly how
   old the numbers are and give a way to try again.
   ─────────────────────────────────────────────────────────────────────── */
let _cacheStampedAt = null;   // cachedAt of the data currently on screen, or null if live


let _fsDocCache = [];
function _openFsDoc(i) {
  const url = (_fsDocCache[i] || {}).file_url;
  if (!url) return;
  if (/^https?:\/\//i.test(url)) { window.open(url, '_blank', 'noopener'); return; }
  try {
    const [header, b64] = url.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'application/pdf';
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const objUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    window.open(objUrl, '_blank', 'noopener');
  } catch (_) { if (typeof Toast !== 'undefined') Toast.error('Could not open document'); }
}

/* ─── Partner info profiles ─── */
const PARTNER_PROFILES = {
  'Beefcor': {
    tagline: 'Producers of quality cattle since 1973',
    profile: 'Beefcor is a vertically integrated South African cattle feedlot founded in 1973, marketing over 70,000 cattle per year. They manage the full value chain from livestock procurement to branded beef in retail stores. Beefcor hosts SA\'s first commercially viable biogas plant at their Bronkhorstspruit facility.',
    website: 'https://www.beefcor.com',
    youtubeId: 'mTIcSDeggtQ',
  },
  'MoolaLend': {
    tagline: 'Your chomie in funding — SA\'s PO finance specialist',
    profile: 'MoolaLend is a Bryanston-based boutique lender that specialises in Purchase Order (PO) finance for South African SMEs. They fund government tenders and private-sector purchase orders from R50,000, enabling businesses to fulfil contracts without upfront capital. Incorporated in 2021 and listed in FundingHub\'s Top 10 PO Funding Lenders in SA, MoolaLend takes a partner-first approach to SME lending.',
    website: 'https://portal.moolalend.co.za/',
  },
  'The Solar Experts': {
    tagline: 'Cape Town\'s trusted solar design & installation specialists',
    profile: 'The Solar Experts is a Somerset West-based solar energy company with over 612 completed installations across the Western Cape since 2019. They serve residential and commercial clients with systems from 5 kW to 250 kW, handled entirely by in-house electrical staff.',
    website: 'https://thesolarexperts.co.za',
  },
  'OnFleet': {
    tagline: 'Rent to Own. Ride. Earn. Own.',
    profile: 'OnFleet Africa runs South Africa\'s leading rent-to-own delivery motorcycle programme. Riders with no deposit access a bike for R650–R850/week and own it outright after 18 months — with free monthly servicing included. Around 60% of riders re-enter a new contract at the 18-month mark, renting out their first bike for additional income.',
    website: 'https://portal.onfleet.africa',
  },
};


let PORTAL = {
  investor: null,
  investments: [],
  transactions: [],
  pools: [],
  tickets: [],
  subAccounts: [],
  waitlist: [],
  charts: {},
  myInvFilter: 'all',
  marketFilter: 'all',
  quests: null,       // { xp, level, currentLevel, nextLevel, completedIds, quests, levels, profile }
};

const PROFILE_DRAFT_KEY = 'svc_profile_draft_v2';
const SUPPORT_DRAFT_KEY = 'svc_support_draft_v2';
let _profileHydrating = false;
let _supportHydrating = false;
let _profileDirty = false;


function _profileFields() {
  return {
    first_name:     document.getElementById('profFirstName')?.value?.trim() || '',
    last_name:      document.getElementById('profLastName')?.value?.trim() || '',
    phone:          document.getElementById('profPhone')?.value?.trim() || '',
    street_address: document.getElementById('profStreetAddress')?.value?.trim() || '',
    suburb:         document.getElementById('profSuburb')?.value?.trim() || '',
    city:           document.getElementById('profCity')?.value?.trim() || '',
    postal_code:    document.getElementById('profPostalCode')?.value?.trim() || '',
    province:       document.getElementById('profProvince')?.value || '',
    risk_profile:   document.querySelector('input[name="riskProf"]:checked')?.value || '',
  };
}

function _applyProfileDraft(data) {
  if (!data) return;
  _profileHydrating = true;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  set('profFirstName',     data.first_name || '');
  set('profLastName',      data.last_name || '');
  set('profPhone',         data.phone || '');
  set('profStreetAddress', data.street_address || '');
  set('profSuburb',        data.suburb || '');
  set('profCity',          data.city || '');
  set('profPostalCode',    data.postal_code || '');
  set('profProvince',      data.province || '');
  if (data.risk_profile) {
    const radio = document.querySelector(`input[name="riskProf"][value="${data.risk_profile}"]`);
    if (radio) radio.checked = true;
  }
  _profileHydrating = false;
}


function bindProfileDraft() {
  if (document.body.dataset.profileDraftBound === '1') return;
  document.body.dataset.profileDraftBound = '1';
  ['profFirstName','profLastName','profPhone','profStreetAddress','profSuburb','profCity','profPostalCode','profProvince'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => { if (!_profileHydrating) _persistProfileDraft(); });
    el.addEventListener('change', () => { if (!_profileHydrating) _persistProfileDraft(); });
  });
  _initAddressSearch('profAddressSearch', 'profAddressDrop', {
    street: 'profStreetAddress', suburb: 'profSuburb',
    city: 'profCity', postal: 'profPostalCode', province: 'profProvince',
  });
  document.querySelectorAll('input[name="riskProf"]').forEach(el => {
    el.addEventListener('change', () => { if (!_profileHydrating) _persistProfileDraft(); });
  });
}
const SUPPORT_TEMPLATES = {
  withdrawal: {
    subject: 'Withdrawal delay',
    category: 'general',
    priority: 'high',
    message: 'Hello SV Capital team, I requested a withdrawal and would like an update on the payout timeline. Reference: \nAmount: \nSubmitted on: \nAdditional context: '
  },
  fica: {
    subject: 'FICA verification status',
    category: 'fica_kyc',
    priority: 'medium',
    message: 'Hello SV Capital team, please share the current status of my FICA / KYC review. Documents uploaded on: \nAnything still outstanding: '
  },
  statement: {
    subject: 'Statement or tax certificate request',
    category: 'general',
    priority: 'medium',
    message: 'Hello SV Capital team, I need help with my statement / tax certificate. Period required: \nPurpose: \nAdditional details: '
  },
  technical: {
    subject: 'Technical issue in the portal',
    category: 'technical',
    priority: 'medium',
    message: 'Hello SV Capital team, I experienced a portal issue. What I was trying to do: \nWhat happened instead: \nDevice / browser: \nTime of issue: '
  }
};


function renderWalletReadinessPanel() {
  const panel = _ensureWalletReadinessPanel();
  const inv = PORTAL.investor;
  if (!panel || !inv) return;
  const wallet = parseFloat(inv.wallet_balance) || 0;
  const pools = _rankMarketPools(_getOpenMarketplacePools().filter(p => p.status === 'open'), wallet);
  const affordable = pools.filter(p => wallet >= (parseFloat(p.min_investment) || 0));
  const cheapest = [...pools].sort((a, b) => (parseFloat(a.min_investment) || 0) - (parseFloat(b.min_investment) || 0))[0] || null;
  const pendingDeposit = (PORTAL.transactions || []).find(t => t.type === 'deposit' && t.status === 'pending');
  const pendingWithdrawal = (PORTAL.transactions || []).find(t => t.type === 'withdrawal' && t.status === 'pending');
  const ficaApproved = _isInvestorFicaApproved(inv);
  const ficaCardApproved = inv.fica_status === 'approved';
  const bankApproved = !!inv.bank_account_number && inv.bank_account_status === 'approved';

  let headline = 'Your wallet is the fastest path to your next investment.';
  let subcopy = 'Choose the next action that will get you to a completed investment quickest.';
  let ctaLabel = 'Top up wallet';
  let ctaAction = "openTopUpModal()";
  let accent = '#fec24f';

  if (affordable.length) {
    const best = affordable[0];
    headline = `You can already invest in ${affordable.length} open pool${affordable.length === 1 ? '' : 's'}.`;
    subcopy = best ? `${best.name} is the closest match for your current wallet balance.` : subcopy;
    ctaLabel = 'Invest now';
    ctaAction = "navigate('marketplace', document.querySelector('[data-view=marketplace]'))";
    accent = '#22C55E';
  } else if (cheapest) {
    const gap = Math.max(0, (parseFloat(cheapest.min_investment) || 0) - wallet);
    headline = `Top up ${Utils.rand(gap)} to reach the lowest open minimum.`;
    subcopy = `${cheapest.name} is currently the most reachable pool for your next step.`;
    ctaLabel = 'Top up now';
    ctaAction = "openTopUpModal()";
    accent = '#fec24f';
  }

  panel.innerHTML = `
    <div class="panel__header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="panel__title"><i class="fa-solid fa-bolt" style="color:${accent}"></i> Wallet Readiness</span>
      <span style="margin-left:auto;font-size:0.72rem;font-weight:700;color:${accent};background:${accent}14;padding:4px 10px;border-radius:999px;border:1px solid ${accent}2f">${ficaApproved ? 'Investment ready checks' : 'FICA pending — withdrawals locked'}</span>
    </div>
    <div class="panel__body" style="display:flex;flex-direction:column;gap:14px">
      <div style="border:1px solid rgba(0,0,0,0.06);border-radius:14px;padding:14px 16px;background:linear-gradient(135deg,rgba(255,255,255,0.98),rgba(254,194,79,0.05))">
        <div style="font-size:0.92rem;font-weight:800;color:#1a1a1a;line-height:1.35">${headline}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:5px;line-height:1.55">${subcopy}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="btn btn--primary btn--sm" onclick="${ctaAction}"><i class="fa-solid fa-arrow-right"></i> ${ctaLabel}</button>
          <button class="btn btn--secondary btn--sm" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i> Statement</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">
        <div style="padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff">
          <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Wallet balance</div>
          <div style="font-size:1.12rem;font-weight:900;color:#1a1a1a;margin-top:4px">${Utils.rand(wallet)}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${affordable.length ? `${affordable.length} pool${affordable.length === 1 ? '' : 's'} you can join now` : cheapest ? `${Utils.rand(Math.max(0, (parseFloat(cheapest.min_investment) || 0) - wallet))} short of the next minimum` : 'No open pools to compare right now'}</div>
        </div>
        <div style="padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff">
          <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Verification</div>
          <div style="font-size:0.88rem;font-weight:800;color:${ficaCardApproved ? '#22c55e' : '#656565'};margin-top:6px">${ficaCardApproved ? 'FICA/KYC approved' : 'FICA/KYC pending'}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${ficaCardApproved ? (bankApproved ? 'Withdrawal bank account verified.' : inv.bank_account_number ? 'Bank account pending review.' : 'Add your bank account before your first withdrawal.') : 'You can invest and top up. Withdrawals unlock once FICA is approved.'}</div>
        </div>
        <div style="padding:12px 14px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;background:#fff">
          <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;font-weight:800">Money in motion</div>
          <div style="font-size:0.88rem;font-weight:800;color:#1a1a1a;margin-top:6px">${pendingDeposit ? 'Deposit pending review' : pendingWithdrawal ? 'Withdrawal pending payout' : 'No pending money movement'}</div>
          <div style="font-size:0.74rem;color:var(--text-muted);margin-top:4px">${pendingDeposit ? `${Utils.rand(Math.abs(parseFloat(pendingDeposit.amount) || 0))} will reflect once admin review completes.` : pendingWithdrawal ? `${Utils.rand(Math.abs(parseFloat(pendingWithdrawal.amount) || 0))} is already in the payout queue.` : 'Your next top-up or withdrawal request will appear here.'}</div>
        </div>
      </div>
    </div>`;
}


let _statementAssistMeta = null;


function renderStatementAssistCard(meta = {}) {
  const card = _ensureStatementAssistCard();
  if (!card) return;
  if (meta && Object.keys(meta).length) _statementAssistMeta = { ...(_statementAssistMeta || {}), ...meta };
  const fromVal = document.getElementById('stmtFrom')?.value || '2020-01-01';
  const toVal = document.getElementById('stmtTo')?.value || new Date().toISOString().split('T')[0];
  const sections = [
    document.getElementById('stmtIncPortfolio')?.checked && 'Portfolio',
    document.getElementById('stmtIncInvestments')?.checked && 'Investments',
    document.getElementById('stmtIncTransactions')?.checked && 'Transactions',
    document.getElementById('stmtIncPerformance')?.checked && 'Performance'
  ].filter(Boolean);
  const taxYear = document.getElementById('taxYearSelect')?.value || new Date().getFullYear();
  card.innerHTML = `
    <div style="padding:14px 18px;border-bottom:1px solid rgba(0,0,0,0.07);background:#F7F8FA">
      <span style="font-size:0.82rem;font-weight:800;color:#1a1a1a"><i class="fa-solid fa-wand-magic-sparkles" style="color:#fec24f;margin-right:6px"></i>Faster statement workflow</span>
    </div>
    <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('30d')">Last 30 days</button>
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('90d')">Last 90 days</button>
        <button class="btn btn--secondary btn--sm" onclick="applyStatementPreset('all')">All activity</button>
      </div>
      <div style="font-size:0.76rem;color:var(--text-muted);line-height:1.6">
        <div><strong style="color:#1a1a1a">Current range:</strong> ${fmtDate(fromVal)} — ${fmtDate(toVal)}</div>
        <div style="margin-top:4px"><strong style="color:#1a1a1a">Included sections:</strong> ${sections.length ? sections.join(', ') : 'Portfolio summary will be added automatically'}</div>
      </div>
      ${_statementAssistMeta?.generatedAt ? `<div style="padding:10px 12px;border-radius:10px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.18);font-size:0.75rem;color:#166534;line-height:1.55"><strong>Last preview generated:</strong> ${_statementAssistMeta.generatedAt}<br>${_statementAssistMeta.summary || ''}</div>` : `<div style="padding:10px 12px;border-radius:10px;background:rgba(254,194,79,0.08);border:1px solid rgba(254,194,79,0.18);font-size:0.75rem;color:#9a5d00;line-height:1.55">Generate a preview once, then use Print / Save PDF to complete the task without re-entering your settings.</div>`}
    </div>`;
}


/* ─── Confirm dialog (replaces browser confirm()) ─── */
const Confirm = {
  ask(message, { title = 'Are you sure?', confirmLabel = 'Confirm', confirmClass = 'btn--danger', cancelLabel = 'Cancel' } = {}) {
    return new Promise(resolve => {
      let el = document.getElementById('portalConfirmModal');
      if (!el) {
        el = document.createElement('div');
        el.id = 'portalConfirmModal';
        el.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;align-items:center;justify-content:center';
        el.innerHTML = `
          <div style="background:#fff;border-radius:16px;padding:28px 24px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2)">
            <div id="pcTitle" style="font-size:1.05rem;font-weight:800;color:#1a1a1a;margin-bottom:8px"></div>
            <div id="pcMsg"   style="font-size:0.88rem;color:#6b7280;line-height:1.6;margin-bottom:20px"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end">
              <button id="pcCancel"  class="btn btn--secondary" style="min-width:90px"></button>
              <button id="pcConfirm" class="btn btn--primary"   style="min-width:90px"></button>
            </div>
          </div>`;
        document.body.appendChild(el);
      }
      el.style.display = 'flex';
      document.getElementById('pcTitle').textContent = title;
      document.getElementById('pcMsg').textContent   = message;
      const cancelBtn  = document.getElementById('pcCancel');
      const confirmBtn = document.getElementById('pcConfirm');
      cancelBtn.textContent  = cancelLabel;
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className   = `btn ${confirmClass}`;
      const done = (val) => { el.style.display = 'none'; resolve(val); };
      cancelBtn.onclick  = () => done(false);
      confirmBtn.onclick = () => done(true);
      el.onclick = (e) => { if (e.target === el) done(false); };
    });
  }
};


const _NOTIF_READ_KEY = 'svc_dismissed_notifs';


/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
// 30-second polling — refresh wallet balance and investment statuses
let _pollTimer = null;

document.addEventListener('visibilitychange', () => { if (!document.hidden && _pollTimer) {} });

// Expose stop function so Auth.logout() can kill the interval before redirecting
window._stopPolling = function () { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } };

// ─── Idle auto-logout (web only) ───
// Shows a countdown overlay after 10 min of inactivity; skipped in native app.
function initIdleAutoLogout() {
  const isNative = (typeof _svcPlatform === 'function' && _svcPlatform() !== 'web') ||
                   (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  if (isNative) return;

  const IDLE_MS  = 10 * 60 * 1000;  // 10 minutes total
  const WARN_MS  = 60 * 1000;        // show countdown for 60 seconds
  let idleTimer = null, warnTimer = null, countdownInterval = null;
  let overlayEl = null, _signingOut = false;

  const _injectIdleStyles = () => {
    if (document.getElementById('_idleStyles')) return;
    const s = document.createElement('style');
    s.id = '_idleStyles';
    s.textContent = [
      '#_idleOverlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:24px;animation:_idleFadeIn .22s ease}',
      '@keyframes _idleFadeIn{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}',
      '._idle-card{background:var(--dark-2,#131b26);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:20px;padding:36px 28px 26px;width:100%;max-width:340px;text-align:center;box-shadow:0 28px 70px rgba(0,0,0,.55)}',
      '._idle-icon{font-size:2.2rem;color:#fec24f;margin-bottom:14px}',
      '._idle-title{font-size:1.15rem;font-weight:700;color:var(--text,#e8edf2);margin-bottom:4px}',
      '._idle-count{font-size:3.8rem;font-weight:800;color:#fec24f;line-height:1.1;letter-spacing:-0.02em;margin:8px 0}',
      '._idle-sub{font-size:0.83rem;color:var(--text-dim,#7a92a8);margin-bottom:18px;line-height:1.5}',
      '._idle-bar-wrap{height:5px;background:var(--dark-3,#1a2535);border-radius:3px;overflow:hidden;margin-bottom:22px}',
      '._idle-bar{height:100%;background:#fec24f;width:100%;transition:width 1s linear;border-radius:3px}',
      '._idle-btn-stay{width:100%;padding:13px;background:#fec24f;color:#1a1a1a;border:none;border-radius:12px;font-size:.95rem;font-weight:700;cursor:pointer;margin-bottom:8px;transition:filter .15s}',
      '._idle-btn-stay:hover{filter:brightness(1.08)}',
      '._idle-btn-out{width:100%;padding:8px;background:none;color:var(--text-dim,#7a92a8);border:none;font-size:.82rem;cursor:pointer;transition:color .15s}',
      '._idle-btn-out:hover{color:var(--text,#e8edf2)}',
    ].join('');
    document.head.appendChild(s);
  };

  const removeOverlay = () => {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  };

  const showCountdown = () => {
    if (overlayEl) return;
    _injectIdleStyles();
    let secs = Math.round(WARN_MS / 1000);
    overlayEl = document.createElement('div');
    overlayEl.id = '_idleOverlay';
    overlayEl.innerHTML = [
      '<div class="_idle-card">',
      '<div class="_idle-icon"><i class="fa-regular fa-clock"></i></div>',
      '<div class="_idle-title">Still there?</div>',
      '<div class="_idle-count" id="_idleSecs">' + secs + '</div>',
      '<div class="_idle-sub">You\'ll be signed out due to inactivity.</div>',
      '<div class="_idle-bar-wrap"><div class="_idle-bar" id="_idleBar"></div></div>',
      '<button class="_idle-btn-stay" onclick="_idleStay()">Stay Signed In</button>',
      '<button class="_idle-btn-out" onclick="_idleLogout()">Sign Out Now</button>',
      '</div>',
    ].join('');
    document.body.appendChild(overlayEl);
    countdownInterval = setInterval(() => {
      secs = Math.max(0, secs - 1);
      const sc  = document.getElementById('_idleSecs');
      const bar = document.getElementById('_idleBar');
      if (sc)  sc.textContent = secs;
      if (bar) bar.style.width = (secs / (WARN_MS / 1000) * 100) + '%';
    }, 1000);
  };

  const doAutoLogout = () => {
    removeOverlay();
    // Idle timeout is the SAME user stepping away — keep the portal cache so the
    // dashboard paints instantly when they log back in instead of sitting on
    // "Loading…" through a Railway cold start. The cache is validated against the
    // new JWT's investorId before it is rendered (see DOMContentLoaded), so it can
    // never be shown to a different user. Explicit Sign Out still clears it.
    localStorage.removeItem('svc_user');
    sessionStorage.removeItem('svc_portal_cache');
    sessionStorage.clear();
    Auth.logout('../login.html?reason=timeout');
  };

  window._idleStay = () => {
    _signingOut = false;
    removeOverlay();
    markActivity();
  };

  window._idleLogout = () => {
    _signingOut = true;
    removeOverlay();
    doAutoLogout();
  };

  const reset = () => {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
    warnTimer  = setTimeout(showCountdown, IDLE_MS - WARN_MS);
    idleTimer  = setTimeout(doAutoLogout,  IDLE_MS);
  };

  // Activity across tabs: broadcast last-activity via localStorage so multiple
  // portal tabs share one idle clock.
  const markActivity = () => {
    if (_signingOut) return;
    if (overlayEl) removeOverlay();  // any interaction during countdown = stay signed in
    try { localStorage.setItem('svc_last_activity', String(Date.now())); } catch (_) {}
    reset();
  };

  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(ev =>
    window.addEventListener(ev, markActivity, { passive: true }));

  // Sync idle clock when another tab reports activity or the tab regains focus.
  window.addEventListener('storage', e => { if (e.key === 'svc_last_activity') reset(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    let last = 0;
    try { last = parseInt(localStorage.getItem('svc_last_activity') || '0', 10) || 0; } catch (_) {}
    if (last && (Date.now() - last) >= IDLE_MS) { doAutoLogout(); return; }
    reset();
  });

  markActivity();
}

document.addEventListener('DOMContentLoaded', async () => {
  _preloadLogo(); // warm logo cache for PDF generation
  Toast.init();
  // Track when the invest modal is closed without the user confirming
  const _iMEl = document.getElementById('investModal');
  if (_iMEl) {
    new MutationObserver(() => {
      if (!_iMEl.classList.contains('open') && _investModalPool && !_investConfirmed) {
        SVC.track('svc_invest_modal_abandoned', { pool_id: _investModalPool.id, product_type: _investModalPool.product_type, fee_seen: _investFeeTracked, amount_entered: _investFeeTracked });
        _trackFunnel('abandoned', { pool_id: _investModalPool.id, product_type: _investModalPool.product_type, fee_seen: _investFeeTracked, amount_entered: _investFeeTracked });
        _investModalPool = null;
      }
    }).observe(_iMEl, { attributes: true, attributeFilter: ['class'] });
  }
  initDarkMode();
  initPortalFormUX();
  initIdleAutoLogout();
  // Set skeleton placeholders on overview stats while data loads
  const _skelSpan = '<span class="skeleton" style="display:inline-block;width:80px;height:20px;border-radius:4px"></span>';
  ['pov-total','pov-invested','pov-wallet','pov-returns'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = _skelSpan;
  });

  // Immediately populate greeting from cached user so name never stays "Loading..."
  try {
    const cached = JSON.parse(localStorage.getItem('svc_user') || '{}') || {};
    let firstName = cached.firstName || cached.first_name || cached.name?.split(' ')[0] || '';
    let lastName  = cached.lastName  || cached.last_name  || cached.name?.split(' ').slice(1).join(' ') || '';
    // Fallback: read the name from the portal data cache. svc_user is cleared on
    // idle-timeout logout while the portal cache survives, so without this the
    // greeting and avatar stay at "—"/"?" for the whole cold start after re-login.
    if (!firstName) {
      try {
        const pc = JSON.parse(localStorage.getItem('svc_portal_cache') || 'null');
        if (pc?.investor) {
          firstName = pc.investor.first_name || '';
          lastName  = pc.investor.last_name  || '';
        }
      } catch (_) {}
    }
    const nameEl = document.getElementById('welcomeName');
    // Always replace "Loading..." — use cached name if available, otherwise a neutral dash
    if (nameEl) nameEl.textContent = firstName ? `${firstName} ${lastName}`.trim() : '—';
    const greetEl = document.getElementById('topbarGreeting');
    if (greetEl) greetEl.textContent = firstName ? `${_timeGreeting()}, ${firstName} 👋` : _timeGreeting();
    const greetEl2 = document.getElementById('welcomeGreeting');
    if (greetEl2) greetEl2.textContent = _timeGreeting();
    const avEl = document.getElementById('welcomeAvatar');
    if (avEl && firstName) avEl.textContent = ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || '?';
  } catch (_) {}
  // Always clear "Loading..." from data tables immediately — render a spinner row instead
  try {
    const _spinRow = (cols) => `<tr><td colspan="${cols}" style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-circle-notch fa-spin" style="margin-right:6px"></i>Loading…</td></tr>`;
    const ib = document.getElementById('overviewInvestmentsBody');
    const tb = document.getElementById('overviewTxnBody');
    if (ib) ib.innerHTML = _spinRow(6);
    if (tb) tb.innerHTML = _spinRow(4);
  } catch (_) {}

  // Try to render from cache immediately — hides cover instantly on repeat launches.
  // No TTL: always show cached data right away; the background refresh below keeps it fresh.
  // If that refresh fails the figures on screen are whatever was last saved, so
  // _cacheStampedAt records how old they are and the banner says so out loud.
  let _cacheRendered = false;
  try {
    const raw = localStorage.getItem('svc_portal_cache');
    if (raw) {
      const c = JSON.parse(raw);
      if (c && c.cachedAt && c.investor) {
        // Validate the cache belongs to the currently logged-in investor. On a
        // shared browser a cache left behind by a previous session must never be
        // rendered to whoever logs in next.
        let _cacheOk = true;
        try {
          const _tok = Auth.getToken();
          if (_tok) {
            const _p = JSON.parse(atob(_tok.split('.')[1]));
            const _jwtInvId = _p.investorId || null;
            if (_jwtInvId && c.investor.id && _jwtInvId !== c.investor.id) {
              _cacheOk = false; // cache belongs to a different investor
              localStorage.removeItem('svc_portal_cache');
            }
          }
        } catch (_) {}

        if (_cacheOk) {
          PORTAL.investor     = c.investor     || null;
          PORTAL.investments  = c.investments  || [];
          PORTAL.transactions = c.transactions || [];
          PORTAL.pools        = c.pools        || [];
          PORTAL.waitlist     = c.waitlist     || [];
          _cacheStampedAt     = c.cachedAt;
          try { renderOverview(); } catch (_) {}
          if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
          _cacheRendered = true;
        }
      }
    }
  } catch (_) {}

  if (_cacheRendered) {
    // Silently refresh data in the background — don't block UI or re-render charts
    loadPortalData(0, { skipCharts: true }).catch(() => {});
  } else {
    // No cache (first visit) — show progressive status while Railway may be cold-starting
    const _statusRow = (cols, msg) => `<tr><td colspan="${cols}" style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem">${msg}</td></tr>`;
    const _updateStatus = (msg) => {
      const ib = document.getElementById('overviewInvestmentsBody');
      const tb = document.getElementById('overviewTxnBody');
      if (ib) ib.innerHTML = _statusRow(6, msg);
      if (tb) tb.innerHTML = _statusRow(4, msg);
    };
    const _coverText = document.getElementById('_nativeCoverText');
    const _t1 = setTimeout(() => {
      const wake = '<i class="fa-solid fa-circle-notch fa-spin" style="margin-right:6px"></i>Server is waking up — this can take up to 30 seconds…';
      _updateStatus(wake);
      if (_coverText) _coverText.textContent = 'Server waking up, please wait…';
    }, 5000);
    const _t2 = setTimeout(() => {
      const almost = '<i class="fa-solid fa-circle-notch fa-spin" style="margin-right:6px"></i>Almost there…';
      _updateStatus(almost);
      if (_coverText) _coverText.textContent = 'Almost there…';
    }, 20000);

    await loadPortalData();
    clearTimeout(_t1);
    clearTimeout(_t2);
    if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
  }

  loadNotifications();
  checkFirstDepositPrompt();
  _checkAutoStartTour();
  load2FAStatus();
  _startPolling();

  // Admin "View as Investor" banner
  if (sessionStorage.getItem('svc_viewas_active') === '1') {
    const invName = sessionStorage.getItem('svc_viewas_name') || 'investor';
    const banner = document.createElement('div');
    banner.id = 'viewasBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fec24f;color:#1a1a1a;padding:8px 16px;display:flex;align-items:center;gap:10px;font-size:0.82rem;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.25)';
    banner.innerHTML = `<i class="fa-solid fa-eye"></i> Admin View — viewing as <strong>${_esc(invName)}</strong> &nbsp;·&nbsp; <span style="font-weight:400">Read-only. Changes made here affect the real account.</span><button onclick="sessionStorage.removeItem('svc_viewas_active');sessionStorage.removeItem('svc_viewas_name');localStorage.removeItem('svc_token');localStorage.removeItem('svc_user');window.close()" style="margin-left:auto;background:rgba(0,0,0,0.15);border:none;cursor:pointer;font-weight:700;padding:4px 12px;border-radius:4px;font-size:0.78rem;color:#1a1a1a">✕ Exit</button>`;
    document.body.prepend(banner);
    // Push page content down so the banner doesn't overlap it
    document.body.style.paddingTop = '38px';
  }
  _initPullToRefresh();

  // Watchdog: runs at 100ms, 600ms, and 1500ms to ensure the active view is visible.
  // Android WebView compositing (esp. with position:fixed overlays) can silently
  // leave the active view at opacity:0. Running the watchdog at three intervals
  // catches races between data-load, cover-hide, and browser paint cycles.
  if (window.__SVC_NATIVE__) {
    const _forceViewVisible = () => {
      const active = document.querySelector('.view.active');
      if (active) {
        active.style.setProperty('display',           'block',   'important');
        active.style.setProperty('opacity',           '1',       'important');
        active.style.setProperty('visibility',        'visible', 'important');
        active.style.setProperty('transform',         'none',    'important');
        active.style.setProperty('animation',         'none',    'important');
        active.style.setProperty('-webkit-animation', 'none',    'important');
      }
      // Re-composite the main content layer. On Android WebView the scrolling
      // content layer can be left at the clear colour (solid white) after the
      // native splash is removed, even though fixed layers (topbar/nav/drawer)
      // paint. Re-asserting display:block on an already-block element does NOT
      // invalidate that layer — only a real off→on display toggle forces the
      // relayout + repaint that rebuilds and paints it.
      const pc = document.querySelector('.page-content');
      if (pc) {
        pc.style.display = 'none';
        void pc.offsetHeight;   // synchronous reflow between writes
        pc.style.display = '';
      }
    };
    // Run at multiple intervals: before tour (100ms, 600ms, 1500ms),
    // after tour starts (3000ms, 5000ms) in case the overlay causes a blank.
    setTimeout(_forceViewVisible, 100);
    setTimeout(_forceViewVisible, 600);
    setTimeout(_forceViewVisible, 1500);
    setTimeout(_forceViewVisible, 3000);
    setTimeout(_forceViewVisible, 5000);
  }
});

async function loadPortalData(_attempt = 0, _opts = {}) {
  const MAX_ATTEMPTS = 4;
  try {
    // allSettled so a single failing endpoint (e.g. a new table not yet migrated)
    // never kills the whole portal load — each result is independently unpacked.
    const [invResult, invstResult, txnResult, poolResult, payResult] = await Promise.allSettled([
      API.investors.list({ limit: 100 }),
      API.investments.list({ limit: 200 }),
      API.transactions.list({ limit: 200 }),
      API.pools.list({ limit: 100 }),
      loadPaymentConfig(),  // load Paystack key from server env var
    ]);

    const invRes   = invResult.status   === 'fulfilled' ? invResult.value   : { data: [] };
    const invstRes = invstResult.status === 'fulfilled' ? invstResult.value : { data: [] };
    const txnRes   = txnResult.status   === 'fulfilled' ? txnResult.value   : { data: [] };
    const poolRes  = poolResult.status  === 'fulfilled' ? poolResult.value  : { data: [] };

    // Log any API failures for debugging
    if (invResult.status === 'rejected')   console.warn('[portal] investors API failed:', invResult.reason?.message);
    if (invstResult.status === 'rejected') console.warn('[portal] investments API failed:', invstResult.reason?.message);
    if (txnResult.status === 'rejected')   console.warn('[portal] transactions API failed:', txnResult.reason?.message);
    if (poolResult.status === 'rejected')  console.warn('[portal] pools API failed:', poolResult.reason?.message);
    if (payResult.status  === 'rejected')  console.warn('[portal] payment config failed:', payResult.reason?.message);

    // If the investors call itself failed (e.g. 401/500), and all other calls also failed,
    // that's a hard network/auth error — throw so the retry loop runs.
    if (invResult.status === 'rejected' && invstResult.status === 'rejected' && txnResult.status === 'rejected') {
      throw invResult.reason;
    }

    let allInvestors   = invRes.data   || [];
    const allInvestments = invstRes.data || [];
    const allTxns        = txnRes.data   || [];

    // Find the logged-in investor by their JWT-resolved ID
    PORTAL.investor = allInvestors.find(i => i.id === DEMO_INVESTOR_ID) || null;

    // Fallback: the server already scopes investor-role list results to the authenticated user,
    // so any item in allInvestors belongs to this user — use the first one when find-by-ID fails.
    if (!PORTAL.investor && allInvestors.length > 0) {
      PORTAL.investor = allInvestors[0];
    }

    // Last resort: if the list returned empty (server could not resolve investor from JWT),
    // call /api/auth/me to get the live investor_id from the DB, then use the single-record
    // GET which has the email fallback and bypasses the list isolation guard.
    if (!PORTAL.investor) {
      try {
        const meData = await API.me();
        const freshInvestorId = meData && (meData.investor_id || meData.investorId);
        if (freshInvestorId) {
          const inv = await API.investors.get(freshInvestorId).catch(() => null);
          if (inv && inv.id) {
            PORTAL.investor = inv;
            allInvestors = [inv];
          }
        }
      } catch (_) {}
    }

    const resolvedId = PORTAL.investor?.id || DEMO_INVESTOR_ID;

    // Filter investments and transactions to the resolved investor
    let myInvests = allInvestments.filter(i => i.investor_id === resolvedId);
    let myTxns    = allTxns.filter(t => t.investor_id === resolvedId);

    // Case-insensitive fallback if IDs use different casing/formats
    if (myInvests.length === 0 && allInvestments.length > 0) {
      const idLower = resolvedId.toLowerCase();
      myInvests = allInvestments.filter(i =>
        (i.investor_id || '').toLowerCase() === idLower ||
        (i.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }
    if (myTxns.length === 0 && allTxns.length > 0) {
      const idLower = resolvedId.toLowerCase();
      myTxns = allTxns.filter(t =>
        (t.investor_id || '').toLowerCase() === idLower ||
        (t.investor_name || '').toLowerCase().includes((PORTAL.investor?.first_name || '').toLowerCase())
      );
    }

    if (!PORTAL.investor) {
      console.error('[portal] Could not resolve investor — showing empty state');
      PORTAL.investor = { id: resolvedId };
    }

    // Belt and braces: the server excludes cancelled investments for clients,
    // but a cached bundle or a stale response must not put one back on screen.
    // A cancelled investment is an administrative record, not a holding.
    myInvests = myInvests.filter(i => (i.status || '') !== 'cancelled');

    PORTAL.investments  = myInvests.map(inv => ({
      ...inv,
      // Normalise DB column names to the aliases used throughout the portal
      // Always coerce to Number so reduce() never does string concatenation
      amount:                 parseFloat(inv.amount || inv.investment_amount || inv.principal || 0) || 0,
      maturity_date:          inv.end_date         || inv.maturity_date,
      investment_date:        inv.start_date        || inv.investment_date,
      expected_return_amount: parseFloat(inv.expected_return   != null ? inv.expected_return   : (inv.expected_return_amount   || 0)) || 0,
      actual_return_amount:   parseFloat(inv.actual_return     != null ? inv.actual_return     : (inv.actual_return_amount     || 0)) || 0,
      expected_return_rate:   parseFloat(inv.annual_rate       != null ? inv.annual_rate       : (inv.expected_return_rate     || 0)) || 0,
    }));
    PORTAL.transactions = myTxns;
    PORTAL.pools        = poolRes.data || [];

    // Ensure investor object is never null so statement guard passes
    if (!PORTAL.investor) PORTAL.investor = { id: DEMO_INVESTOR_ID };

    // Load waitlist entries for this investor (non-blocking)
    const waitlistRes = await API._fetch('GET', 'tables/investment_waitlist', null, { investor_id: PORTAL.investor.id, limit: 50 }).catch(() => ({ data: [] }));
    PORTAL.waitlist = waitlistRes.data || [];

    try { SVC.setUser(PORTAL.investor); } catch (_) {}
    try { SVC.track('portal_loaded', { active_investments: PORTAL.investments.filter(i => i.status === 'active').length }); } catch (_) {}

    // Cache fresh data so the next launch renders instantly from localStorage
    try {
      const _safeCache = {
        cachedAt:     Date.now(),
        investor:     PORTAL.investor,
        investments:  PORTAL.investments,
        transactions: PORTAL.transactions,
        pools:        PORTAL.pools,
        waitlist:     PORTAL.waitlist,
      };
      localStorage.setItem('svc_portal_cache', JSON.stringify(_safeCache));
    } catch (_) {}

    // Data on screen is now live — retire any stale notice from a failed refresh.
    _cacheStampedAt = null;
    clearStaleDataNotice();

    renderOverview(_opts.skipCharts);
    renderOnboardingWizard();
    updateStmtQuickStats();
    _renderBankDetailsPanel();
    // Re-populate profile if user navigated there before data loaded
    if (document.getElementById('view-profile')?.classList.contains('view--active')) {
      renderRiskProfile();
    }

    // Load gamification data (non-blocking — don't fail portal if quests fail)
    loadQuestData().catch(err => console.warn('[Quests] load error:', err.message));
  } catch (e) {
    console.error(`loadPortalData error (attempt ${_attempt + 1}):`, e);

    // Auth errors: do not retry — the session-expired overlay is already showing
    if (e.message && e.message.includes('Session expired')) return;

    // Network / timeout errors: retry with backoff (handles Railway cold-start)
    if (_attempt < MAX_ATTEMPTS - 1) {
      const delay = (_attempt + 1) * 5000; // 5 s, 10 s, 15 s
      console.log(`[portal] Retrying data load in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      return loadPortalData(_attempt + 1);
    }

    // All attempts exhausted — clear any stale "Loading..." and show an actionable error
    if (!PORTAL.investor) PORTAL.investor = { id: DEMO_INVESTOR_ID };
    try { renderOverview(); } catch (_) {}
    const _retryRow = (cols) => `<tr><td colspan="${cols}" style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem"><i class="fa-solid fa-triangle-exclamation" style="color:#f59e0b;margin-right:6px"></i>Could not reach server. <a href="#" onclick="location.reload()" style="color:var(--gold);text-decoration:none;font-weight:600">Tap to retry →</a></td></tr>`;
    const _ib = document.getElementById('overviewInvestmentsBody');
    const _tb = document.getElementById('overviewTxnBody');
    if (_ib && (!PORTAL.investments.length || _ib.textContent.includes('Loading'))) _ib.innerHTML = _retryRow(6);
    if (_tb && (!PORTAL.transactions.length || _tb.textContent.includes('Loading'))) _tb.innerHTML = _retryRow(4);
    if (window.__SVC_HIDE_COVER) window.__SVC_HIDE_COVER();
    /* When the cache populated the tables, neither retry row above replaces
       anything and the only signal was a toast that disappears seconds later,
       leaving stale money figures looking current. This notice persists. */
    showStaleDataNotice();
    Toast.error('Could not connect to server — showing your last saved data');
  }
}

/* ═══════════════════════════════════════════════
   OVERVIEW
   ═══════════════════════════════════════════════ */


/* Countdown + pending outcome for one maturing investment.
   Without an instruction the money is automatically committed to another full
   term, so that outcome is stated on the row rather than left for the investor
   to discover afterwards. Emphasis escalates as the 5pm deadline approaches. */
function _maturityNote(inv, days) {
  const o = Utils.maturityOutcome(inv);
  const urgency = Utils.maturityUrgency(days);
  const link = (text, colour, weight) =>
    `<a href="#" onclick="navigate('maturity', document.querySelector('[data-view=maturity]'));return false"` +
    ` style="color:${colour};font-weight:${weight};text-decoration:none">${text}</a>`;

  if (!urgency || urgency === 'later') {
    return `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">` +
      (o.decided ? o.label : link(o.label + ' — choose', 'var(--gold)', 600)) + `</div>`;
  }
  const tone = (urgency === 'due' || urgency === 'urgent') ? '#ef4444' : '#f59e0b';
  const when = days <= 0 ? 'Matures today' : days === 1 ? 'Matures tomorrow' : `Matures in ${days} days`;
  return `<div style="font-size:0.72rem;font-weight:700;color:${tone};margin-top:3px">${when}</div>
    <div style="font-size:0.7rem;margin-top:1px">` +
    (o.decided ? `<span style="color:var(--text-muted)">${o.label}</span>`
               : link(o.label + ' — change it', tone, 700)) + `</div>`;
}

function renderOverviewInvestments() {
  const body = document.getElementById('overviewInvestmentsBody');
  if (!body) return;
  const active = PORTAL.investments.filter(i => i.status === 'active');

  if (!active.length) { body.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No active investments. <a href="#" onclick="navigate(\'marketplace\', null)" style="color:var(--gold)">Browse pools →</a></td></tr>'; return; }

  body.innerHTML = active.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    const days = Utils.daysRemaining(inv.maturity_date);
    const pool = PORTAL.pools.find(p => p.id === inv.pool_id);
    const progress = pool ? Utils.poolFillPct(pool) : 100;

    return `<tr>
      <td>
        <div class="td-strong">${_esc(inv.pool_name)}</div>
        <div style="margin-top:4px">
          <div class="progress-bar" style="width:120px;height:4px"><div class="progress-fill" style="width:${progress}%"></div></div>
        </div>
      </td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td class="td-muted">${Utils.date(inv.investment_date || inv.start_date)}</td>
      <td class="td-muted">
        <div>${Utils.date(inv.maturity_date || inv.end_date)}</div>
        ${_maturityNote(inv, days)}
      </td>
      <td>${Utils.statusBadge(inv.status)}</td>
    </tr>`;
  }).join('');
}

function renderOverviewTxns() {
  const body = document.getElementById('overviewTxnBody');
  if (!body) return;
  const recent = [...PORTAL.transactions].sort((a, b) => new Date(b.transaction_date || b.created_at || 0) - new Date(a.transaction_date || a.created_at || 0)).slice(0, 5);
  const typeColors = { deposit: 'green', investment: 'blue', return: 'gold', payout: 'green', matured_funds: 'green', fee: 'orange', referral_bonus: 'purple', withdrawal: 'red', gift_sent: 'orange', gift_received: 'green', reward: 'purple' };

  if (!recent.length) { body.innerHTML = '<tr><td colspan="4" class="text-center text-muted" style="padding:24px">No transactions yet</td></tr>'; return; }

  const _txnIsPositive = t => !['withdrawal', 'fee', 'investment', 'reinvestment', 'gift_sent'].includes(t.type);
  body.innerHTML = recent.map(t => {
    const pos = _txnIsPositive(t);
    return `<tr>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${(t.type?.replace(/_/g, ' ') || '').replace(/^\w/, c => c.toUpperCase())}</span></td>
      <td class="${pos ? 'td-green' : 'td-red'} fw-700">${pos ? '+' : '-'}${Utils.rand(Math.abs(t.amount))}</td>
      <td class="td-muted" style="font-size:0.75rem">${t.description || '—'}</td>
      <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
    </tr>`;
  }).join('');
}


/* ═══════════════════════════════════════════════
   MY INVESTMENTS
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   TRANSACTIONS
   ═══════════════════════════════════════════════ */
async function loadMyTransactions() {
  const txnBody = document.getElementById('myTxnBody');
  if (txnBody && !PORTAL.transactions.length) txnBody.innerHTML = _skeletonRows(5, 6);
  if (!PORTAL.transactions.length) await loadPortalData();
  renderMyTxnTable();

  document.getElementById('myTxnTypeFilter').addEventListener('change', renderMyTxnTable);
}

function renderMyTxnTable() {
  const body = document.getElementById('myTxnBody');
  const filter = document.getElementById('myTxnTypeFilter').value;
  const items = filter ? PORTAL.transactions.filter(t => t.type === filter) : PORTAL.transactions;
  const sorted = [...items].sort((a, b) => new Date(b.transaction_date || b.created_at || 0) - new Date(a.transaction_date || a.created_at || 0));

  const typeColors = { deposit: 'green', investment: 'blue', return: 'gold', payout: 'green', matured_funds: 'green', fee: 'orange', referral_bonus: 'purple', withdrawal: 'red', gift_sent: 'orange', gift_received: 'green', reward: 'purple' };

  if (!sorted.length) {
    body.innerHTML = `<tr><td colspan="6" style="padding:0;border:none">
      <div class="empty-state">
        <i class="fa-solid fa-receipt"></i>
        <div class="empty-state__title">No transactions yet</div>
        <div class="empty-state__sub">Top up your wallet or make an investment to see activity here.<br>
          <a href="#" onclick="navigate('wallet', document.querySelector('[data-view=wallet]'))" style="color:var(--gold)">Go to Wallet →</a>
        </div>
      </div>
    </td></tr>`;
    return;
  }

  const _isPosTxn = t => !['withdrawal', 'fee', 'investment', 'reinvestment', 'gift_sent'].includes(t.type);
  body.innerHTML = sorted.map(t => {
    const pos = _isPosTxn(t);
    return `<tr>
      <td><span class="badge badge--${typeColors[t.type] || 'gray'}">${(t.type?.replace(/_/g, ' ') || '').replace(/^\w/, c => c.toUpperCase())}</span></td>
      <td class="${pos ? 'td-green' : 'td-red'} fw-700">${pos ? '+' : '-'}${Utils.rand(Math.abs(t.amount))}</td>
      <td>${Utils.statusBadge(t.status)}</td>
      <td class="td-muted" style="font-size:0.72rem">${t.reference || '—'}</td>
      <td class="td-muted" style="font-size:0.75rem">${t.description || '—'}</td>
      <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
    </tr>`;
  }).join('');
}


/* ═══════════════════════════════════════════════
   WALLET
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   AUTO WALLET TOP-UP (Paystack Authorization)
   ═══════════════════════════════════════════════ */

let _autoTopUpCard     = null;  // cached card info {card_type, last4, ...}
let _autoTopUpSettings = null;  // cached settings {auto_topup_enabled, amount, day}


/* ═══════════════════════════════════════════════
   PAYMENT GATEWAY — 3-Step flow
   Step 1: Enter amount
   Step 2: Choose gateway (Paystack | Ozow | EFT)
   Step 3: Process / confirm / show bank details

   Paystack public key (test): pk_test_72040393098052bb00477db9fb8f69f369193707
   ═══════════════════════════════════════════════ */

// Paystack public key — loaded from server env var (PAYSTACK_PUBLIC_KEY) at init.
// Set PAYSTACK_PUBLIC_KEY=pk_live_... in Railway to go live without touching code.
let PAYSTACK_PUBLIC_KEY = 'pk_test_72040393098052bb00477db9fb8f69f369193707';


// ⚠️  REPLACE with your real Ozow SiteCode from the Ozow merchant portal
// Set IsTest=false in launchOzow() when going live
const OZOW_SITE_CODE      = 'SMA-SMA-030';
const TX_FEE_RATE         = 0.029;   // 2.9% + R1 flat — charged by gateway (Paystack & Ozow)

// Internal state
let _pmAmount       = 0;       // base deposit amount entered by investor (ZAR)
let _pmGateway      = null;    // 'paystack' | 'ozow' | 'eft'
let _pmSaId         = null;    // null = main wallet; saId = credit sub-account instead

// Invest modal drop-off tracking state
let _investModalPool   = null;   // pool shown in the current invest modal session
let _investConfirmed   = false;  // set true when confirmInvestment() is called
let _investFeeTracked  = false;  // true once svc_invest_fee_shown has fired this session
let _investOoBTracked  = false;  // true once over-budget svc_invest_insufficient_funds has fired


/* Total charged to card/bank for non-EFT gateways */


/* ── EFT proof of payment file handler ─── */
let _eftProofFile = null;
let _eftProofBase64 = null;


/* ═══════════════════════════════════════════════
   MARKETPLACE
   ═══════════════════════════════════════════════ */
let _mktProducts = [];
let _selectedProductType = null;   // null = product grid; set = product detail

async function loadMarketplace() {
  try {
    if (!PORTAL.pools.length) {
      const res = await API.pools.list({ limit: 100 });
      PORTAL.pools = res.data || [];
    }
  } catch (err) {
    console.warn('[marketplace] failed to fetch pools:', err);
    // Render with whatever is cached — show empty state rather than "Loading..."
  }
  try { _mktProducts = await _getPortalProducts(); } catch (_) { _mktProducts = []; }

  // Fallback: if the products table has no active entries, synthesise a virtual
  // product for each distinct product_type that has at least one pool so the
  // marketplace always shows what's available.
  if (!_mktProducts.length && PORTAL.pools.length) {
    const seen = new Set();
    _mktProducts = PORTAL.pools
      .filter(p => p && p.product_type && !seen.has(p.product_type) && seen.add(p.product_type))
      .map(p => {
        const pi = Utils.productInfo(p.product_type);
        return {
          product_type: p.product_type,
          label:        pi.label || p.product_type,
          is_active:    true,
          sort_order:   0,
          min_investment: p.min_investment,
          annual_rate:    p.annual_rate,
        };
      });
  }

  // Enrich each product's avg_actual_rate from the track record (matured pools).
  try {
    const tr = await _getTrackRecord();
    if (tr && Object.keys(tr).length) {
      _mktProducts.forEach(p => {
        const isSolar = (p.product_type || '').startsWith('solar');
        const keys = Object.keys(tr).filter(k => isSolar ? k.startsWith('solar') : k === p.product_type);
        let sumA = 0, nA = 0;
        keys.forEach(k => {
          const d = tr[k];
          sumA += (d.avg_actual_rate || 0) * (d.matured_count || 0);
          nA   += d.matured_count || 0;
        });
        // short_term stores period rates (not p.a.); the products API SQL already gives the
        // correct period average — skip enrichment to avoid overwriting it with an annualised value.
        if (p.product_type === 'short_term') return;
        const enriched = nA > 0 ? sumA / nA : 0;
        if (enriched > 0) p.avg_actual_rate = enriched;
      });
    }
  } catch (_) {}

  _selectedProductType = null;   // always land on the product grid
  try {
    renderMarketplace();
  } catch (err) {
    console.error('[marketplace] renderMarketplace failed:', err);
    const grid = document.getElementById('marketplaceGrid');
    if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-triangle-exclamation"></i><div class="empty-state__title">Could not load pools</div><div class="empty-state__sub">Pull down to refresh or check your connection.</div></div>`;
  }
  try {
    SVC.track('view_item_list', { item_list_id: 'marketplace', item_list_name: 'Investment Pools', items: PORTAL.pools.slice(0, 10).map(p => ({ item_id: p.id, item_name: p.name, item_category: p.product_type })) });
  } catch (_) {}
}


const _POOL_META = {
  solar:         { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#fec24f' },
  solar_7yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#fec24f' },
  solar_6yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#fec24f' },
  solar_5yr:     { blurb: 'Funds solar energy installations for homes & businesses across SA.', risk: 'Moderate',     riskColor: '#fec24f' },
  cattle:        { blurb: `Partner with ${_partnerNameLink('Beefcor')} — SA's premier feedlot — and earn returns as your herd grows from 200kg to 500kg.`, risk: 'Aggressive',   riskColor: '#ef4444' },
  short_term:    { blurb: 'Fund South African SMMEs through asset finance. Capital deployed into vetted businesses generating strong short-cycle returns.', risk: 'Moderate',  riskColor: '#fec24f' },
  delivery_bike: { blurb: 'Fleet funding for delivery riders. Steady, predictable returns.',    risk: 'Conservative', riskColor: '#22c55e' },
  gridfarmer:    { blurb: 'Own a uniquely identified 1-ha white maize GPS grid. Your return is your plot\'s actual yield × SAFEX price — satellite-monitored, GPS-verified.', risk: 'High', riskColor: '#ff5229' },
};
// Map each product's risk label to a filter group
// Risk profile is defined per-product in the admin console (products.risk_profile).
// Resolve the current risk label + colour for a product type from live records.
const _RISK_COLORS = { 'Low': '#22c55e', 'Medium': '#fec24f', 'Medium-High': '#fec24f', 'High': '#ef4444' };


// ── Product-first marketplace ────────────────────────────────────────────
// "Browse Pools" is now "Products": investors pick a product, see its details
// + factsheets + a chart, then the open pools under it, and invest from there.


// Count of open/waitlist pools for a product type
function _openPoolsForProduct(type) {
  return PORTAL.pools.filter(p => {
    if (p.product_type !== type) return false;
    if (_poolPastClose(p)) return false;
    return p.status === 'open' || p.status === 'waitlist';
  });
}


async function renderProductDetailView(type) {
  const grid = document.getElementById('marketplaceGrid');
  if (!grid) return;
  const product = (_mktProducts || []).find(p => p.product_type === type) || { product_type: type, label: Utils.productInfo(type).label };
  const pi = Utils.productInfo(type);
  const color = Utils.productColor(product);
  const icon = product.icon || pi.icon;
  const open = _openPoolsForProduct(type);
  const avg = product.avg_actual_rate > 0 ? parseFloat(product.avg_actual_rate) : null;
  const projRate = avg != null ? avg : (product.benchmark_rate ? parseFloat(product.benchmark_rate) : (open[0] ? parseFloat(open[0].annual_rate) : 0.13));
  const keyDetails = (product.key_details || '').split('\n').map(s => s.trim()).filter(Boolean);
  const isStDetail = type === 'short_term';
  const termMoDetail = product.term_months || (open[0] && open[0].term_months) || null;
  const returnLbl = avg != null
    ? (isStDetail && termMoDetail ? `AVG RETURN (${termMoDetail} MO)` : 'AVG RETURN P.A.')
    : (isStDetail && termMoDetail ? `TARGET RETURN (${termMoDetail} MO)` : 'TARGET RETURN P.A.');

  // Live data panels: cattle herd status / solar telematics
  const isSolar = (type || '').startsWith('solar');
  const herdSlot = type === 'cattle'
    ? '<div id="prodHerdStatus" style="margin-bottom:16px"></div>'
    : (isSolar ? '<div id="prodSolarStatus" style="margin-bottom:16px"></div>' : '');

  grid.innerHTML = `
    <div style="grid-column:1/-1">
      <button class="btn btn--ghost btn--sm" onclick="backToProducts()" style="margin-bottom:14px"><i class="fa-solid fa-arrow-left"></i> All products</button>

      <div class="market-pool-card mpc-v2" style="cursor:default">
        <div class="mpc2-accent" style="background:linear-gradient(90deg,${color},${color}88)"></div>
        <div style="padding:16px 16px 8px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
            <div class="mpc2-icon" style="background:${color}18;color:${color}"><i class="fa-solid ${icon}"></i></div>
            <div>
              <div style="font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color}">${_esc((product.label || '').replace(/\s*\(\d+yr\)/gi, '').trim())}</div>
              <div class="mpc2-title" style="font-size:1.3rem">${_esc(product.headline || (product.label || '').replace(/\s*\(\d+yr\)/gi, '').trim() || '')}</div>
            </div>
          </div>
          ${product.description ? `<p style="font-size:0.9rem;color:var(--text-muted);line-height:1.6;margin-bottom:14px">${_esc(product.description)}</p>` : ''}

          <div class="mpc2-metrics" style="margin-bottom:16px">
            <div class="mpc2-metric">
              <div class="mpc2-metric__val" style="background:linear-gradient(135deg,${color},${color}bb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${avg != null ? (avg * 100).toFixed(2) + '%' : (product.benchmark_rate ? (parseFloat(product.benchmark_rate) * 100).toFixed(1) + '%' : (open[0] ? (parseFloat(open[0].annual_rate) * 100).toFixed(1) + '%' : '—'))}</div>
              <div class="mpc2-metric__lbl">${returnLbl}</div>
            </div>
            <div class="mpc2-metric-sep"></div>
            <div class="mpc2-metric"><div class="mpc2-metric__val" style="font-size:1.25rem">${Utils.rand(product.min_investment || 0)}</div><div class="mpc2-metric__lbl">minimum</div></div>
            <div class="mpc2-metric-sep"></div>
            <div class="mpc2-metric"><div class="mpc2-metric__val">${product.term_months || (open[0] && open[0].term_months) || '—'}<span style="font-size:1rem;opacity:0.7">mo</span></div><div class="mpc2-metric__lbl">term</div></div>
            ${product.performance_fee_pct ? `<div class="mpc2-metric-sep"></div><div class="mpc2-metric"><div class="mpc2-metric__val" style="font-size:1.2rem">${(parseFloat(product.performance_fee_pct) * 100).toFixed(0)}%</div><div class="mpc2-metric__lbl">perf. fee</div></div>` : ''}
          </div>

          ${type === 'cattle' && keyDetails.length
            ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;margin-bottom:16px">
                <div id="prodHerdStatus"></div>
                <div style="background:rgba(254,194,79,0.06);border:1px solid rgba(254,194,79,0.22);border-radius:12px;padding:14px 16px">
                  <div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#b8860b;margin-bottom:10px"><i class="fa-solid fa-list" style="margin-right:5px"></i>Key Details</div>
                  <div style="display:flex;flex-direction:column;gap:7px">
                    ${keyDetails.map(d => `<div style="display:flex;gap:9px;font-size:0.86rem;color:var(--text)"><i class="fa-solid fa-arrow-right" style="color:${color};margin-top:3px;font-size:0.75rem"></i><span>${_esc(d)}</span></div>`).join('')}
                  </div>
                </div>
              </div>`
            : `${herdSlot}${keyDetails.length ? `<div style="margin-bottom:16px"><div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:8px">Key Details</div><div style="display:flex;flex-direction:column;gap:7px">${keyDetails.map(d => `<div style="display:flex;gap:9px;font-size:0.86rem;color:var(--text)"><i class="fa-solid fa-arrow-right" style="color:${color};margin-top:3px;font-size:0.75rem"></i><span>${_esc(d)}</span></div>`).join('')}</div></div>` : ''}`}

          ${isSolar ? '<div id="prodSolarHistory" style="margin-top:16px"></div>' : ''}
          <div id="prodTrackRecord" style="margin-top:16px"></div>
        </div>
      </div>

      <div style="font-size:0.95rem;font-weight:800;color:var(--text);margin:22px 0 12px"><i class="fa-solid fa-layer-group" style="color:${color};margin-right:6px"></i>Open pools — ${open.length}</div>
      <div class="grid-3" id="productPoolsGrid"></div>

      <!-- The archive sits below what can be acted on. It was inside the
           product card, above the pools, and a product with three years of
           monthly factsheets pushed its one open pool off the screen. -->
      <div id="prodFactsheets" style="margin-top:26px"></div>
    </div>`;

  // Pools
  const poolsGrid = document.getElementById('productPoolsGrid');
  const _saDetail = _pmSaId ? (PORTAL.subAccounts || []).find(s => s.id === _pmSaId) : null;
  const walletBal = _saDetail ? (parseFloat(_saDetail.wallet_balance) || 0) : (parseFloat(PORTAL.investor?.wallet_balance) || 0);
  const waitlist = PORTAL.waitlist || [];
  const investorId = PORTAL.investor?.id;
  const ranked = _rankMarketPools(open, walletBal);
  if (poolsGrid) {
    poolsGrid.innerHTML = ranked.length
      ? ranked.map((pool, idx) => _marketPoolCardHtml(pool, idx, walletBal, waitlist, investorId)).join('')
      : `<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-clock"></i><div class="empty-state__title">No open pools right now</div><div class="empty-state__sub">Pools for this product open regularly.</div></div>`;
  }

  // Live data panels
  if (type === 'cattle') _renderCattleHerdStatus('prodHerdStatus');
  if (isSolar) { _renderSolarStatus('prodSolarStatus'); _renderSolarHistory('prodSolarHistory', color); }

  // Verifiable track record (matured pools: actual vs benchmark)
  _renderProductTrackRecord(type, color);

  // Factsheets (product-level + all pool factsheets for this product)
  _renderProductFactsheets(type, product);
}

// Compound-growth projection of R10,000 over the term
let _prodGrowthChart = null;


// ── Track record: matured pools' achieved return vs benchmark ──
let _trackRecordCache = null;


let _trackChart = null;


// ── Solar: daily generation this month (FoxESS history) ──
let _solarHistChart = null;


// Single open-pool card (used inside the product detail view)
function _marketPoolCardHtml(pool, idx, walletBal, waitlist, investorId) {
    const pi   = Utils.productInfo(pool.product_type);
    const pct  = Utils.poolFillPct(pool);
    const days = Utils.daysRemaining(pool.end_date);
    const meta = _POOL_META[pool.product_type] || { blurb: '', risk: 'Medium', riskColor: '#fec24f' };
    const pr   = _productRisk(pool.product_type);   // risk profile from the product (admin console)
    const canInvest = walletBal >= _minPlusFee(pool);
    const urgency   = days !== null && days <= 7;

    // Waitlist state
    const isWaitlisted = pool.status === 'waitlist' || pool.is_waitlisted;
    const alreadyOnWaitlist = waitlist.some(w => w.pool_id === pool.id && w.investor_id === investorId);

    // Capacity progress bar
    const maxCap = parseFloat(pool.max_capacity) || 0;
    const curInv = parseFloat(pool.current_invested) || parseFloat(pool.live_raised) || parseFloat(pool.raised_amount) || 0;
    let capacityBarHtml = '';
    if (maxCap > 0) {
      const capPct = Math.min(100, Math.round((curInv / maxCap) * 100));
      const capColor = capPct >= 90 ? '#ef4444' : capPct >= 70 ? '#fec24f' : '#22c55e';
      capacityBarHtml = `
        <div style="margin-top:6px">
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:var(--text-muted);margin-bottom:3px">
            <span>Capacity</span>
            <span style="color:${capColor};font-weight:700">${capPct}% filled</span>
          </div>
          <div style="height:4px;border-radius:2px;background:rgba(0,0,0,0.1);overflow:hidden">
            <div style="height:100%;width:${capPct}%;background:${capColor};border-radius:2px;transition:width 0.4s"></div>
          </div>
        </div>`;
    }

    // CTA area
    let ctaHtml;
    if (isWaitlisted) {
      if (alreadyOnWaitlist) {
        ctaHtml = `
          <div style="display:flex;align-items:center;gap:8px;margin-top:2px">
            <span class="badge badge--green" style="flex:1;justify-content:center;padding:10px 0"><i class="fa-solid fa-check"></i> On Waitlist</span>
          </div>`;
      } else {
        ctaHtml = `
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:2px">
            <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:0.78rem;color:#ef4444">
              <i class="fa-solid fa-lock"></i> Pool Full — Waitlist Available
            </div>
            <button class="btn btn--secondary btn--full" onclick='joinWaitlist(${JSON.stringify(pool.id)})'>
              <i class="fa-solid fa-clock"></i> Join Waitlist
            </button>
          </div>`;
      }
    } else if (canInvest) {
      ctaHtml = `<button class="btn btn--primary btn--full" onclick='openInvestModal(${JSON.stringify(pool.id)})'>
                   <i class="fa-solid fa-coins"></i> Invest Now
                 </button>`;
    } else {
      ctaHtml = `<div class="pool-card__need-topup">
                   <i class="fa-solid fa-wallet"></i>
                   <span>Need ${Utils.rand(Math.max(0, _minPlusFee(pool) - walletBal))} more in wallet</span>
                   <button class="btn btn--ghost btn--sm" onclick="navigate('wallet',document.querySelector('[data-view=wallet]'))">Top Up</button>
                 </div>`;
    }

    const highlighted = idx === 0 && pool.status === 'open';

    // Factsheet link — loaded async into dataset on the card
    const fsAttr = `data-pool-id="${pool.id}"`;

    return `
      <div class="market-pool-card mpc-v2 ${highlighted ? 'mpc-v2--featured' : ''}" ${fsAttr}>
        <!-- Card header accent strip -->
        <div class="mpc2-accent" style="background:linear-gradient(90deg,${pi.color},${pi.color}88)"></div>

        <div class="mpc2-top">
          <!-- Icon + badges row -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div class="mpc2-icon" style="background:${pi.color}18;color:${pi.color}">
              <i class="fa-solid ${pi.icon}"></i>
            </div>
            <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
              ${highlighted ? `<span class="mpc2-badge mpc2-badge--featured"><i class="fa-solid fa-star" style="font-size:0.72rem"></i> Best Next Step</span>` : ''}
              <span class="mpc2-badge" style="background:${pr.color}14;color:${pr.color};border-color:${pr.color}30">${pr.risk} risk</span>
              ${isWaitlisted
                ? '<span class="mpc2-badge mpc2-badge--full"><i class="fa-solid fa-lock"></i> Pool Full</span>'
                : (urgency ? '<span class="mpc2-badge mpc2-badge--urgent"><i class="fa-solid fa-fire"></i> Closing Soon</span>' : '')
              }
            </div>
          </div>

          <!-- Title + blurb -->
          <div style="margin-top:14px">
            <div class="mpc2-title">${_esc(pool.name)}</div>
            <div class="mpc2-blurb">${meta.blurb}</div>
          </div>
        </div>

        <!-- Key metrics -->
        <div class="mpc2-metrics">
          <div class="mpc2-metric">
            <div class="mpc2-metric__val" style="background:linear-gradient(135deg,${pi.color},${pi.color}bb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">${Utils.pct(pool.annual_rate)}</div>
            <div class="mpc2-metric__lbl">benchmark</div>
          </div>
          <div class="mpc2-metric-sep"></div>
          <div class="mpc2-metric">
            <div class="mpc2-metric__val">${pool.term_months}<span style="font-size:1rem;opacity:0.7">mo</span></div>
            <div class="mpc2-metric__lbl">fixed term</div>
          </div>
          <div class="mpc2-metric-sep"></div>
          <div class="mpc2-metric">
            <div class="mpc2-metric__val" style="font-size:1.25rem">${Utils.rand(pool.min_investment)}</div>
            <div class="mpc2-metric__lbl">minimum</div>
          </div>
        </div>

        <!-- Info pills -->
        <div class="mpc2-pills">
          <div class="mpc2-pill">
            <i class="fa-solid fa-users"></i>
            <span><strong>${pool.live_investor_count ?? pool.investor_count ?? 0}</strong> investor${(pool.live_investor_count ?? pool.investor_count ?? 0) !== 1 ? 's' : ''}</span>
          </div>
          ${days !== null ? `<div class="mpc2-pill${urgency ? ' mpc2-pill--urgent' : ''}">
            <i class="fa-solid fa-clock"></i>
            <span>Closes in <strong>${days}d</strong></span>
          </div>` : ''}
          ${pool.partner_name ? `<div class="mpc2-pill">
            <i class="fa-solid fa-handshake"></i>
            <span><strong>${_partnerNameLink(pool.partner_name)}</strong></span>
            ${_partnerInfoBtn(pool.partner_name)}
          </div>` : ''}
        </div>

        <!-- Funding / closure progress -->
        <div class="mpc2-progress">
          ${(Utils.poolIsDateTarget(pool) || !!pool.end_date) ? (() => {
            // Pools with a closing date: show time-elapsed progress bar
            const openD  = pool.start_date ? new Date(pool.start_date) : null;
            const closeD = pool.end_date   ? new Date(pool.end_date)   : null;
            const today  = new Date(); today.setHours(0,0,0,0);
            const totalDays = (openD && closeD) ? Math.max(1, Math.round((closeD - openD) / 86400000)) : null;
            const elapsed   = openD ? Math.max(0, Math.round((today - openD) / 86400000)) : null;
            const timePct   = (totalDays && elapsed !== null) ? Math.min(100, Math.round(elapsed / totalDays * 100)) : null;
            const left = days === null ? '—' : (days === 0 ? 'Closing today' : `${days} day${days === 1 ? '' : 's'} left`);
            const barColor = timePct >= 90 ? '#ef4444' : timePct >= 70 ? '#fec24f' : pi.color;
            return `
              <div class="mpc2-progress__labels">
                <span><i class="fa-solid fa-clock" style="margin-right:4px"></i>${left}</span>
                ${timePct !== null ? `<span style="font-weight:700;color:${barColor}">${timePct}% of term elapsed</span>` : ''}
              </div>
              ${timePct !== null ? `<div class="mpc2-progress__track"><div class="mpc2-progress__fill" style="width:${timePct}%;background:linear-gradient(90deg,${barColor},${barColor}aa)"></div></div>` : ''}`;
          })() : `
            <div class="mpc2-progress__labels">
              <span>${Utils.rand(pool.live_raised ?? pool.raised_amount ?? 0)} raised</span>
              <span style="font-weight:700;color:${pct >= 90 ? '#ef4444' : pct >= 60 ? '#fec24f' : pi.color}">${pct}% funded</span>
            </div>
            <div class="mpc2-progress__track">
              <div class="mpc2-progress__fill" style="width:${pct}%;background:linear-gradient(90deg,${pi.color},${pi.color}aa)"></div>
            </div>`}
          ${capacityBarHtml}
        </div>

        <!-- CTA + factsheet -->
        <div class="mpc2-footer">
          <div style="flex:1">${ctaHtml}</div>
          <button class="mpc2-fs-btn" id="fsBtn-${pool.id}" onclick="viewFactsheet('${pool.id}','${pool.name}')" title="View factsheet" style="display:none">
            <i class="fa-solid fa-file-pdf"></i>
          </button>
        </div>
      </div>
    `;
}

/* ─── Factsheet viewer ───────────────────────────────────────────── */
// Cache of the public products feed (factsheets, herd stats source, etc.)
let _portalProductsCache = null;


// Live cattle herd status (from the fund-management herd data), shown on the
// Cattle Investment product so investors can see the real herd behind it.
let _cattleStatsCache = null;


// Live solar telematics (FoxESS/FoxCloud) — shared across all solar terms
let _solarStatsCache = null;


/* Platform fee is taken FROM the wallet spend (fee-inclusive model).
   User enters total wallet amount; fee ≈ 0.99% of that; pool gets the rest. */
const PLATFORM_FEE_RATE = 0.01;
function _platformFee(walletAmount) {
  return Math.round((parseFloat(walletAmount) || 0) * (PLATFORM_FEE_RATE / (1 + PLATFORM_FEE_RATE)) * 100) / 100;
}
/* Minimum wallet balance needed to invest in this pool.
   Fee comes from the amount, so no extra top-up required. */
function _minPlusFee(pool) {
  return parseFloat(pool.min_investment) || 0;
}

function openInvestModal(poolId) {
  const pool = PORTAL.pools.find(p => p.id === poolId);
  if (!pool) return;

  SVC.track('view_item', { items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type }] });
  SVC.track('select_item', { items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type }] });

  const _activeSa  = _pmSaId ? PORTAL.subAccounts.find(s => s.id === _pmSaId) : null;
  const walletBal  = _activeSa ? (parseFloat(_activeSa.wallet_balance) || 0) : (parseFloat(PORTAL.investor?.wallet_balance) || 0);
  const pi         = Utils.productInfo(pool.product_type);
  const meta       = _POOL_META[pool.product_type] || { risk: 'Medium', riskColor: '#fec24f' };
  const pr         = _productRisk(pool.product_type);   // risk from the product (admin console)
  const maturityDt = new Date();
  maturityDt.setMonth(maturityDt.getMonth() + pool.term_months);
  const maturityStr = maturityDt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });

  document.getElementById('investModalTitle').textContent = `Invest in ${pool.name}`;

  document.getElementById('investModalBody').innerHTML = `
    ${_activeSa ? `<div style="background:rgba(254,194,79,0.1);border:1px solid rgba(254,194,79,0.3);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:0.82rem;color:#fec24f;display:flex;align-items:center;gap:8px"><i class="fa-solid fa-wallet"></i><span>Investing from <strong>${_esc(_activeSa.name)}</strong> sub-account &mdash; available: <strong>${Utils.rand(walletBal)}</strong></span></div>` : ''}
    <!-- Pool summary card -->
    <div class="invest-modal-pool-card">
      <div class="invest-modal-pool-icon" style="background:${pi.color}20;color:${pi.color}">
        <i class="fa-solid ${pi.icon}"></i>
      </div>
      <div class="invest-modal-pool-info">
        <div class="invest-modal-pool-name">${pool.name}</div>
        <div class="invest-modal-pool-meta">
          <span style="color:${pi.color};font-weight:700">${Utils.pct(pool.annual_rate)} benchmark</span>
          <span>·</span>
          <span>${pool.term_months}-month term</span>
          <span>·</span>
          <span class="pool-risk-badge" style="background:${pr.color}18;color:${pr.color}">${pr.risk} risk</span>
        </div>
      </div>
    </div>

    ${pool.product_type === 'cattle' ? '<div id="cattleHerdStatus"></div>' : ''}

    <!-- Wallet balance indicator (needs to cover the minimum + 1% platform fee) -->
    ${walletBal < _minPlusFee(pool)
      ? `<div style="background:rgba(239,68,68,0.07);border:1.5px solid rgba(239,68,68,0.3);border-radius:12px;padding:14px 16px;margin-bottom:14px">
           <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
             <i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;font-size:1.1rem;flex-shrink:0"></i>
             <div>
               <div style="font-weight:700;color:#ef4444;font-size:0.9rem">Wallet top-up required</div>
               <div style="font-size:0.78rem;color:#6b7280;margin-top:2px">You have <strong style="color:#1a1a1a">${Utils.rand(walletBal)}</strong> — you need <strong style="color:#1a1a1a">${Utils.rand(_minPlusFee(pool))}</strong> to invest. The 1% platform fee is included in that amount.</div>
             </div>
           </div>
           <button class="btn btn--primary btn--sm" style="width:100%" onclick="Modal.close('investModal');navigate('wallet',document.querySelector('[data-view=wallet]'))">
             <i class="fa-solid fa-plus"></i> Top Up Wallet
           </button>
         </div>`
      : `<div class="invest-wallet-indicator invest-wallet-ok" style="margin-bottom:14px">
           <i class="fa-solid fa-wallet"></i>
           <span>Wallet: <strong>${Utils.rand(walletBal)}</strong></span>
           <span class="invest-wallet-ok-badge"><i class="fa-solid fa-circle-check"></i> Sufficient</span>
         </div>`}

    <!-- Quick-pick amount buttons -->
    <div class="form-group" style="margin-top:14px">
      <label class="form-label">How much would you like to invest?</label>
      <div class="invest-quickpick mb-8">
        ${[pool.min_investment, 5000, 10000, 25000].filter(v => v <= walletBal || v === pool.min_investment).map(v =>
          `<button class="invest-qp-btn" onclick="document.getElementById('investAmount').value=${v};_updateInvestCalc(${v},${pool.annual_rate},${pool.term_months},${pool.min_investment},${walletBal})">${Utils.rand(v)}</button>`
        ).join('')}
      </div>
      <input type="number" class="form-input" id="investAmount"
        placeholder="Enter amount (min ${Utils.rand(pool.min_investment)})"
        min="${pool.min_investment}" max="${walletBal}"
        oninput="_updateInvestCalc(parseFloat(this.value)||0,${pool.annual_rate},${pool.term_months},${pool.min_investment},${walletBal})" />
    </div>
    <div id="investInsufficientBanner" style="display:none"></div>


    <!-- Wallet deduction breakdown (fee-inclusive: user enters wallet spend) -->
    <div id="investFeeBreakdown" style="margin-top:12px;border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:10px 14px;font-size:0.84rem">
      <div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--text-muted)">
        <span>Pool investment</span><span id="ic-fee-amount" style="font-weight:600;color:#1a1a1a">—</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--text-muted)">
        <span>Platform fee (1%)</span><span id="ic-fee-fee" style="font-weight:600;color:#1a1a1a">—</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:7px 0 1px;margin-top:5px;border-top:1px dashed rgba(0,0,0,0.12);font-weight:700">
        <span>Total from ${_activeSa ? 'sub-account' : 'wallet'}</span><span id="ic-fee-total" style="color:#1a1a1a">—</span>
      </div>
    </div>

  `;

  const invBtn = document.getElementById('investConfirmBtn');
  invBtn.onclick = () => _withBtn(invBtn, () => confirmInvestment(pool));
  _investModalPool  = pool;
  _investConfirmed  = false;
  _investFeeTracked = false;
  _investOoBTracked = false;
  _trackFunnel('modal_opened', { pool_id: pool.id, product_type: pool.product_type, wallet_bucket: _amtBucket(walletBal) });
  if (walletBal < _minPlusFee(pool)) {
    SVC.track('svc_invest_insufficient_funds', { pool_id: pool.id, product_type: pool.product_type, stage: 'modal_open', wallet_bucket: _amtBucket(walletBal), shortfall_bucket: _amtBucket(_minPlusFee(pool) - walletBal) });
    _trackFunnel('insufficient_funds', { pool_id: pool.id, product_type: pool.product_type, stage: 'modal_open', wallet_bucket: _amtBucket(walletBal), shortfall_bucket: _amtBucket(_minPlusFee(pool) - walletBal) });
  }
  Modal.open('investModal');
  if (pool.product_type === 'cattle') {
    _renderCattleHerdStatus('cattleHerdStatus', true); // true = compact mode
  }
}

function _updateInvestCalc(amt, rate, termMonths, minInvest, walletBal) {
  const banner   = document.getElementById('investInsufficientBanner');
  const confirmBtn = document.getElementById('investConfirmBtn');
  const feeAmtEl = document.getElementById('ic-fee-amount');
  const feeFeeEl = document.getElementById('ic-fee-fee');
  const feeTotEl = document.getElementById('ic-fee-total');

  // Fee-inclusive: fee comes FROM amt, pool gets the remainder
  const fee        = _platformFee(amt);
  const poolAmt    = Math.round((amt - fee) * 100) / 100;
  const overBudget = walletBal != null && amt > walletBal + 0.005;

  if (amt >= minInvest) {
    if (feeAmtEl) feeAmtEl.textContent = Utils.rand(poolAmt, 2);
    if (feeFeeEl) feeFeeEl.textContent = Utils.rand(fee, 2);
    if (feeTotEl) {
      feeTotEl.textContent = Utils.rand(amt, 2);
      feeTotEl.style.color = overBudget ? '#ef4444' : '#1a1a1a';
    }
    if (!_investFeeTracked) {
      _investFeeTracked = true;
      SVC.track('svc_invest_fee_shown', { pool_id: _investModalPool?.id, product_type: _investModalPool?.product_type, amount_bucket: _amtBucket(amt) });
      _trackFunnel('fee_shown', { pool_id: _investModalPool?.id, product_type: _investModalPool?.product_type, amount_bucket: _amtBucket(amt) });
    }
  } else {
    if (feeAmtEl) feeAmtEl.textContent = '—';
    if (feeFeeEl) feeFeeEl.textContent = '—';
    if (feeTotEl) { feeTotEl.textContent = '—'; feeTotEl.style.color = '#1a1a1a'; }
  }

  // Over-budget: show top-up prompt
  if (banner) {
    if (overBudget) {
      const canInvest = walletBal >= minInvest;
      banner.style.display = 'block';
      banner.innerHTML = `
        <div style="margin-top:10px;background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.25);border-radius:10px;padding:12px 14px">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <i class="fa-solid fa-circle-exclamation" style="color:#ef4444;margin-top:2px;flex-shrink:0"></i>
            <div style="flex:1">
              <div style="font-size:0.83rem;font-weight:700;color:#ef4444;margin-bottom:4px">Amount exceeds available balance</div>
              <div style="font-size:0.78rem;color:#6b7280;line-height:1.5">
                You entered <strong style="color:#1a1a1a">${Utils.rand(amt, 2)}</strong> but your wallet has <strong style="color:#1a1a1a">${Utils.rand(walletBal)}</strong>.
                ${canInvest
                  ? `The most you can invest right now is <strong style="color:#1a1a1a">${Utils.rand(walletBal)}</strong>.`
                  : `This exceeds your available balance even at the minimum investment.`}
              </div>
              <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                ${canInvest ? `<button class="btn btn--secondary btn--sm" onclick="document.getElementById('investAmount').value=${walletBal};_updateInvestCalc(${walletBal},${rate},${termMonths},${minInvest},${walletBal})">Use max (${Utils.rand(walletBal)})</button>` : ''}
                <button class="btn btn--primary btn--sm" onclick="Modal.close('investModal');navigate('wallet',document.querySelector('[data-view=wallet]'))"><i class="fa-solid fa-plus"></i> Top Up Wallet</button>
              </div>
            </div>
          </div>
        </div>`;
      if (confirmBtn) confirmBtn.disabled = true;
      if (!_investOoBTracked) {
        _investOoBTracked = true;
        SVC.track('svc_invest_insufficient_funds', { pool_id: _investModalPool?.id, product_type: _investModalPool?.product_type, stage: 'amount_entry', wallet_bucket: _amtBucket(walletBal), shortfall_bucket: _amtBucket(amt - walletBal) });
        _trackFunnel('over_budget', { pool_id: _investModalPool?.id, product_type: _investModalPool?.product_type, stage: 'amount_entry', wallet_bucket: _amtBucket(walletBal), shortfall_bucket: _amtBucket(amt - walletBal) });
      }
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }
}

async function confirmInvestment(pool) {
  _investConfirmed = true;
  // walletSpend = what user entered (total leaving wallet, fee-inclusive)
  const walletSpend = parseFloat(document.getElementById('investAmount').value);
  if (!walletSpend || walletSpend < pool.min_investment) { Toast.error(`Minimum investment is ${Utils.rand(pool.min_investment)}`); return; }

  const _confSa = _pmSaId ? PORTAL.subAccounts.find(s => s.id === _pmSaId) : null;
  const wallet = _confSa ? (parseFloat(_confSa.wallet_balance) || 0) : (parseFloat(PORTAL.investor?.wallet_balance) || 0);
  if (walletSpend > wallet + 0.005) { Toast.error(`Insufficient balance. You have ${Utils.rand(wallet)} in your wallet.`); return; }

  // Pool amount = what actually goes to the pool (fee is taken from wallet spend)
  const poolAmount = Math.round((walletSpend / (1 + PLATFORM_FEE_RATE)) * 100) / 100;

  try {
    const expectedReturn = poolAmount * pool.annual_rate * (pool.term_months / 12);
    const maturityDate = new Date();
    maturityDate.setMonth(maturityDate.getMonth() + pool.term_months);

    // Server receives walletSpend as amount + fee_inclusive flag, splits it internally
    const investmentId = Utils.genId('INVST');
    await API.investments.create({
      id: investmentId,
      investor_id: PORTAL.investor?.id,
      pool_id: pool.id,
      product_type: pool.product_type,
      pool_name: pool.name,
      amount: walletSpend,
      fee_inclusive: true,
      annual_rate: pool.annual_rate,
      expected_return: Math.round(expectedReturn),
      actual_return: 0,
      status: 'active',
      start_date: new Date().toISOString().split('T')[0],
      end_date: maturityDate.toISOString().split('T')[0],
      term_months: pool.term_months,
      payout_option: pool.product_type?.includes('delivery_bike') ? 'payout_all' : 'reinvest',
      maturity_instruction: pool.product_type?.includes('delivery_bike') ? 'payout_all' : 'reinvest',
      sub_account_id: _pmSaId || undefined,
      is_reinvestment: false,
    });

    // Investment transaction records the pool amount (fee is a separate 'fee' transaction)
    await API.transactions.create({
      id:          Utils.genId('TXN'),
      investor_id: PORTAL.investor?.id,
      investor_name:    `${PORTAL.investor.first_name} ${PORTAL.investor.last_name}`,
      type:             'investment',
      amount:           poolAmount,
      status:           'completed',
      reference:        `INVST-${Date.now()}`,
      description:      `Investment into ${pool.name}`,
      pool_id:          pool.id,
      sub_account_id:   _pmSaId || undefined,
      transaction_date: new Date().toISOString(),
    });

    // Optimistically update sub-account cache (server handles the real deduction atomically)
    if (_pmSaId) {
      const saIdx = PORTAL.subAccounts.findIndex(s => s.id === _pmSaId);
      if (saIdx !== -1) {
        const sa = PORTAL.subAccounts[saIdx];
        PORTAL.subAccounts[saIdx].wallet_balance = Math.max(0, Math.round(((parseFloat(sa.wallet_balance) || 0) - walletSpend) * 100) / 100);
        PORTAL.subAccounts[saIdx].total_invested  = Math.round(((parseFloat(sa.total_invested) || 0) + poolAmount) * 100) / 100;
      }
    }

    Toast.success(`Successfully invested ${Utils.rand(walletSpend)} in ${pool.name}!`);
    Modal.close('investModal');

    SVC.track('purchase', { transaction_id: investmentId, value: poolAmount, currency: 'ZAR', items: [{ item_id: pool.id, item_name: pool.name, item_category: pool.product_type, price: poolAmount, quantity: 1 }] });
    SVC.track('svc_investment_created', { pool_id: pool.id, pool_name: pool.name, product_type: pool.product_type, amount: poolAmount, amount_bucket: _amtBucket(poolAmount), term_months: pool.term_months, annual_rate: parseFloat(pool.annual_rate) || 0, wallet_balance_bucket: _amtBucket(PORTAL.investor?.wallet_balance), total_investments: PORTAL.investments.filter(i => i.investor_id === (PORTAL.investor?.id || DEMO_INVESTOR_ID)).length + 1 });
    _trackFunnel('confirmed', { pool_id: pool.id, product_type: pool.product_type, amount_bucket: _amtBucket(poolAmount) });
    if (_pmSaId) {
      SVC.track('svc_subaccount_invested', { sub_account_id: _pmSaId, amount: poolAmount });
    }
    _pmSaId = null;  // clear after investment completes

    // Reload data
    await loadPortalData();
    renderOverview();
  } catch (e) {
    SVC.error('investment', e.message);
    Toast.error('Investment failed. Please try again.');
    console.error(e);
  }
}

/* ═══════════════════════════════════════════════
   MATURITY
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   SUPPORT
   ═══════════════════════════════════════════════ */


/* ── Ticket attachment state ─── */
let _tktAttachFile   = null;
let _tktAttachBase64 = null;


/* ═══════════════════════════════════════════════════════════════
   STATEMENT GENERATOR
   ═══════════════════════════════════════════════════════════════ */


function buildStatementHTML(opts) {
  const {
    investor, investments, transactions,
    from, to, totalDeposits, totalReturns, walletBal, totalValue, activeInv,
    totalCapital, activeInvAmt,
    statementNumber, generatedAt, figures,
    incPortfolio, incInvestments, incTransactions, incPerformance
  } = opts;

  /* Every figure below comes from computeStatementFigures in portal-core.
     This builder and the mobile one used to carry their own copies of the
     credit/debit classification, and they had drifted: mobile knew about
     'reinvestment' and this one did not, so the same client's statement showed
     different totals depending on where they opened it. */
  const F = figures || {};

  const fullName   = `${investor.first_name || ''} ${investor.last_name || ''}`.trim() || 'Investor';
  const investorId = investor.id || '—';
  const memberSince = investor.date_joined ? fmtDate(investor.date_joined) : '—';
  const logoUrl     = `${window.location.origin}/assets/sv-capital-logo-horizontal-outline-1.png`;
  const logoOutlineUrl = new URL('../assets/logo-outline.png', window.location.href).href;
  const now = new Date();

  // ── Status helpers ──────────────────────────────────────────────────────
  const STATUS_LABEL  = { active:'Active', matured:'Matured', paid_out:'Completed', cancelled:'Cancelled' };
  const STATUS_COLOR  = { active:'#16a34a', matured:'#b45309', paid_out:'#1d4ed8', cancelled:'#6b7280' };
  const STATUS_BG     = { active:'#f0fdf4', matured:'#fffbeb', paid_out:'#eff6ff',  cancelled:'#f8fafc' };
  const STATUS_BORDER = { active:'#bbf7d0', matured:'#fde68a', paid_out:'#bfdbfe',  cancelled:'#e2e8f0' };

  function statusPill(status) {
    const c  = STATUS_COLOR[status]  || '#6b7280';
    const b  = STATUS_BG[status]     || '#f8fafc';
    const br = STATUS_BORDER[status] || '#e2e8f0';
    const l  = STATUS_LABEL[status]  || status;
    return `<span style="display:inline-flex;align-items:center;gap:3px;background:${b};color:${c};border:1px solid ${br};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap"><span style="width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0;display:inline-block"></span>${l}</span>`;
  }

  /* Every instruction the server accepts needs an entry. instrPill falls back
     to the raw key, so a missing one showed the client the literal string
     "custom_switch" on their own investment. */
  const INSTR_LABEL = { reinvest:'Reinvest', switch:'Switch', payout:'Payout', payout_return:'Payout Returns', reinvest_all:'Reinvest All', payout_all:'Payout All', payout_custom:'Custom Payout', switch_product:'Switch Product', custom_switch:'Payout + Switch', switch_amount:'Switch + Reinvest' };
  const INSTR_COLOR = { reinvest:'#1d4ed8', switch:'#6d28d9', payout:'#9f1239', payout_return:'#9f1239', reinvest_all:'#1d4ed8', payout_all:'#9f1239', payout_custom:'#9f1239', switch_product:'#6d28d9', custom_switch:'#6d28d9', switch_amount:'#6d28d9' };
  const INSTR_BG    = { reinvest:'#eff6ff', switch:'#fdf4ff', payout:'#fff1f2', payout_return:'#fff1f2', reinvest_all:'#eff6ff', payout_all:'#fff1f2', payout_custom:'#fff1f2', switch_product:'#fdf4ff', custom_switch:'#fdf4ff', switch_amount:'#fdf4ff' };

  function instrPill(instr) {
    if (!instr) return '<span style="color:#9ca3af;font-size:10px">—</span>';
    const c = INSTR_COLOR[instr] || '#6b7280';
    const b = INSTR_BG[instr]    || '#f8fafc';
    const l = INSTR_LABEL[instr] || instr;
    return `<span style="background:${b};color:${c};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap">${l}</span>`;
  }

  function sectionHead(title, accentColor, badge) {
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid ${accentColor}">
      <div style="width:4px;height:22px;background:${accentColor};border-radius:2px"></div>
      <h3 style="font-size:13px;font-weight:800;color:#1a1a1a;letter-spacing:0.06em;text-transform:uppercase;margin:0">${title}</h3>
      ${badge ? `<span style="margin-left:auto;font-size:10px;color:#9ca3af">${badge}</span>` : ''}
    </div>`;
  }

  function th(label, align) {
    return `<th style="padding:9px 10px;font-size:10px;text-align:${align||'left'};font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.06em;background:#F7F8FA;white-space:nowrap">${label}</th>`;
  }
  function tdCell(content, align, extraStyle) {
    return `<td style="padding:8px 10px;font-size:11px;color:#1a1a1a;text-align:${align||'left'};${extraStyle||''}">${content}</td>`;
  }

  // ── Pre-sort investments ────────────────────────────────────────────────
  /* Newest first, on the date each table is about: an active holding by when
     it STARTED, a matured one by when it MATURED. An undated row sorts last
     rather than to the top of the document. */
  const _stmtMs = v => { const d = new Date(v); return isNaN(d.getTime()) ? null : d.getTime(); };
  const _stmtNewest = pick => (a, b) => {
    const x = pick(a), y = pick(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  const _startedMs  = i => _stmtMs(i.start_date) ?? _stmtMs(i.created_at);
  const _maturedMs  = i => _stmtMs(i.maturity_date) ?? _stmtMs(i.updated_at);

  const activeInvestments    = investments.filter(i => i.status === 'active')
    .sort(_stmtNewest(_startedMs));
  const completedInvestments = investments.filter(i => ['matured', 'paid_out'].includes(i.status))
    .sort(_stmtNewest(_maturedMs));

  /* The NEXT maturity is the soonest one still ahead, which the display order
     no longer surfaces — it used to fall out of sorting the active table by
     earliest maturity, so reversing that table would silently have turned this
     into the LAST maturity. Computed on its own now. */
  const nextMaturityDate = activeInvestments
    .filter(i => i.maturity_date)
    .map(i => i.maturity_date)
    .sort((a, b) => new Date(a) - new Date(b))[0];
  const capitalInvested  = (totalCapital != null ? totalCapital : 0) ||
    investments.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  let sections = '';

  // ─── PORTFOLIO SUMMARY ─────────────────────────────────────────────────
  if (incPortfolio) {
    sections += `
      <section style="margin-bottom:36px">
        ${sectionHead('Portfolio Summary', '#fec24f')}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px">
          ${stmtKPIBox('Portfolio Value',  fmtNum(totalValue),      '#fec24f')}
          ${stmtKPIBox('Capital Invested', fmtNum(capitalInvested),  '#656565')}
          ${stmtKPIBox('Returns Earned',   fmtNum(totalReturns),     '#22C55E')}
          ${stmtKPIBox('Wallet Balance',   fmtNum(walletBal),        '#0096ff')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
          <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Account Details</div>
            ${stmtInfoRow('Investor Name',  fullName)}
            ${stmtInfoRow('Account Number', investorId)}
            ${stmtInfoRow('Email',          investor.email || '—')}
            ${stmtInfoRow('Phone',          investor.phone || '—')}
            ${stmtInfoRow('Member Since',   memberSince)}
          </div>
          <div style="background:#F7F8FA;border-radius:8px;padding:14px;border:1px solid rgba(0,0,0,0.06)">
            <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#9ca3af;font-weight:700;margin-bottom:10px">Investment Snapshot</div>
            ${stmtInfoRow('Total Investments',  investments.length)}
            ${stmtInfoRow('Active',             activeInvestments.length)}
            ${stmtInfoRow('Completed',          completedInvestments.length)}
            ${stmtInfoRow('Next Maturity Date', nextMaturityDate ? fmtDate(nextMaturityDate) : '—')}
            ${stmtInfoRow('Statement Period',   `${fmtDate(from)} — ${fmtDate(to)}`)}
          </div>
        </div>
      </section>`;
  }

  // ─── PERFORMANCE ANALYSIS ──────────────────────────────────────────────
  if (incPerformance && investments.length > 0) {
    const confirmedByProduct = {};
    completedInvestments.forEach(inv => {
      const p = (inv.product_type === 'smme' ? 'short_term' : inv.product_type) || 'unknown';
      if (!confirmedByProduct[p]) confirmedByProduct[p] = { count:0, capital:0, returns:0 };
      confirmedByProduct[p].count++;
      confirmedByProduct[p].capital += Number(inv.amount) || 0;
      const _ar = Number(inv.pool_actual_rate) || 0;
      const earned = _ar > 0
        ? (Number(inv.amount) || 0) * _ar
        : (Number(inv.actual_return_amount) || 0);
      confirmedByProduct[p].returns += earned;
    });

    const projectedByProduct = {};
    activeInvestments.forEach(inv => {
      const p = (inv.product_type === 'smme' ? 'short_term' : inv.product_type) || 'unknown';
      if (!projectedByProduct[p]) projectedByProduct[p] = { count:0, capital:0, returns:0 };
      projectedByProduct[p].count++;
      projectedByProduct[p].capital += Number(inv.amount) || 0;
      projectedByProduct[p].returns += (Number(inv.amount) || 0) * (Number(inv.annual_rate) || 0);
    });

    const tableHead = `<tr style="background:#F7F8FA">${th('Product')}${th('Count','center')}${th('Capital','right')}${th('Returns','right')}${th('Return %','right')}</tr>`;

    const buildPerfRows = (byProduct) => Object.entries(byProduct).map(([prod, d]) => {
      const pct  = d.capital > 0 ? ((d.returns / d.capital) * 100).toFixed(2) : '0.00';
      const info = getProductInfo(prod);
      return `<tr style="border-bottom:1px solid #f0f0f0">
        ${tdCell(`<span style="font-weight:700">${info.label}</span>`)}
        ${tdCell(d.count, 'center')}
        ${tdCell(fmtNum(d.capital), 'right', 'font-weight:600')}
        ${tdCell(fmtNum(d.returns), 'right', 'font-weight:700')}
        ${tdCell(pct + '%', 'right', 'font-weight:700')}
      </tr>`;
    }).join('');

    const confirmedRows = buildPerfRows(confirmedByProduct);
    const projectedRows = buildPerfRows(projectedByProduct);
    const totC_cap = Object.values(confirmedByProduct).reduce((s, d) => s + d.capital, 0);
    const totC_ret = Object.values(confirmedByProduct).reduce((s, d) => s + d.returns, 0);
    const totP_cap = Object.values(projectedByProduct).reduce((s, d) => s + d.capital, 0);
    const totP_ret = Object.values(projectedByProduct).reduce((s, d) => s + d.returns, 0);

    sections += `
      <section style="margin-bottom:36px">
        ${sectionHead('Performance Analysis', '#656565')}
        ${confirmedRows ? `
          <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">✓ Confirmed — Completed Investments</div>
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;margin-bottom:20px">
            <thead>${tableHead}</thead>
            <tbody>${confirmedRows}</tbody>
            <tfoot><tr style="background:#F7F8FA">
              <td colspan="2" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">CONFIRMED TOTAL</td>
              ${tdCell(fmtNum(totC_cap), 'right', 'font-weight:800')}
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#22C55E;text-align:right">${fmtNum(totC_ret)}</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#fec24f;text-align:right">${totC_cap > 0 ? ((totC_ret/totC_cap)*100).toFixed(2) : 0}%</td>
            </tr></tfoot>
          </table>` : ''}
        ${projectedRows ? `
          <div style="font-size:10px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">~ Projected — Active Investments (estimated, not yet realised)</div>
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea">
            <thead>${tableHead}</thead>
            <tbody>${projectedRows}</tbody>
            <tfoot><tr style="background:#F7F8FA">
              <td colspan="2" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">PROJECTED TOTAL</td>
              ${tdCell(fmtNum(totP_cap), 'right', 'font-weight:800')}
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#60a5fa;text-align:right">${fmtNum(totP_ret)} est.</td>
              <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#60a5fa;text-align:right">${totP_cap > 0 ? ((totP_ret/totP_cap)*100).toFixed(2) : 0}% est.</td>
            </tr></tfoot>
          </table>` : ''}
      </section>`;
  }

  // ─── INVESTMENT DETAILS ────────────────────────────────────────────────
  if (incInvestments && investments.length > 0) {
    const tableStyle = `width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:780px`;

    // Active table
    let activeRows = '';
    let totActiveCapital = 0, totActiveProj = 0;
    activeInvestments.forEach(inv => {
      const info = getProductInfo(inv.product_type);
      const rate    = Number(inv.annual_rate) || Number(inv.pool_actual_rate) || 0;
      const projected = (Number(inv.amount) || 0) * rate;
      const daysLeft = inv.maturity_date ? Math.ceil((new Date(inv.maturity_date) - now) / 86400000) : null;
      const daysColor = daysLeft != null && daysLeft <= 60 ? '#b45309' : '#6b7280';
      const daysStr   = daysLeft != null
        ? `<span style="color:${daysColor};font-weight:${daysLeft <= 60 ? '700' : '400'}">${daysLeft > 0 ? daysLeft + 'd' : 'Due'}${daysLeft <= 60 ? ' ⚠' : ''}</span>`
        : '—';
      totActiveCapital += Number(inv.amount) || 0;
      totActiveProj    += projected;
      activeRows += `<tr style="border-bottom:1px solid #f0f0f0">
        ${tdCell(`<span style="font-size:9px;color:#9ca3af;font-family:monospace">${inv.id}</span>`)}
        ${tdCell(`<span style="font-weight:600">${_esc(inv.pool_name) || '—'}</span>`)}
        ${tdCell(`<span style="background:${info.bg};color:${info.color};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em">${info.label}</span>`)}
        ${tdCell(fmtNum(inv.amount), 'right', 'font-weight:700')}
        ${tdCell(rate > 0 ? `<span style="color:#22C55E;font-weight:700">${(rate*100).toFixed(2)}%</span> <span style="color:#9ca3af;font-size:9px">proj.</span>` : '—', 'right')}
        ${tdCell(projected > 0 ? `<span style="color:#60a5fa;font-size:9px">est.</span> ${fmtNum(projected)}` : '—', 'right')}
        ${tdCell(fmtDate(inv.start_date || inv.investment_date))}
        ${tdCell(fmtDate(inv.maturity_date))}
        ${tdCell(daysStr, 'center')}
        ${tdCell(instrPill(inv.maturity_instruction))}
      </tr>`;
    });

    // Completed table
    let completedRows = '';
    let totCompletedCapital = 0, totCompletedReturns = 0;
    completedInvestments.forEach(inv => {
      const info       = getProductInfo(inv.product_type);
      const actualRate = Number(inv.pool_actual_rate) || 0;
      const earned     = actualRate > 0
        ? (Number(inv.amount) || 0) * actualRate
        : (Number(inv.actual_return_amount) || 0);
      totCompletedCapital  += Number(inv.amount) || 0;
      totCompletedReturns  += earned;
      completedRows += `<tr style="border-bottom:1px solid #f0f0f0">
        ${tdCell(`<span style="font-size:9px;color:#9ca3af;font-family:monospace">${inv.id}</span>`)}
        ${tdCell(`<span style="font-weight:600">${_esc(inv.pool_name) || '—'}</span>`)}
        ${tdCell(`<span style="background:${info.bg};color:${info.color};font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:0.05em">${info.label}</span>`)}
        ${tdCell(fmtNum(inv.amount), 'right', 'font-weight:700')}
        ${tdCell(actualRate > 0 ? `<span style="color:#22C55E;font-weight:700">${(actualRate*100).toFixed(2)}%</span>` : '<span style="color:#9ca3af">—</span>', 'right')}
        ${tdCell(earned > 0 ? `<span style="color:#22C55E;font-weight:700">+${fmtNum(earned)}</span>` : '<span style="color:#9ca3af">—</span>', 'right')}
        ${tdCell(fmtDate(inv.start_date || inv.investment_date))}
        ${tdCell(fmtDate(inv.maturity_date))}
        ${tdCell(statusPill(inv.status))}
      </tr>`;
    });

    sections += `
      <section style="margin-bottom:36px">
        ${sectionHead('Investment Details', '#22C55E', `${investments.length} total`)}

        ${activeInvestments.length > 0 ? `
          <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">
            Active Investments — ${activeInvestments.length} (newest first)
          </div>
          <div style="overflow-x:auto;margin-bottom:20px">
            <table style="${tableStyle}">
              <thead><tr style="background:#F7F8FA">${th('Reference')}${th('Pool')}${th('Product')}${th('Amount','right')}${th('Proj. Rate','right')}${th('Est. Return','right')}${th('Start Date')}${th('Maturity')}${th('Days Left','center')}${th('At Maturity')}</tr></thead>
              <tbody>${activeRows}</tbody>
              <tfoot><tr style="background:#F7F8FA">
                <td colspan="3" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">ACTIVE TOTAL</td>
                ${tdCell(fmtNum(totActiveCapital), 'right', 'font-weight:800')}
                <td></td>
                <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#60a5fa;text-align:right">${fmtNum(totActiveProj)} est.</td>
                <td colspan="4"></td>
              </tr></tfoot>
            </table>
          </div>` : ''}

        ${completedInvestments.length > 0 ? `
          <div style="font-size:10px;font-weight:700;color:#b45309;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">
            Completed Investments — ${completedInvestments.length}
          </div>
          <div style="overflow-x:auto">
            <table style="${tableStyle}">
              <thead><tr style="background:#F7F8FA">${th('Reference')}${th('Pool')}${th('Product')}${th('Amount','right')}${th('Actual Rate','right')}${th('Returns Earned','right')}${th('Start Date')}${th('Maturity Date')}${th('Status')}</tr></thead>
              <tbody>${completedRows}</tbody>
              <tfoot><tr style="background:#F7F8FA">
                <td colspan="3" style="padding:9px 10px;font-size:11px;font-weight:800;color:#1a1a1a">COMPLETED TOTAL</td>
                ${tdCell(fmtNum(totCompletedCapital), 'right', 'font-weight:800')}
                <td></td>
                <td style="padding:9px 10px;font-size:11px;font-weight:800;color:#22C55E;text-align:right">+${fmtNum(totCompletedReturns)}</td>
                <td colspan="3"></td>
              </tr></tfoot>
            </table>
          </div>` : ''}
      </section>`;
  }

  // ─── TRANSACTION LEDGER ────────────────────────────────────────────────
  if (incTransactions) {
    /* Shared with the mobile app and with the totals, so a row's column and the
       figure it is counted in cannot disagree. A type in neither list falls
       back to the SIGN of the amount rather than vanishing from both columns,
       which is what used to happen to every 'adjustment'. */
    const isCreditType = t => _stmtDirection(t) === 'credit';
    const isDebitType  = t => _stmtDirection(t) === 'debit';

    const sortedTxns = [...transactions].sort((a, b) =>
      new Date(a.transaction_date || a.created_at) - new Date(b.transaction_date || b.created_at)
    );

    /* A running balance, so a client can follow their own money down the page.
       It starts at the opening balance and only moves on rows that actually
       moved money. */
    let running = Number(F.opening) || 0;

    /* The balance is accumulated walking FORWARD, so the rows are built in
       date order and reversed for display. Each row still shows the balance
       after its own transaction; the closing balance simply sits at the top
       and the opening at the bottom, the way a bank statement reads. */
    const txnRows = sortedTxns.length > 0 ? sortedTxns.map(t => {
      const absAmt    = Math.abs(Number(t.amount) || 0);
      const counts    = _stmtCounts(t);
      const isCredit  = isCreditType(t);
      const isDebit   = isDebitType(t);
      if (counts) running += isCredit ? absAmt : isDebit ? -absAmt : 0;
      const dim       = counts ? '' : 'opacity:0.55;';
      const debitStr  = isDebit  ? `<span style="color:#ef4444;font-weight:700">${fmtNum(absAmt)}</span>` : `<span style="color:#d1d5db">—</span>`;
      const creditStr = isCredit ? `<span style="color:#22C55E;font-weight:700">${fmtNum(absAmt)}</span>` : `<span style="color:#d1d5db">—</span>`;
      const balStr    = counts ? fmtNum(running) : `<span style="color:#9ca3af;font-size:9px">not counted</span>`;
      const desc = t.pool_name || t.description || '—';
      /* A rejected deposit used to wear the same amber pill as a pending one
         and count toward the totals just the same. */
      const SPILL = { completed:['#dcfce7','#16a34a'], pending:['#fef9c3','#92400e'],
                      rejected:['#fee2e2','#b91c1c'], cancelled:['#f1f5f9','#64748b'] };
      const [sBg, sFg] = SPILL[t.status] || ['#f1f5f9','#64748b'];
      const statusPillHtml = `<span style="background:${sBg};color:${sFg};font-size:9px;font-weight:700;padding:2px 6px;border-radius:20px;text-transform:uppercase">${t.status || 'unknown'}</span>`;
      return `<tr style="border-bottom:1px solid #f0f0f0;${dim}">
        ${tdCell(`<span style="font-size:9px;color:#9ca3af;font-family:monospace">${t.reference || '—'}</span>`)}
        ${tdCell(_stmtLabel(t))}
        ${tdCell(desc)}
        ${tdCell(debitStr, 'right')}
        ${tdCell(creditStr, 'right')}
        ${tdCell(balStr, 'right')}
        ${tdCell(fmtDate(t.transaction_date || t.created_at), 'right')}
        ${tdCell(statusPillHtml)}
      </tr>`;
    }).reverse().join('') : `<tr><td colspan="8" style="padding:20px;text-align:center;color:#9ca3af;font-size:11px">No transactions in selected period</td></tr>`;

    /* Straight off the shared figures — completed rows only. */
    const txDeposits = F.deposits || 0;
    const txReturns  = F.returns  || 0;
    const txDebits   = F.debits   || 0;
    const txCredits  = F.credits  || 0;
    const excludedCount = (F.excluded || []).length;

    sections += `
      <section style="margin-bottom:36px">
        ${sectionHead('Transaction Ledger', '#eda5ff', `${transactions.length} transactions · ${fmtDate(from)} — ${fmtDate(to)}`)}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px">
          ${stmtMiniBox('Opening Balance', fmtNum(F.opening), '#6b7280')}
          ${stmtMiniBox('Total Credits',   fmtNum(txCredits), '#22C55E')}
          ${stmtMiniBox('Total Debits',    fmtNum(txDebits),  '#ef4444')}
          ${stmtMiniBox('Closing Balance', fmtNum(F.closing), '#0096ff')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px">
          ${stmtMiniBox('Deposits',        fmtNum(txDeposits), '#22C55E')}
          ${stmtMiniBox('Returns',         fmtNum(txReturns),  '#fec24f')}
          ${stmtMiniBox('Withdrawals',     fmtNum(F.withdrawals || 0), '#ef4444')}
          ${stmtMiniBox('Fees',            fmtNum(F.fees || 0), '#ef4444')}
        </div>

        <!-- The arithmetic a reader would otherwise do by hand. A statement
             that does not reconcile has to say so on its face; a wrong number
             presented confidently is worse than one that admits doubt. -->
        <div style="background:${F.ties ? '#f0fdf4' : '#fef2f2'};border:1px solid ${F.ties ? '#bbf7d0' : '#fecaca'};border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:10px;color:${F.ties ? '#166534' : '#b91c1c'}">
          ${F.ties
            ? `Opening ${fmtNum(F.opening)} + credits ${fmtNum(txCredits)} − debits ${fmtNum(txDebits)} = closing ${fmtNum(F.closing)}.`
            : `This period does not reconcile: opening ${fmtNum(F.opening)} + credits ${fmtNum(txCredits)} − debits ${fmtNum(txDebits)} does not equal closing ${fmtNum(F.closing)}. Please contact support before relying on these figures.`}
          ${F.complete === false ? ` Not all of your transaction history could be loaded, so the opening balance may be incomplete.` : ''}
          ${excludedCount ? ` ${excludedCount} transaction${excludedCount === 1 ? ' is' : 's are'} listed but not counted, because ${excludedCount === 1 ? 'it has' : 'they have'} not completed.` : ''}
        </div>

        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eaeaea;min-width:700px">
            <thead><tr style="background:#F7F8FA">${th('Reference')}${th('Type')}${th('Description')}${th('Debit','right')}${th('Credit','right')}${th('Balance','right')}${th('Date','right')}${th('Status')}</tr></thead>
            <tbody>${txnRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  return `
    <div id="stmtPrintArea" style="font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:#fff;min-height:100%;position:relative">
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:0;opacity:0.04;width:480px;height:480px;background:url('${logoOutlineUrl}') center/contain no-repeat;print-color-adjust:exact;-webkit-print-color-adjust:exact"></div>
      <div style="background:#303030;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;position:relative;z-index:1">
        <div style="background:#fff;padding:8px 14px;border-radius:8px;display:inline-block"><img src="${logoUrl}" alt="SV Capital" style="height:40px;width:auto;max-width:220px;object-fit:contain;display:block"></div>
        <div style="text-align:right">
          <div style="font-size:16px;font-weight:800;color:#fec24f;letter-spacing:0.04em">ACCOUNT STATEMENT</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:4px"># ${statementNumber}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:2px">Generated: ${generatedAt}</div>
        </div>
      </div>
      <div style="background:linear-gradient(90deg,rgba(254,194,79,0.08),rgba(47,140,155,0.06));border-top:3px solid #fec24f;border-bottom:1px solid rgba(0,0,0,0.06);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Statement Period:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${fmtDate(from)} — ${fmtDate(to)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.08em">Investor:</span>
          <span style="font-size:12px;font-weight:800;color:#1a1a1a">${fullName}</span>
          <span style="background:rgba(254,194,79,0.1);color:#ff5229;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid rgba(254,194,79,0.2);margin-left:4px">${investorId}</span>
        </div>
      </div>
      <div style="padding:32px 40px">${sections}</div>
      <div style="background:#F7F8FA;border-top:3px solid #fec24f;padding:20px 40px;position:relative;z-index:1">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">
          <div>
            <div style="font-size:10px;font-weight:700;color:#1a1a1a;margin-bottom:3px">SV Capital (Pty) Ltd</div>
            <div style="font-size:9px;color:#9ca3af">enquiry@svcapital.co.za · www.svcapital.co.za · 011 568 3490</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:9px;color:#c1c7d0">This statement is computer generated and does not require a signature.</div>
          </div>
        </div>
        <div style="font-size:7.5px;color:#b0b8c4;border-top:1px solid rgba(0,0,0,0.06);padding-top:8px;line-height:1.5">
          IMPORTANT NOTICE: This investment is not a regulated financial product under the Financial Sector Conduct Authority (FSCA) and is not covered by the Financial Advisory and Intermediary Services Act (FAIS) or the Collective Investment Schemes Control Act (CISCA). This investment is managed solely by SV Capital (Pty) Ltd. Capital is at risk and returns are not guaranteed.
        </div>
      </div>
    </div>`;
}


function printStatement() {
  /* The same document the preview shows, opened for printing — one builder,
     so what a client prints is what they were shown. It used to re-wrap the
     preview's innerHTML in a second, differently-styled page. */
  const data = (typeof PORTAL !== 'undefined') && PORTAL._lastStatement;
  if (!data) { Toast.error('Please generate a statement first, then print.'); return; }
  SVCDocs.openAccountStatement(data);
}


/* ─── Profile ─── */
function _initAddressSearch(searchId, dropId, fields) {
  const searchEl = document.getElementById(searchId);
  const dropEl   = document.getElementById(dropId);
  if (!searchEl || !dropEl) return;

  let _timer = null;
  let _results = [];

  const _hide = () => { dropEl.style.display = 'none'; };

  const _show = items => {
    _results = items;
    if (!items.length) { _hide(); return; }
    dropEl.innerHTML = items.map((r, i) => {
      const line1 = [r.housenumber, r.street].filter(Boolean).join(' ') || r.city || r.formatted || '';
      const line2 = [r.suburb || r.quarter, r.city || r.town, r.postcode].filter(Boolean).join(', ');
      return `<div data-idx="${i}" style="padding:9px 14px;cursor:pointer;font-size:0.82rem;border-bottom:1px solid rgba(255,255,255,0.06);transition:background 0.12s" onmouseover="this.style.background='rgba(237,165,255,0.12)'" onmouseout="this.style.background=''">
        <div style="font-weight:600;color:#e8edf2">${_esc(line1)}</div>
        ${line2 ? `<div style="font-size:0.74rem;color:#8aa0b8;margin-top:2px">${_esc(line2)}</div>` : ''}
      </div>`;
    }).join('');
    dropEl.style.display = 'block';
  };

  const _fill = r => {
    const _s = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    if (fields.street)   _s(fields.street,  [r.housenumber, r.street].filter(Boolean).join(' '));
    if (fields.suburb)   _s(fields.suburb,   r.suburb || r.quarter || r.neighbourhood || '');
    if (fields.city)     _s(fields.city,     r.city || r.town || r.municipality || '');
    if (fields.postal)   _s(fields.postal,   r.postcode || '');
    if (fields.province) {
      const sel = document.getElementById(fields.province);
      if (sel && r.state) {
        const opt = [...sel.options].find(o => o.value.toLowerCase() === r.state.toLowerCase() || o.text.toLowerCase() === r.state.toLowerCase());
        if (opt) opt.selected = true;
      }
    }
    _hide();
    searchEl.value = '';
    if (!_profileHydrating) _persistProfileDraft();
  };

  searchEl.addEventListener('input', () => {
    clearTimeout(_timer);
    const q = searchEl.value.trim();
    if (q.length < 3) { _hide(); return; }
    _timer = setTimeout(async () => {
      try {
        const token = localStorage.getItem('svc_token');
        const r = await fetch(`/api/address/autocomplete?q=${encodeURIComponent(q)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) return;
        const d = await r.json();
        _show(d.results || []);
      } catch (_) {}
    }, 300);
  });

  dropEl.addEventListener('mousedown', e => {
    const row = e.target.closest('[data-idx]');
    if (row) { e.preventDefault(); _fill(_results[+row.dataset.idx]); }
  });

  document.addEventListener('click', e => {
    if (!searchEl.contains(e.target) && !dropEl.contains(e.target)) _hide();
  });
}

async function saveProfile() {
  const inv = PORTAL.investor;
  if (!inv) return;

  const firstName = document.getElementById('profFirstName')?.value?.trim() || '';
  const lastName  = document.getElementById('profLastName')?.value?.trim() || '';
  const phone     = document.getElementById('profPhone')?.value?.trim() || '';
  const city      = document.getElementById('profCity')?.value?.trim() || '';
  const risk      = (document.querySelector('input[name="riskProf"]:checked')?.value) || inv.risk_profile;
  const saveBtn   = document.querySelector('button[onclick="saveProfile()"]');

  if (!firstName || !lastName) { Toast.error('First name and last name are required.'); return; }
  if (phone && phone.replace(/\D/g, '').length < 8) { Toast.error('Please enter a valid phone number.'); return; }

  const updates = {
    first_name:     firstName,
    last_name:      lastName,
    phone:          phone || inv.phone,
    address:        city || inv.address,
    street_address: document.getElementById('profStreetAddress')?.value?.trim() || null,
    suburb:         document.getElementById('profSuburb')?.value?.trim() || null,
    postal_code:    document.getElementById('profPostalCode')?.value?.trim() || null,
    province:       document.getElementById('profProvince')?.value || inv.province,
    risk_profile:   risk,
  };

  await _withBtn(saveBtn, async () => {
    try {
      await API._fetch('PATCH', `tables/investors/${inv.id}`, updates);
      Object.assign(PORTAL.investor, updates);
      clearProfileDraft();
      renderTaskCompletionPanel();
      SVC.track('svc_profile_saved', {});
      Toast.success('Profile updated successfully');
    } catch (e) {
      _setInlineMessage('profileSaveMeta', 'Could not save your changes — your local draft is still available.', '#ef4444');
      Toast.error('Failed to save profile — please try again.');
    }
  });
}


/* ═══════════════════════════════════════════════════════════════
   GAMIFICATION — XP, Quests & Learning Hub
   ═══════════════════════════════════════════════════════════════ */

const XP_LEVELS = [
  { id: 'seed',       label: 'Seed',       min: 0,    icon: 'fa-seedling',         color: '#9ca3af' },
  { id: 'sprout',     label: 'Sprout',     min: 100,  icon: 'fa-leaf',             color: '#22c55e' },
  { id: 'grower',     label: 'Grower',     min: 300,  icon: 'fa-tree',             color: '#16a34a' },
  { id: 'cultivator', label: 'Cultivator', min: 600,  icon: 'fa-spa',              color: '#656565' },
  { id: 'harvester',  label: 'Harvester',  min: 1000, icon: 'fa-wheat-awn',        color: '#fec24f' },
  { id: 'pioneer',    label: 'Pioneer',    min: 1500, icon: 'fa-compass',          color: '#fec24f' },
  { id: 'architect',  label: 'Architect',  min: 2500, icon: 'fa-building-columns', color: '#eda5ff' },
  { id: 'luminary',   label: 'Luminary',   min: 5000, icon: 'fa-crown',            color: '#fec24f' },
];


/* ═════════════════════════════════════════════════════════
   QUEST VIEW
   ═════════════════════════════════════════════════════════ */


/* ─── Feedback Form ─────────────────────────────────────── */
let _fbRating = 0;


/* ═════════════════════════════════════════════════════════
   LEARNING HUB
   ═════════════════════════════════════════════════════════ */

const LEARN_MODULES = [
  // ── Explorer Track (getting started) ───────────────────
  {
    id: 'learn_what_is_svc', track: 'explorer', order: 1,
    title: 'What is SV Capital?', readTime: 5, xp: 50,
    icon: 'fa-building-columns', color: '#656565',
    keyPoints: [
      'SV Capital gives investors direct access to tangible South African alternative assets',
      'Products include solar energy projects and cattle farming',
      'Investment terms start from 5 months, each with a defined return rate and maturity date',
      'Every investment is backed by real, income-generating assets',
    ],
    content: `SV Capital is a South African alternative investment platform that connects investors directly with real-economy projects generating above-inflation returns. Unlike unit trusts or share portfolios, your money is put to work in tangible assets — solar panels generating electricity, and cattle being raised and sold at market.

Each investment has a clearly defined term, starting from 5 months, and a set annual rate of return, so you know what to expect from the outset. Every product carries its own risk profile — from Low through to High — so you can match your investments to your appetite. Your capital is tracked in real time on this portal.

At maturity you decide what happens next: pay the funds out to your wallet, reinvest them, or switch into a different product. Reinvested funds are never charged a platform fee, so more of your money stays invested and working for you.`,
    quiz: [
      { q: 'What types of assets does SV Capital invest in?', options: ['Shares and unit trusts', 'Tangible South African alternative assets', 'Foreign currency and crypto', 'Government bonds only'], correct: 1 },
      { q: 'What is the minimum SV Capital investment term?', options: ['1–7 days', '5 months', '5 years', 'No fixed term'], correct: 1 },
      { q: 'What fee is charged when you reinvest your funds at maturity?', options: ['5%', '2%', '1%', 'No fee'], correct: 3 },
    ],
  },
  {
    id: 'learn_how_returns', track: 'explorer', order: 2,
    title: 'How Your Returns Work', readTime: 7, xp: 50,
    icon: 'fa-percent', color: '#22c55e',
    keyPoints: [
      'Returns are shown as an annual percentage rate (p.a.)',
      'Your payout = capital × annual rate × (term ÷ 12 months)',
      'Every return appears in your history as a "Return Earned" entry',
      'Reinvesting at maturity compounds your growth — and reinvestments pay no platform fee',
    ],
    content: `When you invest with SV Capital, your return is driven by two things: the product's annual rate and its term. For example, R10,000 at 14% p.a. over 12 months returns R11,400 — your R10,000 capital plus R1,400 earned.

Shorter terms are simply pro-rated. The same 14% annual rate over 5 months pays roughly R583 on R10,000. Every return you earn is credited and shown in your transaction history as a "Return Earned" entry.

The effective return you see on your dashboard is the annualised figure, so you can compare a 5-month product against a multi-year one on equal footing. When an investment matures you decide what happens next — pay out, reinvest, or switch products — and reinvested funds are never charged a platform fee.`,
    quiz: [
      { q: 'R10,000 invested at 14% p.a. for 12 months — what is the total payout?', options: ['R10,140', 'R10,700', 'R11,400', 'R12,400'], correct: 2 },
      { q: 'What does the "effective return %" on your dashboard allow you to do?', options: ['Calculate your tax', 'Compare products fairly regardless of term length', 'Predict future returns', 'Convert returns to foreign currency'], correct: 1 },
      { q: 'At 14% p.a. for 5 months, the approximate return on R10,000 is:', options: ['R1,400', 'R200', 'R583', 'R2,100'], correct: 2 },
    ],
  },
  {
    id: 'learn_solar', track: 'explorer', order: 3,
    title: 'Solar Energy Investing', readTime: 8, xp: 50,
    icon: 'fa-solar-panel', color: '#fec24f',
    keyPoints: [
      'SV Capital funds solar panel installations for South African businesses',
      'Businesses pay structured lease or energy purchase agreements',
      'Returns typically range from 14–18% p.a. over 5–7 year terms',
      'Solar projects benefit from long-term, predictable contractual cash flows',
    ],
    content: `Solar projects work by financing the installation of commercial-scale photovoltaic (PV) systems for verified South African businesses. Once installed, the business pays a set monthly amount — either as an energy purchase agreement (EPA) or a finance lease — providing predictable monthly revenue.

SV Capital aggregates these returns and passes them to investors net of all structuring costs. Solar assets are long-duration, making them ideal for capital you can commit for several years. Loadshedding in South Africa has significantly increased demand for behind-the-meter solar, providing strong deal flow for this product.

Each solar project undergoes technical assessment, legal review, and business viability checks before being made available to investors.`,
    quiz: [
      { q: 'What do SV Capital solar projects primarily fund?', options: ['Residential rooftop panels', 'Government solar farms', 'Commercial-scale PV system installations for businesses', 'Solar panel exports'], correct: 2 },
      { q: 'Typical SV Capital solar investment returns range from:', options: ['5–8% p.a.', '14–18% p.a.', '25–30% p.a.', '1–3% p.a.'], correct: 1 },
      { q: 'What has significantly increased demand for solar in South Africa?', options: ['Rising petrol prices', 'Tax incentives alone', 'Loadshedding', 'Lower electricity tariffs'], correct: 2 },
    ],
  },
  {
    id: 'learn_cattle', track: 'explorer', order: 4,
    title: 'Cattle Farming', readTime: 8, xp: 50,
    icon: 'fa-cow', color: '#eda5ff',
    keyPoints: [
      'Cattle are bought at auction, raised on a commercial feedlot, and sold at market',
      'A cattle cycle typically runs around 12 months at 12–16% p.a.',
      'Returns are driven by weight gain (≈200kg → 500kg) and the market price at sale',
      'Cattle carries an Aggressive risk profile — higher potential returns with more variability',
    ],
    content: `SV Capital's cattle product funds the purchase of commercial beef cattle at verified South African livestock auctions, in partnership with Beefcor — one of SA's premier feedlots. The cattle are fed and managed under professional supervision as they grow from roughly 200kg to 500kg, then sold at market at the end of the cycle.

Returns are driven by weight gain and the market price at sale. SV Capital manages execution risk through diversified lots and vetted farming partners, and each batch is tracked and reported in real time.

Because cattle depends on biological growth and market prices, it carries a higher (Aggressive) risk profile than solar — with the potential for stronger returns over a shorter, roughly 12-month term.`,
    quiz: [
      { q: 'How long is a typical SV Capital cattle investment cycle?', options: ['30–60 days', 'About 12 months', '3–5 years', '10 years'], correct: 1 },
      { q: 'What drives the returns on a cattle investment?', options: ['Fixed monthly returns', 'Weight gain and the market price at sale', 'Government subsidies', 'Rental income'], correct: 1 },
      { q: 'What risk profile does the cattle product carry?', options: ['Low', 'Medium', 'Aggressive', 'No risk'], correct: 2 },
    ],
  },
  {
    id: 'learn_diversification', track: 'explorer', order: 5,
    title: 'Diversification 101', readTime: 6, xp: 50,
    icon: 'fa-chart-pie', color: '#fec24f',
    keyPoints: [
      'Spreading capital across products reduces exposure to any single risk',
      'Different products have different maturity timelines, creating natural liquidity',
      'A blended portfolio smooths your overall return over time',
      'Diversification is not just by product — also consider term length and entry date',
    ],
    content: `Diversification means not putting all your eggs in one basket — a principle that applies as much to alternative investments as to traditional ones. By spreading your capital across products like solar and cattle, you reduce the impact if any single investment underperforms.

Equally important is timeline diversification. If all your investments mature at the same time, you face reinvestment risk. Staggering your investments across different start dates means you always have capital returning, which can be reinvested into new opportunities.

Our data shows that investors with 3+ active product types consistently achieve smoother returns and higher portfolio satisfaction than those concentrated in a single product.`,
    quiz: [
      { q: 'What is the primary benefit of portfolio diversification?', options: ['Guarantee higher returns', 'Reduce exposure to any single risk', 'Eliminate all risk entirely', 'Reduce the tax you pay'], correct: 1 },
      { q: 'What is "timeline diversification"?', options: ['Investing in different countries at different times', 'Staggering investments across different start dates', 'Only investing in short-term products', 'Changing products every month'], correct: 1 },
      { q: 'According to SV Capital data, investors with 3+ active product types achieve:', options: ['Lower returns overall', 'Higher tax liability', 'Smoother returns and higher portfolio satisfaction', 'Faster access to withdrawals'], correct: 2 },
    ],
  },

  // ── Builder Track (growing investor) ───────────────────
  {
    id: 'learn_risk', track: 'builder', order: 1,
    title: 'Risk vs Return', readTime: 8, xp: 50,
    icon: 'fa-scale-balanced', color: '#eda5ff',
    keyPoints: [
      'Higher potential returns always come with higher risk',
      'Each product has a published risk profile — Low, Medium, Medium-High or High',
      'Match products to your risk appetite and how long you can commit capital',
      'Diversification reduces but cannot eliminate all risk',
    ],
    content: `Every investment involves a trade-off between risk and return. At SV Capital, each product carries a published risk profile — from Low through to High — set by our investment team. Solar projects sit at the more conservative end (long, contractual cash flows), while cattle farming sits at the higher end (biological and market variability) with the potential for higher returns.

Understanding your own risk tolerance is key. If you can only commit capital for a few months, shorter-term products suit you better; if you can commit for several years and tolerate some variability, a blended portfolio tends to deliver the best long-term outcome.

The 'Know Your Risk Profile' survey in Earn Rewards calibrates our recommendations to your personal appetite, and every product page shows its risk badge so you always know what you are taking on.`,
    quiz: [
      { q: 'Which SV Capital product carries the lowest operational risk?', options: ['Cattle farming', 'Solar projects', 'Short-term lending', 'None — they are equal'], correct: 1 },
      { q: 'How do you see the risk level of each product?', options: ['A star rating', 'A risk profile from Low to High', 'A credit score', 'It is not shown'], correct: 1 },
      { q: 'Complete the sentence: "Higher potential returns always come with…"', options: ['Lower risk', 'More regulatory protection', 'Higher risk', 'Better liquidity'], correct: 2 },
    ],
  },
  {
    id: 'learn_compounding', track: 'builder', order: 2,
    title: 'The Compounding Effect', readTime: 7, xp: 50,
    icon: 'fa-chart-line', color: '#22c55e',
    keyPoints: [
      'Compounding means earning returns on your returns, not just your original capital',
      'The longer your investment horizon, the more powerful compounding becomes',
      'Reinvesting at maturity is the single most impactful decision — and it is fee-free',
      'A 14% p.a. return, reinvested over 5 years, nearly doubles your capital',
    ],
    content: `Albert Einstein reportedly called compound interest the "eighth wonder of the world." In practice, compounding means that after your first investment matures, you reinvest both the original capital and the returns — so in the next cycle, you earn returns on a larger base.

At 14% p.a., R10,000 grows to R11,400 after year 1. Reinvested, it becomes R12,996 after year 2 — not R12,800. The difference compounds every year. After 5 years, R10,000 compounding at 14% p.a. becomes approximately R19,254 — nearly double.

The key to unlocking compounding is acting at maturity. Capital sitting idle in your wallet earns nothing. Set your maturity instruction to reinvest — reinvestments pay no platform fee, so your full balance rolls over — and let time do the work.`,
    quiz: [
      { q: 'What does "compounding" mean in investing?', options: ['Adding new capital every month', 'Earning returns on your returns, not just your original capital', 'Splitting investments into smaller portions', 'Switching between product types'], correct: 1 },
      { q: 'R10,000 compounding at 14% p.a. over 5 years grows to approximately:', options: ['R17,000', 'R19,254', 'R21,000', 'R15,500'], correct: 1 },
      { q: 'What is the single most impactful action for compounding growth?', options: ['Withdrawing all returns each year', 'Waiting 6 months before reinvesting', 'Reinvesting at maturity as quickly as possible', 'Only investing in one product'], correct: 2 },
    ],
  },
  {
    id: 'learn_tax', track: 'builder', order: 3,
    title: 'Investment Tax in South Africa', readTime: 9, xp: 50,
    icon: 'fa-receipt', color: '#64748b',
    keyPoints: [
      'Investment returns from SV Capital are generally treated as ordinary income in South Africa',
      'You are required to declare investment returns in your annual tax return (ITR12)',
      'SV Capital issues statements and an annual Investment Income Certificate to help with your tax',
      'Consult a registered tax practitioner for personalised advice',
    ],
    content: `In South Africa, income earned from investments is generally subject to income tax at your marginal rate. This applies to the returns (interest or profit share) you earn through SV Capital products. Your original capital returned at maturity is not taxable — only the profit portion is.

SARS requires you to disclose all South African and foreign income on your annual return (ITR12). Your SV Capital account statement and annual Investment Income Certificate (available under "My Statement") give a breakdown of all returns earned in each tax year, which you or your accountant can use for tax submissions.

Note that SV Capital does not deduct tax at source — you are responsible for declaring and paying tax on returns earned. If your total investment income exceeds R23,800 per year (the annual interest exemption for individuals under 65), the excess is taxable. We strongly recommend consulting a registered tax practitioner.`,
    quiz: [
      { q: 'How are SV Capital investment returns generally taxed in South Africa?', options: ['Capital gains tax only', 'Ordinary income tax at your marginal rate', 'Exempt from all tax', 'Flat 10% withholding tax'], correct: 1 },
      { q: 'Which SARS annual tax return form must you use to declare investment returns?', options: ['IT3(b)', 'IT14', 'ITR12', 'VAT201'], correct: 2 },
      { q: 'What is the annual interest exemption for South African individuals under 65?', options: ['R10,000', 'R23,800', 'R50,000', 'R100,000'], correct: 1 },
    ],
  },

  // ── Strategist Track (advanced) ────────────────────────
  {
    id: 'learn_yield_opt', track: 'strategist', order: 1,
    title: 'Yield Optimisation', readTime: 10, xp: 50,
    icon: 'fa-chart-line-up', color: '#fec24f',
    keyPoints: [
      'Blending high-rate short-term products with stable long-term ones maximises risk-adjusted yield',
      'Entry timing and reinvestment speed have a significant impact on effective annualised returns',
      'Laddering (staggered maturity dates) ensures continuous capital deployment',
      'Idle wallet balances are a hidden drag on your portfolio performance',
    ],
    content: `Yield optimisation is about maximising your effective annualised return across your whole portfolio — not just picking the highest individual rate. A sophisticated investor uses a laddering strategy: starting multiple investments with staggered maturity dates so capital is always being deployed or reinvested.

Equally, minimise idle time. Capital sitting in your wallet between investments earns 0%. Even a 2-week idle period on R50,000 costs you approximately R380 in lost returns at 14% p.a. The fastest investors reinvest within 48 hours of maturity.

A balanced blend for many SV Capital investors is roughly 40% solar (stable, longer-term base), 40% cattle (higher rate, shorter term), and 20% held in reserve for opportunistic reinvestment when new pools open. Because reinvestments are fee-free, rolling capital between pools costs you nothing.`,
    quiz: [
      { q: 'What is a "laddering strategy" in investing?', options: ['Investing in ladder-manufacturing companies', 'Starting multiple investments with staggered maturity dates', 'Increasing investment amounts each cycle', 'Only investing in the highest-rate products'], correct: 1 },
      { q: 'Approximately how much does a 2-week idle period cost on R50,000 at 14% p.a.?', options: ['R50', 'R1,000', 'R380', 'R1,900'], correct: 2 },
      { q: 'A balanced portfolio blend for SV Capital investors is:', options: ['100% solar for maximum stability', '50% cattle, 50% solar', '40% solar, 40% cattle, 20% reserve', 'Equal split across all available products'], correct: 2 },
    ],
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
    quiz: [
      { q: 'What is the estate duty rate in South Africa on dutiable estates above R3.5 million?', options: ['10%', '20%', '30%', '15%'], correct: 1 },
      { q: 'What is the most important first step to protect your investment wealth for your family?', options: ['Sell all investments before you die', 'Move funds to cash at retirement', 'Ensure beneficiary details are on file and your will references investment accounts', 'Convert all investments to foreign currency'], correct: 2 },
      { q: 'In South Africa, all assets when a person dies must go through:', options: ['The South African Reserve Bank', 'SARS', 'The Master of the High Court', 'The Department of Trade and Industry'], correct: 2 },
    ],
  },
];

const LEARN_TRACKS = [
  { id: 'explorer',   label: 'Explorer',   desc: 'New to investing — start here',        icon: 'fa-compass',          color: '#656565',  minInvested: 0 },
  { id: 'builder',    label: 'Builder',    desc: 'Growing your portfolio',                icon: 'fa-hammer',           color: '#22c55e',  minInvested: 5000 },
  { id: 'strategist', label: 'Strategist', desc: 'Advanced portfolio management',         icon: 'fa-chess-knight',     color: '#eda5ff',  minInvested: 50000 },
];

let _learnActiveTrack = null;


/* Learning-quest "Start": jump to the Learning Hub, switch to the module's
   track, expand it, and scroll it into view. */


/* ═════════════════════════════════════════════════════════
   PLATFORM POLICIES
   ═════════════════════════════════════════════════════════ */

const POLICY_SECTIONS = [
  {
    id: 'pol_terms',
    icon: 'fa-file-contract',
    color: '#656565',
    title: 'Terms of Service',
    apiKey: 'terms',
    staticContent: `<p><em>Last updated: June 2025 &nbsp;·&nbsp; Version 1.0</em></p>
<p>By registering for, accessing, or using the SV Capital investor portal, mobile application, or any associated services (collectively, the "Platform"), you agree to be legally bound by these Terms of Service. If you do not agree, do not use the Platform.</p>

<h4>1. Definitions</h4>
<p><strong>"SV Capital"</strong> means SV Capital (Pty) Ltd, a company registered in the Republic of South Africa, authorised as a Financial Services Provider under FSP licence number 52449.<br>
<strong>"Investor"</strong> means any natural person or juristic entity that has registered an account on the Platform.<br>
<strong>"Investment Pool"</strong> means a structured investment product offered through the Platform, including but not limited to cattle investment cycles, solar energy projects, and short-term business loan products.<br>
<strong>"FICA"</strong> means the Financial Intelligence Centre Act 38 of 2001 and all regulations promulgated thereunder.<br>
<strong>"Wallet"</strong> means the virtual account balance held in your investor profile on the Platform, representing funds available for investment.</p>

<h4>2. Eligibility and Registration</h4>
<p>To register and use the Platform, you must: (a) be a natural person of at least 18 years of age, or a duly authorised representative of a registered juristic entity; (b) be a South African citizen, permanent resident, or a foreign national with a valid passport, eligible to invest under applicable South African law; (c) complete the FICA/KYC identity verification process to the satisfaction of SV Capital; and (d) not be listed on any domestic or international sanctions, terrorist financing, or politically exposed persons lists.</p>
<p>You may not create more than one individual investor account. Corporate entities may register a separate account distinct from personal accounts. Accounts created fraudulently, or by persons not meeting the above criteria, will be terminated without notice.</p>

<h4>3. Account Security</h4>
<p>You are solely responsible for maintaining the confidentiality of your login credentials. You must notify SV Capital immediately at <strong>support@svcapital.co.za</strong> if you become aware of any unauthorised access to your account. SV Capital will not be liable for any loss arising from your failure to maintain the security of your credentials. You agree not to share your account with any third party.</p>

<h4>4. Investment Products and Services</h4>
<p>The Platform provides access to alternative investment products. Each Investment Pool has specific terms including minimum investment amounts, fixed investment terms, target annual return rates, and maturity dates. Return rates are targets and are not guaranteed. SV Capital does not guarantee any specific return on investment.</p>
<p>Once an investment is placed and confirmed, it is subject to the terms of the specific Investment Pool and may not be withdrawn before the maturity date without incurring an early exit penalty as specified in the Pool's terms. Maturity instructions must be submitted before the maturity date; failure to submit an instruction may result in automatic rollover at SV Capital's discretion.</p>

<h4>5. Deposits and Withdrawals</h4>
<p>Funds deposited to your Wallet are held in a designated trust or ring-fenced account and are not commingled with SV Capital's operating funds. Deposits are credited to your Wallet upon confirmation of receipt. Withdrawal requests are subject to: (a) verification of your bank account; (b) FICA compliance status; and (c) processing times of 1–5 business days. SV Capital reserves the right to perform enhanced due diligence before processing large withdrawals.</p>

<h4>6. Fees and Charges</h4>
<p>SV Capital charges no entry fees, exit fees, subscription fees, or management fees directly to investors. Revenue is derived from structuring and arrangement fees charged at the project/pool level, which are embedded in and already deducted from the quoted return rate presented to investors. Any third-party banking or payment processing charges incurred during deposits or withdrawals are for the investor's account.</p>

<h4>7. Prohibited Activities</h4>
<p>You agree not to: (a) use the Platform for any unlawful purpose, including money laundering, terrorist financing, or tax evasion; (b) attempt to gain unauthorised access to any part of the Platform or its underlying systems; (c) use automated tools, bots, or scripts to access or scrape the Platform; (d) misrepresent your identity or financial standing; (e) engage in any conduct that disrupts or interferes with the Platform's operation; or (f) resell or sub-license access to the Platform without SV Capital's prior written consent.</p>

<h4>8. Intellectual Property</h4>
<p>All content on the Platform, including software, text, graphics, logos, and data, is owned by or licensed to SV Capital and is protected by applicable intellectual property laws. You are granted a limited, non-exclusive, revocable licence to access and use the Platform for your personal investment purposes only. No licence to reproduce, distribute, or create derivative works is granted.</p>

<h4>9. Limitation of Liability</h4>
<p>To the fullest extent permitted by law, SV Capital, its directors, officers, employees, and agents shall not be liable for: (a) any indirect, incidental, special, consequential, or punitive damages; (b) loss of profits, revenue, data, or investment returns; (c) damages arising from your reliance on information provided on the Platform; or (d) system downtime, data loss, or security breaches not caused by SV Capital's gross negligence or wilful misconduct. SV Capital's total aggregate liability for any claim shall not exceed the total amount invested by you through the Platform in the 12 months preceding the claim.</p>

<h4>10. Indemnification</h4>
<p>You agree to indemnify and hold harmless SV Capital and its affiliates from any claims, losses, liabilities, costs, and expenses (including reasonable legal fees) arising from: (a) your use of the Platform; (b) your breach of these Terms; (c) your violation of any applicable law; or (d) any third-party claim arising from your actions on the Platform.</p>

<h4>11. Amendments</h4>
<p>SV Capital reserves the right to amend these Terms at any time. Material amendments will be communicated to registered investors via email and/or in-app notification at least 30 days before the effective date. Continued use of the Platform after the effective date constitutes acceptance of the amended Terms. If you do not accept the changes, you must cease using the Platform and request account closure.</p>

<h4>12. Termination</h4>
<p>SV Capital may suspend or terminate your account immediately if: (a) you breach these Terms; (b) we are required to do so by law or regulatory authority; (c) your FICA/KYC verification fails; or (d) we reasonably suspect fraudulent or criminal activity. Upon termination, any active investments will continue to their scheduled maturity, and remaining Wallet balances will be paid to your verified bank account within a reasonable period.</p>

<h4>13. Governing Law and Dispute Resolution</h4>
<p>These Terms are governed by the laws of the Republic of South Africa. Any dispute arising from these Terms shall first be submitted to mediation. If mediation fails, the dispute shall be referred to arbitration under the rules of the Arbitration Foundation of Southern Africa (AFSA), with proceedings conducted in English in South Africa. Nothing in this clause prevents either party from seeking urgent relief from a court of competent jurisdiction.</p>

<h4>14. Contact</h4>
<p><strong>SV Capital (Pty) Ltd</strong><br>Email: <strong>legal@svcapital.co.za</strong><br>Support: <strong>support@svcapital.co.za</strong><br>FSP No: 52449 — Regulated by the FSCA</p>`,
  },
  {
    id: 'pol_privacy',
    icon: 'fa-shield-halved',
    color: '#22c55e',
    title: 'Privacy Policy',
    apiKey: 'privacy',
    staticContent: `<p><em>Last updated: June 2025 &nbsp;·&nbsp; Version 1.0</em></p>
<p>SV Capital (Pty) Ltd ("SV Capital", "we", "us", "our") is committed to protecting your personal information and processing it lawfully, in compliance with the Protection of Personal Information Act 4 of 2013 ("POPIA") and all applicable South African data protection legislation.</p>

<h4>1. Responsible Party</h4>
<p><strong>SV Capital (Pty) Ltd</strong> is the Responsible Party for the personal information you provide. Our Information Officer is responsible for ensuring compliance with POPIA and may be contacted at <strong>privacy@svcapital.co.za</strong>.</p>

<h4>2. Personal Information We Collect</h4>
<p>We collect the following categories of personal information:</p>
<ul>
<li><strong>Identity Information:</strong> Full name, date of birth, South African ID number or passport number and expiry date, nationality, and a copy of your identity document.</li>
<li><strong>Contact Information:</strong> Email address, mobile number, physical address, and province of residence.</li>
<li><strong>Financial Information:</strong> Banking details (bank name, account number, account type, branch code), wallet balance, investment history, transaction records, and income/risk profile.</li>
<li><strong>FICA/KYC Documentation:</strong> Proof of identity, proof of address, and any source-of-funds documentation required for regulatory compliance.</li>
<li><strong>Device and Technical Information:</strong> IP address, browser type and version, operating system, session data, and usage patterns within the Platform.</li>
<li><strong>Communication Records:</strong> Support ticket content, email correspondence, and in-app messages.</li>
<li><strong>Referral Information:</strong> Where you were referred by another investor, their referral code is recorded.</li>
</ul>

<h4>3. Purposes of Processing</h4>
<p>We process your personal information for the following purposes:</p>
<ul>
<li>Opening and managing your investor account;</li>
<li>Processing investment transactions, deposits, and withdrawals;</li>
<li>Complying with FICA, FAIS, POPIA, and all applicable financial services legislation;</li>
<li>Verifying your identity and conducting risk assessments (KYC/AML);</li>
<li>Communicating with you about your investments, account status, and platform updates;</li>
<li>Generating investment certificates, account statements, and tax documentation (IT3b);</li>
<li>Preventing, detecting, and investigating fraud, money laundering, and other unlawful activity;</li>
<li>Improving the Platform and its features based on usage analytics;</li>
<li>Responding to legal or regulatory requests, court orders, or governmental inquiries;</li>
<li>Sending you transactional notifications and, with your consent, marketing communications.</li>
</ul>

<h4>4. Lawful Basis for Processing</h4>
<p>We process your personal information on the following lawful grounds:</p>
<ul>
<li><strong>Contractual necessity:</strong> Processing required to fulfil our obligations to you as an investor;</li>
<li><strong>Legal obligation:</strong> Processing required to comply with FICA, the Income Tax Act, FAIS, and POPIA;</li>
<li><strong>Consent:</strong> For direct marketing and optional communications, where you have given explicit consent;</li>
<li><strong>Legitimate interest:</strong> For fraud prevention, security monitoring, and platform improvement, where this does not override your rights.</li>
</ul>

<h4>5. Sharing of Personal Information</h4>
<p>We do not sell, rent, or trade your personal information. We may share it with:</p>
<ul>
<li><strong>Identity verification providers:</strong> For FICA/KYC checks;</li>
<li><strong>Payment processors:</strong> For processing deposits and withdrawals;</li>
<li><strong>Regulatory bodies:</strong> FSCA, FIC, SARS, and other South African authorities as required by law;</li>
<li><strong>Auditors and legal advisers:</strong> Under binding confidentiality obligations;</li>
<li><strong>Cloud service providers:</strong> Who process data on our behalf under strict data processing agreements;</li>
<li><strong>Law enforcement:</strong> Where legally compelled by court order or applicable legislation.</li>
</ul>
<p>All third parties are required to maintain the security of your information and to use it only for the purposes for which it was shared.</p>

<h4>6. Cross-Border Transfers</h4>
<p>Your personal information is primarily processed and stored within the Republic of South Africa. If any processing occurs outside South Africa, we ensure that the recipient country provides adequate protection and that appropriate safeguards (such as data processing agreements or binding corporate rules) are in place, as required by Section 72 of POPIA.</p>

<h4>7. Retention of Personal Information</h4>
<p>We retain your personal information only for as long as necessary to fulfil the purposes for which it was collected, or as required by law:</p>
<ul>
<li>FICA documentation and KYC records: minimum 5 years after account closure, as required by the Financial Intelligence Centre Act;</li>
<li>Investment records and transaction history: minimum 5 years for tax purposes;</li>
<li>Account information: retained while your account is active and for up to 7 years after closure;</li>
<li>Audit logs and access records: 3 years;</li>
<li>Support and complaint records: 3 years from resolution.</li>
</ul>

<h4>8. Security Measures</h4>
<p>We implement appropriate technical and organisational security measures including: TLS encryption for all data in transit; AES-256 encryption for sensitive data at rest; role-based access controls limiting staff access to personal information; multi-factor authentication for admin systems; regular security audits and penetration testing; and incident response procedures. Despite these measures, no system is entirely secure. We will notify you of any security breach that poses a real risk of harm to you, in accordance with POPIA.</p>

<h4>9. Cookies and Tracking</h4>
<p>The Platform uses cookies and similar technologies for session management, security, and analytics. Strictly necessary cookies cannot be disabled as they are required for the Platform to function. Analytics cookies help us understand usage patterns and are collected in pseudonymised form. You may control cookie preferences via your browser settings; however, disabling certain cookies may affect Platform functionality.</p>

<h4>10. Your Rights as a Data Subject</h4>
<p>Under POPIA, you have the right to:</p>
<ul>
<li><strong>Access:</strong> Request a copy of the personal information we hold about you;</li>
<li><strong>Correction:</strong> Request that inaccurate or incomplete information be corrected;</li>
<li><strong>Deletion:</strong> Request deletion of your personal information, subject to our legal retention obligations;</li>
<li><strong>Objection:</strong> Object to processing based on legitimate interests, including direct marketing;</li>
<li><strong>Restriction:</strong> Request that processing be restricted in certain circumstances;</li>
<li><strong>Complaint:</strong> Lodge a complaint with the Information Regulator of South Africa.</li>
</ul>
<p>To exercise any of these rights, contact our Information Officer at <strong>privacy@svcapital.co.za</strong>. We will respond within 30 days.</p>

<h4>11. Direct Marketing</h4>
<p>We may send you information about investment opportunities, platform features, and financial education content. You may opt out of marketing communications at any time by clicking "Unsubscribe" in any email, or by contacting <strong>privacy@svcapital.co.za</strong>. Transactional communications (such as investment confirmations and account statements) cannot be opted out of while your account is active.</p>

<h4>12. Changes to This Policy</h4>
<p>We may update this Privacy Policy from time to time. Material changes will be communicated via email or in-app notification before they take effect. Continued use of the Platform after the effective date constitutes acknowledgment of the updated Policy.</p>

<h4>13. Contact</h4>
<p><strong>Information Officer:</strong> privacy@svcapital.co.za<br>
<strong>General:</strong> info@svcapital.co.za<br>
<strong>Information Regulator (South Africa):</strong> inforeg.org.za &nbsp;·&nbsp; complaints.IR@justice.gov.za</p>`,
  },
  {
    id: 'pol_popia',
    icon: 'fa-lock',
    color: '#eda5ff',
    title: 'POPIA Notice',
    staticContent: `<p><em>Issued in compliance with Section 18 of the Protection of Personal Information Act 4 of 2013 (POPIA) &nbsp;·&nbsp; Version 1.0</em></p>

<h4>1. Responsible Party</h4>
<p><strong>SV Capital (Pty) Ltd</strong><br>
Financial Services Provider · FSP No. 52449<br>
Republic of South Africa<br>
Email: <strong>info@svcapital.co.za</strong></p>

<h4>2. Information Officer</h4>
<p>The designated Information Officer (IO) responsible for ensuring SV Capital's compliance with POPIA may be contacted at: <strong>privacy@svcapital.co.za</strong>. The IO is registered with the Information Regulator of South Africa in accordance with Section 55 of POPIA.</p>

<h4>3. Categories of Personal Information Processed</h4>
<p>SV Capital processes the following categories of personal information:</p>
<ul>
<li><strong>Identifying information:</strong> Full legal name, date of birth, RSA ID number or passport details, photograph (where required for KYC);</li>
<li><strong>Contact details:</strong> Email address, mobile number, physical and postal address;</li>
<li><strong>Financial information:</strong> Bank account details, investment transactions, wallet balance, income level, risk profile;</li>
<li><strong>FICA/KYC documentation:</strong> Certified copies of identity documents, proof of address, source-of-funds declarations;</li>
<li><strong>Technical data:</strong> Device identifiers, IP addresses, browser information, usage logs;</li>
<li><strong>Special categories:</strong> We do not intentionally collect special personal information as defined in Section 26 of POPIA (e.g., health, religious, or racial information).</li>
</ul>

<h4>4. Purposes of Processing</h4>
<p>Your personal information is processed for the following specific, explicit, and legitimate purposes:</p>
<ul>
<li>Investor onboarding and account management;</li>
<li>Identity verification and FICA/KYC compliance;</li>
<li>Anti-money laundering (AML) and counter-terrorist financing (CTF) screening;</li>
<li>Processing investment transactions and generating returns;</li>
<li>Producing investment certificates, account statements, and IT3(b) tax certificates;</li>
<li>Communicating investment performance, maturity notices, and regulatory updates;</li>
<li>Complying with FSCA reporting obligations, SARS requirements, and FIC directives;</li>
<li>Fraud prevention and platform security;</li>
<li>Resolving complaints and support queries.</li>
</ul>

<h4>5. Lawful Grounds for Processing</h4>
<p>Processing is carried out on the following grounds as contemplated in Section 11 of POPIA:</p>
<ul>
<li><strong>Consent (s.11(1)(a)):</strong> Where you have given specific, informed consent, including for direct marketing;</li>
<li><strong>Contract (s.11(1)(b)):</strong> Where processing is necessary for the performance of our investment services agreement with you;</li>
<li><strong>Legal obligation (s.11(1)(c)):</strong> Where we are required to process information to comply with FICA, FAIS, POPIA, and other applicable legislation;</li>
<li><strong>Legitimate interest (s.11(1)(f)):</strong> For fraud prevention, security monitoring, and platform improvement, provided this does not override your rights and interests.</li>
</ul>

<h4>6. Sources of Personal Information</h4>
<p>Personal information is collected directly from you during registration and throughout your use of the Platform. Additional information may be sourced from: identity verification bureaus (for FICA checks), credit bureaus (for risk assessment), payment processors (for banking verification), and public registers (e.g., CIPC for corporate investor verification).</p>

<h4>7. Recipients of Personal Information</h4>
<p>Your personal information may be shared with the following recipients:</p>
<ul>
<li>Identity and KYC verification service providers;</li>
<li>Payment gateway providers and banks;</li>
<li>The Financial Intelligence Centre (FIC), FSCA, SARS, and other regulatory bodies as required by law;</li>
<li>Professional advisers (attorneys, auditors, compliance officers) under confidentiality obligations;</li>
<li>Cloud infrastructure and data hosting providers under data processing agreements;</li>
<li>Law enforcement agencies pursuant to valid legal process.</li>
</ul>

<h4>8. Cross-Border Transfers of Personal Information</h4>
<p>In accordance with Section 72 of POPIA, personal information will only be transferred to a third party in a foreign country if: (a) the recipient is subject to a law, binding corporate rules, or binding agreement that provides an adequate level of protection substantially similar to POPIA; or (b) you have consented to the transfer. We will not transfer your information to jurisdictions that do not provide adequate protection without appropriate safeguards.</p>

<h4>9. Retention Periods</h4>
<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.87rem;margin-bottom:12px;min-width:400px">
<thead><tr style="background:rgba(0,0,0,0.05)"><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Category</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Retention Period</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Legal Basis</th></tr></thead>
<tbody>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">FICA/KYC documentation</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">5 years after account closure</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">FIC Act s.23</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Investment and transaction records</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">5 years (tax purposes)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Income Tax Act</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Account and profile data</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Duration of account + 7 years</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">FAIS Act</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Audit and access logs</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">3 years</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Legitimate interest</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Support and complaint records</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">3 years from resolution</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Legitimate interest</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Policy acceptance records</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Duration of account + 7 years</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Legal obligation / evidence</td></tr>
</tbody>
</table></div>

<h4>10. Your Rights as a Data Subject</h4>
<p>Sections 23–25 of POPIA afford you the following rights, which you may exercise by contacting our Information Officer:</p>
<ul>
<li><strong>Right of access (s.23):</strong> To request confirmation of whether we hold your personal information and to obtain a copy thereof;</li>
<li><strong>Right to correction or deletion (s.24):</strong> To request that inaccurate, incomplete, or outdated information be corrected or destroyed;</li>
<li><strong>Right to object (s.11(3)):</strong> To object to the processing of your personal information on the ground of legitimate interests or for direct marketing purposes;</li>
<li><strong>Right to restriction:</strong> To request that processing be restricted in certain circumstances (e.g., while accuracy of data is disputed);</li>
<li><strong>Right to complain:</strong> To lodge a complaint with the Information Regulator of South Africa.</li>
</ul>
<p>Requests will be responded to within 30 days. We may charge a reasonable fee for manifestly unfounded or excessive requests.</p>

<h4>11. Objection to Direct Marketing</h4>
<p>In terms of Section 69 of POPIA, you have the right to object, at any time, to your personal information being used for direct marketing purposes. To opt out, email <strong>privacy@svcapital.co.za</strong> or use the unsubscribe link in any marketing email.</p>

<h4>12. Complaints to the Information Regulator</h4>
<p>If you believe that SV Capital has infringed your rights under POPIA, you may lodge a complaint with:</p>
<p><strong>The Information Regulator (South Africa)</strong><br>
Website: <strong>inforeg.org.za</strong><br>
Email: <strong>complaints.IR@justice.gov.za</strong><br>
PAIAComplaints.IR@justice.gov.za (for PAIA complaints)</p>`,
  },
  {
    id: 'pol_risk',
    icon: 'fa-triangle-exclamation',
    color: '#d97706',
    title: 'Risk Disclaimer',
    staticContent: `<p><em>Version 1.0 &nbsp;·&nbsp; Effective June 2025</em></p>
<p><strong>Please read this Risk Disclaimer carefully before making any investment decision. By investing through the SV Capital Platform, you acknowledge that you have read, understood, and accepted the risks described herein.</strong></p>

<h4>1. General Investment Risk Warning</h4>
<p>All investments involve risk. The value of your investment, and any returns derived from it, may go down as well as up. You may receive back less than the amount you invested. Past performance of any Investment Pool or SV Capital's overall portfolio is not a reliable indicator of future performance. No investment return is guaranteed.</p>

<h4>2. Not a Deposit</h4>
<p>Investments made through SV Capital are not deposits and are not protected by any deposit insurance scheme, government guarantee, or scheme of arrangement under the Deposit Guarantee Scheme or any equivalent. Your invested capital is at risk.</p>

<h4>3. Alternative Investment Risk</h4>
<p>The products offered on this Platform are alternative investments — they differ significantly from listed equities, bonds, and traditional unit trusts. Alternative investments carry specific and heightened risks, including reduced regulatory oversight of underlying assets, less frequent valuation, and greater complexity. You should understand the nature of each Investment Pool before committing funds.</p>

<h4>4. Liquidity Risk</h4>
<p>Investment Pools have fixed terms. Once an investment is placed, your capital is locked in for the duration of the selected term. Early exit is not guaranteed and, where permitted, will attract an early exit penalty as specified in the Pool terms. You should only invest funds that you can afford to have unavailable for the full investment term. There is no secondary market for your investment interest.</p>

<h4>5. Credit and Default Risk</h4>
<p>For loan-based products, there is a risk that underlying borrowers may default on their obligations. While SV Capital structures loans with security and collateral where possible, the realisation of security may not fully recover your capital in all circumstances. SV Capital does not guarantee the creditworthiness of any borrower.</p>

<h4>6. Commodity and Market Risk</h4>
<p>Cattle investment products are subject to commodity risk. Live cattle prices are determined by market forces including supply and demand, feed costs, disease outbreaks, export restrictions, and consumer preferences. Adverse movements in beef prices may reduce or eliminate projected returns. SV Capital does not control commodity markets and cannot guarantee the price at which cattle will be sold.</p>

<h4>7. Operational Risk (Cattle)</h4>
<p>Cattle farming involves operational risks including, but not limited to: disease and mortality (including foot-and-mouth disease, anthrax, and other livestock diseases); drought and adverse weather affecting grazing and water availability; theft and security incidents; veterinary costs exceeding projections; and challenges in sourcing quality stock. Although SV Capital employs experienced farm managers and carries appropriate insurance where available, these risks cannot be entirely eliminated.</p>

<h4>8. Renewable Energy and Solar Risk</h4>
<p>Solar energy projects are subject to risks including: weather variability and reduced solar irradiance reducing output below projections; equipment failure or degradation; grid connectivity issues and load-shedding impacts; changes to government feed-in tariff or energy policy; counterparty risk of energy off-takers; and regulatory changes to the energy sector. Returns on solar projects are partly dependent on energy production volumes and prevailing energy tariffs.</p>

<h4>9. Regulatory and Compliance Risk</h4>
<p>The regulatory environment for alternative investments and financial technology in South Africa is evolving. Changes in legislation (including FICA, FAIS, or tax law), regulatory interpretation, or enforcement policy could affect SV Capital's ability to offer certain products or could impose additional compliance costs. SV Capital may be required to make changes to its products or operations in response to regulatory developments, which could affect investor returns.</p>

<h4>10. Technology and Cybersecurity Risk</h4>
<p>The Platform relies on technology infrastructure that may be subject to downtime, technical failures, data breaches, or cyberattacks. While SV Capital implements industry-standard security measures, no system is completely immune to security incidents. A technology failure could result in temporary inability to access your account or execute transactions. SV Capital maintains business continuity and disaster recovery plans to minimise the impact of such events.</p>

<h4>11. Inflation Risk</h4>
<p>The purchasing power of your returns may be eroded by inflation. If the rate of inflation exceeds the return rate of your investment, the real value of your returns will be negative even if the nominal return is positive.</p>

<h4>12. Concentration Risk</h4>
<p>Investing a significant portion of your total investable assets in any single Investment Pool or product type increases concentration risk. SV Capital recommends that you diversify your investments across different asset classes and Pool types to reduce the impact of any single investment's underperformance.</p>

<h4>13. Suitability Warning</h4>
<p>Alternative investments may not be suitable for all investors. These products are designed for investors who: understand the risks of illiquid, fixed-term investments; have an investment horizon that matches the product term; can afford to lose some or all of their invested capital; and have adequate financial resources for their day-to-day needs beyond the amounts invested. Before investing, carefully consider your investment objectives, risk tolerance, financial situation, and need for liquidity. If you are unsure, seek independent financial advice from a registered financial adviser authorised under FAIS.</p>

<h4>14. No Financial Advice</h4>
<p>Nothing on this Platform, including product descriptions, return rate projections, investment summaries, or communications from SV Capital staff (unless expressly provided by a registered financial adviser in terms of an advisory mandate), constitutes financial, investment, legal, or tax advice. Information is provided for general informational purposes only. Investment decisions are the sole responsibility of the investor.</p>

<h4>15. Tax Considerations</h4>
<p>Returns on investments may be subject to South African income tax, capital gains tax, or withholding tax depending on your tax status and the nature of the return. Interest income earned through the Platform must be declared in your annual tax return (ITR12). SV Capital issues IT3(b) certificates annually to assist with this. SV Capital does not provide tax advice; consult a registered tax practitioner for guidance specific to your circumstances.</p>

<h4>16. Forward-Looking Statements</h4>
<p>Any projected return rates, indicative timelines, or performance forecasts presented on this Platform are forward-looking statements based on current market conditions and assumptions. They do not constitute a guarantee or promise of future results. Actual outcomes may differ materially from projections.</p>`,
  },
  {
    id: 'pol_paia',
    icon: 'fa-folder-open',
    color: '#656565',
    title: 'PAIA Manual',
    staticContent: `<p><em>Published in terms of Section 51 of the Promotion of Access to Information Act 2 of 2000 (PAIA) &nbsp;·&nbsp; Version 1.0 &nbsp;·&nbsp; June 2025</em></p>

<h4>1. Contact Details of SV Capital</h4>
<p><strong>Legal Name:</strong> SV Capital (Pty) Ltd<br>
<strong>Nature of Business:</strong> Alternative Investment Platform, licensed Financial Services Provider<br>
<strong>FSP Number:</strong> 52449<br>
<strong>Email:</strong> info@svcapital.co.za<br>
<strong>PAIA Requests:</strong> privacy@svcapital.co.za<br>
<strong>Registered Country:</strong> Republic of South Africa</p>

<h4>2. Information Officer</h4>
<p>The Information Officer is responsible for administering all PAIA requests on behalf of SV Capital.</p>
<p><strong>Contact:</strong> privacy@svcapital.co.za<br>
<strong>Postal:</strong> Marked "PAIA Request — Confidential" to the registered address of SV Capital (Pty) Ltd</p>
<p>The Information Officer is registered with the Information Regulator of South Africa in accordance with POPIA s.55.</p>

<h4>3. Guide on How to Access Information</h4>
<p>The South African Human Rights Commission (SAHRC) has published a guide to assist persons who wish to access information held by private or public bodies. This guide is available on the SAHRC website at <strong>sahrc.org.za</strong>. SV Capital will, on request, provide a copy of or direct you to this guide.</p>

<h4>4. Records Available Without Submitting a PAIA Request</h4>
<p>The following records are automatically available to registered investors through the Platform without requiring a formal PAIA request:</p>
<ul>
<li>Your investor account profile and contact details;</li>
<li>Account statements and transaction history;</li>
<li>Investment certificates and confirmation documents;</li>
<li>IT3(b) interest income certificates;</li>
<li>FICA/KYC submission status and uploaded documentation (your own only);</li>
<li>Support ticket history;</li>
<li>Accepted policy documents and timestamps;</li>
<li>Platform policies (Terms of Service, Privacy Policy, POPIA Notice, Risk Disclaimer, this PAIA Manual, and the Complaints Procedure).</li>
</ul>

<h4>5. Records Available on Request (Subject to PAIA)</h4>
<p>The following categories of records may be made available on formal PAIA request, subject to the grounds for refusal set out in PAIA:</p>
<ul>
<li>Internal audit records relating to your account (where refusal grounds do not apply);</li>
<li>Communications records between you and SV Capital staff;</li>
<li>Records relating to a specific investment decision affecting your account;</li>
<li>Any other record in which you have a personal interest.</li>
</ul>
<p>Records that do not pertain to you personally, or that are subject to grounds for refusal under PAIA (including records of third parties, commercially sensitive information, and legally privileged records), will not be disclosed without the consent of the affected party or a court order.</p>

<h4>6. Grounds for Refusal</h4>
<p>In terms of PAIA, SV Capital may refuse to grant access to records on the following grounds:</p>
<ul>
<li>Records containing personal information of third parties who have not consented to disclosure;</li>
<li>Commercially sensitive information, including trade secrets, financial models, or proprietary investment strategies;</li>
<li>Legally privileged communications (attorney-client privilege);</li>
<li>Records that, if disclosed, could jeopardise a criminal investigation or legal proceedings;</li>
<li>Records whose disclosure would be contrary to any binding agreement or court order.</li>
</ul>

<h4>7. How to Submit a PAIA Request</h4>
<p>To request access to records held by SV Capital, you must:</p>
<ol>
<li>Complete Form C as prescribed by the Regulations under PAIA (available at <strong>justice.gov.za</strong>) or submit a written request containing the same information;</li>
<li>Clearly identify the record(s) you wish to access;</li>
<li>Provide a copy of your identity document;</li>
<li>State the form in which you wish to receive the record (electronic copy, printed copy, or inspection);</li>
<li>If requesting records about a third party, provide reasons and confirm you are authorised to do so;</li>
<li>Submit the request to: <strong>privacy@svcapital.co.za</strong>, marked "PAIA Request".</li>
</ol>

<h4>8. Fees</h4>
<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.87rem;margin-bottom:12px;min-width:400px">
<thead><tr style="background:rgba(0,0,0,0.05)"><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Fee Type</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Amount</th></tr></thead>
<tbody>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Request fee (payable on submission)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">R35.00</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Request for own personal information</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Waived</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Printed copies (A4 per page)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">R1.10 per page</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Electronic copy (per megabyte)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">R7.50 per MB</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Deposit (if reproduction fee exceeds R100)</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">1/3 of total fee upfront</td></tr>
</tbody>
</table></div>
<p>Fees are prescribed in terms of the PAIA regulations and are subject to change by the Information Regulator.</p>

<h4>9. Response Timeframes</h4>
<p>SV Capital will respond to a PAIA request within <strong>30 days</strong> of receipt of a complete request and payment of the request fee. In complex cases, this period may be extended by a further 30 days with notice to the requester. If SV Capital fails to respond within the required period, this is deemed a refusal and may be appealed to the Information Regulator.</p>

<h4>10. Internal Appeal and External Remedies</h4>
<p>If your request is refused, you may:</p>
<ul>
<li>Lodge an internal appeal in writing to the Information Officer within 60 days of the refusal, setting out the grounds of appeal;</li>
<li>Apply to the Information Regulator for a review of the refusal (at <strong>inforeg.org.za</strong>);</li>
<li>Apply to a court of competent jurisdiction for appropriate relief.</li>
</ul>

<h4>11. Date of Compilation</h4>
<p>This PAIA Manual was compiled in June 2025 and will be updated as required by law or as SV Capital's operations change. The current version is available on the Platform and will be provided free of charge upon request.</p>`,
  },
  {
    id: 'pol_complaints',
    icon: 'fa-circle-exclamation',
    color: '#ef4444',
    title: 'Complaints Procedure',
    staticContent: `<p><em>Version 1.0 &nbsp;·&nbsp; Effective June 2025</em></p>
<p>SV Capital (Pty) Ltd is committed to providing high-quality investment services and resolving all investor complaints promptly, fairly, and transparently. This procedure sets out how to lodge a complaint and what you can expect from us.</p>

<h4>1. Scope</h4>
<p>This Complaints Procedure applies to all complaints received from registered investors relating to: investment products offered on the Platform; account management and transactions; FICA/KYC processes; communications from SV Capital; data privacy and POPIA matters; and the conduct of SV Capital staff or representatives.</p>

<h4>2. What Constitutes a Complaint</h4>
<p>A complaint is any expression of dissatisfaction by an investor regarding SV Capital's products, services, conduct, or failure to act. Complaints are distinct from general queries (requests for information or assistance) and service requests (routine account actions). If in doubt, submit your concern as a complaint and SV Capital will categorise it appropriately.</p>

<h4>3. How to Lodge a Complaint</h4>
<p>You may lodge a complaint through any of the following channels:</p>
<ul>
<li><strong>In-Platform:</strong> Navigate to the Support section of this portal and submit a support ticket with category "Complaint";</li>
<li><strong>Email:</strong> Send a written complaint to <strong>complaints@svcapital.co.za</strong>;</li>
<li><strong>Compliance Officer:</strong> For escalated or serious complaints, email <strong>compliance@svcapital.co.za</strong>.</li>
</ul>
<p>When lodging a complaint, please include: your full name and investor ID; a clear description of the complaint and the events giving rise to it; the date(s) of the relevant events; any relevant reference numbers, transaction IDs, or correspondence; and the outcome or remedy you are seeking.</p>

<h4>4. Acknowledgement</h4>
<p>SV Capital will acknowledge all complaints within <strong>1 business day</strong> of receipt. The acknowledgement will confirm receipt, assign a complaint reference number, and provide the name and contact details of the person handling your complaint.</p>

<h4>5. Investigation and Resolution (Stage 1)</h4>
<p>Your complaint will be investigated by the relevant team within SV Capital. We aim to provide a full written response within <strong>5 business days</strong> of acknowledging the complaint. Where the complaint requires a more complex investigation, we will notify you of the extended timeline and provide weekly progress updates. In all cases, a final response will be provided within <strong>10 business days</strong> of acknowledgement, unless agreed otherwise with you in writing.</p>
<p>The response will set out: a summary of your complaint as understood by SV Capital; the findings of our investigation; our decision (uphold, partially uphold, or reject) and the reasons therefor; any remedial action to be taken; and information about your escalation options if you are dissatisfied.</p>

<h4>6. Escalation (Stage 2)</h4>
<p>If you are not satisfied with the Stage 1 response, you may escalate your complaint to the Compliance Officer at <strong>compliance@svcapital.co.za</strong> within <strong>30 days</strong> of receiving the Stage 1 response. Your escalation should set out: the original complaint reference number; why you are dissatisfied with the Stage 1 response; and the outcome you are seeking. The Compliance Officer will conduct an independent review and provide a final internal response within <strong>10 business days</strong>.</p>

<h4>7. External Dispute Resolution (Stage 3)</h4>
<p>If SV Capital is unable to resolve your complaint to your satisfaction through our internal process, you may refer the matter to an appropriate external body:</p>
<ul>
<li><strong>Financial Sector Conduct Authority (FSCA):</strong> For complaints relating to market conduct, FAIS, and financial services regulation. Website: <strong>fsca.co.za</strong> &nbsp;·&nbsp; Tel: 0800 110 443</li>
<li><strong>FAIS Ombud:</strong> For complaints relating to financial advice received from a financial adviser or intermediary. Website: <strong>faisombud.co.za</strong> &nbsp;·&nbsp; Tel: 012 762 5000</li>
<li><strong>Information Regulator:</strong> For complaints specifically relating to POPIA or PAIA rights. Website: <strong>inforeg.org.za</strong> &nbsp;·&nbsp; Email: complaints.IR@justice.gov.za</li>
<li><strong>National Consumer Commission (NCC):</strong> For complaints relating to consumer rights under the Consumer Protection Act. Website: <strong>thencc.org.za</strong></li>
</ul>
<p>You are not required to exhaust our internal procedure before referring a complaint to an external body, but we encourage you to do so as many matters can be resolved more efficiently through direct engagement.</p>

<h4>8. Timeframe Summary</h4>
<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.87rem;margin-bottom:12px;min-width:400px">
<thead><tr style="background:rgba(0,0,0,0.05)"><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Stage</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Action</th><th style="text-align:left;padding:7px 10px;border:1px solid rgba(0,0,0,0.1)">Timeframe</th></tr></thead>
<tbody>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Receipt</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Acknowledgement issued</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">1 business day</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Stage 1</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Full written response</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">5–10 business days</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Stage 2</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Compliance Officer review</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">10 business days</td></tr>
<tr><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">Stage 3</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">External referral</td><td style="padding:7px 10px;border:1px solid rgba(0,0,0,0.08)">As per regulator</td></tr>
</tbody>
</table></div>

<h4>9. Record Keeping</h4>
<p>SV Capital maintains a complaints register as required by the FSCA and FAIS. All complaints are recorded with their reference number, date received, nature of complaint, response provided, and resolution outcome. This register is available for inspection by the FSCA upon request. Complaints records are retained for 5 years.</p>

<h4>10. Contact Details</h4>
<p><strong>General Support:</strong> support@svcapital.co.za<br>
<strong>Complaints:</strong> complaints@svcapital.co.za<br>
<strong>Compliance Officer:</strong> compliance@svcapital.co.za<br>
<strong>Information Officer (POPIA/PAIA):</strong> privacy@svcapital.co.za<br>
<strong>Regulator:</strong> FSCA · FSP No. 52449 · fsca.co.za</p>`,
  },
];

let _policyOpenId = null;


/* ═══════════════════════════════════════════════════════════════
   DARK MODE
   ═══════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════
   GUIDED TOUR
   ═══════════════════════════════════════════════════════════════ */

const TOUR_STEPS = [
  {
    id: 'welcome',
    type: 'center',
    icon: 'fa-door-open',
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
    body: 'Your current investments are listed here with product type, amount, target return, and days remaining until maturity.',
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
    body: 'Explore open pools across solar, cattle, and loans. Each shows its rate, term, and how much is still available.',
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
    body: 'Complete quests and surveys to earn XP and climb through 8 levels — from Seed to Luminary. Unlock badges and show off your progress.',
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


/* ═══════════════════════════════════════════════════════════════
   FIRST DEPOSIT PROMPT
   ═══════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════
   §50 — SUB ACCOUNTS
   Business · Trust · Stokvel · Minor
   ═══════════════════════════════════════════════════════════════ */

/* ── Meta ───────────────────────────────────────────────────── */
const SA_TYPE_META = {
  business: {
    icon: 'fa-building',       label: 'Business',
    color: '#656565',          bg: 'linear-gradient(135deg,#1a3d42 0%,#656565 100%)',
    tagline: 'Invest through your registered company',
    ficaDocs: ['Company Registration Certificate (COR14.3 / COR15.1A)', 'Company Tax Clearance Certificate', 'CIPC CoR39 or similar', 'Authorised signatory ID (copy)'],
  },
  trust:    {
    icon: 'fa-scale-balanced',  label: 'Trust',
    color: '#eda5ff',           bg: 'linear-gradient(135deg,#2d1d6e 0%,#eda5ff 100%)',
    tagline: 'Invest through a family or business trust',
    ficaDocs: ['Trust Deed (certified copy)', 'Letters of Authority (Master of Court)', 'Trustee(s) ID documents', 'Trust tax clearance certificate'],
  },
  stokvel:  {
    icon: 'fa-people-group',    label: 'Stokvel',
    color: '#22c55e',           bg: 'linear-gradient(135deg,#064e1e 0%,#22c55e 100%)',
    tagline: 'Community savings club investing together',
    ficaDocs: ['Stokvel constitution / rules', 'Proof of banking account', 'Two or more members\' ID documents', 'NASASA certificate (if applicable)'],
  },
  minor:    {
    icon: 'fa-child-reaching',  label: 'Minor',
    color: '#fec24f',           bg: 'linear-gradient(135deg,#ff5229 0%,#fec24f 100%)',
    tagline: 'Start your child\'s investment journey today',
    ficaDocs: ['Child\'s birth certificate (unabridged)', 'Guardian\'s ID document', 'Proof of guardianship / parental rights', 'Child\'s tax reference number (if applicable)'],
  },
};


const _SA_TIPS = {
  little: [
    { emoji: '🐷', title: 'Save Like a Piggy!', body: 'Every rand you save goes into your piggy bank. When it\'s full, amazing things can happen!' },
    { emoji: '🌱', title: 'Money is Like a Seed', body: 'When you plant a seed and water it, a big tree grows. When you save money, it grows too!' },
    { emoji: '⭐', title: 'You\'re a Super Saver!', body: 'Every time your grown-up adds money to your account, you\'re one step closer to your goal!' },
  ],
  young: [
    { emoji: '🎯', title: 'Set a Goal!', body: 'Want a new toy or game? Figure out how much it costs, then save a little bit each week to get there!' },
    { emoji: '🆚', title: 'Needs vs Wants', body: '"Needs" are things like food and school books. "Wants" are things like games. Smart savers know the difference!' },
    { emoji: '📈', title: 'Your Money Grows!', body: 'SV Capital pays you to keep your money here. It\'s called a return — your R100 becomes R115!' },
    { emoji: '💡', title: 'Start Early, Win Big', body: 'If you save R50 a month from now until you\'re 18, you could have more than R5 000 before you even finish school!' },
  ],
  growing: [
    { emoji: '🔮', title: 'The Power of Compounding Returns', body: 'When your returns are reinvested, those returns also generate returns. It\'s money multiplying itself!' },
    { emoji: '📊', title: 'Rule of 72', body: 'Divide 72 by your annual return rate to see how many years to double your money. At 14%: 72 ÷ 14 = just over 5 years!' },
    { emoji: '🧺', title: 'Don\'t Put All Eggs in One Basket', body: 'Spreading money across different investments (diversifying) reduces risk. SV Capital does this across sectors.' },
    { emoji: '⏰', title: 'Time is Your Biggest Advantage', body: 'Starting to invest at 12 vs 22 can mean twice as much money at retirement. You have a head start!' },
  ],
  teen: [
    { emoji: '🚀', title: 'Compound Growth is Exponential', body: 'R10 000 at 14% per year becomes R37 072 in 10 years without adding anything. Your money works while you sleep.' },
    { emoji: '📉', title: 'Market Volatility is Normal', body: 'Markets go up and down, but SV Capital\'s asset-backed investments provide stable, predictable returns.' },
    { emoji: '🏦', title: 'Alternative vs Traditional', body: 'Banks offer 6-8%. SV Capital targets 12-21% through real assets like cattle, solar, and SMEs.' },
    { emoji: '💼', title: 'Start a Portfolio Now', body: 'At 16, if you invest R500/month at 14%, you\'ll have R1.2 million by age 40. The earlier, the better.' },
  ],
};


/* ── Create modal ───────────────────────────────────────────── */
let _saCreateType = null;
let _saCreateStep = 1;


let _tipIdx = 0;


/* ── Deposit to sub account — handled by openSaDeposit() near line 2511 ── */


/* ── FICA upload for sub account ────────────────────────────── */
let _saFicaFile = null;
let _saFicaB64  = null;
let _saFicaSaId = null;


/* ── Sub-Account Banking Details ────────────────────────────── */
let _saBankSaId = null;


/* ═══════════════════════════════════════════════
   BANK DETAILS & WITHDRAWALS
   ═══════════════════════════════════════════════ */


let _saWithdrawalId = null;


/* ═══════════════════════════════════════════════
   TAX CERTIFICATE — SARS Interest Income
   ═══════════════════════════════════════════════ */
let _lastTaxCertHTML = null; // cached for PDF download


/* ═══════════════════════════════════════════════
   TWO-FACTOR AUTHENTICATION (TOTP)
   ═══════════════════════════════════════════════ */
let _2faSecret = null; // temp storage during setup flow


/* ═══════════════════════════════════════════════
   INVESTMENT CALCULATOR  (Feature 6 — Enhanced)
   ═══════════════════════════════════════════════ */
let _calcPoolId = null;


/* ═══════════════════════════════════════════════
   LIVE REFERRAL DASHBOARD
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   FEATURE 7: DOCUMENT VAULT
   ═══════════════════════════════════════════════ */

/* ─── KYC Document Upload ─────────────────────────────────────── */
let _kycFile = null;


/* ═══════════════════════════════════════════════════════
   GIFT FEATURE
═══════════════════════════════════════════════════════ */
let _giftEmailDebounce = null;
let _giftSentCache = [];
let _giftReceivedCache = [];


/* inject confetti keyframes once */
if (!document.getElementById('giftConfettiStyle')) {
  const s = document.createElement('style');
  s.id = 'giftConfettiStyle';
  s.textContent = `@keyframes giftConfettiFall{to{transform:translateY(80vh) rotate(720deg);opacity:0}}`;
  document.head.appendChild(s);
}


function _renderCertificatesTable() {
  const body = document.getElementById('docCertificatesBody');
  if (!body) return;

  const investments = PORTAL.investments;
  if (!investments.length) {
    body.innerHTML = `<tr><td colspan="8" style="padding:28px"><div class="empty-state" style="padding:0;border:none;background:transparent"><i class="fa-solid fa-file-certificate"></i><div class="empty-state__title">No investment certificates yet</div><div class="empty-state__sub">Your first completed investment will unlock downloadable certificates and term sheets here.</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px"><button class="btn btn--primary btn--sm" onclick="navigate('marketplace', document.querySelector('[data-view=marketplace]'))"><i class="fa-solid fa-layer-group"></i> Browse pools</button><button class="btn btn--secondary btn--sm" onclick="navigate('wallet', document.querySelector('[data-view=wallet]'))"><i class="fa-solid fa-wallet"></i> Fund wallet</button></div></div></td></tr>`;
    return;
  }

  body.innerHTML = investments.map(inv => {
    const pi = Utils.productInfo(inv.product_type);
    return `<tr>
      <td class="td-strong">${_esc(inv.pool_name) || '—'}</td>
      <td><span class="badge ${pi.badgeClass}"><i class="fa-solid ${pi.icon}"></i> ${pi.label}</span></td>
      <td class="td-gold fw-700">${Utils.rand(inv.amount)}</td>
      <td>${(() => { const _r = Utils.effectiveRate(inv); return _r != null ? Utils.pct(_r) : '—'; })()}</td>
      <td class="td-muted">${Utils.date(inv.investment_date || inv.start_date)}</td>
      <td class="td-muted">${Utils.date(inv.maturity_date || inv.end_date)}</td>
      <td>${Utils.statusBadge(inv.status)}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn--primary btn--sm" onclick="downloadCertificate('${inv.id}')">
          <i class="fa-solid fa-file-pdf"></i> Certificate
        </button>
        ${(() => { const pool = PORTAL.pools.find(p => p.id === inv.pool_id); return pool && pool.term_sheet_url ? `<a href="${pool.term_sheet_url}" target="_blank" rel="noopener" class="btn btn--secondary btn--sm"><i class="fa-solid fa-file-contract"></i> Term Sheet</a>` : ''; })()}
      </td>
    </tr>`;
  }).join('');
}

function _renderReceiptsTable() {
  const body = document.getElementById('docReceiptsBody');
  if (!body) return;

  const deposits = [...PORTAL.transactions]
    .filter(t => t.type === 'deposit')
    .sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at))
    .slice(0, 20);

  if (!deposits.length) {
    body.innerHTML = `<tr><td colspan="6" style="padding:28px"><div class="empty-state" style="padding:0;border:none;background:transparent"><i class="fa-solid fa-receipt"></i><div class="empty-state__title">No deposit receipts yet</div><div class="empty-state__sub">As soon as your first wallet top-up is completed, the receipt will appear here for download.</div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px"><button class="btn btn--primary btn--sm" onclick="openTopUpModal()"><i class="fa-solid fa-plus"></i> Top up wallet</button><button class="btn btn--secondary btn--sm" onclick="navigate('statement', document.querySelector('[data-view=statement]'))"><i class="fa-solid fa-file-invoice"></i> Generate statement</button></div></div></td></tr>`;
    return;
  }

  body.innerHTML = deposits.map(t => `<tr>
    <td class="td-muted">${Utils.date(t.transaction_date || t.created_at)}</td>
    <td class="td-green fw-700">+${Utils.rand(Math.abs(t.amount))}</td>
    <td class="td-muted" style="font-size:0.78rem">${t.description || 'Wallet deposit'}</td>
    <td class="td-muted" style="font-size:0.75rem">${t.reference || '—'}</td>
    <td>${Utils.statusBadge(t.status)}</td>
    <td><button class="btn btn--secondary btn--sm" onclick="downloadReceipt('${t.id}')">
      <i class="fa-solid fa-download"></i> Receipt
    </button></td>
  </tr>`).join('');
}


/* ── PDF: logo cache ── */
let _cachedLogoDataUrl = null;
let _cachedLogoOutlineDataUrl = null;


/* downloadStatement() — 90-day statement */
function downloadStatement() {
  const investor = PORTAL.investor;
  if (!investor) { Toast.error('Portfolio data still loading'); return; }

  const doc = _getPDF('portrait');
  if (!doc) return;

  const W  = doc.internal.pageSize.getWidth();
  const now = new Date();
  const from90 = new Date(now);
  from90.setDate(from90.getDate() - 90);

  // Filter last 90 days
  const txns = PORTAL.transactions
    .filter(t => {
      const d = new Date(t.transaction_date || t.created_at || 0);
      return d >= from90;
    })
    .sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at));

  const totalInvested = PORTAL.investments.filter(i => !i.is_reinvestment).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  /* Income only — `return` and `interest`. This counted `payout`, whose amount
     is capital plus return, so a client whose holding matured in the window saw
     their own capital reported back to them as returns earned. See
     _isIncomeTxn in portal-core. */
  const _txnReturns90 = txns.filter(t => _isIncomeTxn(t) && t.status !== 'cancelled').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const totalReturns  = _txnReturns90 > 0 ? _txnReturns90
    : PORTAL.investments.filter(i => ['paid_out', 'matured'].includes(i.status) && new Date(i.maturity_date || i.investment_date) >= from90)
                        .reduce((s, i) => s + (i.actual_return_amount || i.expected_return_amount || 0), 0);
  const walletBal     = Number(investor.wallet_balance) || 0;
  // Portfolio value is a point-in-time figure and moves only on posted
  // returns — totalReturns above is period-scoped and falls back to expected
  // amounts, so it must not feed this.
  const portfolioVal  = Utils.portfolioValue(PORTAL.investments, walletBal);

  const periodLabel = `${from90.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })} – ${now.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}`;

  // Header
  let y = _pdfHeader(doc, 'ACCOUNT STATEMENT', periodLabel);
  _pdfWatermark(doc);
  y += 6;

  // Investor info
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(26, 26, 26);
  doc.text(`${investor.first_name} ${investor.last_name}`, 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(107, 114, 128);
  doc.setFontSize(8);
  doc.text(`${investor.id} · ${investor.email || ''}`, 14, y + 5);
  y += 14;

  // Summary stats
  const stats = [
    ['Portfolio Value', Utils.rand(portfolioVal), [255, 155, 12]],
    ['Wallet Balance',  Utils.rand(walletBal),    [0, 150, 255]],
    ['Total Invested',  Utils.rand(totalInvested), [48, 48, 48]],
    ['Returns Earned',  Utils.rand(totalReturns),  [34, 197, 94]],
  ];
  const boxW = (W - 28 - 9) / 4;
  stats.forEach(([label, value, color], i) => {
    const bx = 14 + i * (boxW + 3);
    doc.setFillColor(247, 248, 250);
    doc.roundedRect(bx, y, boxW, 24, 2, 2, 'F');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold');
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(label.toUpperCase(), bx + boxW / 2, y + 8, { align: 'center' });
    doc.setFontSize(10); doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 26, 26);
    doc.text(value, bx + boxW / 2, y + 18, { align: 'center' });
  });
  y += 30;

  // Transaction table
  if (!txns.length) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(156, 163, 175);
    doc.text('No transactions in the last 90 days.', 14, y + 10);
  } else {
    const typeMap = { deposit: 'Deposit', withdrawal: 'Withdrawal', investment: 'Investment', return: 'Return', payout: 'Payout', fee: 'Fee', referral_bonus: 'Referral Bonus', gift_sent: 'Gift Sent', gift_received: 'Gift Received', reward: 'XP Reward' };
    const tableHead = [['Date', 'Type', 'Description', 'Debit', 'Credit', 'Status']];
    const _isCreditTx = t => ['deposit','return','payout','referral_bonus','gift_received','reward'].includes(t.type);
    const _isDebitTx  = t => ['withdrawal','investment','platform_fee','fee','gift_sent'].includes(t.type);
    const tableBody = txns.map(t => {
      const absAmt = Math.abs(Number(t.amount) || 0);
      return [
        Utils.date(t.transaction_date || t.created_at),
        typeMap[t.type] || t.type,
        t.description || t.pool_name || '—',
        _isDebitTx(t)  ? Utils.rand(absAmt) : '—',
        _isCreditTx(t) ? Utils.rand(absAmt) : '—',
        (t.status || '—').toUpperCase(),
      ];
    });

    if (doc.autoTable) {
      doc.autoTable({
        head: tableHead,
        body: tableBody,
        startY: y,
        margin: { left: 14, right: 14 },
        headStyles: { fillColor: [48, 48, 48], textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
        bodyStyles: { fontSize: 8, textColor: [26, 26, 26] },
        alternateRowStyles: { fillColor: [247, 248, 250] },
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 26 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 28, halign: 'right', textColor: [239, 68, 68] },
          4: { cellWidth: 28, halign: 'right', textColor: [22, 163, 74]  },
          5: { cellWidth: 20, halign: 'center' },
        },
        didDrawPage: () => _pdfFooter(doc),
      });
    } else {
      // Fallback without autoTable
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(107, 114, 128);
      doc.text('Date', 14, y + 6); doc.text('Type', 40, y + 6); doc.text('Description', 70, y + 6); doc.text('Amount', 150, y + 6); doc.text('Status', 175, y + 6);
      y += 10;
      doc.setFont('helvetica', 'normal'); doc.setTextColor(26, 26, 26);
      tableBody.slice(0, 30).forEach(row => {
        doc.text(row[0], 14, y); doc.text(row[1], 40, y); doc.text(row[2].slice(0, 30), 70, y);
        doc.text(row[3], 150, y, { align: 'right' }); doc.text(row[4], 175, y);
        y += 6;
        if (y > 260) { doc.addPage(); y = 20; }
      });
    }
  }

  _pdfFooter(doc);
  const ym = now.toISOString().slice(0, 7);
  doc.save(`SVC-Statement-${ym}.pdf`);
  Toast.success('90-day statement downloaded!');
}


/* ═══════════════════════════════════════════════
   FEATURE 12: RISK PROFILE QUESTIONNAIRE
   ═══════════════════════════════════════════════ */


function renderRiskProfile() {
  const inv = PORTAL.investor;
  if (!inv) return;

  // ── Populate personal info form ───────────────────────────
  const _set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  _set('profFirstName', inv.first_name);
  _set('profLastName',  inv.last_name);
  _set('profEmail',     inv.email);
  _set('profPhone',     inv.phone);
  _set('profStreetAddress', inv.street_address || '');
  _set('profSuburb',        inv.suburb || '');
  _set('profCity',          inv.address || inv.city || '');
  _set('profPostalCode',    inv.postal_code || '');

  // Province dropdown: select matching option
  const provSel = document.getElementById('profProvince');
  if (provSel && inv.province) {
    const opt = [...provSel.options].find(o => o.value === inv.province || o.text === inv.province);
    if (opt) opt.selected = true;
  }

  // ── Populate Account Summary sidebar ─────────────────────
  const _setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  _setText('profSummaryId',       inv.id);
  _setText('profSummaryJoined',   inv.date_joined ? new Date(inv.date_joined).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  // Copy button for Investor ID — placed BEFORE the value: [label] ... [copy] [value]
  const invIdEl = document.getElementById('profSummaryId');
  if (invIdEl && !invIdEl.previousElementSibling?.classList?.contains('copy-btn')) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.title = 'Copy';
    btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
    btn.onclick = () => _copyText(invIdEl.textContent, btn);
    invIdEl.before(btn);
  }

  const statusEl = document.getElementById('profSummaryStatus');
  if (statusEl) {
    const st = (inv.status || 'active').toLowerCase();
    const statusClass = st === 'active' ? 'badge--green' : st === 'suspended' ? 'badge--red' : 'badge--gray';
    statusEl.innerHTML = `<span class="badge ${statusClass}">${st.charAt(0).toUpperCase() + st.slice(1)}</span>`;
  }

  const ficaEl = document.getElementById('profSummaryFica');
  if (ficaEl) {
    const kyc = (inv.kyc_status || 'pending').toLowerCase();
    const kycClass = kyc === 'approved' ? 'badge--green' : kyc === 'rejected' ? 'badge--red' : 'badge--gray';
    const kycLabel = kyc === 'fica_submitted' ? 'Submitted' : kyc.charAt(0).toUpperCase() + kyc.slice(1);
    ficaEl.innerHTML = `<span class="badge ${kycClass}">${kycLabel}</span>`;
  }

  const profile = inv.risk_profile || null;
  const badge = document.getElementById('riskProfileBadge');
  const desc  = document.getElementById('riskProfileDesc');
  const btnLabel = document.getElementById('riskProfileBtnLabel');

  // Also sync the radio buttons in the profile form
  if (profile) {
    const radios = document.querySelectorAll('input[name="riskProf"]');
    radios.forEach(r => { r.checked = r.value === profile; });
  }

  // Load login history
  _loadLoginHistory();

  if (!badge) return;

  const configs = {
    conservative: {
      badgeClass: 'badge--blue',
      label: 'Conservative',
      desc: 'You prefer capital preservation with lower risk. We recommend short-term and solar investments.',
    },
    moderate: {
      badgeClass: 'badge--orange',
      label: 'Moderate',
      desc: 'You balance growth with prudent risk. A blend of cattle and solar products suits you well.',
    },
    aggressive: {
      badgeClass: 'badge--red',
      label: 'Aggressive',
      desc: 'You prioritise high returns and can tolerate risk. Cattle cycles and high-yield pools are ideal.',
    },
  };

  if (profile && configs[profile]) {
    const cfg = configs[profile];
    badge.className = `badge ${cfg.badgeClass}`;
    badge.textContent = cfg.label;
    if (desc) desc.textContent = cfg.desc;
    if (btnLabel) btnLabel.textContent = 'Retake Questionnaire';
  } else {
    badge.className = 'badge badge--gray';
    badge.textContent = 'Not assessed';
    if (desc) desc.textContent = 'Complete the questionnaire to determine your risk appetite and get tailored pool recommendations.';
    if (btnLabel) btnLabel.textContent = 'Take Questionnaire';
  }

  _loadStatementArchive();
  restoreProfileDraft();
}


/* ═══════════════════════════════════════════════
   FEATURE: STATEMENT ARCHIVE & TAX CERTIFICATES
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   FEATURE: ENHANCED 2FA STATUS IN PROFILE
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   FEATURE 2: TWO-WAY SUPPORT MESSAGING
   ═══════════════════════════════════════════════ */

let _activeTicketId = null;


/* ═══════════════════════════════════════════════
   FEATURE 3: RECURRING INVESTMENT SETUP
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   FEATURE 5 (extended): ACCOUNT DELETION
   ═══════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════
   FEATURE 6: PUSH NOTIFICATION OPT-IN
   ═══════════════════════════════════════════════ */

const PUSH_PREF_KEY = 'svc_push_pref';


/* ═══════════════════════════════════════════════════════════════
   PWA INSTALL PROMPT
   ═══════════════════════════════════════════════════════════════ */
let _pwaPromptEvt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _pwaPromptEvt = e;
  if (!localStorage.getItem('pwa_installed') && !localStorage.getItem('pwa_dismissed')) {
    setTimeout(() => {
      const banner = document.getElementById('pwaInstallBanner');
      if (banner) banner.style.display = 'flex';
    }, 8000);
  }
});

window.addEventListener('appinstalled', () => {
  localStorage.setItem('pwa_installed', '1');
  const banner = document.getElementById('pwaInstallBanner');
  if (banner) banner.style.display = 'none';
  Toast.success('App installed! You can now open SV Capital from your home screen.');
});


/* ── iOS / Safari "Add to Home Screen" prompt ── */
(function _initIOSBanner() {
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true;
  if (!isIOS || isStandalone) return;
  if (localStorage.getItem('ios_pwa_dismissed')) return;
  setTimeout(() => {
    const el = document.getElementById('iosPwaBanner');
    if (el) el.style.display = 'flex';
  }, 8000);
})();


/* ═══════════════════════════════════════════════════════════════
   PORTFOLIO ANALYTICS VIEW
   ═══════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════
   COMMAND PALETTE
   ═══════════════════════════════════════════════════════════════ */

const PORTAL_CMD_ITEMS = [
  { label: 'Portfolio Overview',        icon: 'fa-grid-2',          group: 'Navigate', action: () => navigate('overview',      document.querySelector('[data-view=overview]')) },
  { label: 'My Investments',            icon: 'fa-chart-line',      group: 'Navigate', action: () => navigate('investments',   document.querySelector('[data-view=investments]')) },
  { label: 'Portfolio Analytics',       icon: 'fa-chart-mixed',     group: 'Navigate', action: () => navigate('analytics',     document.querySelector('[data-view=analytics]')) },
  { label: 'Transactions',             icon: 'fa-arrows-rotate',   group: 'Navigate', action: () => navigate('transactions',  document.querySelector('[data-view=transactions]')) },
  { label: 'Wallet',                    icon: 'fa-wallet',          group: 'Navigate', action: () => navigate('wallet',        document.querySelector('[data-view=wallet]')) },
  { label: 'My Accounts',              icon: 'fa-layer-group',     group: 'Navigate', action: () => navigate('subaccounts',   document.querySelector('[data-view=subaccounts]')) },
  { label: 'Browse Pools',             icon: 'fa-store',           group: 'Navigate', action: () => navigate('marketplace',   document.querySelector('[data-view=marketplace]')) },
  { label: 'Maturity Instructions',    icon: 'fa-hourglass-end',   group: 'Navigate', action: () => navigate('maturity',      document.querySelector('[data-view=maturity]')) },
  { label: 'Earn Rewards',             icon: 'fa-trophy',          group: 'Navigate', action: () => navigate('quests',        document.querySelector('[data-view=quests]')) },
  { label: 'Learning Hub',             icon: 'fa-graduation-cap',  group: 'Navigate', action: () => navigate('learn',         document.querySelector('[data-view=learn]')) },
  { label: 'My Profile',               icon: 'fa-user-circle',     group: 'Navigate', action: () => navigate('profile',       document.querySelector('[data-view=profile]')) },
  { label: 'Support',                  icon: 'fa-headset',         group: 'Navigate', action: () => navigate('support',       document.querySelector('[data-view=support]')) },
  // Refer & Earn hidden — referral programme not yet live
  { label: 'Documents',                icon: 'fa-folder-open',     group: 'Navigate', action: () => navigate('documents',     document.querySelector('[data-view=documents]')) },
  { label: 'Account Statement',        icon: 'fa-file-invoice',    group: 'Navigate', action: () => navigate('statement',     document.querySelector('[data-view=statement]')) },
  { label: 'Top Up Wallet',            icon: 'fa-plus',            group: 'Actions',  action: () => openTopUpModal() },
  { label: 'Download Tax Certificate', icon: 'fa-file-shield',     group: 'Actions',  action: () => { navigate('documents', document.querySelector('[data-view=documents]')); } },
  { label: 'Download Statement PDF',   icon: 'fa-file-pdf',        group: 'Actions',  action: () => downloadStatement() },
  { label: 'Export Analytics CSV',     icon: 'fa-table',           group: 'Actions',  action: () => exportAnalyticsCSV() },
  { label: 'Submit Maturity Instruction', icon: 'fa-check-circle', group: 'Actions',  action: () => navigate('maturity', document.querySelector('[data-view=maturity]')) },
  { label: 'Sign Out',                 icon: 'fa-arrow-right-from-bracket', group: 'Actions', action: () => { localStorage.removeItem('svc_portal_cache'); localStorage.removeItem('svc_user'); sessionStorage.clear(); Auth.logout('../login.html'); } },
];

let _portalCmdActive = -1;


document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const overlay = document.getElementById('portalCmdOverlay');
    if (overlay && overlay.style.display !== 'none') closePortalCmd();
    else openPortalCmd();
  } else if (e.key === 'Escape') {
    const overlay = document.getElementById('portalCmdOverlay');
    if (overlay && overlay.style.display !== 'none') closePortalCmd();
  }
});

